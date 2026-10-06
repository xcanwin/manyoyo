'use strict';

// 真实容器：默认收紧、热更新宿主机端口、容器间、失败即关闭、越界被拒。运行时不可用或镜像缺失时自动跳过。
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { imageVersion } = require('../../package.json');
const { selectContainerRuntime } = require('../../lib/container-runtime');
const { buildContainerRunArgs } = require('../../lib/container-run');
const { buildExecArgs } = require('../../lib/container-exec');
const { createNetworkManager, NETWORK_NAME } = require('../../lib/container-network');
const { normalizePolicy } = require('../../lib/network-policy');
const state = require('../../lib/container-state');
const { createPortForwarder } = require('../../lib/port-forward');

const IMAGE_NAME = 'ghcr.io/xcanwin/manyoyo';
const IMAGE = `${IMAGE_NAME}:${imageVersion}`;
let runtime = null;
let skipReason = '';
try {
    runtime = selectContainerRuntime();
    const env = { ...process.env, ...runtime.env };
    if (spawnSync(runtime.command, ['info'], { stdio: 'ignore', timeout: 15000, env }).status !== 0) skipReason = `${runtime.command} info 失败`;
    else if (spawnSync(runtime.command, ['image', 'inspect', IMAGE], { stdio: 'ignore', env }).status !== 0) skipReason = `本机没有镜像 ${IMAGE}`;
    else if (spawnSync(runtime.command, ['run', '--rm', '--entrypoint', 'nft', IMAGE, '--version'], { stdio: 'ignore', env }).status !== 0) skipReason = '镜像里没有 nft（需要含 nftables 的镜像）';
} catch (e) {
    skipReason = e.message;
}
if (skipReason) console.warn(`[container-network 集成测试已跳过] ${skipReason}`);
const maybe = skipReason ? describe.skip : describe;

function rtSync(args, options = {}) {
    return spawnSync(runtime.command, args, { encoding: 'utf-8', env: { ...process.env, ...runtime.env }, timeout: 60000, ...options });
}

