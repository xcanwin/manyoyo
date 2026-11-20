'use strict';

// 真实容器：新建容器自动填入运行配置、明确改掉、地址识别与自启动放行。
// 运行时不可用或镜像缺失时自动跳过；临时 HOME，只建 qa-preset-* 容器，结束按创建清单删除。
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const { imageVersion } = require('../../package.json');
const { selectContainerRuntime } = require('../../lib/container-runtime');
const state = require('../../lib/container-state');
const { makeSidecarSafeHome } = require('./helpers/sidecar-home');

const IMAGE_NAME = 'ghcr.io/xcanwin/manyoyo';
const IMAGE = `${IMAGE_NAME}:${imageVersion}`;
let runtime = null;
let skipReason = '';
try {
    runtime = selectContainerRuntime();
    const env = { ...process.env, ...runtime.env };
    if (spawnSync(runtime.command, ['info'], { stdio: 'ignore', timeout: 15000, env }).status !== 0) skipReason = `${runtime.command} info 失败`;
    else if (spawnSync(runtime.command, ['image', 'inspect', IMAGE], { stdio: 'ignore', env }).status !== 0) skipReason = `本机没有镜像 ${IMAGE}`;
} catch (e) {
    skipReason = e.message;
}
if (skipReason) console.warn(`[new-container-preset 集成测试已跳过] ${skipReason}`);
const maybe = skipReason ? describe.skip : describe;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function rtSync(args, options = {}) {
    return spawnSync(runtime.command, args, { encoding: 'utf-8', env: { ...process.env, ...runtime.env }, timeout: 60000, ...options });
}

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(err => (err ? reject(err) : resolve(port)));
        });
    });
}

// 3930–3939 留给临时 serve；被占就顺延
async function pickServePort() {
    for (let port = 3930; port <= 3939; port += 1) {
        const free = await new Promise(resolve => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
        });
        if (free) return port;
    }
    return getFreePort();
}

async function startServe({ port, home }) {
    fs.mkdirSync(path.join(home, '.manyoyo'), { recursive: true });
    const env = { ...process.env, HOME: home };
    if (runtime.command === 'podman') {
        const realHome = os.homedir();
        env.XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(realHome, '.local', 'share');
        env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(realHome, '.config');
        if (!env.XDG_RUNTIME_DIR && typeof process.getuid === 'function') env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
    }
    ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'].forEach(key => { delete env[key]; });
    const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'manyoyo.js'), 'serve', `127.0.0.1:${port}`, '-U', 'u', '-P', 'p'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 160; i += 1) {
        try {
            const res = await fetch(`${base}/auth/login`);
            if (res.status) return { child, base, log: () => log };
        } catch (e) { /* 还没起来 */ }
        if (child.exitCode !== null) break;
        await sleep(250);
    }
    child.kill('SIGTERM');
    throw new Error(`serve 没有启动：\n${log.slice(-2000)}`);
}

function createApi(base) {
    let cookie = '';
    async function call(method, urlPath, body) {
        const res = await fetch(base + urlPath, {
            method,
            headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        if (urlPath === '/auth/login') cookie = (res.headers.get('set-cookie') || '').split(';')[0];
        return { status: res.status, json, text };
    }
    return { call, login: () => call('POST', '/auth/login', { username: 'u', password: 'p' }) };
}

async function waitForFile(file, predicate, timeoutMs = 30000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const text = fs.readFileSync(file, 'utf-8');
            if (predicate(text)) return text;
        } catch (e) { /* 还没写 */ }
        await sleep(500);
    }
    return null;
}

