'use strict';

const { spawn } = require('child_process');
const dns = require('dns').promises;
const JSON5 = require('json5');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const state = require('./container-state');
const { buildExecArgs } = require('./container-exec');
const policyLib = require('./network-policy');
const { createSidecarManager } = require('./egress-sidecar');

// 容器网络：把策略翻译成 nft 规则，用一次性 helper 容器（--network container:<名> + NET_ADMIN）写进
// 目标容器自己的 netns。Agent 没有 NET_ADMIN，改不掉；规则热更新，不重启。
// 容器重启后 netns 重建、规则丢失 → 每次启动后重新下发，/run/manyoyo-gate/ready 门闩（tmpfs，重启即清）
// 标记“本次启动已下发”，没有门闩时 init 不跑自启动脚本、manyoyo 也不往里 exec（失败即关闭）。

const NETWORK_NAME = 'manyoyo';
const GATE_READY = '/run/manyoyo-gate/ready';
const PROXY_ENV_KEYS = new Set(['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']);
const HOST_NAMES = ['host.containers.internal', 'host.docker.internal'];

function envMapOf(info) {
    const map = {};
    ((info.Config && info.Config.Env) || []).forEach(line => {
        const i = String(line).indexOf('=');
        if (i > 0) map[line.slice(0, i)] = line.slice(i + 1);
    });
    return map;
}

function labelsOf(info) {
    return (info.Config && info.Config.Labels) || {};
}

function ipv4ToInt(ip) {
    return ip.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

function intToIpv4(value) {
    return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
}

function subnetOf(ip, prefixLen) {
    if (!net.isIPv4(ip) || !Number.isInteger(prefixLen) || prefixLen < 8 || prefixLen > 30) return '';
    const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
    return `${intToIpv4((ipv4ToInt(ip) & mask) >>> 0)}/${prefixLen}`;
}

/** 容器当前所在 bridge 的 IP / 网关 / 网段；slirp4netns 等没有 bridge 时返回 null。 */
function bridgeOf(info) {
    const networks = (info.NetworkSettings && info.NetworkSettings.Networks) || {};
    const pick = networks[NETWORK_NAME] || Object.values(networks).find(n => n && n.IPAddress);
    if (!pick || !pick.IPAddress) return null;
    const subnet = subnetOf(pick.IPAddress, Number(pick.IPPrefixLen));
    if (!subnet || !pick.Gateway) {
        throw new Error('无法确定容器网络的网段，不下发规则');
    }
    return { ip: pick.IPAddress, gateway: pick.Gateway, subnet };
}

function parseHostsAndResolv(text) {
    const hostIps = [];
    const dnsServers = [];
    String(text || '').split('\n').forEach(raw => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;
        const parts = line.split(/\s+/);
        if (parts[0] === 'nameserver' && net.isIP(parts[1])) {
            if (!/^127\./.test(parts[1]) && parts[1] !== '::1') dnsServers.push(parts[1]);
        } else if (net.isIP(parts[0]) && parts.slice(1).some(name => HOST_NAMES.includes(name))) {
            if (!hostIps.includes(parts[0])) hostIps.push(parts[0]);
        }
    });
    return { hostIps, dnsServers };
}

async function resolveHostToIps(host) {
    if (net.isIP(host)) return [host];
    try {
        const records = await dns.lookup(host, { all: true });
        return records.map(r => r.address);
    } catch (e) {
        return [];
    }
}

function parseUrlHostPort(value) {
    try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
        const defaultPort = { 'http:': 80, 'https:': 443, 'socks5:': 1080, 'socks5h:': 1080 }[url.protocol] || 80;
        return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || defaultPort };
    } catch (e) {
        return null;
    }
}