// 被测命令必须异步：夹具 HTTP 服务跑在测试进程里，spawnSync 会把它卡死
function rtAsync(args, timeout = 30000) {
    return new Promise(resolve => {
        const child = spawn(runtime.command, args, { env: { ...process.env, ...runtime.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.stdout.on('data', c => { stdout += c; });
        child.stderr.on('data', c => { stderr += c; });
        child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
}

maybe('container-network（真实容器）', () => {
    let home;
    let work;
    let server;
    let serverPort;
    let manager;
    const names = [];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    beforeAll(async () => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-net-home-'));
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-net-work-'));
        server = http.createServer((req, res) => res.end('host-ok'));
        await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
        serverPort = server.address().port;
        manager = createNetworkManager({ command: runtime.command, env: runtime.env, homeDir: home, imageRef: () => IMAGE });
        await manager.ensureBridgeNetwork();
    });
    afterAll(async () => {
        names.forEach(name => rtSync(['rm', '-f', name]));
        rtSync(['rm', '-f', manager.sidecar.name]);
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(work, { recursive: true, force: true });
    });

    async function create({ policy = {}, autostart = '' } = {}) {
        const name = `cm-net-${crypto.randomBytes(3).toString('hex')}`;
        names.push(name);
        const network = normalizePolicy(policy);
        const st = state.createState({ homeDir: home, autostart, network, netRequired: network.preset !== 'open', meta: { name } });
        const args = buildContainerRunArgs({
            state: st, containerName: name, hostPath: work, containerPath: '/workspace', imageName: IMAGE_NAME, imageVersion,
            defaultNetwork: NETWORK_NAME, defaultCommand: '/bin/bash',
            // 与 buildContainerIntegration 对 docker 的做法一致：让容器里有 host.docker.internal
            containerExtraArgs: path.basename(runtime.command) === 'docker' ? ['--add-host', 'host.docker.internal:host-gateway'] : []
        });
        const r = rtSync(args);
        if (r.status !== 0) throw new Error(r.stderr);
        return { name, st };
    }

    function execArgs(name, command) {
        return buildExecArgs({ homeDir: home, dockerExecArgs: () => '' }, name, { withEnv: false, command: ['/bin/bash', '-c', command] });
    }

    async function exec(name, command, timeout) {
        const built = execArgs(name, command);
        try {
            return await rtAsync(built.args, timeout);
        } finally {
            built.cleanup();
        }
    }

    // 与 manyoyo 的 exec 一致：加载 managed.env 与用户 env
    async function execWithEnv(name, command) {
        const built = buildExecArgs({
            homeDir: home,
            dockerExecArgs: args => rtSync(args).stdout
        }, name, { command: ['/bin/bash', '-c', command] });
        try {
            return await rtAsync(built.args, 40000);
        } finally {
            built.cleanup();
        }
    }

    async function hostIp(name) {
        const out = (await exec(name, "getent hosts host.containers.internal host.docker.internal | head -1 | cut -d' ' -f1")).stdout.trim();
        return out;
    }

    const code = async (name, url) => (await exec(name, `curl --noproxy '*' -s -m 4 -o /dev/null -w '%{http_code}' ${url}; true`)).stdout.trim();

    function setPolicy(st, policy) {
        state.writeNetworkRaw(home, st.id, normalizePolicy(policy));
    }

    test('restricted 默认：公网经上游代理可达；宿主机未放行端口、元数据地址、局域网不通；加/删宿主机端口不重启即生效', async () => {
        const { name, st } = await create();
        const t0 = Date.now();
        await manager.apply(name);
        console.log(`[L3] 下发规则耗时 ${Date.now() - t0} ms`);
        const ip = await hostIp(name);
        expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

        expect(await code(name, `http://${ip}:${serverPort}/`)).toBe('000');
        expect(await code(name, 'http://169.254.169.254/')).toBe('000');
        expect(await code(name, 'http://192.168.1.1/')).toBe('000');

        const hostProbe = spawnSync('curl', ['-s', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/'], { encoding: 'utf-8' });
        if (hostProbe.stdout.trim() === '200') {
            const viaProxy = (await exec(name, "curl -s -m 10 -o /dev/null -w '%{http_code}' https://example.com/; true")).stdout.trim();
            const direct = (await exec(name, "curl --noproxy '*' -s -m 10 -o /dev/null -w '%{http_code}' https://example.com/; true")).stdout.trim();
            // 容器里有代理变量（rootless podman 自动注入）就必须仍然能出网；直连能通就更好
            expect(viaProxy === '200' || direct === '200').toBe(true);
        }

        setPolicy(st, { host: [{ ports: String(serverPort) }] });
        await manager.apply(name);
        expect(await code(name, `http://${ip}:${serverPort}/`)).toBe('200');
        expect(await code(name, 'http://169.254.169.254/')).toBe('000');

        setPolicy(st, {});
        await manager.apply(name);
        expect(await code(name, `http://${ip}:${serverPort}/`)).toBe('000');

        setPolicy(st, { preset: 'open' });
        await manager.apply(name);
        expect(await code(name, `http://${ip}:${serverPort}/`)).toBe('200');
    }, 120000);

    test('容器间：默认 A→B 不通；B 的 peers.inbound 列了 A 后通；B 重启（IP 变化）后重算仍通', async () => {
        const a = await create();
        const b = await create();
        await manager.apply(a.name);
        await manager.apply(b.name);
        const startServer = async () => exec(b.name, 'nohup python3 -m http.server 7000 >/tmp/h.log 2>&1 & sleep 1', 10000);
        await startServer();
        const ipOf = async name => rtSync(['inspect', name, '-f', `{{(index .NetworkSettings.Networks "${NETWORK_NAME}").IPAddress}}`]).stdout.trim();
        expect(await code(a.name, `http://${await ipOf(b.name)}:7000/`)).toBe('000');

        setPolicy(b.st, { peers: { inbound: [{ from: a.st.id, ports: '7000' }] } });
        await manager.apply(b.name);
        await manager.apply(a.name);
        expect(await code(a.name, `http://${await ipOf(b.name)}:7000/`)).toBe('200');

        // 占住地址，让 B 重启后拿到不同的 IP
        const filler = await create({ policy: { preset: 'open' } });
        rtSync(['restart', '-t', '1', b.name]);
        rtSync(['restart', '-t', '1', filler.name]);
        await manager.apply(b.name);
        await startServer();
        for (const related of await manager.relatedContainers(b.name)) await manager.apply(related);
        expect(await code(a.name, `http://${await ipOf(b.name)}:7000/`)).toBe('200');
    }, 120000);

    test('失败即关闭：重启后规则没下发时自启动不执行，下发后 2 秒内执行；helper 镜像坏了下发失败且不放行', async () => {
        const { name, st } = await create({ autostart: 'echo run >> /run/manyoyo/ran.txt\n' });
        const ran = () => (fs.existsSync(path.join(st.box, 'ran.txt')) ? fs.readFileSync(path.join(st.box, 'ran.txt'), 'utf-8').trim().split('\n').length : 0);
        await sleep(2000);
        expect(ran()).toBe(0); // 新建后没下发，init 在等门闩
        expect(fs.readFileSync(st.autostartLog, 'utf-8')).toContain('等待 manyoyo 下发网络规则');
        await manager.apply(name);
        await sleep(1500);
        expect(ran()).toBe(1);

        rtSync(['restart', '-t', '1', name]);
        await sleep(2500);
        expect(ran()).toBe(1); // 重启后规则丢失、门闩清空：不得再执行
        const broken = createNetworkManager({ command: runtime.command, env: runtime.env, homeDir: home, imageRef: () => `${IMAGE_NAME}:0.0.0-missing` });
        await expect(broken.apply(name)).rejects.toThrow(/网络规则下发失败/);
        await sleep(1500);
        expect(ran()).toBe(1);
        expect(state.readNetStatus(home, st.id).status).toBe('error');
        await expect(broken.ensureReady(name)).rejects.toThrow(/网络规则下发失败/);

        await manager.ensureReady(name);
        await sleep(1500);
        expect(ran()).toBe(2);
        expect(state.readNetStatus(home, st.id).status).toBe('applied');
    }, 120000);

    test('serve 订阅 start 事件：外部重启后 2 秒内自动补下发，自启动随之执行，规则仍然生效', async () => {
        const { name, st } = await create({ autostart: 'echo run >> /run/manyoyo/ran.txt\n' });
        const ran = () => (fs.existsSync(path.join(st.box, 'ran.txt')) ? fs.readFileSync(path.join(st.box, 'ran.txt'), 'utf-8').trim().split('\n').length : 0);
        const watcher = manager.watchStarts();
        try {
            // 订阅启动时的对账会给新建的容器下发
            let t0 = Date.now();
            while (ran() < 1 && Date.now() - t0 < 8000) await sleep(200);
            expect(ran()).toBe(1);
            rtSync(['restart', '-t', '1', name]);
            t0 = Date.now();
            while (ran() < 2 && Date.now() - t0 < 8000) await sleep(200);
            console.log(`[L3] 外部重启 → 自启动再次执行耗时 ${Date.now() - t0} ms`);
            expect(ran()).toBe(2);
            expect(await code(name, `http://${await hostIp(name)}:${serverPort}/`)).toBe('000');
        } finally {
            watcher.stop();
        }
    }, 120000);

    test('allowlist + sidecar 过滤代理：白名单域名可达、其他 403、直连被挡、按来源 IP 识别（未知来源 403、不能伪造）、宿主机无监听、记录被拦截、sidecar 被杀失败即关闭并自愈、重启后 IP 不变', async () => {
        const { name, st } = await create({ policy: { preset: 'allowlist', egress: { domains: ['example.com'] } } });
        const sidecarName = manager.sidecar.name;
        const denied = require('../../lib/egress-denied');
        await manager.apply(name);
        const env = (await execWithEnv(name, 'env | grep -i "^https\\?_proxy=" | sort')).stdout;
        const proxyUrl = env.split('\n')[0].split('=')[1];
        expect(proxyUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:3128$/); // 没有账号密码
        const proxyIp = proxyUrl.replace('http://', '').split(':')[0];
        const viaProxy = async (url, extra = '') => (await execWithEnv(name, `curl -s -m 12 -o /dev/null -w '%{http_code}' ${extra} ${url}; true`)).stdout.trim();

        // 宿主机上不再有过滤代理端口（8936 与 sidecar 的 3128 都不在宿主机监听）
        const ss = spawnSync('ss', ['-ltn'], { encoding: 'utf-8' });
        if (ss.status === 0) {
            expect(ss.stdout).not.toMatch(/:8936\s/);
            expect(ss.stdout).not.toMatch(/:3128\s/);
        }

        const hostProbe = spawnSync('curl', ['-s', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/'], { encoding: 'utf-8' });
        const online = hostProbe.stdout.trim() === '200';
        if (online) expect(await viaProxy('https://example.com/')).toBe('200');
        expect(await viaProxy('http://other.example.net/')).toBe('403');
        expect(await viaProxy('https://www.baidu.com/')).not.toBe('200');
        expect(await code(name, 'https://example.com/')).toBe('000'); // --noproxy 直连被防火墙挡
        expect(await code(name, `http://${await hostIp(name)}:${serverPort}/`)).toBe('000');
        // 借代理打宿主机 loopback（SSRF）
        expect((await execWithEnv(name, `env -u NO_PROXY -u no_proxy curl -s -m 8 -o /dev/null -w '%{http_code}' http://127.0.0.1:${serverPort}/; true`)).stdout.trim()).toBe('403');

        // 被拦截记录：访问过的被拒域名出现在列表里，计数正确
        await viaProxy('http://other.example.net/');
        await sleep(1500);
        const list = denied.read(manager.sidecar.paths().denied, st.id);
        const hit = list.find(r => r.host === 'other.example.net' && r.port === 80);
        expect(hit && hit.count).toBe(2);

        // 来源识别：不在映射里的容器（open 预设）连 sidecar → 403
        const other = await create({ policy: { preset: 'open' } });
        await manager.apply(other.name);
        expect((await exec(other.name, `env -u NO_PROXY -u no_proxy -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY curl -s -m 8 -o /dev/null -w '%{http_code}' -x http://${proxyIp}:3128 http://example.com/; true`)).stdout.trim()).toBe('403');

        // 来源伪造：容器里没有 NET_RAW，也绑不到别人的地址
        const spoof = (await exec(name, `python3 - <<'EOF'
import socket
try:
    socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW); print('raw-ok')
except Exception as e: print('raw-denied')
s = socket.socket()
try:
    s.bind(('10.89.0.99', 0)); print('bind-ok')
except Exception as e: print('bind-denied')
EOF`)).stdout;
        expect(spoof).toContain('raw-denied');
        expect(spoof).toContain('bind-denied');
        const ruleset = await rtAsync(['run', '--rm', '--pull=never', '--network', `container:${name}`, '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--user', 'root', '--entrypoint', 'nft', IMAGE, 'list', 'ruleset']);
        expect(ruleset.stdout).toMatch(new RegExp(`ip daddr ${proxyIp.replace(/\./g, '\\.')} ip saddr != \\S+ drop`));

        // sidecar 被杀：容器出网失败（不放开）；ensureReady 自愈后恢复，IP 不变
        rtSync(['kill', sidecarName]);
        expect(await viaProxy('http://other.example.net/')).toBe('000');
        await manager.ensureReady(name);
        expect(await viaProxy('http://other.example.net/')).toBe('403');
        rtSync(['rm', '-f', sidecarName]);
        expect(await viaProxy('http://other.example.net/')).toBe('000');
        await manager.ensureReady(name);
        expect(await viaProxy('http://other.example.net/')).toBe('403');
        // sidecar 重启：固定 IP 不变，映射与规则仍然有效
        rtSync(['restart', '-t', '1', sidecarName]);
        await sleep(1500);
        const ipOf = () => rtSync(['inspect', '-f', `{{(index .NetworkSettings.Networks "${NETWORK_NAME}").IPAddress}}`, sidecarName]).stdout.trim();
        expect(ipOf()).toBe(proxyIp);
        expect(await viaProxy('http://other.example.net/')).toBe('403');

        // 一键放行：加入白名单并下发后 2 秒内可访问
        if (online) {
            expect(await viaProxy('http://example.org/')).toBe('403');
            setPolicy(st, { preset: 'allowlist', egress: { domains: ['example.com', 'example.org'] } });
            const t0 = Date.now();
            await manager.apply(name);
            await sleep(700);
            expect(await viaProxy('http://example.org/')).toMatch(/^(200|30\d)$/);
            console.log(`[L3] 放行 → 可访问耗时 ${Date.now() - t0} ms`);
        }

        // 切回 restricted：代理地址不再注入，clients 里不再有它
        setPolicy(st, {});
        await manager.apply(name);
        expect((await execWithEnv(name, 'env | grep -c "^HTTPS_PROXY=http://' + proxyIp + '" || true')).stdout.trim()).toBe('0');
    }, 240000);

    test('allowlist 下容器内 Chrome 直接用环境变量里的代理：白名单站点能打开，被拒站点报网络错误，浏览器配置不被改动', async () => {
        const hostProbe = spawnSync('curl', ['-s', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/'], { encoding: 'utf-8' });
        if (hostProbe.stdout.trim() !== '200') {
            console.warn('[跳过] 宿主机访问不了 example.com');
            return;
        }
        const { name } = await create({ policy: { preset: 'allowlist', egress: { domains: ['example.com'] } } });
        await manager.apply(name);
        const sum = async () => (await execWithEnv(name, 'md5sum /run/manyoyo-playwright/config.json')).stdout.trim();
        const before = await sum();
        const open = async url => {
            const r = await execWithEnv(name, `playwright-cli open ${url} 2>&1; playwright-cli snapshot 2>&1; playwright-cli close >/dev/null 2>&1; true`);
            return r.stdout;
        };
        const good = await open('https://example.com/');
        expect(good).toContain('Example Domain');
        const bad = await open('https://example.net/');
        expect(bad).toMatch(/ERR_|net::|Error/);
        expect(bad).not.toContain('Example Domain');
        expect(await sum()).toBe(before);
    }, 240000);

    test('端口暴露：运行中加 127.0.0.1:P→8080 立即可访问；删除后被拒；端口被占时明确报错；容器停止后连接断开而不是崩', async () => {
        const { name, st } = await create({ policy: { preset: 'open' } });
        await manager.apply(name);
        await exec(name, 'nohup python3 -m http.server 8080 --bind 0.0.0.0 >/tmp/h.log 2>&1 & sleep 1', 10000);
        const forwarder = createPortForwarder({ command: runtime.command, env: runtime.env, homeDir: home, resolveName: id => (id === st.id ? name : null) });
        const hostPort = 18700 + Math.floor(Math.random() * 200);
        const fetchCode = async port => new Promise(resolve => {
            http.get({ host: '127.0.0.1', port, path: '/' }, res => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve(0));
        });
        try {
            expect(await fetchCode(hostPort)).toBe(0);
            await forwarder.open({ id: st.id, bind: '127.0.0.1', hostPort, port: 8080 });
            const times = [];
            let okCount = 0;
            for (let i = 0; i < 20; i += 1) {
                const t0 = Date.now();
                if (await fetchCode(hostPort) === 200) okCount += 1;
                times.push(Date.now() - t0);
            }
            times.sort((a, b) => a - b);
            console.log(`[L3] 端口转发 20 次：成功 ${okCount}，中位延迟 ${times[10]} ms`);
            expect(okCount).toBe(20);

            // 端口被占
            const blocker = net.createServer();
            await new Promise(resolve => blocker.listen(hostPort + 300, '127.0.0.1', resolve));
            await expect(forwarder.open({ id: st.id, bind: '127.0.0.1', hostPort: hostPort + 300, port: 8080 })).rejects.toThrow(/已被占用/);
            await new Promise(resolve => blocker.close(resolve));

            forwarder.close(st.id, '127.0.0.1', hostPort);
            expect(await fetchCode(hostPort)).toBe(0);

            await forwarder.open({ id: st.id, bind: '127.0.0.1', hostPort, port: 8080 });
            rtSync(['stop', '-t', '1', name]);
            expect(await fetchCode(hostPort)).toBe(0); // 容器停了：连接被断开，serve 不崩
        } finally {
            forwarder.closeAll();
        }
    }, 120000);

    test('别的 manyoyo 实例（另一个 HOME）的容器：不碰它的网络', async () => {
        const { name } = await create();
        const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-net-other-'));
        try {
            const foreign = createNetworkManager({ command: runtime.command, env: runtime.env, homeDir: otherHome, imageRef: () => IMAGE });
            expect(await foreign.apply(name)).toEqual(expect.objectContaining({ status: 'foreign' }));
            expect(await foreign.ensureReady(name)).toEqual({ status: 'foreign' });
            // 没有被下发过规则：宿主机端口依然可达
            const ip = await hostIp(name);
            expect(await code(name, `http://${ip}:${serverPort}/`)).toBe('200');
        } finally {
            fs.rmSync(otherHome, { recursive: true, force: true });
        }
    }, 60000);

    test('越界被拒：容器内改不了自己的规则、写不了 sys；看不到别的容器的状态目录', async () => {
        const { name } = await create();
        await manager.apply(name);
        const flush = await exec(name, 'nft flush ruleset');
        expect(flush.status).not.toBe(0);
        const ip = await hostIp(name);
        expect(await code(name, `http://${ip}:${serverPort}/`)).toBe('000');
        expect((await exec(name, 'touch /run/manyoyo-sys/x')).status).not.toBe(0);
        const ls = await exec(name, 'ls /run/manyoyo /run/manyoyo-sys; ls /root/.manyoyo 2>&1 | head -1');
        expect(ls.stdout).not.toContain('network.json');
        expect(ls.stdout).not.toContain('net-status.json');
        expect((await exec(name, 'unshare -n true')).status).not.toBe(0);
    }, 60000);
});
