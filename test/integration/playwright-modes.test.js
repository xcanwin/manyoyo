'use strict';

// Playwright 四种模式的真实集成测试：容器里的 playwright-cli 经本地夹具页面读回随机暗号。
// 没有运行时或镜像时跳过；headed 没有 DISPLAY 跳过。浏览器并发不超过 3 个，每个用例独立 HOME 与端口。
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { chromium } = require('patchright-core');
const { startFixture } = require('./helpers/fingerprint-fixture');
const env = require('./helpers/playwright-env');
const { PlaywrightPlugin } = require('../../lib/plugin/playwright');

const runtime = env.usableRuntime();
const ready = Boolean(runtime) && env.imageAvailable(runtime);
if (!ready) {
    // eslint-disable-next-line no-console
    console.warn(`[integration] ${runtime ? `镜像 ${env.IMAGE} 不存在` : '没有可用的 podman / docker'}，跳过 Playwright 模式集成测试`);
}
const maybe = ready ? describe : describe.skip;
const maybeHeaded = ready && env.hasDisplay() ? describe : describe.skip;

jest.setTimeout(420000);

function configure(home, port, extra = {}) {
    fs.writeFileSync(path.join(home, '.manyoyo', 'manyoyo.json'), JSON.stringify({
        containerRuntime: runtime,
        plugins: { playwright: { port, vncPort: port + 1, novncPort: port + 2, ...extra } }
    }));
}

function psCount(pattern) {
    const result = spawnSync('sh', ['-c', `ps -eo args | grep -c '[${pattern[0]}]${pattern.slice(1)}'`], { encoding: 'utf8' });
    return Number(result.stdout.trim() || 0);
}

function readState(home) {
    return JSON.parse(fs.readFileSync(path.join(home, '.manyoyo', 'plugin', 'playwright', 'run', 'state.json'), 'utf8'));
}

async function waitFor(check, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        if (await check()) {
            return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    return false;
}

function httpStatus(port, urlPath = '/') {
    return new Promise(resolve => {
        http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
            res.resume();
            resolve(res.statusCode);
        }).on('error', () => resolve(0));
    });
}

maybe('Playwright 模式（容器内默认 + 宿主机 headed）', () => {
    let home;
    let fixture;
    let port;
    const containers = [];

    beforeEach(async () => {
        home = env.makeHome();
        port = await env.freePort();
        configure(home, port);
        fixture = await startFixture();
    });

    afterEach(async () => {
        containers.splice(0).forEach(name => env.removeContainer(runtime, name));
        await env.cli(home, ['playwright', 'down']);
        await fixture.close();
        fs.rmSync(home, { recursive: true, force: true });
    });

    async function newContainer(options) {
        const name = env.randomName('pw-it');
        containers.push(name);
        await env.createContainer(runtime, home, name, options);
        return name;
    }

    const url = () => `http://${env.hostAlias(runtime)}:${fixture.port}/`;

    test('default 可用：容器内 open + snapshot 读到暗号', async () => {
        const name = await newContainer();
        const result = await env.openAndSnapshot(runtime, name, url());
        expect(result.text).toContain(fixture.secret);
    });

    test('代理：容器 env 带不可用的 HTTP_PROXY，仍能连上宿主机上的夹具', async () => {
        const name = await newContainer({ env: ['HTTP_PROXY=http://127.0.0.1:9', 'HTTPS_PROXY=http://127.0.0.1:9'] });
        const result = await env.openAndSnapshot(runtime, name, url());
        expect(result.text).toContain(fixture.secret);
    });

    test('并发：同时创建 3 个容器，配置没写坏，都能用', async () => {
        const names = await Promise.all([newContainer(), newContainer(), newContainer()]);
        const config = path.join(home, '.manyoyo', 'plugin', 'playwright', 'current', 'config.json');
        expect(() => JSON.parse(fs.readFileSync(config, 'utf8'))).not.toThrow();
        const results = await Promise.all(names.map(name => env.openAndSnapshot(runtime, name, url())));
        results.forEach(result => expect(result.text).toContain(fixture.secret));
    });

    test('端口被占：明确报错并给出建议，当前模式不变', async () => {
        const blocker = net.createServer();
        await new Promise(resolve => blocker.listen(port, '0.0.0.0', resolve));
        try {
            const result = await env.cli(home, ['playwright', 'up', 'headed']);
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain(`端口 ${port} 已被占用`);
            expect(result.stderr).toContain('plugins');
        } finally {
            await new Promise(resolve => blocker.close(resolve));
        }
    });

    test('真实 status：端口通但不是浏览器服务时报不可用、退出码非 0', async () => {
        const sockets = [];
        const fake = net.createServer(socket => { sockets.push(socket); socket.end(); });
        await new Promise(resolve => fake.listen(port, '0.0.0.0', resolve));
        try {
            const plugin = new PlaywrightPlugin({ homeDir: home });
            plugin.writeState({ mode: 'headed', port, pid: process.pid });
            const result = await env.cli(home, ['playwright', 'status']);
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('真实探测: 失败');
        } finally {
            sockets.forEach(socket => socket.destroy());
            await new Promise(resolve => fake.close(resolve));
        }
    });

    test('状态文件被删：status / run 都会重建，新容器可用', async () => {
        const name = await newContainer();
        const current = path.join(home, '.manyoyo', 'plugin', 'playwright', 'current');
        fs.rmSync(path.join(current, 'config.json'));
        fs.rmSync(path.join(current, 'stealth.init.js'));
        const status = await env.cli(home, ['playwright', 'status']);
        expect(status.status).toBe(0);
        // 没有重建 current 目录本身，所以已运行的容器也恢复可用
        const result = await env.openAndSnapshot(runtime, name, url());
        expect(result.text).toContain(fixture.secret);

        fs.rmSync(path.join(home, '.manyoyo', 'plugin'), { recursive: true, force: true });
        const second = await newContainer();
        expect((await env.openAndSnapshot(runtime, second, url())).text).toContain(fixture.secret);
    });
});

