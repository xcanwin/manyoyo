const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');
const fingerprint = require('../lib/plugin/fingerprint');
const extensions = require('../lib/plugin/playwright-extensions');
const { createRelay } = require('../lib/plugin/playwright-relay');
const { PlaywrightPlugin, appendNoProxy, googleChromeCandidates, headedListenHost } = require('../lib/plugin/playwright');
const { buildContainerIntegration, mergeIntegration } = require('../lib/plugin');
const { renderDefaultFiles } = require('../scripts/gen-playwright-res');
const pkg = require('../package.json');

const BIN_PATH = path.join(__dirname, '../bin/manyoyo.js');
const ROOT = path.join(__dirname, '..');
const OLD_SCENE_PATTERN = /mcp-host|cli-host|dev-host|mcp-cont|cliSessionScene|enabledScenes|mcpDefaultHost|cli-cont-headless/;

function makeHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-pw-'));
}

function newPlugin(home, config = {}) {
    const sink = { out: '', err: '' };
    const plugin = new PlaywrightPlugin({
        homeDir: home,
        globalConfig: config,
        stdout: { write: text => { sink.out += text; } },
        stderr: { write: text => { sink.err += text; } },
        runtime: { command: 'docker', env: {} }
    });
    return { plugin, sink };
}

function cli(home, args) {
    return spawnSync(process.execPath, [BIN_PATH, ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
        timeout: 60000
    });
}

