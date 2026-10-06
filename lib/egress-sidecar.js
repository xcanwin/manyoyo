'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { writeConfigFileSecure } = require('./secure-file');

// 域名白名单的强制执行点：manyoyo 网络里的一个专用小容器（sidecar），里面用镜像自带的 node 跑 egress-proxy。
// - 容器按“来源 IP”识别：宿主机在每次下发规则时把「容器 IP → 容器 id + 策略」写进 clients.json（只读挂入），
//   认不出的来源一律 403；宿主机上不监听任何端口，同机其他用户无法占用或冒充。
// - 固定 IP（--ip）：重启后不变，容器的代理地址与 nft 规则才能稳定。
// - sidecar 只读挂入程序文件和数据目录，只有拒绝记录目录可写；丢掉全部能力。
const SIDECAR_PORT = 3128;
const APP_FILES = ['egress-sidecar-main.js', 'egress-proxy.js', 'egress-denied.js', 'network-policy.js', 'container-id.js'];
const READY_TIMEOUT_MS = 15000;

function egressDir(homeDir) {
    return path.join(homeDir, '.manyoyo', 'egress');
}

function egressPaths(homeDir) {
    const dir = egressDir(homeDir);
    return { dir, app: path.join(dir, 'app'), data: path.join(dir, 'data'), denied: path.join(dir, 'denied') };
}

function homeHash(homeDir) {
    return crypto.createHash('sha256').update(path.resolve(homeDir)).digest('hex').slice(0, 8);
}

function sidecarName(homeDir) {
    return `manyoyo-egress-${homeHash(homeDir)}`;
}

// 任何 HOME 的过滤代理 sidecar 名字：容器列表（网页 / ls）里要排除，它不是用户的会话容器
function isSidecarName(name) {
    return /^manyoyo-egress-[0-9a-f]{8}$/.test(String(name || ''));
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700); // 只限制宿主机其他用户；容器里的 root（rootless 下就是宿主机用户，rootful 下是真 root）不受影响
}

function writeAtomic(file, text, mode) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
}

