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

// 从自启动脚本与 first（命令、env、envFile）里找出“可能需要放行”的地址。
// 只读取和整理文本：不执行命令、不拼接 shell、不读取命令里调用的脚本文件。返回的每条地址只有 host、端口、来源和风险，
// 不包含命令原文、URL 的 path / query、用户名密码、env 值或密钥片段。
// 由 Web 新建容器弹窗调用（CLI 不扫描）；DNS 查询可以替换，方便测试。
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

const HOST_ALIASES = new Set(['host.containers.internal', 'host.docker.internal', 'gateway.docker.internal']);
// 带 scheme 的地址：默认端口与协议。port=0 表示没有默认端口（tcp:// / udp://）。
// 只收明确表示网络服务的 scheme；未知 scheme（file://、vscode:// 等）不参与识别。
const URL_SCHEMES = {
    'http:': { port: 80, proto: 'tcp' },
    'https:': { port: 443, proto: 'tcp' },
    'ws:': { port: 80, proto: 'tcp' },
    'wss:': { port: 443, proto: 'tcp' },
    'ftp:': { port: 21, proto: 'tcp' },
    'ssh:': { port: 22, proto: 'tcp' },
    'sftp:': { port: 22, proto: 'tcp' },
    'git:': { port: 9418, proto: 'tcp' },
    'git+ssh:': { port: 22, proto: 'tcp' },
    'git+https:': { port: 443, proto: 'tcp' },
    'git+http:': { port: 80, proto: 'tcp' },
    'svn:': { port: 3690, proto: 'tcp' },
    'rsync:': { port: 873, proto: 'tcp' },
    'postgres:': { port: 5432, proto: 'tcp' },
    'postgresql:': { port: 5432, proto: 'tcp' },
    'mysql:': { port: 3306, proto: 'tcp' },
    'mariadb:': { port: 3306, proto: 'tcp' },
    'redis:': { port: 6379, proto: 'tcp' },
    'rediss:': { port: 6379, proto: 'tcp' },
    'mongodb:': { port: 27017, proto: 'tcp' },
    'mongodb+srv:': { port: 27017, proto: 'tcp' },
    'amqp:': { port: 5672, proto: 'tcp' },
    'amqps:': { port: 5671, proto: 'tcp' },
    'mqtt:': { port: 1883, proto: 'tcp' },
    'mqtts:': { port: 8883, proto: 'tcp' },
    'kafka:': { port: 9092, proto: 'tcp' },
    'nats:': { port: 4222, proto: 'tcp' },
    'smtp:': { port: 25, proto: 'tcp' },
    'smtps:': { port: 465, proto: 'tcp' },
    'imap:': { port: 143, proto: 'tcp' },
    'imaps:': { port: 993, proto: 'tcp' },
    'pop3:': { port: 110, proto: 'tcp' },
    'pop3s:': { port: 995, proto: 'tcp' },
    'ldap:': { port: 389, proto: 'tcp' },
    'ldaps:': { port: 636, proto: 'tcp' },
    'smb:': { port: 445, proto: 'tcp' },
    'nfs:': { port: 2049, proto: 'tcp' },
    'docker:': { port: 443, proto: 'tcp' },
    'oci:': { port: 443, proto: 'tcp' },
    'tcp:': { port: 0, proto: 'tcp' },
    'udp:': { port: 0, proto: 'udp' }
};
const NETWORK_COMMANDS = [
    'curl', 'wget', 'ping', 'dig', 'nslookup', 'host', 'nc', 'ncat', 'netcat', 'telnet', 'ssh', 'autossh',
    'scp', 'sftp', 'sshfs', 'rsync', 'git', 'docker', 'podman', 'npm', 'npx', 'pip', 'pip3', 'go', 'cargo',
    'mysql', 'mongosh', 'psql', 'redis-cli', 'apt', 'apt-get', 'yum', 'dnf', 'brew', 'gem', 'composer',
    'smbclient'
];
const NETWORK_FLAGS = [
    '--url', '--api-url', '--base-url', '--host', '--hostname', '--registry', '--index-url', '--extra-index-url',
    '--server', '--endpoint'
];
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
// 本机回环、未指定、组播、只在本地网络内使用的地址：不能作为访问目标，不列出来
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

