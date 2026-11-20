'use strict';

const dns = require('dns');
const net = require('net');
const {
    normalizeCidr,
    normalizeDomain,
    PRESETS,
    PRIVATE_V4,
    PRIVATE_V6,
    METADATA_V4,
    METADATA_V6
} = require('./network-policy');
const { PROXY_KEYS } = require('./network-endpoints');

// 从自启动脚本与 first（命令、env、envFile）里识别“可能需要放行”的地址。
// 只做解析与提示：不执行、不拼接 shell、不读取命令里调用的脚本；返回的候选只有 host / port / 来源 / 风险，
// 绝不带命令原文、URL 的 path / query / userinfo、env 值或密钥片段。
// 纯函数 + 一次可注入的 DNS 解析；由 Web 新建容器弹窗调用（CLI 不扫描）。
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_AUTOSTART_BYTES = 256 * 1024;
const MAX_FIRST_BYTES = 64 * 1024;
const MAX_ENV_BYTES = 192 * 1024;
const MAX_RAW_MATCHES = 200;
const MAX_CANDIDATES = 50;
const MAX_LOOKUP_HOSTS = 50;
const LOOKUP_TIMEOUT_MS = 2000;
const LOOKUP_CONCURRENCY = 8;
const TOTAL_LOOKUP_BUDGET_MS = 5000;
const DNS_CACHE_TTL_MS = 30000;

const HOST_ALIASES = new Set(['host.containers.internal', 'host.docker.internal']);
const DEFAULT_PORTS = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443, 'ftp:': 21 };
const NETWORK_COMMANDS = [
    'curl', 'wget', 'ping', 'dig', 'nslookup', 'host', 'nc', 'netcat', 'telnet', 'ssh', 'scp', 'sftp',
    'git', 'docker', 'podman', 'npm', 'npx', 'pip', 'pip3', 'go', 'cargo', 'mysql', 'psql', 'redis-cli',
    'apt', 'apt-get', 'yum', 'dnf', 'brew', 'gem', 'composer'
];
const NETWORK_FLAGS = ['--url', '--host', '--hostname', '--registry', '--index-url', '--extra-index-url', '--server', '--endpoint'];
// 常见文件扩展名：带这些 TLD 的裸 token 不当域名（避免把 build/app.js、config.json 之类收进来）
const FILE_EXTENSIONS = new Set([
    'sh', 'js', 'json', 'txt', 'log', 'py', 'md', 'yml', 'yaml', 'toml', 'conf', 'env', 'html', 'css',
    'ts', 'tsx', 'jsx', 'go', 'rs', 'java', 'jar', 'zip', 'tar', 'gz', 'png', 'jpg', 'svg', 'pdf', 'lock',
    'ini', 'cfg', 'sql', 'db', 'bin', 'exe', 'dll', 'so', 'dylib', 'bak', 'tmp'
]);
const COMMAND_RE = new RegExp(`(?:^|[\\s;|&(])(${NETWORK_COMMANDS.join('|')})(?=$|[\\s;|&)<])`, 'i');
const FLAG_RE = new RegExp(`(?:^|\\s)(${NETWORK_FLAGS.join('|')})(?=\\s|=|$)`, 'i');

function blockListOf(cidrs) {
    const list = new net.BlockList();
    (cidrs || []).forEach(cidr => {
        const [addr, prefix] = String(cidr).split('/');
        const family = net.isIP(addr);
        if (!family) return;
        const type = family === 4 ? 'ipv4' : 'ipv6';
        if (prefix === undefined) list.addAddress(addr, type);
        else list.addSubnet(addr, Number(prefix), type);
    });
    return list;
}

// ::ffff:a.b.c.d 与 NAT64（64:ff9b::/96）里嵌的 IPv4 要按 IPv4 判断
function embeddedV4(ip) {
    const lower = String(ip || '').toLowerCase();
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return mapped[1];
    const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hex) {
        const a = parseInt(hex[1], 16);
        const b = parseInt(hex[2], 16);
        return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    }
    return '';
}

function check(list, ip) {
    const addr = embeddedV4(ip) || String(ip || '');
    const family = net.isIP(addr);
    return family ? list.check(addr, family === 4 ? 'ipv4' : 'ipv6') : false;
}

const privateList = blockListOf([...PRIVATE_V4, ...PRIVATE_V6]);
const metadataList = blockListOf([...METADATA_V4, ...METADATA_V6]);
// 环回 / 未指定 / 组播 / 链路本地：不是可用的目标，永远不列
const unusableList = blockListOf(['127.0.0.0/8', '0.0.0.0/8', '224.0.0.0/4', '255.255.255.255/32', '::1/128', '::/128', 'ff00::/8', 'fe80::/10']);