function ipv4ToInt(ip) {
    return ip.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

function intToIpv4(value) {
    return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
}

/**
 * 在 manyoyo 网络网段里选 sidecar 的固定地址：网段内偏移 250（/24 即 .250），不同 HOME 的实例在
 * 250 往下的几个地址里按 HOME 哈希错开；真的撞上了由 `run --ip` 报“地址已占用”，不会随机换。
 */
function chooseSidecarIp(subnet, homeDir) {
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(String(subnet || ''));
    if (!m || !net.isIPv4(m[1])) throw new Error(`无法确定 manyoyo 网络的网段: ${subnet}`);
    const prefix = Number(m[2]);
    if (prefix < 8 || prefix > 29) throw new Error(`manyoyo 网络网段不适合放过滤代理: ${subnet}`);
    const size = 2 ** (32 - prefix);
    const base = (ipv4ToInt(m[1]) & ((0xffffffff << (32 - prefix)) >>> 0)) >>> 0;
    const slot = parseInt(homeHash(homeDir), 16) % 5;
    const offset = size > 256 ? 250 - slot : Math.max(2, size - 6 - slot);
    return intToIpv4((base + offset) >>> 0);
}

// docker：IPAM.Config[].Subnet；podman 4/5：subnets[].subnet；返回第一个 IPv4 网段
function subnetOfNetwork(inspectJson) {
    const parsed = Array.isArray(inspectJson) ? inspectJson[0] : inspectJson;
    const candidates = [];
    ((parsed && parsed.IPAM && parsed.IPAM.Config) || []).forEach(c => candidates.push(c.Subnet));
    ((parsed && (parsed.subnets || parsed.Subnets)) || []).forEach(c => candidates.push(c.subnet || c.Subnet));
    return candidates.find(s => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(String(s || ''))) || '';
}

// 上游代理在宿主机上的地址对 sidecar 容器可能不通：环回地址改写成容器看到的宿主机别名
function containerSideUpstream(upstream, hostAlias) {
    if (!upstream) return '';
    try {
        const url = new URL(upstream);
        if (url.protocol !== 'http:') return '';
        if (/^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(url.hostname)) url.hostname = hostAlias;
        return url.toString().replace(/\/$/, '');
    } catch (e) {
        return '';
    }
}

// 固定 MAC（同 docker 的 02:42:<IP 四字节> 规则）：重启后 MAC 变了，别的容器里缓存的 ARP 要等一分钟才失效，期间出网不通
function macForIp(ip) {
    return `02:42:${ip.split('.').map(part => Number(part).toString(16).padStart(2, '0')).join(':')}`;
}

function appFileContents() {
    return APP_FILES.map(name => [name, fs.readFileSync(path.join(__dirname, name), 'utf-8')]);
}

/**
 * @param {object} options
 * @param {(args: string[], opts?: object) => Promise<string>} options.run 运行时命令（容器运行时 CLI）
 * @param {string} options.command 运行时命令名（docker / podman，用来判断宿主机别名）
 * @param {string} options.homeDir
 * @param {() => string} options.imageRef 当前镜像
 * @param {string} options.networkName manyoyo 网络名
 * @param {() => Promise<void>} options.ensureNetwork
 * @param {() => string} [options.getUpstream] 上游代理（宿主机视角）
 */
function createSidecarManager(options) {
    const { run, homeDir, networkName } = options;
    const getUpstream = options.getUpstream || (() => '');
    const isDocker = /docker/i.test(path.basename(String(options.command || '')));
    const hostAlias = isDocker ? 'host.docker.internal' : 'host.containers.internal';
    const name = sidecarName(homeDir);
    const hash = homeHash(homeDir);
    let inflight = null;
    let lastClients = '';

    async function inspectSidecar() {
        try {
            const out = await run(['inspect', '--format', '{{json .}}', name]);
            const line = out.split('\n').map(l => l.trim()).filter(Boolean)[0];
            return line ? JSON.parse(line) : null;
        } catch (e) {
            if (/no such|not found|no container|does not exist/i.test(String(e.message))) return null;
            throw e;
        }
    }

    function ipOf(info) {
        const networks = (info.NetworkSettings && info.NetworkSettings.Networks) || {};
        return (networks[networkName] && networks[networkName].IPAddress) || '';
    }

    function runningOf(info) {
        return Boolean(info.State && (info.State.Running === true || info.State.Status === 'running'));
    }

    function prepareFiles(upstream) {
        const p = egressPaths(homeDir);
        ensureDir(path.join(homeDir, '.manyoyo'));
        ensureDir(p.dir);
        [p.app, p.data, p.denied].forEach(ensureDir);
        const contents = appFileContents();
        contents.forEach(([file, text]) => {
            const target = path.join(p.app, file);
            if (!fs.existsSync(target) || fs.readFileSync(target, 'utf-8') !== text) writeAtomic(target, text, 0o644);
        });
        const upstreamFile = path.join(p.data, 'upstream.txt');
        if (upstream) writeConfigFileSecure(upstreamFile, `${upstream}\n`);
        else fs.rmSync(upstreamFile, { force: true });
        const rev = crypto.createHash('sha256');
        contents.forEach(([file, text]) => rev.update(`${file}\0${text}\0`));
        return { p, rev: rev.digest('hex').slice(0, 16) };
    }

    // 就绪 = 在 sidecar 里真的连得上代理端口（不能看日志：重启后日志里还留着上一次的“ready”）
    async function waitReady() {
        const deadline = Date.now() + READY_TIMEOUT_MS;
        const probe = `require('net').connect(${SIDECAR_PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))`;
        while (Date.now() < deadline) {
            const info = await inspectSidecar();
            if (!info || !runningOf(info)) break;
            try {
                await run(['exec', name, 'node', '-e', probe], { timeout: 5000 });
                return;
            } catch (e) { /* 还没起来 */ }
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        let tail = '';
        try { tail = await run(['logs', '--tail', '5', name]); } catch (e) { /* 取不到就算了 */ }
        throw new Error(`域名白名单代理没有起来${tail ? `: ${String(tail).trim().split('\n').slice(-2).join(' ')}` : ''}`);
    }

    async function doEnsure() {
        await options.ensureNetwork();
        const subnet = subnetOfNetwork(JSON.parse((await run(['network', 'inspect', networkName, '--format', '{{json .}}'])).trim().split('\n')[0] || 'null'));
        const ip = chooseSidecarIp(subnet, homeDir);
        const upstream = containerSideUpstream(getUpstream(), hostAlias);
        const { p, rev } = prepareFiles(upstream);
        let info = await inspectSidecar();
        const labels = (info && info.Config && info.Config.Labels) || {};
        const matches = info && labels['manyoyo.egress.rev'] === rev && labels['manyoyo.home'] === hash;
        if (matches && runningOf(info) && ipOf(info) === ip) return { name, ip, port: SIDECAR_PORT };
        if (matches && !runningOf(info)) {
            try {
                await run(['start', name]);
                info = await inspectSidecar();
                if (info && runningOf(info) && ipOf(info) === ip) {
                    await waitReady();
                    return { name, ip, port: SIDECAR_PORT };
                }
            } catch (e) { /* 起不来就重建 */ }
        }
        if (info) await run(['rm', '-f', name]);
        const args = [
            'run', '-d', '--name', name,
            '--network', networkName, '--ip', ip, '--mac-address', macForIp(ip),
            // 宿主机上这几个目录属于普通用户且是 0700：rootful 运行时里的 root 不带 DAC_OVERRIDE 就进不去（rootless 下 root 就是该用户，不受影响）
            '--user', 'root', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--security-opt', 'no-new-privileges',
            '--read-only', '--tmpfs', '/tmp', '--pids-limit', '256', '--memory', '256m',
            '--pull=never',
            '--label', 'manyoyo.role=egress', '--label', `manyoyo.home=${hash}`, '--label', `manyoyo.egress.rev=${rev}`,
            '--volume', `${p.app}:/app:ro`, '--volume', `${p.data}:/data:ro`, '--volume', `${p.denied}:/denied`,
            '--env', `EGRESS_PORT=${SIDECAR_PORT}`
        ];
        if (isDocker) args.push('--add-host', 'host.docker.internal:host-gateway');
        args.push('--entrypoint', 'node', options.imageRef(), '/app/egress-sidecar-main.js');
        try {
            await run(args, { timeout: 60000 });
        } catch (e) {
            const message = String(e.message);
            // 另一个进程（CLI / serve）刚好同时建好了它：直接用现成的
            if (/name .*(already in use|is already used)|already in use by container|name is already/i.test(message)) {
                const other = await inspectSidecar();
                if (other && runningOf(other) && ipOf(other) === ip) {
                    await waitReady();
                    return { name, ip, port: SIDECAR_PORT };
                }
            }
            throw new Error(/address already in use|ip.*(used|allocated)|in use/i.test(message) && !/name/i.test(message)
                ? `域名白名单代理需要的地址 ${ip} 已被占用（${networkName} 网络里有别的容器用了它）`
                : `域名白名单代理启动失败: ${message}`);
        }
        await waitReady();
        return { name, ip, port: SIDECAR_PORT };
    }

    /** 保证 sidecar 在运行，返回 {name, ip, port}；多处同时调用合并成一次。 */
    function ensure() {
        if (!inflight) inflight = doEnsure().finally(() => { inflight = null; });
        return inflight;
    }

    /** 只读检查：sidecar 现在是否在运行且地址正确（ensureReady 的快速路径用）。 */
    async function isHealthy() {
        const info = await inspectSidecar();
        return Boolean(info && runningOf(info));
    }

    /** 写入「来源 IP → 容器 id + 策略」；内容没变就不写（避免无谓刷新）。 */
    function writeClients(clients) {
        const p = egressPaths(homeDir);
        ensureDir(p.dir);
        ensureDir(p.data);
        const text = `${JSON.stringify({ clients }, null, 2)}\n`;
        if (text === lastClients && fs.existsSync(path.join(p.data, 'clients.json'))) return;
        writeAtomic(path.join(p.data, 'clients.json'), text, 0o644);
        lastClients = text;
    }

    return { name, ensure, isHealthy, writeClients, paths: () => egressPaths(homeDir), isSidecarName: n => n === name };
}

module.exports = {
    SIDECAR_PORT,
    APP_FILES,
    egressDir,
    egressPaths,
    sidecarName,
    isSidecarName,
    chooseSidecarIp,
    macForIp,
    subnetOfNetwork,
    containerSideUpstream,
    createSidecarManager
};
