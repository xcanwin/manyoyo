'use strict';

// L3 指纹一致性：夹具页面采集浏览器暴露的信号，断言各项自洽、各模式之间一致，chrome 模式不注入。
// 公开检测站点（bot.sannysoft.com 等）依赖外网，只在 temp/ 下手动截图对比，不作为断言。
const { spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('patchright-core');
const { startFixture } = require('./helpers/fingerprint-fixture');
const env = require('./helpers/playwright-env');
const fingerprint = require('../../lib/plugin/fingerprint');

const runtime = env.usableRuntime();
const ready = Boolean(runtime) && env.imageAvailable(runtime);
const maybe = ready ? describe : describe.skip;
const maybeHeaded = ready && env.hasDisplay() ? describe : describe.skip;

jest.setTimeout(420000);

const FIXTURE_FILE = path.join(__dirname, 'helpers', 'fingerprint-fixture.js');
const profile = fingerprint.detectHostProfile();
const collected = {};

function expectSelfConsistent(data, { checkClientHints = true } = {}) {
    const { report, headers } = data;
    expect(report.webdriver).not.toBe(true);
    expect(report.userAgent).not.toContain('HeadlessChrome');
    // UA 声称的平台与 navigator.platform 一致（都用浏览器真实值）
    expect(report.userAgent).toContain('Linux');
    expect(report.platform).toMatch(/^Linux/);
    // 语言、时区与配置一致，Accept-Language 与 navigator.languages 一致
    expect(report.languages[0]).toBe(profile.locale);
    expect(report.timezone).toBe(profile.timezoneId);
    expect(String(headers['accept-language']).split(',')[0]).toBe(profile.locale);
    // Worker 与页面一致（contextOptions 模拟只作用于页面，Worker 里会是系统值）
    expect(report.worker.languages).toEqual(report.languages);
    expect(report.worker.timezone).toBe(report.timezone);
    expect(report.worker.userAgent).toBe(report.userAgent);
    expect(report.worker.hardwareConcurrency).toBe(report.hardwareConcurrency);
    // 没有 CDP Runtime 痕迹（页面与 Worker）
    expect(report.cdp).toBe(false);
    expect(report.worker.cdp).toBe(false);
    // 窗口像真实窗口：外框不为 0，屏幕尺寸不被伪造成 viewport
    expect(report.window.outerWidth).toBeGreaterThan(0);
    expect(report.window.outerHeight).toBeGreaterThanOrEqual(report.window.innerHeight);
    if (checkClientHints) {
        expect(report.userAgentData.platform).toBe('Linux');
        // 浏览器是 Google Chrome，品牌里要有 Google Chrome（Chromium 的品牌里没有）
        expect(report.userAgentData.brands.map(brand => brand.brand)).toContain('Google Chrome');
        const chromiumVersion = report.userAgentData.brands.find(brand => brand.brand === 'Chromium').version;
        expect(report.userAgent).toContain(`Chrome/${chromiumVersion}.`);
        expect(headers['sec-ch-ua-platform']).toBe('"Linux"');
    }
}

async function inContainerFixture(name) {
    spawnSync(runtime, ['cp', FIXTURE_FILE, `${name}:/tmp/fixture.js`]);
    await env.exec(runtime, name, 'nohup node /tmp/fixture.js 7777 >/tmp/fixture.log 2>&1 &');
    await new Promise(resolve => setTimeout(resolve, 800));
    await env.exec(runtime, name, 'playwright-cli open http://localhost:7777/fingerprint', { timeout: 90000 });
    await new Promise(resolve => setTimeout(resolve, 1500));
    const state = await env.exec(runtime, name, 'curl -s localhost:7777/state');
    await env.exec(runtime, name, 'playwright-cli close');
    return JSON.parse(state.stdout);
}

maybe('指纹一致性：default（容器内 Xvfb 有头浏览器）', () => {
    test('各项信号自洽', async () => {
        const home = env.makeHome();
        const name = env.randomName('pw-fp');
        try {
            await env.createContainer(runtime, home, name);
            const data = await inContainerFixture(name);
            collected.default = data;
            expectSelfConsistent(data);
            expect(data.report.screen.width).toBe(1920);
            expect(data.report.window.dpr).toBe(1);
        } finally {
            env.removeContainer(runtime, name);
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

maybe('指纹一致性：allowlist 预设下浏览器走过滤代理，指纹不退化', () => {
    test('各项信号自洽，且与 default 一致', async () => {
        const home = env.makeHome();
        const name = env.randomName('pw-fp');
        try {
            await env.createContainer(runtime, home, name, { network: { preset: 'allowlist', outbound: [{ action: 'allow', target: 'example.com', ports: '', proto: 'all' }] } });
            const data = await inContainerFixture(name);
            expectSelfConsistent(data);
            expect(data.report.screen.width).toBe(1920);
            if (collected.default) {
                expect(data.report.userAgent).toBe(collected.default.report.userAgent);
                expect(data.report.languages).toEqual(collected.default.report.languages);
                expect(data.report.timezone).toBe(collected.default.report.timezone);
            }
        } finally {
            env.removeContainer(runtime, name);
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

maybe('default：Agent 读得到页面主世界的 JS 全局变量', () => {
    test('playwright-cli eval 与 run-code 里的 page.evaluate 都能读到页面自己定义的全局变量和函数', async () => {
        const home = env.makeHome();
        const name = env.randomName('pw-fp');
        const fixture = await startFixture();
        try {
            await env.createContainer(runtime, home, name, { hostPorts: [fixture.port] });
            // 夹具在宿主机，容器里的浏览器经 host 别名访问
            await env.exec(runtime, name, `playwright-cli open http://${env.hostAlias(runtime)}:${fixture.port}/global`, { timeout: 90000 });
            const global = await env.exec(runtime, name, 'playwright-cli eval "window.manyoyoGlobal"', { timeout: 60000 });
            const fn = await env.exec(runtime, name, 'playwright-cli eval "window.manyoyoFn()"', { timeout: 60000 });
            const code = await env.exec(runtime, name, 'playwright-cli run-code "async page => page.evaluate(() => window.manyoyoGlobal)"', { timeout: 60000 });
            await env.exec(runtime, name, 'playwright-cli close');
            expect(global.stdout).toContain(`g-${fixture.secret}`);
            expect(fn.stdout).toContain(`f-${fixture.secret}`);
            expect(code.stdout).toContain(`g-${fixture.secret}`);
        } finally {
            env.removeContainer(runtime, name);
            await fixture.close();
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

maybe('default：语言时区用原生环境变量，代理等环境变量不丢', () => {
    test('容器带 HTTP_PROXY 时浏览器仍走该代理，同时页面语言时区取自 env 文件', async () => {
        const home = env.makeHome();
        const name = env.randomName('pw-fp');
        const requests = [];
        const proxy = http.createServer((req, res) => {
            requests.push(req.url);
            res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>via-proxy</title>');
        });
        await new Promise(resolve => proxy.listen(0, '0.0.0.0', resolve));
        try {
            const proxyUrl = `http://${env.hostAlias(runtime)}:${proxy.address().port}`;
            await env.createContainer(runtime, home, name, { env: [`HTTP_PROXY=${proxyUrl}`, `http_proxy=${proxyUrl}`], hostPorts: [proxy.address().port] });
            const opened = await env.exec(runtime, name, 'playwright-cli open http://proxy-probe.invalid/', { timeout: 90000 });
            await env.exec(runtime, name, 'playwright-cli close');
            expect(opened.stdout + opened.stderr).toContain('via-proxy');
            expect(requests.some(url => url.includes('proxy-probe.invalid'))).toBe(true);
        } finally {
            env.removeContainer(runtime, name);
            proxy.close();
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

maybeHeaded('指纹一致性：headed / chrome 与跨模式一致', () => {
    let home;
    let fixture;
    let port;
    const containers = [];

    beforeEach(async () => {
        home = env.makeHome();
        port = await env.freePort();
        fs.writeFileSync(path.join(home, '.manyoyo', 'manyoyo.json'), JSON.stringify({
            containerRuntime: runtime,
            plugins: { playwright: { port } }
        }));
        fixture = await startFixture({ host: '127.0.0.1' });
    });

    afterEach(async () => {
        containers.splice(0).forEach(name => env.removeContainer(runtime, name));
        await env.cli(home, ['playwright', 'down']);
        await fixture.close();
        fs.rmSync(home, { recursive: true, force: true });
    });

    // 浏览器在宿主机，所以 127.0.0.1 是它自己的 loopback，属于安全上下文
    async function collectViaContainer() {
        const name = env.randomName('pw-fp');
        containers.push(name);
        await env.createContainer(runtime, home, name, { hostPorts: [fixture.port] });
        await env.exec(runtime, name, `playwright-cli open http://127.0.0.1:${fixture.port}/fingerprint`, { timeout: 90000 });
        await fixture.waitForReport();
        await env.exec(runtime, name, 'playwright-cli close');
        return { report: fixture.state.report, headers: fixture.state.headers };
    }

    test('headed：自洽，且与 default 一致', async () => {
        expect((await env.cli(home, ['playwright', 'up', 'headed'], { timeout: 300000 })).status).toBe(0);
        const data = await collectViaContainer();
        collected.headed = data;
        expectSelfConsistent(data);
        if (collected.default) {
            expect(data.report.userAgent).toBe(collected.default.report.userAgent);
            expect(data.report.languages).toEqual(collected.default.report.languages);
            expect(data.report.timezone).toBe(collected.default.report.timezone);
            expect(data.report.platform).toBe(collected.default.report.platform);
        }
    });

    test('chrome：不注入任何指纹（语言保持浏览器自己的值）', async () => {
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-chrome-fp-'));
        const context = await chromium.launchPersistentContext(userDataDir, {
            ...env.simulatedUserChromeOptions(),
            headless: false,
            chromiumSandbox: false,
            locale: 'en-US',
            args: ['--remote-debugging-port=0']
        });
        try {
            const activePort = path.join(userDataDir, 'DevToolsActivePort');
            fs.writeFileSync(path.join(home, '.manyoyo', 'manyoyo.json'), JSON.stringify({
                containerRuntime: runtime,
                plugins: { playwright: { port, devtoolsActivePortPath: activePort, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' } }
            }));
            expect((await env.cli(home, ['playwright', 'up', 'chrome'])).status).toBe(0);
            const config = JSON.parse(fs.readFileSync(path.join(home, '.manyoyo', 'plugin', 'playwright', 'current', 'config.json'), 'utf8'));
            expect(Object.keys(config.browser).sort()).toEqual(['cdpEndpoint', 'cdpTimeout']);
            const data = await collectViaContainer();
            expect(data.report.languages[0]).not.toBe('ja-JP');
            expect(data.report.timezone).not.toBe('Asia/Tokyo');
        } finally {
            await context.close().catch(() => {});
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });
});

maybe('指纹一致性：vnc 与 default 一致', () => {
    test('vnc：自洽，与 default 的 UA、语言、时区一致', async () => {
        const home = env.makeHome();
        const port = await env.freePort();
        fs.writeFileSync(path.join(home, '.manyoyo', 'manyoyo.json'), JSON.stringify({
            containerRuntime: runtime,
            plugins: { playwright: { port, vncPort: port + 1, novncPort: port + 2 } }
        }));
        // vnc 容器里的浏览器经 host 别名访问夹具，不是安全上下文：没有 userAgentData / Sec-CH-UA
        const fixture = await startFixture();
        const name = env.randomName('pw-fp');
        try {
            expect((await env.cli(home, ['playwright', 'up', 'vnc'], { timeout: 400000 })).status).toBe(0);
            await env.createContainer(runtime, home, name, { hostPorts: [fixture.port] });
            await env.exec(runtime, name, `playwright-cli open http://${env.hostAlias(runtime)}:${fixture.port}/fingerprint`, { timeout: 90000 });
            await fixture.waitForReport();
            await env.exec(runtime, name, 'playwright-cli close');
            const data = { report: fixture.state.report, headers: fixture.state.headers };
            expectSelfConsistent(data, { checkClientHints: false });
            if (collected.default) {
                expect(data.report.userAgent).toBe(collected.default.report.userAgent);
                expect(data.report.languages).toEqual(collected.default.report.languages);
                expect(data.report.timezone).toBe(collected.default.report.timezone);
                expect(data.report.screen.width).toBe(collected.default.report.screen.width);
            }
        } finally {
            env.removeContainer(runtime, name);
            await env.cli(home, ['playwright', 'down']);
            await fixture.close();
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});