function freePort() {
    return new Promise(resolve => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

describe('指纹单一数据源', () => {
    test('default / ws 配置带齐指纹，cdp 配置不注入任何指纹', () => {
        const profile = { locale: 'de-DE', timezoneId: 'Europe/Berlin', navigatorPlatform: 'Win32', disableWebRTC: true };
        for (const kind of ['default', 'ws']) {
            const cfg = fingerprint.buildContainerConfig(kind, { ...profile, endpoint: 'ws://h:1/t' });
            expect(cfg.browser.initScript).toEqual([fingerprint.CONTAINER_INIT_SCRIPT_PATH]);
            // 语言与时区不用 contextOptions 模拟（只作用于页面，Worker 里还是系统值），改由浏览器进程原生环境提供
            expect(cfg.browser.contextOptions).toEqual({ viewport: null });
        }
        const localConfig = fingerprint.buildContainerConfig('default', profile);
        const local = localConfig.browser.launchOptions;
        // 用镜像里的 Google Chrome；容器内是 root，沙箱必须写在 launchOptions 里才生效
        expect(local.channel).toBe('chrome');
        expect(local.chromiumSandbox).toBe(false);
        expect(localConfig.browser.chromiumSandbox).toBeUndefined();
        expect(local.headless).toBe(false);
        expect(local.args).toEqual(expect.arrayContaining([
            '--lang=de-DE',
            // 虚拟屏 1920x1080，fluxbox 底栏占 22px：窗口必须是工作区大小并贴在 (0,0)，否则被整体顶上去、标签栏被截掉
            '--window-size=1920,1058',
            '--window-position=0,0',
            '--disable-blink-features=AutomationControlled',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--disable-webrtc'
        ]));
        expect(local.args.join(' ')).not.toContain('--enable-automation');
        expect(local.args.join(' ')).not.toContain('--user-agent');
        const ws = fingerprint.buildContainerConfig('ws', { endpoint: 'ws://h:1/t' });
        expect(ws.browser).toEqual(expect.objectContaining({ remoteEndpoint: 'ws://h:1/t', isolated: true }));
        const server = fingerprint.buildServerConfig({ host: '0.0.0.0', port: 1, wsPath: '/t', ...profile });
        expect(server.headless).toBe(false);
        expect(server.args).toEqual(expect.arrayContaining(['--lang=de-DE', '--disable-blink-features=AutomationControlled', '--start-maximized']));

        const cdp = fingerprint.buildContainerConfig('cdp', { ...profile, endpoint: 'ws://h:1/t' });
        expect(cdp.browser).toEqual({ cdpEndpoint: 'ws://h:1/t', cdpTimeout: 60000 });
    });

    test('语言与时区经进程环境变量原生传入，格式非法时拒绝（会被写进 shell 与 env 文件）', () => {
        expect(fingerprint.buildProcessEnv({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })).toEqual({
            TZ: 'Asia/Shanghai', LANG: 'zh_CN.UTF-8', LANGUAGE: 'zh_CN:zh'
        });
        expect(fingerprint.buildProcessEnv({ locale: 'en', timezoneId: 'UTC' })).toEqual({
            TZ: 'UTC', LANG: 'en.UTF-8', LANGUAGE: 'en'
        });
        expect(fingerprint.buildContainerEnvFile({ locale: 'de-DE', timezoneId: 'Europe/Berlin' })).toBe(
            "export TZ='Europe/Berlin'\nexport LANG='de_DE.UTF-8'\nexport LANGUAGE='de_DE:de'\n"
        );
        // POSIX 写法与带扩展的 locale 也能用
        expect(fingerprint.buildProcessEnv({ locale: 'en_US', timezoneId: 'UTC' }).LANG).toBe('en_US.UTF-8');
        expect(fingerprint.buildProcessEnv({ locale: 'zh-CN-u-nu-hanidec', timezoneId: 'UTC' }).LANGUAGE).toBe('zh_CN:zh');
        expect(fingerprint.buildProcessEnv({ locale: 'zh-Hans-CN', timezoneId: 'UTC' }).LANG).toBe('zh_CN.UTF-8');
        expect(() => fingerprint.buildProcessEnv({ locale: "en-US'; rm -rf /", timezoneId: 'UTC' })).toThrow();
        expect(() => fingerprint.buildProcessEnv({ locale: 'en-US', timezoneId: 'UTC $(id)' })).toThrow();
    });

    test('宿主机服务配置：有 Google Chrome 用 chrome 渠道，没有则退回 Chromium（不写 channel）', () => {
        const withChrome = fingerprint.buildServerConfig({ host: 'h', port: 1, wsPath: '/t', useChrome: true });
        expect(withChrome.channel).toBe('chrome');
        const without = fingerprint.buildServerConfig({ host: 'h', port: 1, wsPath: '/t', useChrome: false });
        expect(without.channel).toBeUndefined();
        expect(fingerprint.buildServerConfig({ host: 'h', port: 1, wsPath: '/t' }).channel).toBe('chrome');
    });

    test('WebRTC 默认禁用；initScript 只在 disableWebRTC / navigatorPlatform 生效时才有内容与加载（不再补 outerWidth/outerHeight：Google Chrome 首屏本来就不是 0）', () => {
        expect(fingerprint.DEFAULT_PROFILE.disableWebRTC).toBe(true);
        expect(fingerprint.resolveProfile({}).disableWebRTC).toBe(true);
        expect(fingerprint.resolveProfile({ disableWebRTC: false }).disableWebRTC).toBe(false);
        expect(fingerprint.buildLaunchArgs({})).toContain('--disable-webrtc');
        expect(fingerprint.buildLaunchArgs({ disableWebRTC: false })).not.toContain('--disable-webrtc');
        // 关闭 WebRTC 禁用且没设 platform：什么都不改，配置不加载 initScript
        expect(fingerprint.buildInitScript({ disableWebRTC: false })).toBe("'use strict';\n");
        expect(fingerprint.buildInitScript({ disableWebRTC: false })).not.toContain('outerWidth');
        for (const kind of ['default', 'ws']) {
            expect(fingerprint.buildContainerConfig(kind, { endpoint: 'ws://h:1/t', disableWebRTC: false }).browser.initScript).toBeUndefined();
            expect(fingerprint.buildContainerConfig(kind, { endpoint: 'ws://h:1/t' }).browser.initScript)
                .toEqual([fingerprint.CONTAINER_INIT_SCRIPT_PATH]);
            expect(fingerprint.buildContainerConfig(kind, { endpoint: 'ws://h:1/t', disableWebRTC: false, navigatorPlatform: 'Win32' }).browser.initScript)
                .toEqual([fingerprint.CONTAINER_INIT_SCRIPT_PATH]);
        }
        expect(fingerprint.buildInitScript({ disableWebRTC: false })).not.toContain('platform');
        expect(fingerprint.buildInitScript({ disableWebRTC: false, navigatorPlatform: 'MacIntel' })).toContain('"MacIntel"');
        expect(fingerprint.buildInitScript()).toContain('RTCPeerConnection');
    });

    test('插件配置：disableWebRTC 默认 true，可显式关闭（含字符串 false）', () => {
        const home = makeHome();
        try {
            expect(newPlugin(home).plugin.profile().disableWebRTC).toBe(true);
            expect(newPlugin(home, { disableWebRTC: false }).plugin.profile().disableWebRTC).toBe(false);
            expect(newPlugin(home, { disableWebRTC: 'false' }).plugin.profile().disableWebRTC).toBe(false);
            expect(newPlugin(home, { disableWebRTC: 'true' }).plugin.profile().disableWebRTC).toBe(true);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    test('docker/res/playwright 下的默认文件与指纹模块生成结果逐字节一致', () => {
        for (const [name, content] of Object.entries(renderDefaultFiles())) {
            expect(fs.readFileSync(path.join(ROOT, 'docker', 'res', 'playwright', name), 'utf8')).toBe(content);
        }
    });

    test('时区与语言默认跟随宿主机，可被配置覆盖', () => {
        const home = makeHome();
        try {
            const host = fingerprint.detectHostProfile();
            expect(newPlugin(home).plugin.profile()).toEqual(expect.objectContaining(host));
            const overridden = newPlugin(home, { locale: 'fr-FR', timezoneId: 'Europe/Paris' }).plugin.profile();
            expect(overridden).toEqual(expect.objectContaining({ locale: 'fr-FR', timezoneId: 'Europe/Paris' }));
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('headed 监听地址', () => {
    test('不论平台都监听 0.0.0.0：playwright 只绑 loopback 时会因 Host 头不是 localhost 回 403（macOS 容器连不上）', () => {
        expect(headedListenHost()).toBe('0.0.0.0');
        const source = fs.readFileSync(path.join(ROOT, 'lib', 'plugin', 'playwright.js'), 'utf8');
        const headed = source.slice(source.indexOf('async startHeaded'), source.indexOf('async startChrome'));
        expect(headed).toContain('host: headedListenHost()');
        expect(headed).not.toContain('defaultListenHost()');
    });
});

describe('宿主机 Google Chrome', () => {
    test('各平台的标准安装位置', () => {
        expect(googleChromeCandidates('linux')).toEqual(['/opt/google/chrome/chrome']);
        expect(googleChromeCandidates('darwin')).toEqual(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
        expect(googleChromeCandidates('win32', { PROGRAMFILES: 'C:\\PF' })).toEqual([path.join('C:\\PF', 'Google', 'Chrome', 'Application', 'chrome.exe')]);
    });

    test('有 Google Chrome 时直接使用，不下载 Chromium', () => {
        const { plugin, sink } = newPlugin(makeHome());
        plugin.hasGoogleChrome = () => true;
        plugin.installChromium = jest.fn();
        expect(plugin.ensureBrowserInstalled()).toBe(true);
        expect(plugin.installChromium).not.toHaveBeenCalled();
        expect(sink.out).toBe('');
    });

    test('没有时退回 Chromium 并提示（不静默安装 Chrome）', () => {
        const { plugin, sink } = newPlugin(makeHome());
        plugin.hasGoogleChrome = () => false;
        plugin.installChromium = jest.fn();
        expect(plugin.ensureBrowserInstalled()).toBe(false);
        expect(plugin.installChromium).toHaveBeenCalledTimes(1);
        expect(sink.out).toContain('未检测到 Google Chrome');
    });
});

describe('版本单一来源', () => {
    // 每个 @playwright/cli 版本自带的 playwright-core minor（npm view @playwright/cli@<版本> dependencies）
    const CLI_CORE_MINOR = { '0.1.19': '1.63', '0.1.20': '1.64', '0.1.21': '1.64', '0.1.22': '1.64' };

    test('patchright-core 精确钉版本，旧的官方 core / cli 依赖已删除', () => {
        expect(pkg.dependencies['patchright-core']).toBe(pkg.patchrightCoreVersion);
        expect(pkg.dependencies['@playwright/cli']).toBeUndefined();
        expect(pkg.dependencies['playwright-core']).toBeUndefined();
        expect(pkg.dependencies.playwright).toBeUndefined();
        expect(pkg.dependencies['@playwright/mcp']).toBeUndefined();
    });

    test('patchright-core 与容器内 @playwright/cli 同 minor（否则 launchServer 连接被 428 拒绝）', () => {
        expect(CLI_CORE_MINOR[pkg.playwrightCliVersion]).toBeDefined();
        expect(pkg.patchrightCoreVersion.split('.').slice(0, 2).join('.')).toBe(CLI_CORE_MINOR[pkg.playwrightCliVersion]);
    });

    test('integrity 与 package-lock 一致，镜像构建时据此校验', () => {
        const lock = require('../package-lock.json');
        const entry = lock.packages['node_modules/patchright-core'];
        expect(entry.version).toBe(pkg.patchrightCoreVersion);
        expect(entry.integrity).toBe(pkg.patchrightCoreIntegrity);
        expect(pkg.patchrightCoreIntegrity).toMatch(/^sha512-[A-Za-z0-9+/=]{86,}$/);
    });

    test('镜像构建时把客户端 isolatedContext 默认值改成主世界：次数与 patchright-core 实际出现次数一致，升级时强制复核', () => {
        const dockerfile = fs.readFileSync(path.join(ROOT, 'docker', 'manyoyo.Dockerfile'), 'utf8');
        const expected = Number(/ISOLATED_DEFAULTS=(\d+)/.exec(dockerfile)[1]);
        const bundle = fs.readFileSync(path.join(require('path').dirname(require.resolve('patchright-core/package.json')), 'lib', 'coreBundle.js'), 'utf8');
        expect(bundle.split('isolatedContext = true').length - 1).toBe(expected);
        expect(dockerfile).toContain("sed -i 's/isolatedContext = true/isolatedContext = false/g'");
    });

    test('宿主机用的是 patchright-core', () => {
        const { plugin } = newPlugin(makeHome());
        expect(plugin.corePath()).toContain(path.join('node_modules', 'patchright-core'));
        expect(require(path.join(plugin.corePath(), 'package.json')).version).toBe(pkg.patchrightCoreVersion);
    });
});

describe('容器集成参数', () => {
    let home;
    beforeEach(() => { home = makeHome(); });
    afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

    test('挂的是只读目录而不是单文件，配置路径固定，docker 加 add-host', async () => {
        const result = await buildContainerIntegration({ homeDir: home, runtimeCommand: 'docker' });
        const current = path.join(home, '.manyoyo', 'plugin', 'playwright', 'current');
        expect(result.volumeArgs).toEqual(['--volume', `${current}:/run/manyoyo-playwright:ro`]);
        expect(fs.statSync(current).isDirectory()).toBe(true);
        expect(fs.statSync(current).mode & 0o777).toBe(0o700);
        expect(result.envArgs).toEqual(expect.arrayContaining([
            '--env', 'PLAYWRIGHT_MCP_CONFIG=/run/manyoyo-playwright/config.json',
            '--env', 'NO_UPDATE_NOTIFIER=1'
        ]));
        expect(result.extraArgs).toEqual(['--add-host', 'host.docker.internal:host-gateway']);
        expect(fs.existsSync(path.join(current, 'config.json'))).toBe(true);
        expect(fs.existsSync(path.join(current, 'stealth.init.js'))).toBe(true);
        // 语言与时区经 env 文件交给 playwright-cli 包装脚本，进入浏览器进程环境
        const host = fingerprint.detectHostProfile();
        expect(fs.readFileSync(path.join(current, 'env'), 'utf8')).toBe(fingerprint.buildContainerEnvFile(host));
    });

    test('podman（含绝对路径）不加 add-host', async () => {
        for (const command of ['podman', '/x/y/podman']) {
            // eslint-disable-next-line no-await-in-loop
            const result = await buildContainerIntegration({ homeDir: home, runtimeCommand: command });
            expect(result.extraArgs).toEqual([]);
        }
    });

    test('NO_PROXY 在已有值后追加而不是覆盖', async () => {
        expect(appendNoProxy('localhost,10.0.0.0/8')).toBe('localhost,10.0.0.0/8,host.docker.internal,host.containers.internal');
        expect(appendNoProxy('host.docker.internal')).toBe('host.docker.internal,host.containers.internal');
        const result = await buildContainerIntegration({
            homeDir: home,
            runtimeCommand: 'docker',
            envEntries: ['NO_PROXY=corp.example.com']
        });
        const value = result.envArgs.find(item => item.startsWith('NO_PROXY='));
        expect(value).toBe('NO_PROXY=corp.example.com,host.docker.internal,host.containers.internal');
        expect(result.envArgs).toContain('no_proxy=corp.example.com,host.docker.internal,host.containers.internal');
    });

    test('mergeIntegration 保留用户 env、替换 NO_PROXY、volume 与参数去重', async () => {
        const integration = await buildContainerIntegration({
            homeDir: home,
            runtimeCommand: 'docker',
            envEntries: ['NO_PROXY=corp']
        });
        const runtime = {
            containerEnvs: ['--env', 'A=1', '--env', 'NO_PROXY=corp', '--env', 'PLAYWRIGHT_MCP_CONFIG=/mine.json'],
            containerVolumes: integration.volumeArgs,
            containerExtraArgs: integration.extraArgs
        };
        const merged = mergeIntegration(runtime, integration);
        const envs = merged.containerEnvs.filter((_, i) => i % 2 === 1);
        expect(envs).toContain('A=1');
        expect(envs).toContain('PLAYWRIGHT_MCP_CONFIG=/mine.json');
        expect(envs.filter(item => item.startsWith('PLAYWRIGHT_MCP_CONFIG='))).toHaveLength(1);
        expect(envs.filter(item => item.startsWith('NO_PROXY='))).toEqual(['NO_PROXY=corp,host.docker.internal,host.containers.internal']);
        expect(merged.containerVolumes).toEqual(integration.volumeArgs);
        expect(merged.containerExtraArgs).toEqual(integration.extraArgs);
    });

    test('CLI run 与 Web 建会话都走同一个集成入口，且一次性 setup 测试容器不注入', () => {
        const bin = fs.readFileSync(BIN_PATH, 'utf8');
        const server = fs.readFileSync(path.join(ROOT, 'lib', 'web', 'server.js'), 'utf8');
        expect(bin).toContain('buildContainerIntegration');
        expect(server).toContain('buildContainerIntegration');
        const setupTest = server.slice(server.indexOf('manyoyo-setup-test-'));
        expect(setupTest.slice(0, 1200)).not.toContain('buildWebPlaywrightIntegration');
    });

    test('原子替换：写入后 inode 改变、权限 0600', () => {
        const { plugin } = newPlugin(home);
        plugin.writeCurrentConfig({ mode: 'default' }, 'docker');
        const configPath = path.join(plugin.currentDir, 'config.json');
        const before = fs.statSync(configPath);
        plugin.writeCurrentConfig({ mode: 'headed', port: 8935 }, 'docker');
        const after = fs.statSync(configPath);
        expect(after.ino).not.toBe(before.ino);
        expect(after.mode & 0o777).toBe(0o600);
        expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).browser.remoteEndpoint).toMatch(/^ws:\/\/host\.docker\.internal:8935\/[0-9a-f]{64}$/);
    });

    test('预览命令（dryRun）不写任何文件也不改状态，但返回相同的参数', async () => {
        const preview = await buildContainerIntegration({ homeDir: home, runtimeCommand: 'docker', dryRun: true });
        expect(fs.existsSync(path.join(home, '.manyoyo'))).toBe(false);
        const real = await buildContainerIntegration({ homeDir: home, runtimeCommand: 'docker' });
        expect(preview.volumeArgs).toEqual(real.volumeArgs);
        expect(preview.envArgs).toEqual(real.envArgs);
    });

    test('state 里的 pid 被无关进程复用时，不当成存活也不会被杀', async () => {
        const { plugin } = newPlugin(home);
        // 当前 jest 进程肯定活着，但不是 playwright-server / relay
        const state = { mode: 'headed', port: await freePort(), pid: process.pid };
        expect(await plugin.modeAlive(state)).toBe(false);
        await plugin.stopCurrent(state);
        expect(() => process.kill(process.pid, 0)).not.toThrow();
    });

    test('同一模式下内容不变就不重写，podman 与 docker 的连接主机不同', () => {
        const { plugin } = newPlugin(home);
        plugin.writeState({ mode: 'headed', port: 8935 });
        plugin.writeCurrentConfig({ mode: 'headed', port: 8935 }, 'podman');
        const configPath = path.join(plugin.currentDir, 'config.json');
        const ino = fs.statSync(configPath).ino;
        plugin.writeCurrentConfig({ mode: 'headed', port: 8935 }, 'podman');
        expect(fs.statSync(configPath).ino).toBe(ino);
        expect(fs.readFileSync(configPath, 'utf8')).toContain('host.containers.internal');
    });

    test('模式失效时回退默认配置并警告；状态目录不可写时 run 也不抛错', async () => {
        const { plugin } = newPlugin(home);
        plugin.writeState({ mode: 'headed', port: await freePort(), pid: 2 ** 22 + 12345 });
        const result = await buildContainerIntegration({ homeDir: home, runtimeCommand: 'docker' });
        expect(result.warning).toContain('manyoyo playwright up headed');
        const config = JSON.parse(fs.readFileSync(path.join(plugin.currentDir, 'config.json'), 'utf8'));
        expect(config.browser.remoteEndpoint).toBeUndefined();
        expect(config.browser.launchOptions.headless).toBe(false);
        expect(plugin.readState().mode).toBe('default');

        const brokenHome = makeHome();
        try {
            fs.mkdirSync(path.join(brokenHome, '.manyoyo'));
            fs.writeFileSync(path.join(brokenHome, '.manyoyo', 'plugin'), 'not a directory');
            const broken = await buildContainerIntegration({ homeDir: brokenHome, runtimeCommand: 'docker' });
            expect(broken.volumeArgs).toEqual([]);
            expect(broken.warning).toContain('Playwright 集成不可用');
        } finally {
            fs.rmSync(brokenHome, { recursive: true, force: true });
        }
    });

    test('状态目录被删后下一次集成会重建', async () => {
        const first = await buildContainerIntegration({ homeDir: home, runtimeCommand: 'docker' });
        const root = path.join(home, '.manyoyo', 'plugin', 'playwright');
        fs.rmSync(root, { recursive: true, force: true });
        const second = await buildContainerIntegration({ homeDir: home, runtimeCommand: 'docker' });
        expect(second.volumeArgs).toEqual(first.volumeArgs);
        expect(fs.existsSync(path.join(root, 'current', 'config.json'))).toBe(true);
    });

    test('token 持久化：重复读取相同，down 后重新生成；至少 32 字节', async () => {
        const { plugin } = newPlugin(home);
        const token = plugin.ensureToken();
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(newPlugin(home).plugin.ensureToken()).toBe(token);
        expect(fs.statSync(plugin.tokenPath()).mode & 0o777).toBe(0o600);
        await plugin.down();
        expect(fs.existsSync(plugin.tokenPath())).toBe(false);
        expect(plugin.ensureToken()).not.toBe(token);
    });

    test('status 发现配置文件被删会重建并提示', async () => {
        const { plugin, sink } = newPlugin(home);
        plugin.writeCurrentConfig({ mode: 'default' }, 'docker');
        fs.rmSync(path.join(plugin.currentDir, 'config.json'));
        fs.rmSync(path.join(plugin.currentDir, 'stealth.init.js'));
        expect(await plugin.status()).toBe(0);
        expect(sink.out).toContain('配置文件缺失，已重建');
        expect(fs.existsSync(path.join(plugin.currentDir, 'config.json'))).toBe(true);
        expect(fs.existsSync(path.join(plugin.currentDir, 'stealth.init.js'))).toBe(true);
    });

    test('down 回到默认配置并写 current/config.json', async () => {
        const { plugin, sink } = newPlugin(home);
        plugin.writeState({ mode: 'headed', port: 1, pid: 2 ** 22 + 1 });
        expect(await plugin.down()).toBe(0);
        expect(sink.out).toContain('回到默认模式');
        expect(plugin.readState().mode).toBe('default');
        expect(JSON.parse(fs.readFileSync(path.join(plugin.currentDir, 'config.json'), 'utf8')).browser.launchOptions).toBeDefined();
    });
});

describe('命令行', () => {
    let home;
    beforeEach(() => { home = makeHome(); });
    afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

    test('up 不带参数输出模式表并以非 0 退出', () => {
        const result = cli(home, ['playwright', 'up']);
        expect(result.status).not.toBe(0);
        for (const mode of ['headed', 'chrome', 'vnc']) {
            expect(result.stdout).toContain(mode);
        }
    });

    test('旧场景名报未知模式并列出可用模式', () => {
        const result = cli(home, ['playwright', 'up', 'mcp-host-headless']);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('未知模式: mcp-host-headless');
        expect(result.stderr).toContain('headed, chrome, vnc');
    });

    test('隐藏的 plugin 命名空间已删除', () => {
        const result = cli(home, ['plugin', 'playwright', 'status']);
        expect(result.status).not.toBe(0);
    });

    test('帮助与 mcp-add 里没有旧场景名', () => {
        const help = cli(home, ['playwright', '--help']).stdout;
        expect(help).not.toMatch(OLD_SCENE_PATTERN);
        for (const mode of ['headed', 'chrome', 'vnc']) {
            expect(help).toContain(mode);
        }
        const mcp = cli(home, ['playwright', 'mcp-add']);
        expect(mcp.status).toBe(0);
        expect(mcp.stdout).toContain('playwright-mcp');
        expect(mcp.stdout).not.toMatch(OLD_SCENE_PATTERN);
    });

    test('status：默认模式退出码 0；当前模式不可用时退出码非 0 并回退默认', async () => {
        expect(cli(home, ['playwright', 'status']).status).toBe(0);
        const { plugin } = newPlugin(home);
        plugin.writeState({ mode: 'headed', port: await freePort(), pid: 2 ** 22 + 7 });
        const result = cli(home, ['playwright', 'status']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('真实探测: 失败');
        expect(plugin.readState().mode).toBe('default');
    });

    test('up chrome：没开 Chrome / 只剩旧的调试端口记录时给出清晰的下一步，且不起中继', () => {
        const none = cli(home, ['playwright', 'up', 'chrome']);
        expect(none.status).toBe(1);
        expect(none.stderr).toContain('没有找到开启了远程调试的 Chrome');
        expect(none.stderr).toContain('chrome://inspect/#remote-debugging');
        expect(none.stderr.split('\n')).toContain('chrome://inspect/#remote-debugging'); // 地址独占一行，方便复制
        expect(none.stderr).toContain('勾选“Allow remote debugging”（Chrome 没开就先打开它），然后重试。');

        const stale = path.join(home, 'DevToolsActivePort');
        fs.writeFileSync(stale, '9\n/devtools/browser/x\n');
        fs.writeFileSync(path.join(home, '.manyoyo', 'manyoyo.json'), JSON.stringify({ plugins: { playwright: { devtoolsActivePortPath: stale } } }));
        const old = cli(home, ['playwright', 'up', 'chrome']);
        expect(old.status).toBe(1);
        expect(old.stderr).toContain('Chrome 没有在运行');
        expect(old.stderr).not.toContain('ready');
        expect(fs.existsSync(path.join(home, '.manyoyo', 'plugin', 'playwright', 'run', 'relay.json'))).toBe(false);
    });

    test('chrome 模式不支持扩展参数', () => {
        const result = cli(home, ['playwright', 'up', 'chrome', '--ext-path', os.tmpdir()]);
        expect(result.status).not.toBe(0);
    });

    test('源码里没有遗留的旧场景引用', () => {
        const files = ['bin/manyoyo.js', 'lib/plugin/playwright.js', 'lib/plugin/index.js', 'lib/plugin/fingerprint.js', 'lib/web/server.js', 'manyoyo.example.json'];
        for (const file of files) {
            expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).not.toMatch(OLD_SCENE_PATTERN);
        }
        expect(fs.existsSync(path.join(ROOT, 'lib', 'plugin', 'playwright-assets', 'compose-headed.yaml'))).toBe(false);
    });
});

describe('扩展', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ext-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    function makeExt(name) {
        const extPath = path.join(dir, name);
        fs.mkdirSync(extPath, { recursive: true });
        fs.writeFileSync(path.join(extPath, 'manifest.json'), '{"manifest_version":3}', 'utf8');
        return extPath;
    }

    test('--ext-path 与 --ext-name 合并解析；扩展名/路径校验', () => {
        const fromPath = makeExt('from-path');
        const named = makeExt(path.join('extensions', 'adguard'));
        const resolved = extensions.resolveExtensionInputs(dir, { extensionPaths: [fromPath], extensionNames: ['adguard'] });
        expect(resolved).toEqual([fromPath, named]);
        expect(() => extensions.resolveExtensionInputs(dir, { extensionNames: ['../x'] })).toThrow('扩展名称无效');
        const comma = makeExt('a,b');
        expect(() => extensions.resolveExtensionPaths([comma])).toThrow('不能包含逗号');
    });

    test('扩展经 CDP Extensions.loadUnpacked 加载：官方 Google Chrome 从 M137 起忽略 --load-extension，只有扩展时才加调试开关', () => {
        const withExt = fingerprint.buildServerConfig({ host: 'h', port: 1, wsPath: '/t', extensionPaths: ['/a', '/b'] });
        expect(withExt.extensionPaths).toEqual(['/a', '/b']);
        expect(withExt.args).toContain('--enable-unsafe-extension-debugging');
        expect(withExt.args.join(' ')).not.toContain('--load-extension');
        const without = fingerprint.buildServerConfig({ host: 'h', port: 1, wsPath: '/t' });
        expect(without.extensionPaths).toBeUndefined();
        expect(without.args).not.toContain('--enable-unsafe-extension-debugging');
        expect(extensions.buildExtensionLaunchArgs).toBeUndefined();
    });

    test('容器内扩展目录映射为只读挂载', () => {
        const a = makeExt('a');
        const b = makeExt('b');
        const mapped = extensions.buildContainerExtensionMounts([a, b]);
        expect(mapped.containerPaths[0]).toBe('/app/extensions/ext-1-a');
        expect(mapped.containerPaths[1]).toBe('/app/extensions/ext-2-b');
        expect(mapped.volumes).toEqual([`${a}:/app/extensions/ext-1-a:ro`, `${b}:/app/extensions/ext-2-b:ro`]);
    });
});

describe('Chrome 中继', () => {
    const TOKEN = 'a'.repeat(64);
    let servers;
    beforeEach(() => { servers = []; });
    afterEach(async () => {
        await Promise.all(servers.map(server => new Promise(resolve => {
            if (server.clients) { server.clients.forEach(client => client.terminate()); }
            server.close(() => resolve());
        })));
    });

    function listen(server) {
        servers.push(server);
        return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    }

    // 模拟 Chrome：只接受 Host 为 127.0.0.1:<端口> 的 WebSocket，并回显
    async function fakeChrome(label) {
        const seenHosts = [];
        const server = http.createServer();
        const wss = new WebSocketServer({ server });
        wss.on('connection', (socket, req) => {
            seenHosts.push(req.headers.host);
            socket.on('message', data => socket.send(`${label}:${data}`));
        });
        const port = await listen(server);
        servers.push({ close: cb => wss.close(cb), clients: wss.clients });
        return { port, seenHosts };
    }

    function connect(port, urlPath) {
        return new Promise(resolve => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`);
            socket.once('open', () => resolve({ socket }));
            socket.once('error', error => resolve({ error }));
            socket.once('unexpected-response', (req, res) => resolve({ status: res.statusCode }));
        });
    }

    function roundTrip(socket, text) {
        return new Promise(resolve => {
            socket.once('message', data => resolve(String(data)));
            socket.send(text);
        });
    }

    test('只放行带 token 的 upgrade，其余 HTTP 与路径一律 404；Chrome 重启后新连接自动跟随', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-relay-'));
        try {
            const activePort = path.join(dir, 'DevToolsActivePort');
            const first = await fakeChrome('first');
            fs.writeFileSync(activePort, `${first.port}\n/devtools/browser/abc\n`);
            const relayPort = await listen(createRelay({ token: TOKEN, candidates: [path.join(dir, 'missing'), activePort] }));

            const http404 = await new Promise(resolve => {
                http.get({ host: '127.0.0.1', port: relayPort, path: `/${TOKEN}` }, res => resolve(res.statusCode));
            });
            expect(http404).toBe(404);
            expect((await connect(relayPort, '/wrong')).status).toBe(404);
            expect((await connect(relayPort, '/')).status).toBe(404);

            const one = await connect(relayPort, `/${TOKEN}`);
            expect(await roundTrip(one.socket, 'hi')).toBe('first:hi');
            expect(first.seenHosts[0]).toBe(`127.0.0.1:${first.port}`);
            one.socket.close();

            // “重启 Chrome”：端口变化
            const second = await fakeChrome('second');
            fs.writeFileSync(activePort, `${second.port}\n/devtools/browser/def\n`);
            const two = await connect(relayPort, `/${TOKEN}`);
            expect(await roundTrip(two.socket, 'again')).toBe('second:again');
            two.socket.close();

            fs.rmSync(activePort);
            expect((await connect(relayPort, `/${TOKEN}`)).status).toBe(502);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