function uniqueBy(items, keyFn) {
    const seen = new Set();
    return items.filter(item => {
        const key = keyFn(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function createNetworkManager(options) {
    const homeDir = options.homeDir || os.homedir();
    const command = options.command;
    const runtimeEnv = options.env ? { ...process.env, ...options.env } : process.env;
    const getImageRef = typeof options.imageRef === 'function' ? options.imageRef : () => options.imageRef;
    const getMirrorUrls = options.getMirrorUrls || (() => []);
    const getUpstream = options.getUpstream || (() => process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '');
    const warn = options.warn || (() => {});
    const locks = new Map();

    function run(args, { input, timeout = 30000 } = {}) {
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn(command, args, { env: runtimeEnv, stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (e) {
                reject(e);
                return;
            }
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
            child.on('error', error => { clearTimeout(timer); reject(error); });
            child.on('close', code => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve(stdout);
                } else {
                    const error = new Error((stderr || stdout || `exit ${code}`).trim().split('\n').slice(-3).join(' '));
                    error.status = code;
                    reject(error);
                }
            });
            child.stdin.on('error', () => {});
            child.stdin.end(input || '');
        });
    }

    // 域名白名单的过滤代理：manyoyo 网络里的 sidecar 容器，按来源 IP 认容器（见 egress-sidecar.js）
    const sidecar = createSidecarManager({ run, command, homeDir, imageRef: getImageRef, networkName: NETWORK_NAME, ensureNetwork: ensureBridgeNetwork, getUpstream });

    // buildExecArgs 只需要同步 inspect 取 id；这里 withEnv:false 不会用到
    const execCtx = { homeDir, dockerExecArgs: () => '' };

    async function execInContainer(name, cmd) {
        const built = buildExecArgs(execCtx, name, { withEnv: false, command: cmd });
        try {
            return await run(built.args, { timeout: 15000 });
        } finally {
            built.cleanup();
        }
    }

    async function inspectMany(refs) {
        if (!refs.length) return [];
        const out = await run(['inspect', '--format', '{{json .}}', ...refs]);
        return out.split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
    }

    async function listManaged() {
        const ids = (await run(['ps', '-a', '-q', '--no-trunc', '--filter', 'label=manyoyo.id'])).split('\n').map(s => s.trim()).filter(Boolean);
        const infos = await inspectMany(ids);
        return infos.map(info => ({
            info,
            id: labelsOf(info)['manyoyo.id'],
            name: String(info.Name || '').replace(/^\//, ''),
            running: Boolean(info.State && (info.State.Running === true || info.State.Status === 'running'))
        })).filter(item => state.isValidId(item.id));
    }

    function loadPolicy(id) {
        const raw = state.readNetworkRaw(homeDir, id);
        return policyLib.normalizePolicy(raw || undefined);
    }

    async function ensureBridgeNetwork() {
        try {
            await run(['network', 'inspect', NETWORK_NAME]);
        } catch (e) {
            await run(['network', 'create', NETWORK_NAME]);
        }
    }

    // Playwright 浏览器服务在宿主机上的端口：切模式（up headed / vnc / chrome）时容器不重建，
    // 所以不能只看当前 config.json——配置里的端口（默认 8935）一律放行，当前 config.json 里出现的也放行
    function playwrightHostPorts() {
        const ports = new Set([8935]);
        try {
            const text = fs.readFileSync(path.join(homeDir, '.manyoyo', 'plugin', 'playwright', 'current', 'config.json'), 'utf-8');
            const re = /(?:host\.containers\.internal|host\.docker\.internal):(\d{2,5})/g;
            let m;
            while ((m = re.exec(text))) ports.add(Number(m[1]));
        } catch (e) { /* 没有就只用默认 */ }
        try {
            const config = JSON5.parse(fs.readFileSync(path.join(homeDir, '.manyoyo', 'manyoyo.json'), 'utf-8'));
            const port = Number(config && config.plugins && config.plugins.playwright && config.plugins.playwright.port);
            if (Number.isInteger(port)) ports.add(port);
        } catch (e) { /* 没有配置文件 */ }
        return [...ports].filter(p => p >= 1 && p <= 65535);
    }

    // 容器里的 /etc/hosts、/etc/resolv.conf 是容器可写的，不能拿来生成防火墙规则（容器写一个 `nameserver <公网 IP>`
    // 就能给自己放行一条隧道）。改为在同一个网络里起一个一次性的全新容器读取运行时生成的值：
    // 复制创建时的 --network / --dns / --add-host（都是创建者给定的，不是容器内进程能改的）。
    async function readRuntimeNetworkFacts(info) {
        const args = ['run', '--rm', '--pull=never', '--user', 'root', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];
        const bridge = safeBridge(info);
        if (bridge) {
            const networks = (info.NetworkSettings && info.NetworkSettings.Networks) || {};
            args.push('--network', networks[NETWORK_NAME] ? NETWORK_NAME : Object.keys(networks).find(key => networks[key] && networks[key].IPAddress));
        }
        const hostConfig = info.HostConfig || {};
        (hostConfig.Dns || []).filter(ip => net.isIP(ip)).forEach(ip => args.push('--dns', ip));
        (hostConfig.ExtraHosts || []).filter(entry => /^[A-Za-z0-9._-]+:(?:host-gateway|[0-9a-fA-F:.]+)$/.test(entry)).forEach(entry => args.push('--add-host', entry));
        args.push('--entrypoint', 'cat', getImageRef(), '/etc/hosts', '/etc/resolv.conf');
        return await run(args, { timeout: 30000 });
    }

    // 下发时现算：容器看到的宿主机 IP / DNS / 代理 / 镜像源 / peer 的当前 IP
    async function resolveEndpoints(self, policy, all) {
        const hostsText = await readRuntimeNetworkFacts(self.info);
        const parsedHosts = parseHostsAndResolv(hostsText);
        const dnsServers = parsedHosts.dnsServers;
        // 没有 host.*.internal（docker 不带 --add-host 时）就用 bridge 的网关：它是宿主机上的 bridge 接口地址
        const gatewayBridge = safeBridge(self.info);
        const hostIps = parsedHosts.hostIps.length ? parsedHosts.hostIps : (gatewayBridge ? [gatewayBridge.gateway] : []);
        const allow = [];
        const addHost = (ports, proto) => hostIps.forEach(ip => allow.push({ ip, ports: String(ports), proto }));

        // 必需端点：上游代理、过滤代理、Playwright、镜像源
        const env = envMapOf(self.info);
        const proxyTargets = [];
        // allowlist 下容器只能经过滤代理出网，上游代理不能直连放行（否则绕过域名白名单）
        if (policy.preset !== 'allowlist') {
            Object.keys(env).filter(key => PROXY_ENV_KEYS.has(key)).forEach(key => {
                const parsed = env[key] && parseUrlHostPort(env[key]);
                if (parsed) proxyTargets.push(parsed);
            });
        }
        getMirrorUrls().forEach(url => {
            const parsed = parseUrlHostPort(url);
            if (parsed) proxyTargets.push(parsed);
        });
        for (const target of uniqueBy(proxyTargets, t => `${t.host}:${t.port}`)) {
            for (const ip of await resolveHostToIps(target.host)) allow.push({ ip, ports: String(target.port), proto: 'tcp' });
        }
        // 过滤代理（sidecar 容器）：allowlist 容器经它出网，只放行到它的 IP:端口；
        // 容器发往它的包来源必须是自己的 IP（第二道保险：识别身份靠的就是来源 IP）
        let managedEnv = [];
        const antiSpoof = [];
        if (policy.preset === 'allowlist' && policy.egress.domains.length) {
            const selfBridge = safeBridge(self.info);
            if (!selfBridge) throw new Error('域名白名单需要容器在 manyoyo 网络里，这个容器的网络不支持');
            const proxy = await sidecar.ensure();
            allow.push({ ip: proxy.ip, ports: String(proxy.port), proto: 'tcp' });
            antiSpoof.push({ daddr: proxy.ip, saddr: selfBridge.ip });
            const url = `http://${proxy.ip}:${proxy.port}`;
            managedEnv = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].map(key => `${key}=${url}`);
        }
        playwrightHostPorts().forEach(port => addHost(port, 'tcp'));
        policy.host.forEach(entry => addHost(entry.ports, entry.proto));

        // 容器间：我的 peers.inbound 里的容器能进来；别人的 inbound 列了我，我才能出去
        const peerIn = [];
        const byId = new Map(all.map(item => [item.id, item]));
        policy.peers.inbound.forEach(entry => {
            const peer = byId.get(entry.from);
            const b = peer && peer.running ? safeBridge(peer.info) : null;
            if (b) peerIn.push({ ip: b.ip, ports: entry.ports, proto: entry.proto });
        });
        for (const other of all) {
            if (other.id === self.id || !other.running || !state.stateExists(homeDir, other.id)) continue;
            let otherPolicy;
            try { otherPolicy = loadPolicy(other.id); } catch (e) { continue; }
            const b = safeBridge(other.info);
            if (!b) continue;
            otherPolicy.peers.inbound.filter(entry => entry.from === self.id).forEach(entry => {
                allow.push({ ip: b.ip, ports: entry.ports, proto: entry.proto });
            });
        }
        return {
            managedEnv,
            antiSpoof,
            dns: dnsServers,
            allow: uniqueBy(allow, a => `${a.ip}|${a.ports}|${a.proto}`),
            peerIn,
            bridge: bridgeOf(self.info) ? { subnet: bridgeOf(self.info).subnet, gateway: bridgeOf(self.info).gateway } : null
        };
    }

    function safeBridge(info) {
        try { return bridgeOf(info); } catch (e) { return null; }
    }

    // 过滤代理的「来源 IP → 容器 id + 策略」：所有运行中、属于本 HOME、策略是 allowlist 的容器
    function syncEgressClients(all) {
        const clients = {};
        for (const item of all) {
            if (!item.running || !state.stateExists(homeDir, item.id)) continue;
            let policy;
            try { policy = loadPolicy(item.id); } catch (e) { continue; }
            if (policy.preset !== 'allowlist') continue;
            const bridge = safeBridge(item.info);
            if (bridge) clients[bridge.ip] = { id: item.id, preset: policy.preset, domains: policy.egress.domains, rules: policy.egress.rules };
        }
        sidecar.writeClients(clients);
    }

    async function sendRuleset(name, text) {
        await run([
            'run', '--rm', '-i',
            '--network', `container:${name}`,
            '--user', 'root',
            '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN',
            '--security-opt', 'no-new-privileges',
            '--entrypoint', 'nft',
            '--pull=never',
            getImageRef(),
            '-f', '-'
        ], { input: text, timeout: 30000 });
    }

    // host / container: / none 网络模式下 helper 会把规则写进宿主机或别的容器的网络命名空间，一律不下发
    function unsupportedNetworkMode(info) {
        const mode = String((info.HostConfig && info.HostConfig.NetworkMode) || '');
        return mode === 'host' || mode === 'none' || mode.startsWith('container:') ? mode : '';
    }

    const policyHashOf = policy => crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);

    async function clearGate(name) {
        try {
            await execInContainer(name, ['/bin/rm', '-f', GATE_READY]);
        } catch (e) { /* 尽力：门闩清不掉也不影响“宿主机侧状态=未下发”的判断 */ }
    }

    async function doApply(name, expectId) {
        const all = await listManaged();
        const self = all.find(item => item.name === name);
        // 刚创建的容器必须能按 id 找到，找不到不能当“旧容器”放过（失败即关闭）
        if (expectId && (!self || self.id !== expectId)) throw new Error(`网络规则下发失败: 找不到容器 ${name}（id ${expectId}）`);
        if (!self) return { status: 'legacy', message: '该容器创建于旧版本，重建后可用' };
        // 状态目录不在本 HOME 下：这个容器属于别的 manyoyo 实例（另一个 HOME / 另一个 serve），不碰它的网络
        if (!state.stateExists(homeDir, self.id)) return { status: 'foreign' };
        if (!self.running) throw new Error(`容器 ${name} 未在运行`);
        const startedAt = String((self.info.State && self.info.State.StartedAt) || '');
        try {
            const policy = loadPolicy(self.id);
            const mode = unsupportedNetworkMode(self.info);
            if (mode) {
                state.setNetRequired(homeDir, self.id, false);
                await execInContainer(name, ['/bin/sh', '-c', `mkdir -p ${path.posix.dirname(GATE_READY)} && : > ${GATE_READY}`]);
                const status = { status: 'unsupported', message: `容器使用 ${mode} 网络，无法下发网络规则`, startedAt, at: new Date().toISOString() };
                state.writeNetStatus(homeDir, self.id, status);
                return { ...status, id: self.id };
            }
            state.setNetRequired(homeDir, self.id, policy.preset !== 'open');
            const endpoints = await resolveEndpoints(self, policy, all);
            state.syncFilesEnv(homeDir, self.id); // 环境变量文件的最新快照（供自启动脚本用）
            state.writeManagedEnv(homeDir, self.id, endpoints.managedEnv);
            syncEgressClients(all); // 先让代理认得这个容器，再放行门闩
            await sendRuleset(name, policyLib.buildNftRuleset(policy, endpoints));
            await execInContainer(name, ['/bin/sh', '-c', `mkdir -p ${path.posix.dirname(GATE_READY)} && : > ${GATE_READY}`]);
            const privileged = Boolean(self.info.HostConfig && self.info.HostConfig.Privileged);
            const status = {
                status: 'applied',
                startedAt,
                policyHash: policyHashOf(policy),
                warning: privileged && policy.preset !== 'open' ? '特权容器（dind / sock 模式）里的进程自带 NET_ADMIN，可以改动这些规则，网络限制没有约束力' : '',
                at: new Date().toISOString()
            };
            state.writeNetStatus(homeDir, self.id, status);
            return { ...status, id: self.id };
        } catch (e) {
            const message = `网络规则下发失败: ${e.message}`;
            try { state.writeNetStatus(homeDir, self.id, { status: 'error', message, startedAt, at: new Date().toISOString() }); } catch (err) { /* 状态目录可能已被删 */ }
            // 旧规则可能还在（比如 open → allowlist 失败）：清掉门闩，让 manyoyo 的 exec 与自启动都按“未下发”处理
            await clearGate(name);
            const error = new Error(message);
            error.cause = e;
            throw error;
        }
    }

    // 同一容器的下发串行化，避免保存策略与 start 事件同时下发时互相覆盖
    function apply(name, { expectId } = {}) {
        const prev = locks.get(name) || Promise.resolve();
        const next = prev.catch(() => {}).then(() => doApply(name, expectId));
        locks.set(name, next);
        next.finally(() => { if (locks.get(name) === next) locks.delete(name); }).catch(() => {});
        return next;
    }

    /**
     * manyoyo 往容器里 exec 之前调用：策略要求网络规则而本次启动还没下发（没有门闩）就现在下发，
     * 下发失败直接抛错，不放行。
     */
    async function ensureReady(name) {
        // inspect 失败（运行时抖动）不能当旧容器放行：直接抛错
        const infos = await inspectMany([name]);
        const info = infos[0];
        const id = info && labelsOf(info)['manyoyo.id'];
        if (!state.isValidId(id)) return { status: 'legacy' };
        if (!state.stateExists(homeDir, id)) return { status: 'foreign' };
        let policy;
        try {
            policy = loadPolicy(id);
        } catch (e) {
            policy = null; // 策略文件损坏：按收紧处理，下发时会报错
        }
        if (policy && policy.preset === 'open') return { status: 'open' };
        // 判断依据在宿主机侧（net-status.json：同一次启动 + 同一份策略 + 下发成功），不依赖容器里的任何文件或命令
        const status = state.readNetStatus(homeDir, id);
        const startedAt = String((info.State && info.State.StartedAt) || '');
        const sameRun = status && status.startedAt === startedAt;
        if (sameRun && status.status === 'unsupported') return { status: 'unsupported' };
        if (policy && sameRun && status.status === 'applied' && status.policyHash === policyHashOf(policy)) {
            // 规则还在，但过滤代理可能意外退了（容器出网此时是失败即关闭）：顺手拉起，失败不拦 exec
            if (policy.preset === 'allowlist' && policy.egress.domains.length) {
                try {
                    if (!await sidecar.isHealthy()) {
                        await sidecar.ensure();
                        syncEgressClients(await listManaged());
                    }
                } catch (e) { warn(`域名白名单代理恢复失败: ${e.message}`); }
            }
            return { status: 'applied' };
        }
        return await apply(name, { expectId: id });
    }

    // 与 `name` 有 peers 关系的其他运行中容器（本容器重启后 IP 变化时要重算它们）
    async function relatedContainers(name) {
        const all = await listManaged();
        const self = all.find(item => item.name === name);
        if (!self) return [];
        const related = [];
        for (const other of all) {
            if (other.id === self.id || !other.running || !state.stateExists(homeDir, other.id)) continue;
            let p;
            let mine;
            try { p = loadPolicy(other.id); mine = loadPolicy(self.id); } catch (e) { continue; }
            if (p.peers.inbound.some(e => e.from === self.id) || mine.peers.inbound.some(e => e.from === other.id)) related.push(other.name);
        }
        return related;
    }

    // 启动 / 重连时把所有运行中的受管容器过一遍门闩：serve 没在时被外部重启的容器，现在补下发
    async function reconcileAll() {
        const all = await listManaged();
        for (const item of all.filter(i => i.running)) {
            try {
                await ensureReady(item.name);
            } catch (e) {
                warn(`容器 ${item.name} 网络规则下发失败: ${e.message}`);
            }
        }
        // 没有容器需要重新下发规则时，过滤代理也要在（运行时重启后它同样是停着的）
        await healSidecar().catch(e => warn(`域名白名单代理恢复失败: ${e.message}`));
    }

    // 订阅容器 start 事件：容器被外部重启（podman restart、machine 重启后手动 start）后 netns 重建、规则丢失，
    // 事件到来就重新下发，并重算与它有 peers 关系的容器（它的 IP 可能变了）。
    async function needsSidecar(all) {
        return all.some(item => {
            if (!state.stateExists(homeDir, item.id)) return false;
            try {
                const policy = loadPolicy(item.id);
                return policy.preset === 'allowlist' && policy.egress.domains.length > 0;
            } catch (e) { return false; }
        });
    }

    // 过滤代理容器自己退出 / 被删：有 allowlist 容器就拉起来，并重写映射
    async function healSidecar() {
        const all = await listManaged();
        if (!await needsSidecar(all)) return;
        await sidecar.ensure();
        syncEgressClients(all);
    }

    function watchStarts(watchOptions = {}) {
        let attempts = 0;
        let outageWarned = false;
        let stopped = false;
        let child = null;
        let delay = 1000;
        let retryTimer = null;
        const timers = new Map();

        // start：重新下发并重算相关容器；die：只重算相关容器（它的 IP 会被回收，别人规则里的旧 IP 要去掉）
        const onEvent = (name, status) => {
            const key = `${status}:${name}`;
            clearTimeout(timers.get(key));
            timers.set(key, setTimeout(async () => {
                timers.delete(key);
                try {
                    if (name === sidecar.name) {
                        await healSidecar();
                        return;
                    }
                    if (status === 'start') await apply(name);
                    if (status === 'die') syncEgressClients(await listManaged()); // 回收的 IP 不能再被认成它
                    for (const related of await relatedContainers(name, { includeStopped: status === 'die' })) {
                        await apply(related).catch(e => warn(`容器 ${related} 网络规则重算失败: ${e.message}`));
                    }
                } catch (e) {
                    warn(`容器 ${name} 网络规则下发失败: ${e.message}`);
                }
            }, 300));
        };

        const parseEvent = line => {
            let event;
            try { event = JSON.parse(line); } catch (e) { return null; }
            const attrs = event.Attributes || (event.Actor && event.Actor.Attributes) || {};
            const name = event.Name || attrs.name;
            const status = event.Status || event.status || event.Action;
            if ((status !== 'start' && status !== 'die') || !name) return null;
            if (name === sidecar.name && attrs['manyoyo.role'] === 'egress') return { name, status };
            if (!state.isValidId(attrs['manyoyo.id'])) return null;
            return { name, status };
        };

        const connect = () => {
            if (stopped) return;
            try {
                child = spawn(command, ['events', '--filter', 'event=start', '--filter', 'event=die', '--filter', 'type=container', '--format', '{{json .}}'], {
                    env: runtimeEnv, stdio: ['ignore', 'pipe', 'ignore']
                });
            } catch (e) {
                retryTimer = setTimeout(connect, delay);
                return;
            }
            let pending = '';
            child.stdout.on('data', chunk => {
                delay = 1000;
                pending += chunk;
                const lines = pending.split('\n');
                pending = lines.pop();
                lines.forEach(line => {
                    const parsed = line.trim() && parseEvent(line);
                    if (parsed) onEvent(parsed.name, parsed.status);
                });
            });
            const again = () => {
                if (stopped) return;
                delay = Math.min(delay * 2, 30000);
                retryTimer = setTimeout(connect, delay);
            };
            child.on('error', again);
            child.on('close', again);
            // 第二次起的连接 = 事件流断过，运行时可能重启过（machine 重启、服务重置）：除了补下发规则，
            // 还要让调用方把该拉起的容器拉起来。运行时还没恢复时对账会失败，每次断线只警告一次
            attempts += 1;
            const reconnected = attempts > 1;
            reconcileAll()
                .then(() => (reconnected && watchOptions.onReconnect ? watchOptions.onReconnect() : null))
                .then(() => { outageWarned = false; })
                .catch(e => {
                    if (!outageWarned) warn(`网络规则对账失败: ${e.message}`);
                    outageWarned = true;
                });
        };
        connect();
        return {
            stop() {
                stopped = true;
                clearTimeout(retryTimer);
                timers.forEach(timer => clearTimeout(timer));
                if (child && !child.killed) child.kill('SIGTERM');
            }
        };
    }

    return { NETWORK_NAME, sidecar, run, listManaged, loadPolicy, ensureBridgeNetwork, apply, ensureReady, relatedContainers, resolveEndpoints, reconcileAll, watchStarts };
}

module.exports = {
    NETWORK_NAME,
    GATE_READY,
    subnetOf,
    bridgeOf,
    parseHostsAndResolv,
    parseUrlHostPort,
    createNetworkManager
};