function isLocalHost(host) {
    const value = String(host || '').toLowerCase();
    return value === 'localhost' || value === '::1' || value === '::' || value === '0.0.0.0' || /^127\./.test(value);
}

function parseHostPort(text) {
    const value = String(text || '').trim();
    const match = /^(\[[0-9a-fA-F:]+\]|[^:]+):(\d{1,5})$/.exec(value);
    if (!match) return null;
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: match[1].replace(/^\[|\]$/g, ''), port };
}

// 域名 + udp 在策略里不合法（域名规则只支持 tcp），用 all 表示“放行该地址的 UDP”
function domainProto(kind, proto) {
    return kind === 'domain' && proto === 'udp' ? 'all' : proto;
}

// 统一的 host / IP / 域名转换：宿主机别名一律变成 @host，端口只保留数字
function hostTarget(host, port, proto, source, evidence) {
    const value = String(host || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
    if (!value || isLocalHost(value)) return null;
    const portText = port ? String(port) : '';
    if (HOST_ALIASES.has(value)) {
        return makeToken({
            kind: 'host',
            target: '@host',
            ports: portText,
            proto,
            evidence: evidence || `@host${portText ? `:${portText}` : ''}`,
            source
        });
    }
    if (net.isIP(value)) {
        return makeToken({
            kind: 'cidr',
            target: value,
            ports: portText,
            proto,
            evidence: evidence || `${value}${portText ? `:${portText}` : ''}`,
            source
        });
    }
    try {
        normalizeDomain(value);
    } catch (e) {
        return null;
    }
    return makeToken({
        kind: 'domain',
        target: value,
        ports: portText,
        proto: domainProto('domain', proto),
        evidence: evidence || `${value}${portText ? `:${portText}` : ''}`,
        source
    });
}

function urlToken(text, source) {
    let url;
    try {
        url = new URL(text);
    } catch (e) {
        return null;
    }
    const protocol = url.protocol.toLowerCase();
    const scheme = URL_SCHEMES[protocol];
    if (!scheme) return null;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || isLocalHost(host)) return null;
    const explicitPort = Number(url.port) || 0;
    const port = explicitPort || scheme.port || 0;
    const bracketed = net.isIPv6(host) ? `[${host}]` : host;
    const origin = `${protocol}//${bracketed}${explicitPort ? `:${explicitPort}` : ''}`;
    if (HOST_ALIASES.has(host)) {
        return makeToken({ kind: 'host', target: '@host', ports: port ? String(port) : '', proto: scheme.proto, evidence: `@host${port ? `:${port}` : ''}`, source });
    }
    if (net.isIP(host)) {
        return makeToken({ kind: 'cidr', target: host, ports: port ? String(port) : '', proto: scheme.proto, evidence: origin, source });
    }
    try {
        normalizeDomain(host);
    } catch (e) {
        return null;
    }
    return makeToken({
        kind: 'domain',
        target: host,
        ports: port ? String(port) : '',
        proto: domainProto('domain', scheme.proto),
        evidence: origin,
        source
    });
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

// 一个完整的值（env 的值、命令里的 KEY=value）如果本身就是 URL / 域名 / IP / host:port，就直接当成目标，不再看命令上下文
function valueTokens(value, source) {
    const text = String(value || '').trim().replace(/^["']|["']$/g, '');
    if (!text || /\s/.test(text) || /[$`{}]/.test(text)) return [];
    // 逗号分隔的值列表（GOPROXY=https://a,direct）：逐项解析，只有像地址的项会被保留
    if (text.includes(',')) {
        const out = [];
        for (const part of text.split(',').slice(0, 8)) {
            if (!part.trim()) continue;
            out.push(...valueTokens(part, source));
        }
        return out;
    }
    if (HOST_ALIASES.has(text.toLowerCase())) {
        return [makeToken({ kind: 'host', target: '@host', ports: '', proto: 'all', evidence: '@host', source })];
    }
    const hostPort = parseHostPort(text);
    if (hostPort) {
        const token = hostTarget(hostPort.host, String(hostPort.port), 'tcp', source, `${hostPort.host}:${hostPort.port}`);
        return token ? [token] : [];
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
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

// ---- 命令语法解析：只按空白与 ; | & 切词，去掉成对引号，不做变量展开、不执行任何东西 ----

function splitShellWords(text) {
    const words = [];
    let current = '';
    let started = false;
    let quote = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = '';
            else if (ch === '\\' && quote === '"' && i + 1 < text.length) current += text[++i];
            else current += ch;
        } else if (ch === "'" || ch === '"') {
            quote = ch;
            started = true;
        } else if (/\s/.test(ch)) {
            if (started) {
                words.push(current);
                current = '';
                started = false;
            }
        } else if (ch === ';' || ch === '|' || ch === '&') {
            if (started) {
                words.push(current);
                current = '';
                started = false;
            }
            words.push(ch);
        } else if (ch === '\\' && i + 1 < text.length) {
            current += text[++i];
            started = true;
        } else {
            current += ch;
            started = true;
        }
    }
    if (started) words.push(current);
    return words;
}

function commandSegments(text) {
    const segments = [];
    let current = [];
    for (const token of splitShellWords(text)) {
        if (token === ';' || token === '|' || token === '&') {
            if (current.length) segments.push(current);
            current = [];
        } else {
            current.push(token);
        }
    }
    if (current.length) segments.push(current);
    return segments;
}

const COMMAND_HANDLERS = new Set(['socat', 'ssh', 'autossh', 'scp', 'sftp', 'sshfs', 'rsync', 'mount', 'smbclient', 'docker', 'podman']);

function commandName(word) {
    return String(word || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
}

function findHandler(words) {
    for (let i = 0; i < words.length; i++) {
        const name = commandName(words[i]);
        if (COMMAND_HANDLERS.has(name)) return { name, index: i };
    }
    return null;
}

function parseSshTarget(raw, defaultPort) {
    let text = String(raw || '').trim();
    if (!text) return null;
    const at = text.lastIndexOf('@');
    const hasUser = at >= 0;
    if (hasUser) text = text.slice(at + 1);
    let host = text;
    let port = String(defaultPort || '');
    let explicit = false;
    const hostPort = parseHostPort(text);
    if (hostPort) {
        host = hostPort.host;
        port = String(hostPort.port);
        explicit = true;
    } else {
        host = text.replace(/^\[|\]$/g, '');
    }
    if (!host) return null;
    return { host, port, explicit, hasUser };
}

// 文件传输的远端写法：[user@]host:path（scp / rsync / sshfs / sftp）
function splitRemotePath(raw) {
    let text = String(raw || '').trim();
    if (!text || text.includes('://')) return null;
    const at = text.lastIndexOf('@');
    if (at >= 0) text = text.slice(at + 1);
    let host = '';
    let rest = '';
    if (text.startsWith('[')) {
        const end = text.indexOf(']');
        if (end < 0) return null;
        host = text.slice(0, end + 1);
        rest = text.slice(end + 1);
    } else {
        const colon = text.indexOf(':');
        if (colon <= 0) return null;
        host = text.slice(0, colon);
        rest = text.slice(colon);
    }
    host = host.replace(/^\[|\]$/g, '');
    if (!host) return null;
    return { host, rest };
}

function splitSmbShare(raw) {
    const text = String(raw || '').trim();
    if (!text.startsWith('//')) return null;
    const rest = text.slice(2);
    const slash = rest.indexOf('/');
    const hostPart = slash >= 0 ? rest.slice(0, slash) : rest;
    const hostPort = parseHostPort(hostPart);
    const host = hostPort ? hostPort.host : hostPart;
    if (!host) return null;
    return { host };
}

// 容器镜像引用：只有第一段是主机名（带点或带端口）时才当 registry；nginx:1.27 这类 Docker Hub 名称忽略
function imageRefToken(raw, source) {
    const ref = String(raw || '').trim().replace(/^["']|["']$/g, '');
    if (!ref || /^[-./~$]/.test(ref) || /[=${}]/.test(ref) || ref.includes('://')) return null;
    const slash = ref.indexOf('/');
    if (slash <= 0) return null;
    const first = ref.slice(0, slash);
    if (first.toLowerCase() === 'localhost') return null;
    const hostPort = parseHostPort(first);
    const host = (hostPort ? hostPort.host : first).toLowerCase();
    if (!hostPort && !net.isIP(host) && (!host.includes('.') || !isDomainText(host))) return null;
    const port = hostPort ? String(hostPort.port) : '443';
    return hostTarget(host, port, 'tcp', source, `${host}:${port}`);
}

const SOCAT_CONNECT_TYPES = new Map([
    ['TCP', 'tcp'], ['TCP4', 'tcp'], ['TCP6', 'tcp'],
    ['UDP', 'udp'], ['UDP4', 'udp'], ['UDP6', 'udp'],
    ['UDPLITE', 'udp'], ['UDPLITE4', 'udp'], ['UDPLITE6', 'udp'],
    ['GOPEN', 'udp'], ['UDP-SENDTO', 'udp'],
    ['OPENSSL', 'tcp'], ['OPENSSL-CONNECT', 'tcp'], ['SSL', 'tcp'], ['HTTP', 'tcp'], ['HTTPS', 'tcp']
]);

// socat 地址对：TCP:host:port / TCP4:... / UDP:... / OPENSSL:...；LISTEN / RECVFROM / SOCKS / PROXY 侧不进出站
function socatTokens(args, source) {
    const out = [];
    for (const word of args) {
        const match = /^([A-Za-z][A-Za-z0-9_+-]*):(.+)$/.exec(String(word || ''));
        if (!match) continue;
        const type = match[1].toUpperCase().replace(/_/g, '-');
        const proto = SOCAT_CONNECT_TYPES.get(type);
        if (!proto) continue;
        let rest = match[2];
        const comma = rest.indexOf(',');
        if (comma >= 0) rest = rest.slice(0, comma);
        // OPENSSL:host:port 与 TCP:host:port 一样，取最后一节的数字端口
        const hostPort = parseHostPort(rest);
        if (!hostPort) continue;
        const token = hostTarget(hostPort.host, String(hostPort.port), proto, source, `${hostPort.host}:${hostPort.port}`);
        if (token) out.push(token);
    }
    return out;
}

const SSH_VALUE_FLAGS = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-M', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']);

function sshTokens(args, source) {
    const out = [];
    const jumps = [];
    const positionals = [];
    let port = '';
    for (let i = 0; i < args.length; i++) {
        const word = args[i];
        if (!word) continue;
        if (word === '--') {
            positionals.push(...args.slice(i + 1));
            break;
        }
        if (!word.startsWith('-')) {
            positionals.push(word);
            continue;
        }
        const flag = word.length > 2 ? word.slice(0, 2) : word;
        const attached = word.length > 2 ? word.slice(2) : '';
        if (flag === '-p') {
            const value = attached || args[++i] || '';
            if (/^\d{1,5}$/.test(value)) port = value;
            continue;
        }
        if (flag === '-o') {
            const value = attached || args[++i] || '';
            const portMatch = /^Port=(.+)$/i.exec(value);
            if (portMatch && /^\d{1,5}$/.test(portMatch[1])) port = portMatch[1];
            const jumpMatch = /^ProxyJump=(.+)$/i.exec(value);
            if (jumpMatch) jumps.push(jumpMatch[1]);
            continue;
        }
        if (flag === '-J') {
            const value = attached || args[++i] || '';
            if (value) jumps.push(value);
            continue;
        }
        if (SSH_VALUE_FLAGS.has(flag)) {
            if (!attached) i += 1;
            continue;
        }
    }
    const emit = (raw, forcedPort) => {
        const parsed = parseSshTarget(raw, '22');
        if (!parsed) return;
        const finalPort = forcedPort || parsed.port;
        // 没写 @、没写端口、也不是宿主机别名的普通主机名 / IP：现有字符串扫描已经会产出“不限端口”的候选，避免重复
        const signal = forcedPort || parsed.explicit || parsed.hasUser || HOST_ALIASES.has(parsed.host.toLowerCase());
        if (!signal) return;
        const token = hostTarget(parsed.host, finalPort, 'tcp', source, `${parsed.host}:${finalPort}`);
        if (token) out.push(token);
    };
    for (const raw of jumps) {
        String(raw).split(',').forEach(item => emit(item, ''));
    }
    if (positionals.length) emit(positionals[0], port);
    return out;
}

const SCP_VALUE_FLAGS = new Set(['-i', '-o', '-F', '-S', '-c', '-l', '-J', '-D']);
const SSHFS_VALUE_FLAGS = new Set(['-o', '-F']);

// scp / sftp / sshfs：[user@]host:path；端口 -P（scp/sftp）或 -p（sshfs）
function fileTransferTokens(args, source, config) {
    const out = [];
    const positionals = [];
    let port = '';
    for (let i = 0; i < args.length; i++) {
        const word = args[i];
        if (!word) continue;
        if (word === '--') {
            positionals.push(...args.slice(i + 1));
            break;
        }
        if (!word.startsWith('-')) {
            positionals.push(word);
            continue;
        }
        const flag = word.length > 2 ? word.slice(0, 2) : word;
        const attached = word.length > 2 ? word.slice(2) : '';
        if (flag === config.portFlag) {
            const value = attached || args[++i] || '';
            if (/^\d{1,5}$/.test(value)) port = value;
            continue;
        }
        if (flag === '-o') {
            const value = attached || args[++i] || '';
            const portMatch = /^Port=(.+)$/i.exec(value);
            if (portMatch && /^\d{1,5}$/.test(portMatch[1])) port = portMatch[1];
            continue;
        }
        if (config.valueFlags.has(flag)) {
            if (!attached) i += 1;
        }
    }
    const usePort = port || String(config.defaultPort || 22);
    const emit = raw => {
        const remote = splitRemotePath(raw);
        if (remote) {
            const token = hostTarget(remote.host, usePort, 'tcp', source, `${remote.host}:${usePort}`);
            if (token) out.push(token);
            return;
        }
        // sftp user@host（没有路径）
        if (raw.includes('@')) {
            const parsed = parseSshTarget(raw, usePort);
            if (parsed && parsed.hasUser) {
                const token = hostTarget(parsed.host, usePort, 'tcp', source, `${parsed.host}:${usePort}`);
                if (token) out.push(token);
            }
        }
    };
    positionals.forEach(emit);
    return out;
}

const RSYNC_VALUE_FLAGS = new Set([
    '-e', '-f', '--rsh', '--filter', '--exclude', '--include', '--exclude-from', '--include-from', '--files-from',
    '--password-file', '--bwlimit', '--timeout', '--contimeout', '--sockopts', '--address', '--config', '--log-file',
    '--log-file-format', '--partial-dir', '--compare-dest', '--copy-dest', '--link-dest', '--backup-dir', '--temp-dir',
    '--chmod', '--chown', '--usermap', '--groupmap', '--max-size', '--min-size', '--max-delete', '--out-format',
    '--log-format', '--rsync-path', '--remote-option'
]);

// rsync：[user@]host:path（SSH，默认 22）/ host::module（daemon，默认 873）/ rsync://host/module 交给 URL 解析
function rsyncTokens(args, source) {
    const out = [];
    const positionals = [];
    let port = '';
    let rsh = '';
    for (let i = 0; i < args.length; i++) {
        const word = args[i];
        if (!word) continue;
        if (word === '--') {
            positionals.push(...args.slice(i + 1));
            break;
        }
        if (word === '--port' || word.startsWith('--port=')) {
            const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : (args[++i] || '');
            if (/^\d{1,5}$/.test(value)) port = value;
            continue;
        }
        if (word === '-e' || word === '--rsh') {
            rsh = args[++i] || '';
            continue;
        }
        if (word.startsWith('--rsh=')) {
            rsh = word.slice(6);
            continue;
        }
        if (word.startsWith('-e') && word.length > 2) {
            rsh = word.slice(2);
            continue;
        }
        if (word.startsWith('-')) {
            if (RSYNC_VALUE_FLAGS.has(word)) i += 1;
            continue;
        }
        positionals.push(word);
    }
    if (!port) {
        const match = /(?:^|\s)-p\s+(\d{1,5})(?:\s|$)/.exec(rsh);
        if (match) port = match[1];
    }
    for (const raw of positionals) {
        const remote = splitRemotePath(raw);
        if (!remote) continue;
        const daemon = remote.rest.startsWith('::');
        const usePort = port || (daemon ? '873' : '22');
        const token = hostTarget(remote.host, usePort, 'tcp', source, `${remote.host}:${usePort}`);
        if (token) out.push(token);
    }
    return out;
}

function mountTokens(args, source) {
    const out = [];
    const positionals = [];
    let type = '';
    for (let i = 0; i < args.length; i++) {
        const word = args[i];
        if (!word) continue;
        if (word === '-t' || word === '--types') {
            type = String(args[++i] || '').toLowerCase();
            continue;
        }
        if (word.startsWith('--types=')) {
            type = word.slice(8).toLowerCase();
            continue;
        }
        if (word === '-o' || word === '--options' || word === '-O') {
            i += 1;
            continue;
        }
        if (word.startsWith('-')) continue;
        positionals.push(word);
    }
    const src = positionals[0] || '';
    if (!src) return out;
    if (src.startsWith('//')) {
        const share = splitSmbShare(src);
        const token = share && hostTarget(share.host, '445', 'tcp', source, `${share.host}:445`);
        return token ? [token] : [];
    }
    if (type && !type.startsWith('nfs') && type !== 'autofs') return out;
    const remote = splitRemotePath(src);
    if (!remote || !remote.rest.startsWith(':')) return out;
    const token = hostTarget(remote.host, '2049', 'tcp', source, `${remote.host}:2049`);
    return token ? [token] : [];
}

const SMB_VALUE_FLAGS = new Set(['-U', '-p', '-W', '-I', '-L', '-m', '-A', '-s', '-T', '-D', '-c', '-b', '-e', '-O', '-R', '-n']);

function smbclientTokens(args, source) {
    const out = [];
    const positionals = [];
    for (let i = 0; i < args.length; i++) {
        const word = args[i];
        if (!word) continue;
        if (!word.startsWith('-')) {
            positionals.push(word);
            continue;
        }
        if (SMB_VALUE_FLAGS.has(word)) i += 1;
    }
    for (const raw of positionals) {
        const share = splitSmbShare(raw);
        if (!share) continue;
        const token = hostTarget(share.host, '445', 'tcp', source, `${share.host}:445`);
        if (token) out.push(token);
    }
    return out;
}

const DOCKER_GLOBAL_VALUE_FLAGS = new Set(['-H', '--host', '--context', '--config', '--log-level', '--tlscacert', '--tlscert', '--tlskey']);

function dockerTokens(args, source) {
    const out = [];
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
        i += DOCKER_GLOBAL_VALUE_FLAGS.has(args[i]) ? 2 : 1;
    }
    const sub = String(args[i] || '').toLowerCase();
    if (sub === 'login' || sub === 'logout') {
        // 没写端口的登录地址由现有的裸域名扫描覆盖，这里只补 host:port（端口后跟 / 的镜像名也会在下面处理）
        for (let j = i + 1; j < args.length; j++) {
            const word = args[j];
            if (word.startsWith('-')) {
                if (['-u', '--username', '-p', '--password'].includes(word)) j += 1;
                continue;
            }
            const hostPort = parseHostPort(word);
            if (hostPort) {
                const token = hostTarget(hostPort.host, String(hostPort.port), 'tcp', source, `${hostPort.host}:${hostPort.port}`);
                if (token) out.push(token);
            }
            break;
        }
        return out;
    }
    for (let j = i + 1; j < args.length; j++) {
        const token = imageRefToken(args[j], source);
        if (token) out.push(token);
    }
    return out;
}

function commandHandlerTokens(segment, handler, source) {
    const args = segment.slice(handler.index + 1);
    if (handler.name === 'socat') return socatTokens(args, source);
    if (handler.name === 'ssh' || handler.name === 'autossh') return sshTokens(args, source);
    if (handler.name === 'scp' || handler.name === 'sftp') {
        return fileTransferTokens(args, source, { portFlag: '-P', valueFlags: SCP_VALUE_FLAGS, defaultPort: 22 });
    }
    if (handler.name === 'sshfs') {
        return fileTransferTokens(args, source, { portFlag: '-p', valueFlags: SSHFS_VALUE_FLAGS, defaultPort: 22 });
    }
    if (handler.name === 'rsync') return rsyncTokens(args, source);
    if (handler.name === 'mount') return mountTokens(args, source);
    if (handler.name === 'smbclient') return smbclientTokens(args, source);
    if (handler.name === 'docker' || handler.name === 'podman') return dockerTokens(args, source);
    return [];
}

// --host / --hostname 与同一条命令里的 --port 配对；值里已经写了端口的保持不变
function withPortFlag(tokens, line) {
    const match = /(?:^|\s)--port(?:=|\s+)(\d{1,5})(?=$|[\s;])/.exec(line);
    if (!match) return tokens;
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return tokens;
    return tokens.map(token => {
        if (token.ports) return token;
        const target = token.kind === 'host' ? '@host' : token.target;
        return { ...token, ports: String(port), proto: 'tcp', evidence: `${target}:${port}` };
    });
}

// --registry 不带 scheme / 端口时按 HTTPS 443 补上
function withDefaultPort(tokens, port) {
    return tokens.map(token => {
        if (token.ports) return token;
        const target = token.kind === 'host' ? '@host' : token.target;
        return { ...token, ports: String(port), proto: 'tcp', evidence: `${target}:${port}` };
    });
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
        // 代理设置不是访问目标：先去掉，避免把代理地址也建议加入白名单
        let scanned = line.replace(/(?:^|[\s;])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=([^\s;]*)/g, (all, key) => (PROXY_KEYS.has(key) ? ' ' : all));

        // 带 scheme 的网址（只认 URL_SCHEMES 里的协议；未知 scheme 在 urlToken 里被忽略）
        const urlRe = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>|;]+/gi;
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

        // git@host:path（ssh://git@host:2222/repo 交给 URL 解析，避免误报成 22）
        const gitSshRe = /\bgit@([A-Za-z0-9.-]+):[^\s"'`<>|;]+/g;
        while ((match = gitSshRe.exec(scanned))) {
            if (scanned.slice(Math.max(0, match.index - 3), match.index) === '://') continue;
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

        // host:port（网址里的写法前面是 /，不会重复匹配）
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

        // 不带 scheme 的 IPv6 / CIDR（按空格等分隔后逐个检查，避免复杂正则）
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

        // 不带 scheme 的域名：只有同一行出现网络命令 / 网络参数，或以 www. / api. 开头时才当成目标
        const networkContext = COMMAND_RE.test(scanned) || FLAG_RE.test(scanned);
        const bareTokens = scanned.split(/[\s;|&"'`()]+/);
        for (let ti = 0; ti < bareTokens.length; ti++) {
            let tokenText = bareTokens[ti].replace(/[,.;]+$/, '');
            if (!tokenText || /[*@=$`{}]/.test(tokenText)) continue;
            if (/[一-鿿]/.test(tokenText)) continue;
            const lower = tokenText.toLowerCase();
            // 宿主机别名不是普通域名；能带上端口（nc host 11434 / psql -h host -p 5432）就带上
            if (networkContext && HOST_ALIASES.has(lower)) {
                const next = String(bareTokens[ti + 1] || '').replace(/[,.;]+$/, '');
                let port = /^\d{1,5}$/.test(next) && Number(next) >= 1 && Number(next) <= 65535 ? next : '';
                if (!port) {
                    const upper = /(?:^|\s)(?:--port(?:=|\s+)|-P\s+)(\d{1,5})(?=$|[\s;])/.exec(scanned);
                    if (upper) port = upper[1];
                }
                // -p 在 mysql 里是密码，只在明确用它表示端口的客户端上解析
                if (!port && /\b(?:psql|redis-cli|ssh|autossh|sshfs)\b/i.test(scanned)) {
                    const lowerFlag = /(?:^|\s)-p\s+(\d{1,5})(?=$|[\s;])/.exec(scanned);
                    if (lowerFlag) port = lowerFlag[1];
                }
                if (port) {
                    const token = hostTarget(lower, port, 'tcp', source);
                    if (token && !addAll(out, [token])) return out;
                }
                continue;
            }
            const eq = tokenText.indexOf('=');
            if (eq >= 0) {
                if (PROXY_KEYS.has(tokenText.slice(0, eq))) continue;
                tokenText = tokenText.slice(eq + 1);
                if (!tokenText) continue;
                if (!addAll(out, valueTokens(tokenText, source))) return out;
                continue;
            }
            if (tokenText.includes('/') || tokenText.includes(':')) continue;
            const prefixed = lower.startsWith('www.') || lower.startsWith('api.');
            if ((!networkContext && !prefixed) || !isDomainText(lower)) continue;
            if (!addAll(out, [makeToken({ kind: 'domain', target: lower, ports: '', proto: 'all', evidence: lower, source })])) return out;
        }

        // 命令语法解析：socat 地址对、SSH / scp / rsync、挂载、镜像仓库等
        for (const segment of commandSegments(scanned)) {
            const handler = findHandler(segment);
            if (!handler) continue;
            if (!addAll(out, commandHandlerTokens(segment, handler, source))) return out;
        }

        // Dockerfile 的 FROM（自启动里直接写文件也很常见）
        const fromRe = /(?:^|[\s"'`])FROM\s+((?:--\S+\s+)*)([^\s"'`]+)/gi;
        while ((match = fromRe.exec(scanned))) {
            const token = imageRefToken(match[2], source);
            if (token && !addAll(out, [token])) return out;
        }

        // --flag=值：--host=db --registry=registry:5000
        const assignFlagRe = /(?:^|\s)(--[A-Za-z0-9-]+)=([^\s;]+)/g;
        while ((match = assignFlagRe.exec(scanned))) {
            const flag = match[1].toLowerCase();
            if (!NETWORK_FLAGS.includes(flag)) continue;
            let tokens = valueTokens(match[2], source);
            if (flag === '--host' || flag === '--hostname') tokens = withPortFlag(tokens, scanned);
            if (flag === '--registry') tokens = withDefaultPort(tokens, 443);
            if (!addAll(out, tokens)) return out;
        }

        // --flag 值：--host db --registry registry:5000；普通域名交给上面的裸域名扫描，避免重复
        const spaceFlagRe = /(?:^|\s)(--[A-Za-z0-9-]+)\s+([^\s;]+)/g;
        while ((match = spaceFlagRe.exec(scanned))) {
            const flag = match[1].toLowerCase();
            if (!NETWORK_FLAGS.includes(flag)) continue;
            let tokens = valueTokens(match[2], source)
                .filter(token => token.kind !== 'domain' || token.ports);
            if (flag === '--host' || flag === '--hostname') tokens = withPortFlag(tokens, scanned);
            if (flag === '--registry') tokens = withDefaultPort(tokens, 443);
            if (!addAll(out, tokens)) return out;
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

    // 去重：同类型、同目标、同端口只留一条；来源按扫描顺序合并
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

    // DNS：只查询域名，去重后最多 50 个，每个最多 2 秒、同时查 8 个、总共 5 秒；失败只是拿不到解析地址
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

/**
 * 创建容器时，为“没有勾选界面”的入口（快捷对话、CLI run、克隆）自动放行默认勾选的地址。
 * 只处理默认勾选的项（云元数据、范围过大的网段不自动加）；custom 模式或解析失败都不改策略，失败也不影响创建。
 * @param {object} policy 已校验的 v2 策略（可以已经过 withEnvEndpoints）
 * @param {object} options { autostart, firstCommand, firstEnvLines, lookup }
 */
async function withScriptEndpoints(policy, options = {}) {
    if (!policy || typeof policy !== 'object' || policy.preset === 'custom') return policy;
    const autostart = String(options.autostart || '');
    const firstCommand = String(options.firstCommand || '');
    const firstEnvLines = Array.isArray(options.firstEnvLines) ? options.firstEnvLines : [];
    if (!autostart.trim() && !firstCommand.trim() && !firstEnvLines.length) return policy;
    let result;
    try {
        result = await inferEndpointCandidates({
            autostart,
            firstCommand,
            firstEnvLines,
            preset: policy.preset,
            lookup: options.lookup
        });
    } catch (e) {
        return policy;
    }
    const candidates = (result.candidates || []).filter(candidate => candidate.defaultChecked === true);
    if (!candidates.length) return policy;
    const key = rule => `${rule.action}|${rule.target}|${rule.ports}|${rule.proto}`;
    const have = new Set((policy.outbound || []).filter(rule => rule.action === 'allow').map(key));
    const added = [];
    const push = (target, ports, proto) => {
        const rule = { action: 'allow', target, ports, proto, enabled: true };
        const id = key(rule);
        if (have.has(id)) return;
        have.add(id);
        added.push(rule);
    };
    for (const candidate of candidates) {
        if (candidate.kind === 'domain') {
            push(candidate.target, candidate.ports, candidate.proto);
            (candidate.resolved || []).forEach(ip => push(ip, candidate.ports, candidate.proto));
        } else {
            push(candidate.target, candidate.ports, candidate.proto);
        }
    }
    if (!added.length) return policy;
    try {
        const { normalizePolicy } = require('./network-policy');
        return normalizePolicy({ ...policy, outbound: [...added, ...(policy.outbound || [])] });
    } catch (e) {
        return policy;
    }
}

module.exports = {
    withScriptEndpoints,
    MAX_INPUT_BYTES,
    MAX_CANDIDATES,
    MAX_RAW_MATCHES,
    extractEndpointTokens,
    inferEndpointCandidates
};