maybe('新建容器运行配置与地址识别（真实容器）', () => {
    let home;
    let work;
    let fixture;
    let fixturePort;
    let serve;
    let api;
    const created = [];

    beforeAll(async () => {
        home = makeSidecarSafeHome('manyoyo-preset-home-');
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-preset-work-'));
        fixture = http.createServer((req, res) => res.end('host-ok'));
        await new Promise(resolve => fixture.listen(0, '0.0.0.0', resolve));
        fixturePort = fixture.address().port;
        const autostart = `curl -fsS -m 5 http://host.containers.internal:${fixturePort}/ok -o /run/manyoyo/autostart-result || echo FAILED > /run/manyoyo/autostart-result\n`;
        fs.mkdirSync(path.join(home, '.manyoyo'), { recursive: true });
        fs.writeFileSync(path.join(home, '.manyoyo', 'manyoyo.json'), JSON.stringify({
            runs: {
                qa: {
                    hostPath: work,
                    imageName: IMAGE_NAME,
                    imageVersion,
                    autostart,
                    autostartOnServe: true,
                    first: { shell: `curl -fsS -m 5 http://host.containers.internal:${fixturePort}/ok -o ${work}/first-result` },
                    network: {
                        preset: 'allowlist',
                        outbound: [{ action: 'allow', target: '@host', ports: String(fixturePort), proto: 'tcp', enabled: true }]
                    }
                }
            }
        }, null, 2), { mode: 0o600 });
        const port = await pickServePort();
        serve = await startServe({ port, home });
        api = createApi(serve.base);
        const login = await api.login();
        if (login.status !== 200) throw new Error(`登录失败 ${login.status}`);
    }, 180000);

    afterAll(async () => {
        created.forEach(name => rtSync(['rm', '-f', name]));
        const hash = crypto.createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 8);
        rtSync(['rm', '-f', `manyoyo-egress-${hash}`]);
        if (serve) serve.child.kill('SIGTERM');
        if (fixture) await new Promise(resolve => fixture.close(resolve));
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(work, { recursive: true, force: true });
    }, 120000);

    const idOf = name => state.listStateIds(home).find(id => state.readMeta(home, id).name === name);

    test('配置接口返回运行配置的值；不带覆盖时容器按运行配置创建', async () => {
        const preset = await api.call('GET', '/api/system/new-container-preset?run=qa');
        expect(preset.status).toBe(200);
        expect(preset.json).toEqual(expect.objectContaining({ run: 'qa', autostartOnServe: true }));
        expect(preset.json.autostart).toContain('host.containers.internal');
        expect(preset.json.network).toEqual(expect.objectContaining({
            version: 2,
            preset: 'allowlist',
            outbound: [expect.objectContaining({ action: 'allow', target: '@host', ports: String(fixturePort), proto: 'tcp', enabled: true })]
        }));

        const name = `qa-preset-inherit-${crypto.randomBytes(2).toString('hex')}`;
        created.push(name);
        const res = await api.call('POST', '/api/sessions', {
            run: 'qa',
            createOptions: { containerName: name, hostPath: work, imageName: IMAGE_NAME, imageVersion }
        });
        expect(res.status).toBe(200);
        const id = idOf(name);
        expect(id).toBeTruthy();
        expect(state.readAutostart(home, id)).toContain('host.containers.internal');
        expect(state.readNetworkRaw(home, id)).toEqual(expect.objectContaining({
            preset: 'allowlist',
            autostartOnServe: true,
            outbound: [expect.objectContaining({ target: '@host' })]
        }));

        // 自启动真的访问到了宿主机夹具（网络规则已下发）
        const result = await waitForFile(path.join(state.paths(home, id).box, 'autostart-result'), text => text.includes('host-ok'));
        expect(result).toContain('host-ok');
        // first 命令也访问成功（工作目录可写）
        const first = await waitForFile(path.join(work, 'first-result'), text => text.includes('host-ok'));
        expect(first).toContain('host-ok');
    }, 120000);

    test('地址识别给出 @host 地址；空串 / false / 默认网络能明确改掉运行配置，未放行时自启动被拦', async () => {
        const infer = await api.call('POST', '/api/system/new-container-preset/infer', { run: 'qa' });
        expect(infer.status).toBe(200);
        expect(infer.json.candidates).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'host', target: '@host', ports: String(fixturePort) })
        ]));
        const candidate = infer.json.candidates.find(item => item.target === '@host' && item.ports === String(fixturePort));

        const blocked = `qa-preset-blocked-${crypto.randomBytes(2).toString('hex')}`;
        created.push(blocked);
        const overrideRes = await api.call('POST', '/api/sessions', {
            run: 'qa',
            createOptions: {
                containerName: blocked,
                hostPath: work,
                imageName: IMAGE_NAME,
                imageVersion,
                autostart: `curl -fsS -m 5 http://host.containers.internal:${fixturePort}/ok -o /run/manyoyo/autostart-result || echo FAILED > /run/manyoyo/autostart-result\n`,
                autostartOnServe: false,
                // 与新建容器弹窗一致：用户明确取消了地址勾选，服务端不要再自动放行
                autoAllowScriptEndpoints: false,
                network: { preset: 'restricted', outbound: [], inbound: [], expose: [] }
            }
        });
        expect(overrideRes.status).toBe(200);
        const id = idOf(blocked);
        expect(state.readAutostart(home, id)).toContain('curl');
        expect(state.readNetworkRaw(home, id)).toEqual(expect.objectContaining({ preset: 'restricted', autostartOnServe: false, outbound: [] }));
        const blockedResult = await waitForFile(path.join(state.paths(home, id).box, 'autostart-result'), text => text.includes('FAILED'));
        expect(blockedResult).toContain('FAILED');

        // 把识别到的地址勾选后加入白名单：同样的自启动能访问
        const allowed = `qa-preset-allowed-${crypto.randomBytes(2).toString('hex')}`;
        created.push(allowed);
        const allowedRes = await api.call('POST', '/api/sessions', {
            run: 'qa',
            createOptions: {
                containerName: allowed,
                hostPath: work,
                imageName: IMAGE_NAME,
                imageVersion,
                network: {
                    preset: 'allowlist',
                    outbound: [{ action: 'allow', target: candidate.target, ports: candidate.ports, proto: candidate.proto, enabled: true }]
                }
            }
        });
        expect(allowedRes.status).toBe(200);
        const allowedId = idOf(allowed);
        const allowedResult = await waitForFile(path.join(state.paths(home, allowedId).box, 'autostart-result'), text => text.includes('host-ok'));
        expect(allowedResult).toContain('host-ok');
    }, 180000);
});
