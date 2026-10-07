'use strict';

// 真实容器：统一规则表（出站 / 入站）与运行时注入的宿主机代理。运行时不可用或镜像缺失时自动跳过。
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { imageVersion } = require('../../package.json');
const { selectContainerRuntime } = require('../../lib/container-runtime');
const { buildContainerRunArgs } = require('../../lib/container-run');
const { buildExecArgs } = require('../../lib/container-exec');
const { createNetworkManager, NETWORK_NAME } = require('../../lib/container-network');
const { normalizePolicy, isUnrestricted } = require('../../lib/network-policy');
const state = require('../../lib/container-state');

const IMAGE_NAME = 'ghcr.io/xcanwin/manyoyo';
const IMAGE = `${IMAGE_NAME}:${imageVersion}`;
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
const allow = (target, extra = {}) => ({ action: 'allow', target, ports: '', proto: 'all', ...extra });
const deny = (target, extra = {}) => ({ action: 'deny', target, ports: '', proto: 'all', ...extra });
const OPEN = { preset: 'custom', outbound: [allow('@any')], inbound: [{ action: 'allow', source: '@any', ports: '', proto: 'all' }] };

let runtime = null;
let skipReason = '';
try {
    runtime = selectContainerRuntime();
    const env = { ...process.env, ...runtime.env };
    if (spawnSync(runtime.command, ['info'], { stdio: 'ignore', timeout: 15000, env }).status !== 0) skipReason = `${runtime.command} info 失败`;
    else if (spawnSync(runtime.command, ['image', 'inspect', IMAGE], { stdio: 'ignore', env }).status !== 0) skipReason = `本机没有镜像 ${IMAGE}`;
    else if (spawnSync(runtime.command, ['run', '--rm', '--entrypoint', 'nft', IMAGE, '--version'], { stdio: 'ignore', env }).status !== 0) skipReason = '镜像里没有 nft';
} catch (e) {
    skipReason = e.message;
}
if (skipReason) console.warn(`[container-network-rules 集成测试已跳过] ${skipReason}`);
const maybe = skipReason ? describe.skip : describe;

// 运行时命令的环境：去掉开发机自带的代理变量，由用例显式注入
function cleanEnv(extra = {}) {
    const env = { ...process.env, ...runtime.env };
    PROXY_KEYS.forEach(key => delete env[key]);
    return { ...env, ...extra };
}

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