maybeHeaded('Playwright headed 模式', () => {
    let home;
    let fixture;
    let port;
    const containers = [];

    beforeEach(async () => {
        home = env.makeHome();
        port = await env.freePort();
        configure(home, port);
        fixture = await startFixture();
    });

    afterEach(async () => {
        containers.splice(0).forEach(name => env.removeContainer(runtime, name));
        await env.cli(home, ['playwright', 'down']);
        await fixture.close();
        fs.rmSync(home, { recursive: true, force: true });
    });

    // 浏览器在宿主机上时由它解析地址，用宿主机自己的 loopback；回退到容器内浏览器后要用宿主机别名
    const hostUrl = () => `http://127.0.0.1:${fixture.port}/`;
    const containerUrl = () => `http://${env.hostAlias(runtime)}:${fixture.port}/`;

    async function newContainer(options) {
        const name = env.randomName('pw-it');
        containers.push(name);
        await env.createContainer(runtime, home, name, options);
        return name;
    }

    test('扩展：up headed --ext-path 真的加载了扩展（官方 Chrome 忽略 --load-extension，要靠 CDP 加载）', async () => {
        const extDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'manyoyo-ext-'));
        try {
            fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({
                manifest_version: 3, name: 'manyoyo-it-ext', version: '1.0', background: { service_worker: 'manyoyo-it-sw.js' }
            }));
            fs.writeFileSync(path.join(extDir, 'manyoyo-it-sw.js'), '// noop\n');
            const up = await env.cli(home, ['playwright', 'up', 'headed', '--ext-path', extDir], { timeout: 300000 });
            expect(up.status).toBe(0);
            const token = fs.readFileSync(path.join(home, '.manyoyo', 'plugin', 'playwright', 'run', 'token'), 'utf8').trim();
            const browser = await chromium.connect(`ws://127.0.0.1:${port}/${token}`);
            try {
                const cdp = await browser.newBrowserCDPSession();
                await new Promise(resolve => setTimeout(resolve, 2000));
                const { targetInfos } = await cdp.send('Target.getTargets');
                expect(targetInfos.some(item => item.type === 'service_worker' && item.url.endsWith('/manyoyo-it-sw.js'))).toBe(true);
            } finally {
                await browser.close();
            }
        } finally {
            fs.rmSync(extDir, { recursive: true, force: true });
        }
    });

    test('多容器共用一个宿主机浏览器服务；down 回退、再 up 后无需重建容器', async () => {
        const up = await env.cli(home, ['playwright', 'up', 'headed'], { timeout: 300000 });
        expect(up.status).toBe(0);
        expect(up.stdout).toContain('真实探测通过');
        const [a, b] = [await newContainer(), await newContainer()];
        for (const name of [a, b]) {
            // eslint-disable-next-line no-await-in-loop
            expect((await env.openAndSnapshot(runtime, name, hostUrl())).text).toContain(fixture.secret);
        }
        expect(psCount('playwright-server.js')).toBe(1);

        const down = await env.cli(home, ['playwright', 'down']);
        expect(down.status).toBe(0);
        expect(psCount('playwright-server.js')).toBe(0);
        for (const name of [a, b]) {
            // eslint-disable-next-line no-await-in-loop
            expect((await env.openAndSnapshot(runtime, name, containerUrl())).text).toContain(fixture.secret);
        }

        expect((await env.cli(home, ['playwright', 'up', 'headed'], { timeout: 300000 })).status).toBe(0);
        for (const name of [a, b]) {
            // eslint-disable-next-line no-await-in-loop
            expect((await env.openAndSnapshot(runtime, name, hostUrl())).text).toContain(fixture.secret);
        }
    });

    test('容器用 host.containers.internal 作 Host 头也能握手（playwright 只绑 loopback 时会 403）', async () => {
        expect((await env.cli(home, ['playwright', 'up', 'headed'], { timeout: 300000 })).status).toBe(0);
        const token = fs.readFileSync(path.join(home, '.manyoyo', 'plugin', 'playwright', 'run', 'token'), 'utf8').trim();
        const { WebSocket } = require('ws');
        const status = await new Promise(resolve => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}/${token}`, { headers: { Host: `${env.hostAlias(runtime)}:${port}` } });
            socket.once('open', () => { socket.close(); resolve(101); });
            socket.once('unexpected-response', (req, res) => resolve(res.statusCode));
            socket.once('error', () => resolve(0));
        });
        expect(status).toBe(101);
    });

    test('服务被 kill -9：新建容器正常，提示已回退，容器用本地浏览器', async () => {
        expect((await env.cli(home, ['playwright', 'up', 'headed'], { timeout: 300000 })).status).toBe(0);
        const state = readState(home);
        process.kill(state.pid, 'SIGKILL');
        expect(await waitFor(async () => (await httpStatus(port)) === 0)).toBe(true);
        const integration = await require('../../lib/plugin').buildContainerIntegration({ homeDir: home, runtimeCommand: runtime });
        expect(integration.warning).toContain('已失效');
        const name = await newContainer();
        expect((await env.openAndSnapshot(runtime, name, containerUrl())).text).toContain(fixture.secret);
    });

    test('代理：容器带不可用的 HTTP_PROXY 仍能连上宿主机浏览器', async () => {
        expect((await env.cli(home, ['playwright', 'up', 'headed'], { timeout: 300000 })).status).toBe(0);
        const name = await newContainer({ env: ['HTTP_PROXY=http://127.0.0.1:9', 'HTTPS_PROXY=http://127.0.0.1:9'] });
        expect((await env.openAndSnapshot(runtime, name, hostUrl())).text).toContain(fixture.secret);
    });

    test('chrome（模拟）：中继转发到本机浏览器；它重启（端口变化）后容器不重建也能继续用；无 token 被拒', async () => {
        const userDataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'manyoyo-chrome-'));
        const launch = () => chromium.launchPersistentContext(userDataDir, {
            ...env.simulatedUserChromeOptions(),
            headless: false,
            chromiumSandbox: false,
            args: ['--remote-debugging-port=0']
        });
        let context = await launch();
        try {
            const activePort = path.join(userDataDir, 'DevToolsActivePort');
            configure(home, port, { devtoolsActivePortPath: activePort });
            const up = await env.cli(home, ['playwright', 'up', 'chrome']);
            expect(up.status).toBe(0);
            expect(up.stdout).toContain('风险');
            const name = await newContainer();
            expect((await env.openAndSnapshot(runtime, name, hostUrl())).text).toContain(fixture.secret);

            expect(await httpStatus(port, '/')).toBe(404);
            expect(await httpStatus(port, '/json/version')).toBe(404);

            const firstPort = fs.readFileSync(activePort, 'utf8').split('\n')[0];
            await context.close();
            context = await launch();
            expect(await waitFor(() => fs.existsSync(activePort) && fs.readFileSync(activePort, 'utf8').split('\n')[0] !== firstPort)).toBe(true);
            expect((await env.openAndSnapshot(runtime, name, hostUrl())).text).toContain(fixture.secret);
        } finally {
            await context.close().catch(() => {});
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });
});

maybe('Playwright vnc 模式', () => {
    let home;
    let fixture;
    let port;
    const containers = [];

    beforeEach(async () => {
        home = env.makeHome();
        port = await env.freePort();
        configure(home, port);
        fixture = await startFixture();
    });

    afterEach(async () => {
        containers.splice(0).forEach(name => env.removeContainer(runtime, name));
        await env.cli(home, ['playwright', 'down']);
        await fixture.close();
        fs.rmSync(home, { recursive: true, force: true });
    });

    test('构建并启动；noVNC 返回 200；VNC 必须密码；容器内 Agent 能控制浏览器', async () => {
        const up = await env.cli(home, ['playwright', 'up', 'vnc'], { timeout: 400000 });
        expect(up.status).toBe(0);
        expect(up.stdout).toMatch(/noVNC 观看: http:\/\/127\.0\.0\.1:\d+\/vnc\.html\?.*password=\w{8}/);

        expect(await httpStatus(port + 2, '/vnc.html')).toBe(200);

        const handshake = await new Promise(resolve => {
            const socket = net.createConnection({ host: '127.0.0.1', port: port + 1 });
            const chunks = [];
            socket.on('data', chunk => {
                chunks.push(chunk);
                if (chunks.length === 1) {
                    socket.write('RFB 003.008\n');
                }
                if (chunks.length === 2) {
                    socket.destroy();
                    resolve(Buffer.concat(chunks.slice(1)));
                }
            });
            socket.on('error', () => resolve(Buffer.alloc(0)));
            setTimeout(() => { socket.destroy(); resolve(Buffer.alloc(0)); }, 5000);
        });
        // 安全类型列表：只有 2（VNC 密码认证），不含 1（无认证）
        expect([...handshake.subarray(1)]).toEqual([2]);

        const name = env.randomName('pw-it');
        containers.push(name);
        await env.createContainer(runtime, home, name);
        const result = await env.openAndSnapshot(runtime, name, `http://${env.hostAlias(runtime)}:${fixture.port}/`);
        expect(result.text).toContain(fixture.secret);

        const status = await env.cli(home, ['playwright', 'status']);
        expect(status.status).toBe(0);
        expect(status.stdout).toContain('真实探测: 通过');
    });
});