const isPrivateAddress = ip => check(privateList, ip);
const isMetadataAddress = ip => check(metadataList, ip);
const isUnusableAddress = ip => check(unusableList, ip);

function unique(list) {
    return [...new Set(list)];
}

function isDomainText(text) {
    const value = String(text || '').trim().toLowerCase();
    if (!value || value.length > 253) return false;
    if (!value.includes('.')) return false;
    try {
        normalizeDomain(value);
    } catch (e) {
        return false;
    }
    const labels = value.split('.');
    if (labels.some(label => /^\d+$/.test(label) && labels.length === 3)) return false;
    const tld = labels[labels.length - 1];
    if (FILE_EXTENSIONS.has(tld)) return false;
    if (labels.slice(0, -1).every(label => /^\d+$/.test(label))) return false;
    return true;
}

function isWideCidr(target) {
    const match = /\/(\d+)$/.exec(target);
    const prefix = match ? Number(match[1]) : (target.includes(':') ? 128 : 32);
    return target.includes(':') ? prefix <= 16 : prefix <= 8;
}

function makeToken({ kind, target, ports, proto, evidence, risk, source }) {
    return { kind, target, ports: String(ports || ''), proto, evidence, risk: risk || '', source };
}

function urlToken(text, source) {
    let url;
    try {
        url = new URL(text);
    } catch (e) {
        return null;
    }
    const protocol = url.protocol;
    if (!DEFAULT_PORTS[protocol]) return null;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return null;
    if (host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0' || /^127\./.test(host)) return null;
    const port = Number(url.port) || DEFAULT_PORTS[protocol];
    const bracketed = net.isIPv6(host) ? `[${host}]` : host;
    const origin = `${protocol}//${bracketed}${Number(url.port) ? `:${url.port}` : ''}`;
    if (HOST_ALIASES.has(host)) return makeToken({ kind: 'host', target: '@host', ports: port, proto: 'tcp', evidence: `@host:${port}`, source });
    if (net.isIP(host)) return makeToken({ kind: 'cidr', target: host, ports: port, proto: 'tcp', evidence: origin, source });
    try {
        normalizeDomain(host);
    } catch (e) {
        return null;
    }
    return makeToken({ kind: 'domain', target: host, ports: port, proto: 'tcp', evidence: origin, source });
}

function ipToken(run, source) {
    let parsed;
    try {
        parsed = normalizeCidr(run);
    } catch (e) {
        return null;
    }
    const address = parsed.cidr.split('/')[0];
    if (isUnusableAddress(address)) return null;
    return makeToken({
        kind: 'cidr',
        target: parsed.cidr,
        ports: '',
        proto: 'all',
        evidence: parsed.cidr,
        risk: isMetadataAddress(address) ? 'metadata' : '',
        source
    });
}

// 一个完整的值（env 的值、命令里的 KEY=value）已经是 URL / 域名 / IP 时直接接受；不做命令上下文判断
function valueTokens(value, source) {
    const text = String(value || '').trim().replace(/^["']|["']$/g, '');
    if (!text || /\s/.test(text) || /[$`{}]/.test(text)) return [];
    if (/^(?:https?|wss?|ftp):\/\//i.test(text)) {
        const token = urlToken(text, source);
        return token ? [token] : [];
    }
    if (net.isIP(text.split('/')[0])) {
        const token = ipToken(text, source);
        return token ? [token] : [];
    }
    if (isDomainText(text)) {
        return [makeToken({ kind: 'domain', target: text.toLowerCase(), ports: '', proto: 'all', evidence: text.toLowerCase(), source })];
    }
    return [];
}

function addAll(out, tokens) {
    for (const token of tokens) {
        if (out.length >= MAX_RAW_MATCHES) return false;
        out.push(token);
    }
    return true;
}

/**
 * 从一段命令文本提取原始 token（未去重 / 未做 DNS / 未按模式过滤）。
 * 只返回解析后的字段；原文里的 path / query / userinfo / 变量值不会出现在结果里。
 */
function extractEndpointTokens(text, options = {}) {
    const source = options.source || 'first';
    const out = [];
    const lines = String(text || '').split('\n');
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        // 代理赋值不是目标：先抹掉，避免把上游代理地址建议成白名单
        let scanned = line.replace(/(?:^|[\s;])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=([^\s;]*)/g, (all, key) => (PROXY_KEYS.has(key) ? ' ' : all));

        // 带 scheme 的 URL
        const urlRe = /\b(?:https?|wss?|ftp):\/\/[^\s"'`<>|;]+/gi;
        let match;
        while ((match = urlRe.exec(scanned))) {
            const token = urlToken(match[0].replace(/[)\],;'"]+$/, ''), source);
            if (token && !addAll(out, [token])) return out;
        }

        // 通配域名
        const wildcardRe = /\*\.([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)/g;
        while ((match = wildcardRe.exec(scanned))) {
            const target = `*.${match[1]}`.toLowerCase();
            let valid = false;
            try {
                normalizeDomain(target);
                valid = match[1].includes('.');
            } catch (e) {
                valid = false;
            }
            if (!valid) continue;
            if (!addAll(out, [makeToken({ kind: 'domain', target, ports: '', proto: 'all', evidence: target, risk: 'wide', source })])) return out;
        }

        // git@host:path
        const gitSshRe = /\bgit@([A-Za-z0-9.-]+):[^\s"'`<>|;]+/g;
        while ((match = gitSshRe.exec(scanned))) {
            const host = match[1].toLowerCase();
            if (!isDomainText(host)) continue;
            if (!addAll(out, [makeToken({ kind: 'domain', target: host, ports: 22, proto: 'tcp', evidence: `${host}:22`, source })])) return out;
        }

        // ssh -p <port> user@host
        const sshPortRe = /\bssh\b[^\n;|&]*?\s-p\s*(\d{1,5})\s+(?:[A-Za-z0-9._-]+@)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)/g;
        while ((match = sshPortRe.exec(scanned))) {
            const port = Number(match[1]);
            const host = match[2].replace(/^\[|\]$/g, '').toLowerCase();
            if (port < 1 || port > 65535) continue;
            const token = ipToken(`${host}`, source) || (isDomainText(host)
                ? makeToken({ kind: 'domain', target: host, ports: port, proto: 'tcp', evidence: `${host}:${port}`, source })
                : null);
            if (!token) continue;
            if (token.kind === 'cidr') token.ports = String(port);
            if (!addAll(out, [token])) return out;
        }

        // host:port（排除 URL 里的写法：前面是 / 时不匹配）
        const hostPortRe = /(?:^|[\s"'`(=,])(\[[0-9a-fA-F:]+\]|[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]|[A-Za-z0-9]):(\d{1,5})(?=$|[\s"'`),;])/g;
        while ((match = hostPortRe.exec(scanned))) {
            const port = Number(match[2]);
            if (port < 1 || port > 65535) continue;
            const host = match[1].replace(/^\[|\]$/g, '').toLowerCase();
            if (host === 'localhost' || /^127\./.test(host) || host === '::1') continue;
            if (HOST_ALIASES.has(host)) {
                if (!addAll(out, [makeToken({ kind: 'host', target: '@host', ports: port, proto: 'tcp', evidence: `@host:${port}`, source })])) return out;
                continue;
            }
            if (net.isIP(host)) {
                const token = ipToken(host, source);
                if (token) {
                    token.ports = String(port);
                    token.proto = 'tcp';
                    token.evidence = `${host}:${port}`;
                    if (!addAll(out, [token])) return out;
                }
                continue;
            }
            if (!isDomainText(host)) continue;
            if (!addAll(out, [makeToken({ kind: 'domain', target: host, ports: port, proto: 'tcp', evidence: `${host}:${port}`, source })])) return out;
        }

        // 裸 IPv4 / CIDR
        const ipv4Re = /(?:^|[\s"'`(=,])((?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?)(?=$|[\s"'`),;])/g;
        while ((match = ipv4Re.exec(scanned))) {
            const token = ipToken(match[1], source);
            if (token && !addAll(out, [token])) return out;
        }

        // 裸 IPv6 / CIDR（按 token 扫，避免复杂正则）
        for (const rawToken of scanned.split(/[\s;|&"'`()]+/)) {
            const tokenText = rawToken.replace(/[,.;]+$/, '').replace(/^\[|\]$/g, '');
            if (!tokenText.includes(':') || tokenText.includes('://')) continue;
            if (PROXY_KEYS.has(tokenText.split('=')[0])) continue;
            const candidate = valueTokens(tokenText, source).find(item => item.kind === 'cidr');
            if (candidate && net.isIP(candidate.target.split('/')[0]) === 6) {
                if (!addAll(out, [candidate])) return out;
            }
        }

        // KEY=value：非代理变量按“完整值”处理（export API_HOST=llm.corp.example）
        const assignRe = /(?:^|[\s;])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=([^\s;]+)/g;
        while ((match = assignRe.exec(scanned))) {
            if (PROXY_KEYS.has(match[1])) continue;
            if (!addAll(out, valueTokens(match[2], source))) return out;
        }

        // 裸域名：只在命令上下文（网络命令 / 网络参数）或 www. / api. 开头时接受
        const networkContext = COMMAND_RE.test(scanned) || FLAG_RE.test(scanned);
        for (const rawToken of scanned.split(/[\s;|&"'`()]+/)) {
            let tokenText = rawToken.replace(/[,.;]+$/, '');
            if (!tokenText || /[*@=$`{}]/.test(tokenText)) continue;
            if (/[一-鿿]/.test(tokenText)) continue;
            const eq = tokenText.indexOf('=');
            if (eq >= 0) {
                if (PROXY_KEYS.has(tokenText.slice(0, eq))) continue;
                tokenText = tokenText.slice(eq + 1);
                if (!tokenText) continue;
                if (!addAll(out, valueTokens(tokenText, source))) return out;
                continue;
            }
            if (tokenText.includes('/') || tokenText.includes(':')) continue;
            const lower = tokenText.toLowerCase();
            const prefixed = lower.startsWith('www.') || lower.startsWith('api.');
            if ((!networkContext && !prefixed) || !isDomainText(lower)) continue;
            if (!addAll(out, [makeToken({ kind: 'domain', target: lower, ports: '', proto: 'all', evidence: lower, source })])) return out;
        }
    }
    return out;
}

function envLineTokens(lines, source) {
    const out = [];
    for (const line of lines || []) {
        const text = String(line || '');
        const index = text.indexOf('=');
        if (index <= 0) continue;
        const key = text.slice(0, index).trim();
        if (PROXY_KEYS.has(key)) continue;
        const tokens = valueTokens(text.slice(index + 1), source);
        if (!addAll(out, tokens)) break;
    }
    return out;
}

function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await fn(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

const dnsCache = new Map();
function defaultLookup(host) {
    const hit = dnsCache.get(host);
    if (hit && Date.now() - hit.at < DNS_CACHE_TTL_MS) return Promise.resolve(hit.ips);
    return new Promise((resolve, reject) => {
        dns.lookup(host, { all: true }, (err, addresses) => {
            if (err) return reject(err);
            const ips = (addresses || []).map(item => item.address).filter(Boolean);
            dnsCache.set(host, { ips, at: Date.now() });
            resolve(ips);
        });
    });
}

function checkInputSize({ autostart, firstCommand, firstEnvLines, firstEnvFileLines }) {
    const autostartBytes = Buffer.byteLength(String(autostart || ''));
    const firstBytes = Buffer.byteLength(String(firstCommand || ''));
    const envBytes = Buffer.byteLength([...(firstEnvLines || []), ...(firstEnvFileLines || [])].join('\n'));
    if (autostartBytes > MAX_AUTOSTART_BYTES) throw new Error('自启动脚本过大，无法识别地址');
    if (firstBytes > MAX_FIRST_BYTES) throw new Error('首次命令过大，无法识别地址');
    if (envBytes > MAX_ENV_BYTES) throw new Error('首次环境变量过大，无法识别地址');
    if (autostartBytes + firstBytes + envBytes > MAX_INPUT_BYTES) throw new Error('识别输入过大');
}

/**
 * @param {object} options
 * @param {string} [options.autostart] 自启动脚本文本
 * @param {string} [options.firstCommand] first 的 shellPrefix + shell + shellSuffix
 * @param {string[]} [options.firstEnvLines] first.env 的 KEY=VALUE 行
 * @param {string[]} [options.firstEnvFileLines] first.envFile 的内容行
 * @param {'restricted'|'allowlist'|'custom'} options.preset
 * @param {(host: string) => Promise<string[]|{address: string}[]>} [options.lookup] 测试替身
 * @returns {Promise<{candidates: object[], truncated: boolean, preset: string, reason?: string}>}
 */
async function inferEndpointCandidates(options = {}) {
    const preset = String(options.preset || 'restricted');
    if (!PRESETS.includes(preset)) throw new Error(`未知的网络模式: ${preset}`);
    checkInputSize(options);
    if (preset === 'custom') return { candidates: [], truncated: false, preset, reason: 'unrestricted' };

    const raw = [];
    const addTokens = tokens => {
        for (const token of tokens) {
            if (raw.length >= MAX_RAW_MATCHES) return;
            raw.push(token);
        }
    };
    addTokens(extractEndpointTokens(String(options.autostart || ''), { source: 'autostart' }));
    addTokens(extractEndpointTokens(String(options.firstCommand || ''), { source: 'first' }));
    addTokens(envLineTokens(options.firstEnvLines, 'first.env'));
    addTokens(envLineTokens(options.firstEnvFileLines, 'first.envFile'));
    let truncated = raw.length >= MAX_RAW_MATCHES;

    // 去重：kind|target|ports；来源按扫描顺序合并
    const merged = new Map();
    for (const token of raw) {
        const key = `${token.kind}|${token.target}|${token.ports}`;
        const existing = merged.get(key);
        if (existing) {
            if (!existing.sources.includes(token.source)) existing.sources.push(token.source);
            if (!existing.evidence && token.evidence) existing.evidence = token.evidence;
        } else {
            merged.set(key, { ...token, sources: [token.source] });
        }
    }

    // DNS：只对域名做，去重后最多 50 个，单 host 2 秒、并发 8、总预算 5 秒；失败只影响 resolved
    const lookup = options.lookup || defaultLookup;
    const lookupTimeoutMs = Number(options.lookupTimeoutMs) || LOOKUP_TIMEOUT_MS;
    const totalBudgetMs = Number(options.totalLookupBudgetMs) || TOTAL_LOOKUP_BUDGET_MS;
    const domainTargets = unique([...merged.values()]
        .filter(item => item.kind === 'domain' && !item.target.startsWith('*.'))
        .map(item => item.target))
        .slice(0, MAX_LOOKUP_HOSTS);
    const started = Date.now();
    const resolvedByHost = new Map();
    await mapLimit(domainTargets, LOOKUP_CONCURRENCY, async host => {
        if (Date.now() - started > totalBudgetMs) {
            resolvedByHost.set(host, { ips: [], failed: true });
            return;
        }
        try {
            const list = await withTimeout(Promise.resolve(lookup(host, { all: true })), lookupTimeoutMs);
            const ips = (Array.isArray(list) ? list : []).map(item => (typeof item === 'string' ? item : item && item.address)).filter(Boolean);
            resolvedByHost.set(host, { ips, failed: false });
        } catch (e) {
            resolvedByHost.set(host, { ips: [], failed: true });
        }
    });

    const candidates = [];
    for (const item of merged.values()) {
        const host = item.kind === 'domain' ? item.target : '';
        const lookupResult = host ? (resolvedByHost.get(host) || { ips: [], failed: true }) : null;
        const allIps = lookupResult ? unique(lookupResult.ips) : [];
        const usableIps = allIps.filter(ip => !isUnusableAddress(ip));
        if (host && allIps.length && !usableIps.length) continue; // 解析出来全是环回 / 未指定 / 组播
        const resolvedPrivate = usableIps.filter(ip => isPrivateAddress(ip));
        const targetAddress = item.kind === 'cidr' ? item.target.split('/')[0] : '';
        if (preset === 'restricted') {
            if (item.kind === 'domain' && !resolvedPrivate.length) continue;
            if (item.kind === 'cidr' && !(isPrivateAddress(targetAddress) && !isUnusableAddress(targetAddress))) continue;
        }

        const metadata = item.risk === 'metadata'
            || (targetAddress && isMetadataAddress(targetAddress))
            || usableIps.some(ip => isMetadataAddress(ip));
        const wide = item.target.startsWith('*.')
            || (item.kind === 'cidr' && isWideCidr(item.target))
            || (item.kind === 'host' && !item.ports);
        const privateRisk = (targetAddress && isPrivateAddress(targetAddress)) || resolvedPrivate.length > 0;
        const risk = metadata ? 'metadata' : wide ? 'wide' : privateRisk ? 'private' : '';

        candidates.push({
            id: `${item.kind}|${item.target}|${item.ports}`,
            kind: item.kind,
            target: item.target,
            ports: item.ports,
            proto: item.proto,
            sources: item.sources,
            evidence: item.evidence || item.target,
            resolved: item.kind === 'domain' ? resolvedPrivate : [],
            risk,
            defaultChecked: risk !== 'metadata' && risk !== 'wide'
        });
        if (candidates.length >= MAX_CANDIDATES) {
            truncated = true;
            break;
        }
    }

    return { candidates, truncated, preset };
}

module.exports = {
    MAX_INPUT_BYTES,
    MAX_CANDIDATES,
    MAX_RAW_MATCHES,
    extractEndpointTokens,
    inferEndpointCandidates
};