maybe('统一网络规则（真实容器）', () => {
    let home;
    let work;
    let hostServer;
    let hostPort;
    let proxyFixture;
    let proxyPort;
    let proxyHits = 0;
    let manager;
    const names = [];
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const alias = path.basename(runtime ? runtime.command : '') === 'docker' ? 'host.docker.internal' : 'host.containers.internal';
    const online = () => spawnSync('curl', ['--noproxy', '*', '-s', '-m', '8', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/'], { encoding: 'utf-8' }).stdout.trim() === '200';

    beforeAll(async () => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rules-home-'));
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rules-work-'));
        hostServer = http.createServer((req, res) => res.end('host-ok'));
        await new Promise(resolve => hostServer.listen(0, '0.0.0.0', resolve));
        hostPort = hostServer.address().port;
        // 宿主机上的 HTTP 代理夹具（只认绝对 URI 的 HTTP 请求），带命中计数
        proxyFixture = http.createServer((req, res) => { proxyHits += 1; res.end('via-proxy'); });
        await new Promise(resolve => proxyFixture.listen(0, '0.0.0.0', resolve));
        proxyPort = proxyFixture.address().port;
        // 运行时（rootless podman 的 containers.conf / docker 的 config.json 同理）把宿主机代理注入它起的所有容器，包括过滤代理自己；
        // 进程自己的上游设成空：过滤代理只能靠注入的代理出网（P2）
        const proxyEnv = Object.fromEntries(PROXY_KEYS.map(key => [key, `http://${alias}:${proxyPort}`]));
        manager = createNetworkManager({ command: runtime.command, env: cleanEnv(proxyEnv), homeDir: home, imageRef: () => IMAGE, getUpstream: () => '' });
        await manager.ensureBridgeNetwork();
    });
    afterAll(async () => {
        names.forEach(name => rtSync(['rm', '-f', name]));
        rtSync(['rm', '-f', manager.sidecar.name]);
        await new Promise(resolve => hostServer.close(resolve));
        await new Promise(resolve => proxyFixture.close(resolve));
        [home, work].forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
    });

    async function create({ policy = {}, runEnv = {}, homeDir = home } = {}) {
        const name = `cm-rules-${crypto.randomBytes(3).toString('hex')}`;
        names.push(name);
        const network = normalizePolicy(policy);
        const st = state.createState({ homeDir, network, netRequired: !isUnrestricted(network), meta: { name } });
        const args = buildContainerRunArgs({
            state: st, containerName: name, hostPath: work, containerPath: '/workspace', imageName: IMAGE_NAME, imageVersion,
            defaultNetwork: NETWORK_NAME, defaultCommand: '/bin/bash',
            containerExtraArgs: path.basename(runtime.command) === 'docker' ? ['--add-host', 'host.docker.internal:host-gateway'] : []
        });
        const r = rtSync(args, { env: cleanEnv(runEnv) });
        if (r.status !== 0) throw new Error(r.stderr);
        return { name, st, homeDir };
    }

    async function exec(name, command, { withEnv = false, homeDir = home, timeout = 30000 } = {}) {
        const built = buildExecArgs({ homeDir, dockerExecArgs: args => rtSync(args).stdout }, name, { withEnv, command: ['/bin/bash', '-c', command] });
        try {
            return await rtAsync(built.args, timeout);
        } finally {
            built.cleanup();
        }
    }

    const hostIp = async name => (await exec(name, "getent hosts host.containers.internal host.docker.internal | head -1 | cut -d' ' -f1")).stdout.trim();
    const ipOf = name => rtSync(['inspect', name, '-f', `{{(index .NetworkSettings.Networks "${NETWORK_NAME}").IPAddress}}`]).stdout.trim();
    const code = async (name, url, extra = '') => (await exec(name, `curl --noproxy '*' -s -m 5 -o /dev/null -w '%{http_code}' ${extra} ${url}; true`)).stdout.trim();
    // 与 manyoyo 的 exec 一致：加载 managed.env（过滤代理地址）
    const viaProxy = async (c, url) => (await exec(c.name, `curl -s -m 12 -o /dev/null -w '%{http_code}' ${url}; true`, { withEnv: true, homeDir: c.homeDir })).stdout.trim();
    const setPolicy = (c, policy) => state.writeNetworkRaw(c.homeDir || home, c.st.id, normalizePolicy(policy));
    const listen = async (c, port) => exec(c.name, `nohup python3 -m http.server ${port} >/tmp/h${port}.log 2>&1 & sleep 1`, { timeout: 10000 });

    test('P1：运行时把宿主机代理（host.*.internal）注入容器后，收紧模式下仍能经代理出网', async () => {
        const c = await create({ runEnv: { http_proxy: `http://${alias}:${proxyPort}`, https_proxy: `http://${alias}:${proxyPort}` } });
        await manager.apply(c.name);
        const before = proxyHits;
        const status = (await exec(c.name, "curl -s -m 8 -o /dev/null -w '%{http_code}' http://p1.invalid/; true")).stdout.trim();
        expect(status).toBe('200');
        expect(proxyHits).toBe(before + 1);
        // 宿主机上的其他端口仍然不通
        expect(await code(c.name, `http://${await hostIp(c.name)}:${hostPort}/`)).toBe('000');
    }, 120000);

    test('P2：过滤代理的上游取自运行时注入 sidecar 的代理（serve / CLI 进程自己没有上游）', async () => {
        const c = await create({ policy: { outbound: [allow('p2.example.test')] } });
        await manager.apply(c.name);
        const before = proxyHits;
        expect(await viaProxy(c, 'http://p2.example.test/')).toBe('200');
        expect(proxyHits).toBe(before + 1);
        // 没有规则命中的域名走默认放行公网：同样经上游
        expect(await viaProxy(c, 'http://p2-other.example.test/')).toBe('200');
        expect(proxyHits).toBe(before + 2);
    }, 180000);

    test('收紧矩阵：公网通；宿主机端口、其他容器、元数据地址不通（拒绝而不是超时）', async () => {
        const a = await create();
        const b = await create();
        await manager.apply(a.name);
        await manager.apply(b.name);
        await listen(b, 7000);
        const t0 = Date.now();
        expect(await code(a.name, `http://${await hostIp(a.name)}:${hostPort}/`)).toBe('000');
        expect(await code(a.name, `http://${ipOf(b.name)}:7000/`)).toBe('000');
        expect(await code(a.name, 'http://169.254.169.254/')).toBe('000');
        expect(Date.now() - t0).toBeLessThan(10000); // 三次都是被 reject 立即失败，不是各等 5 秒超时
        if (online()) expect(await code(a.name, 'https://example.com/')).toBe('200');
    }, 120000);

    test('例外、暂停与顺序：允许 @host 端口 → 暂停 → 拒绝排在上面 → 下移后通；允许某容器 IP', async () => {
        const a = await create();
        const b = await create({ policy: OPEN }); // B 不设限，只测 A 的出站规则
        await manager.apply(a.name);
        await manager.apply(b.name);
        await listen(b, 7000);
        const hostUrl = `http://${await hostIp(a.name)}:${hostPort}/`;
        const hostRule = allow('@host', { ports: String(hostPort), proto: 'tcp' });
        const apply = async policy => { setPolicy(a, policy); await manager.apply(a.name); };

        await apply({ outbound: [hostRule] });
        expect(await code(a.name, hostUrl)).toBe('200');
        await apply({ outbound: [{ ...hostRule, enabled: false }] });
        expect(await code(a.name, hostUrl)).toBe('000');
        await apply({ outbound: [deny('@host', { ports: String(hostPort), proto: 'tcp' }), hostRule] });
        expect(await code(a.name, hostUrl)).toBe('000');
        await apply({ outbound: [hostRule, deny('@host', { ports: String(hostPort), proto: 'tcp' })] });
        expect(await code(a.name, hostUrl)).toBe('200');

        await apply({ outbound: [allow(ipOf(b.name), { ports: '7000', proto: 'tcp' })] });
        expect(await code(a.name, `http://${ipOf(b.name)}:7000/`)).toBe('200');
        expect(await code(a.name, `http://${ipOf(b.name)}:7001/`)).toBe('000');
    }, 180000);

    test('域名规则（收紧）：拒绝行经过滤代理 403 并出现在被拦截列表，其他域名照常；直连被挡之外的端口不受影响', async () => {
        const c = await create({ policy: { outbound: [deny('example.com')] } });
        await manager.apply(c.name);
        const env = (await exec(c.name, 'env | grep -i "^https\\?_proxy=" | sort', { withEnv: true })).stdout;
        expect(env).toMatch(/^https?_proxy=http:\/\/\d+\.\d+\.\d+\.\d+:3128$/im);
        expect(await viaProxy(c, 'http://example.com/')).toBe('403');
        if (online()) expect(await viaProxy(c, 'http://example.org/')).toMatch(/^(200|30\d)$/);
        await sleep(1500);
        const list = require('../../lib/egress-denied').read(manager.sidecar.paths().denied, c.st.id);
        expect(list.some(r => r.host === 'example.com')).toBe(true);
    }, 120000);

    test('域名规则（仅白名单）：精确域名放行、其余 403；通配域名在内网解析时被拒（单测覆盖解析注入，这里验证默认行）', async () => {
        const c = await create({ policy: { preset: 'allowlist', outbound: [allow('example.com'), allow('*.nip.example.test')] } });
        await manager.apply(c.name);
        expect(await viaProxy(c, 'http://other.example.net/')).toBe('403');
        expect(await code(c.name, 'https://example.com/')).toBe('000');
    }, 120000);

    test('自定义（只有允许 @any）：不建规则表，宿主机端口可达', async () => {
        const c = await create({ policy: OPEN });
        await manager.apply(c.name);
        const ruleset = await rtAsync(['run', '--rm', '--pull=never', '--network', `container:${c.name}`, '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--user', 'root', '--entrypoint', 'nft', IMAGE, 'list', 'ruleset']);
        expect(ruleset.stdout).not.toContain('manyoyo');
        expect(await code(c.name, `http://${await hostIp(c.name)}:${hostPort}/`)).toBe('200');
    }, 60000);

    test('入站：A 允许 @container:B 的 7000；B→A:7000 通、:7001 不通、C→A 不通；A 重启（IP 变化）后仍正确', async () => {
        const a = await create();
        const b = await create();
        const c = await create();
        for (const x of [a, b, c]) await manager.apply(x.name);
        await listen(a, 7000);
        await listen(a, 7001);
        setPolicy(a, { inbound: [{ action: 'allow', source: `@container:${b.st.id}`, ports: '7000', proto: 'tcp' }] });
        await manager.apply(a.name);
        for (const related of await manager.relatedContainers(a.name)) await manager.apply(related);
        const aIp = () => ipOf(a.name);
        expect(await code(b.name, `http://${aIp()}:7000/`)).toBe('200'); // B 的出站里自动有派生行
        expect(await code(b.name, `http://${aIp()}:7001/`)).toBe('000');
        expect(await code(c.name, `http://${aIp()}:7000/`)).toBe('000');

        const filler = await create({ policy: OPEN });
        rtSync(['restart', '-t', '1', a.name]);
        rtSync(['restart', '-t', '1', filler.name]);
        await manager.apply(a.name);
        await listen(a, 7000);
        for (const related of await manager.relatedContainers(a.name)) await manager.apply(related);
        expect(await code(b.name, `http://${aIp()}:7000/`)).toBe('200');
        expect(await code(c.name, `http://${aIp()}:7000/`)).toBe('000');
    }, 240000);

    test('破坏性：策略文件写坏时按默认收紧下发（不会放开），修好后恢复；sidecar 被删后自愈', async () => {
        const c = await create({ policy: { outbound: [deny('example.com')] } });
        await manager.apply(c.name);
        const file = state.paths(home, c.st.id).network;
        const good = fs.readFileSync(file, 'utf-8');
        fs.writeFileSync(file, '{not json');
        // 读不出来当作没有策略：按默认收紧下发（只会更严，不会放开）
        expect((await manager.apply(c.name)).status).toBe('applied');
        expect(manager.loadPolicy(c.st.id)).toEqual(normalizePolicy({}));
        expect(await code(c.name, `http://${await hostIp(c.name)}:${hostPort}/`)).toBe('000');
        fs.writeFileSync(file, good);
        await manager.ensureReady(c.name);
        expect(await viaProxy(c, 'http://example.com/')).toBe('403');
        rtSync(['rm', '-f', manager.sidecar.name]);
        expect(await viaProxy(c, 'http://example.com/')).toBe('000');
        await manager.ensureReady(c.name);
        expect(await viaProxy(c, 'http://example.com/')).toBe('403');
    }, 180000);

    test('防伪造：走过滤代理的收紧容器没有 NET_RAW、绑不到别人的地址，nft 里有发往代理的 antiSpoof 规则', async () => {
        const c = await create({ policy: { outbound: [deny('example.com')] } });
        await manager.apply(c.name);
        const spoof = (await exec(c.name, `python3 - <<'PY'
import socket
try:
    socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW); print('raw-ok')
except Exception as e: print('raw-denied')
s = socket.socket()
try:
    s.bind(('10.89.0.99', 0)); print('bind-ok')
except Exception as e: print('bind-denied')
PY`)).stdout;
        expect(spoof).toContain('raw-denied');
        expect(spoof).toContain('bind-denied');
        const ruleset = await rtAsync(['run', '--rm', '--pull=never', '--network', `container:${c.name}`, '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--user', 'root', '--entrypoint', 'nft', IMAGE, 'list', 'ruleset']);
        expect(ruleset.stdout).toMatch(/ip daddr \S+ ip saddr != \S+ drop/);
    }, 60000);
});
