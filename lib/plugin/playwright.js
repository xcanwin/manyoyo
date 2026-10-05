'use strict';

// Playwright 插件：容器内的浏览器怎么来，只有 4 种模式、同一时间只有一个。
//   default  容器内 Xvfb 里的有头 Google Chrome（无需宿主机进程）
//   headed   宿主机有窗口的浏览器（优先用本机 Google Chrome）
//   chrome   用户正在使用的 Chrome（经本机中继）
//   vnc      独立容器里的浏览器，用 noVNC 网页观看
// 宿主机目录 current/ 以目录方式只读挂进容器的 /run/manyoyo-playwright/，里面的 config.json 一律原子替换，
// 因此切换模式后已运行的容器自动跟随，不需要重建。

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { writeConfigFileSecure } = require('../secure-file');
const fingerprint = require('./fingerprint');
const extensions = require('./playwright-extensions');
const { findDevToolsActivePort } = require('./playwright-relay');

const MODES = ['headed', 'chrome', 'vnc'];
const MODE_HELP = [
    ['(默认)', '容器内虚拟屏里的有头浏览器，无需任何命令'],
    ['headed', '宿主机上有窗口的浏览器，亲眼看着 Agent 操作'],
    ['chrome', '你正在用的 Chrome，沿用登录状态（有风险）'],
    ['vnc', '独立容器里的浏览器，通过 noVNC 网页观看（无桌面的机器）']
];
const VNC_CONTAINER = 'my-playwright-vnc';
const VNC_ASSET_DIR = path.join(__dirname, 'playwright-assets');
const VNC_MOUNT_DIR = '/run/manyoyo-playwright-vnc';
const DEFAULT_PORTS = { port: 8935, vncPort: 5900, novncPort: 6080 };
const PROXY_BYPASS_HOSTS = ['host.docker.internal', 'host.containers.internal'];
const SERVER_START_TIMEOUT_MS = 30000;
const PROBE_TIMEOUT_MS = 5000;
// chrome 首次连接要等用户在 Chrome 弹出的“要允许远程调试吗？”里点允许
const CHROME_APPROVAL_TIMEOUT_MS = 60000;

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function tailText(filePath, lineCount) {
    try {
        return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).slice(-lineCount).join('\n');
    } catch {
        return '';
    }
}

function randomAlnum(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += chars[crypto.randomInt(0, chars.length)];
    }
    return out;
}

function shellValue(value) {
    const text = String(value);
    return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

function portReady(port, host = '127.0.0.1', timeout = 300) {
    return new Promise(resolve => {
        const socket = net.createConnection({ host, port });
        const finish = value => {
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(timeout);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

// pid 可能在重启后被不相干的进程复用：确认它的命令行还是我们起的服务脚本
function pidIsOurs(pid) {
    if (!pidAlive(pid)) {
        return false;
    }
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
    return /playwright-(server|relay)\.js/.test(result.stdout || '');
}

// 宿主机监听地址：macOS 的容器能访问宿主机 loopback；Linux 容器只能访问 0.0.0.0
function defaultListenHost(platform = process.platform) {
    return platform === 'darwin' ? '127.0.0.1' : '0.0.0.0';
}

// Google Chrome 在各平台的标准安装位置（patchright 的 channel: 'chrome' 也在这些位置查找）
function googleChromeCandidates(platform = process.platform, env = process.env) {
    if (platform === 'darwin') {
        return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    }
    if (platform === 'win32') {
        return ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA']
            .filter(name => env[name])
            .map(name => path.join(env[name], 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    return ['/opt/google/chrome/chrome'];
}

// headed 的浏览器服务必须监听 0.0.0.0：playwright 只绑 loopback 时会按 Host 头做 DNS 重绑定防护，
// 容器用 host.containers.internal 访问会被 403（macOS 上实测）；监听 0.0.0.0 则不检查 Host，靠 token 保护
function headedListenHost() {
    return '0.0.0.0';
}

function runtimeKind(runtimeCommand) {
    return path.basename(String(runtimeCommand || '').trim()).toLowerCase() === 'podman' ? 'podman' : 'docker';
}

function connectHostFor(runtimeCommand) {
    return runtimeKind(runtimeCommand) === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
}

function appendNoProxy(existing) {
    const parts = String(existing || '').split(',').map(item => item.trim()).filter(Boolean);
    for (const host of PROXY_BYPASS_HOSTS) {
        if (!parts.includes(host)) {
            parts.push(host);
        }
    }
    return parts.join(',');
}

function envEntryValue(entries, key) {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const text = String(entries[i]);
        if (text.startsWith(`${key}=`)) {
            return text.slice(key.length + 1);
        }
    }
    return undefined;
}

class PlaywrightPlugin {
    constructor(options = {}) {
        this.stdout = options.stdout || process.stdout;
        this.stderr = options.stderr || process.stderr;
        this.rootGlobalConfig = asObject(options.rootGlobalConfig);
        this.rootRunConfig = asObject(options.rootRunConfig);
        this.runtime = options.runtime || null;
        this.homeDir = options.homeDir || os.homedir();
        this.root = path.join(this.homeDir, '.manyoyo', 'plugin', 'playwright');
        this.currentDir = path.join(this.root, 'current');
        this.runDir = path.join(this.root, 'run');
        this.config = this.resolveConfig(asObject(options.globalConfig), asObject(options.runConfig));
    }

    resolveConfig(globalConfig, runConfig) {
        const merged = { ...globalConfig, ...runConfig };
        const host = fingerprint.detectHostProfile();
        const port = name => {
            const value = Number(merged[name] || DEFAULT_PORTS[name]);
            if (!Number.isInteger(value) || value <= 0 || value > 65535) {
                throw new Error(`plugins.playwright.${name} 无效: ${merged[name]}`);
            }
            return value;
        };
        return {
            port: port('port'),
            vncPort: port('vncPort'),
            novncPort: port('novncPort'),
            locale: String(merged.locale || '').trim() || host.locale,
            timezoneId: String(merged.timezoneId || '').trim() || host.timezoneId,
            navigatorPlatform: String(merged.navigatorPlatform || '').trim(),
            disableWebRTC: merged.disableWebRTC === undefined ? fingerprint.DEFAULT_PROFILE.disableWebRTC : (merged.disableWebRTC === true || String(merged.disableWebRTC).toLowerCase() === 'true'),
            devtoolsActivePortPath: String(merged.devtoolsActivePortPath || '').trim(),
            extensionProdversion: String(merged.extensionProdversion || '').trim() || '132.0.0.0'
        };
    }

    profile() {
        const { locale, timezoneId, navigatorPlatform, disableWebRTC } = this.config;
        return { locale, timezoneId, navigatorPlatform, disableWebRTC };
    }

    out(line = '') {
        this.stdout.write(`${line}\n`);
    }

    err(line = '') {
        this.stderr.write(`${line}\n`);
    }

    // ---------- 路径与状态 ----------

    statePath() { return path.join(this.runDir, 'state.json'); }
    tokenPath() { return path.join(this.runDir, 'token'); }
    logPath() { return path.join(this.runDir, 'server.log'); }
    hostConfigPath() { return path.join(this.root, 'host.json'); }

    ensureDirs() {
        for (const dir of [this.root, this.currentDir, this.runDir]) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
    }

    readState() {
        try {
            const state = JSON.parse(fs.readFileSync(this.statePath(), 'utf8'));
            return state && MODES.includes(state.mode) ? state : { mode: 'default' };
        } catch {
            return { mode: 'default' };
        }
    }

    writeState(state) {
        this.ensureDirs();
        writeConfigFileSecure(this.statePath(), `${JSON.stringify(state, null, 4)}\n`);
    }

    // token 首次生成后持久化，重启服务不换；只有 down 才会让它失效
    ensureToken() {
        this.ensureDirs();
        try {
            const token = fs.readFileSync(this.tokenPath(), 'utf8').trim();
            if (/^[0-9a-f]{64}$/.test(token)) {
                return token;
            }
        } catch {
            // 还没有，下面生成
        }
        const token = crypto.randomBytes(32).toString('hex');
        writeConfigFileSecure(this.tokenPath(), `${token}\n`);
        return token;
    }

    readPersisted(name) {
        try {
            return fs.readFileSync(path.join(this.runDir, name), 'utf8').trim();
        } catch {
            return '';
        }
    }

    ensureVncPassword() {
        const existing = this.readPersisted('vnc-password');
        if (existing) {
            return existing;
        }
        const password = randomAlnum(8);
        writeConfigFileSecure(path.join(this.runDir, 'vnc-password'), `${password}\n`);
        return password;
    }

    // ---------- 容器侧配置（挂载目录里的 config.json） ----------

    containerConfigFor(state, runtimeCommand) {
        const profile = this.profile();
        const host = connectHostFor(runtimeCommand);
        if (state.mode === 'chrome') {
            return fingerprint.buildContainerConfig('cdp', {
                ...profile,
                endpoint: `ws://${host}:${state.port}/${this.ensureToken()}`
            });
        }
        if (state.mode === 'headed' || state.mode === 'vnc') {
            return fingerprint.buildContainerConfig('ws', {
                ...profile,
                endpoint: `ws://${host}:${state.port}/${this.ensureToken()}`
            });
        }
        return fingerprint.buildContainerConfig('default', profile);
    }

    // 原子替换：目录挂载能看到 rename 之后的新文件
    writeCurrentConfig(state, runtimeCommand) {
        this.ensureDirs();
        const config = `${JSON.stringify(this.containerConfigFor(state, runtimeCommand), null, 4)}\n`;
        const initScript = fingerprint.buildInitScript(this.profile());
        const envFile = fingerprint.buildContainerEnvFile(this.profile());
        const configPath = path.join(this.currentDir, 'config.json');
        const initPath = path.join(this.currentDir, 'stealth.init.js');
        const envPath = path.join(this.currentDir, 'env');
        const same = (file, content) => {
            try {
                return fs.readFileSync(file, 'utf8') === content;
            } catch {
                return false;
            }
        };
        if (!same(initPath, initScript)) {
            writeConfigFileSecure(initPath, initScript);
        }
        if (!same(envPath, envFile)) {
            writeConfigFileSecure(envPath, envFile);
        }
        if (!same(configPath, config)) {
            writeConfigFileSecure(configPath, config);
        }
        return configPath;
    }

    // 宿主机上的 Agent 用的配置（路径与端点都是宿主机视角）
    writeHostConfig(state) {
        const profile = this.profile();
        const endpoint = `ws://127.0.0.1:${state.port}/${this.ensureToken()}`;
        const initPath = path.join(this.root, 'host.init.js');
        writeConfigFileSecure(initPath, fingerprint.buildInitScript(profile));
        const config = state.mode === 'chrome'
            ? fingerprint.buildContainerConfig('cdp', { endpoint })
            : fingerprint.buildContainerConfig('ws', { ...profile, endpoint });
        config.outputDir = path.join(os.tmpdir(), '.playwright-cli');
        if (config.browser.initScript) {
            config.browser.initScript = [initPath];
        }
        writeConfigFileSecure(this.hostConfigPath(), `${JSON.stringify(config, null, 4)}\n`);
        return this.hostConfigPath();
    }

    userDisplayPath(filePath) {
        return filePath.startsWith(`${this.homeDir}${path.sep}`) ? `~${filePath.slice(this.homeDir.length)}` : filePath;
    }

    // ---------- 容器集成（CLI 与 Web 共用） ----------

    // 模式是否真的还活着（只看进程与端口，足够快；真实探测见 probe）
    async modeAlive(state) {
        if (state.mode === 'default') {
            return true;
        }
        if (state.mode === 'vnc') {
            // 发布端口由运行时转发，容器没了端口也可能还能连上，所以看容器状态
            try {
                const inspect = this.runtimeCall(['inspect', '--format', '{{.State.Running}}', VNC_CONTAINER]);
                return inspect.status === 0 && inspect.stdout.trim() === 'true' && await portReady(state.port);
            } catch {
                return false;
            }
        }
        return pidIsOurs(state.pid) && await portReady(state.port);
    }

    // 返回 { env, volumes, extraArgs, warning }；永远不抛错，不因 playwright 让 run 退出
    async buildContainerIntegration({ runtimeCommand, envEntries = [], dryRun = false } = {}) {
        let warning = '';
        try {
            // 预览命令（dryRun）不写任何文件、不改状态
            if (!dryRun) {
                this.ensureDirs();
            }
            let state = this.readState();
            if (dryRun) {
                state = { mode: 'default' };
            } else if (!(await this.modeAlive(state))) {
                warning = `Playwright ${state.mode} 模式已失效，容器内浏览器已回退到默认模式。恢复: manyoyo playwright up ${state.mode}`;
                state = { mode: 'default' };
                this.writeState(state);
            }
            if (!dryRun) {
                this.writeCurrentConfig(state, runtimeCommand);
            }
        } catch (error) {
            return { env: [], volumes: [], extraArgs: [], warning: `Playwright 集成不可用: ${error.message || String(error)}` };
        }
        const noProxy = appendNoProxy(envEntryValue(envEntries, 'NO_PROXY') ?? envEntryValue(envEntries, 'no_proxy')
            ?? process.env.NO_PROXY ?? process.env.no_proxy);
        return {
            env: [
                `PLAYWRIGHT_MCP_CONFIG=${fingerprint.CONTAINER_CONFIG_PATH}`,
                'NO_UPDATE_NOTIFIER=1',
                `NO_PROXY=${noProxy}`,
                `no_proxy=${noProxy}`
            ],
            volumes: [`${this.currentDir}:${fingerprint.CONTAINER_CONFIG_DIR}:ro`],
            extraArgs: runtimeKind(runtimeCommand) === 'docker' ? ['--add-host', 'host.docker.internal:host-gateway'] : [],
            warning
        };
    }

    // ---------- 运行时与命令 ----------

    resolveRuntime() {
        if (!this.runtime) {
            const { selectContainerRuntime } = require('../container-runtime');
            this.runtime = selectContainerRuntime({ configured: this.rootGlobalConfig.containerRuntime });
        }
        return this.runtime;
    }

    runtimeCall(args, { capture = true } = {}) {
        const runtime = this.resolveRuntime();
        const result = spawnSync(runtime.command, args, {
            encoding: 'utf8',
            env: { ...process.env, ...runtime.env },
            stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
        });
        return {
            status: result.error ? 1 : (result.status === null ? 1 : result.status),
            stdout: result.stdout || '',
            stderr: result.stderr || (result.error ? String(result.error.message) : '')
        };
    }

    // 浏览器服务与探测用 patchright-core（去掉 CDP Runtime 痕迹的开源补丁版），
    // 版本与镜像内 @playwright/cli 的 playwright-core 同 minor，否则容器内 client 连宿主机服务会被 428 拒绝
    corePath() {
        return path.dirname(require.resolve('patchright-core/package.json'));
    }

    coreCli() {
        return path.join(this.corePath(), 'cli.js');
    }

    installCommand(args) {
        return `node ${shellValue(this.coreCli())} ${args}`;
    }

    // 宿主机是否装了 Google Chrome；不会替用户安装（需要 sudo）
    hasGoogleChrome() {
        return googleChromeCandidates().some(file => fs.existsSync(file));
    }

    installChromium() {
        const result = spawnSync(process.execPath, [this.coreCli(), 'install', '--no-shell', 'chromium'], { stdio: 'inherit' });
        if (result.status !== 0) {
            throw new Error(`浏览器安装失败，请手动执行: ${this.installCommand('install --no-shell chromium')}`);
        }
    }

    // 返回是否使用 Google Chrome；没有时退回 patchright 的 Chromium 并提示
    ensureBrowserInstalled() {
        if (this.hasGoogleChrome()) {
            return true;
        }
        this.out('[up] 未检测到 Google Chrome，使用 Chromium，部分检测站点会识别为 Chromium。安装 Google Chrome 后重新 up 即可。');
        this.installChromium();
        return false;
    }

    // ---------- 探测 ----------

    probe(kind, endpoint, timeout = PROBE_TIMEOUT_MS) {
        return new Promise(resolve => {
            const child = spawn(process.execPath, [path.join(__dirname, 'playwright-probe.js')], {
                env: {
                    ...process.env,
                    MANYOYO_PROBE: JSON.stringify({ core: this.corePath(), kind, endpoint, timeout })
                },
                stdio: ['ignore', 'pipe', 'ignore']
            });
            let output = '';
            const timer = setTimeout(() => child.kill('SIGKILL'), timeout + 3000);
            child.stdout.on('data', chunk => { output += chunk; });
            child.on('error', () => {
                clearTimeout(timer);
                resolve({ ok: false, error: '无法启动探测进程' });
            });
            child.on('close', () => {
                clearTimeout(timer);
                try {
                    resolve(JSON.parse(output.trim().split('\n').pop()));
                } catch {
                    resolve({ ok: false, error: '探测超时或无输出' });
                }
            });
        });
    }

    async probeState(state) {
        const endpoint = `ws://127.0.0.1:${state.port}/${this.ensureToken()}`;
        return state.mode === 'chrome'
            ? await this.probe('cdp', endpoint, CHROME_APPROVAL_TIMEOUT_MS)
            : await this.probe('ws', endpoint);
    }

    // ---------- 进程管理 ----------

    spawnDetached(command, args, logPath, env = process.env) {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        const logFd = fs.openSync(logPath, 'a', 0o600);
        const child = spawn(command, args, { detached: true, stdio: ['ignore', logFd, logFd], env });
        fs.closeSync(logFd);
        child.unref();
        return child;
    }

    async killGroup(pid, { verify = true } = {}) {
        if (verify ? !pidIsOurs(pid) : !pidAlive(pid)) {
            return;
        }
        for (const signal of ['SIGTERM', 'SIGKILL']) {
            try {
                process.kill(-pid, signal);
            } catch {
                try {
                    process.kill(pid, signal);
                } catch {
                    return;
                }
            }
            for (let i = 0; i < 20; i += 1) {
                if (!pidAlive(pid)) {
                    return;
                }
                // eslint-disable-next-line no-await-in-loop
                await sleep(100);
            }
        }
    }

    async waitForPort(port, child) {
        const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (child && child.exitCode !== null) {
                return false;
            }
            // eslint-disable-next-line no-await-in-loop
            if (await portReady(port)) {
                return true;
            }
            // eslint-disable-next-line no-await-in-loop
            await sleep(300);
        }
        return false;
    }

    async stopCurrent(state) {
        if (state.mode === 'vnc') {
            this.runtimeCall(['rm', '-f', VNC_CONTAINER]);
        } else if (state.mode === 'headed' || state.mode === 'chrome') {
            await this.killGroup(state.pid);
        }
    }

    // ---------- 各模式启动 ----------

    startFailure(mode, message, extra = '') {
        this.err(`[up] ${mode} 失败: ${message}`);
        if (extra) {
            this.err(extra);
        }
        return 1;
    }

    async portPreflight(mode, port) {
        if (await portReady(port)) {
            this.startFailure(mode, `端口 ${port} 已被占用。`,
                '换一个端口: 在 ~/.manyoyo/manyoyo.json 设置 "plugins": { "playwright": { "port": 9335 } }，或先停掉占用它的进程。');
            return false;
        }
        return true;
    }

    async startHeaded(extensionPaths) {
        if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
            return this.startFailure('headed', '当前没有图形界面（DISPLAY / WAYLAND_DISPLAY 为空）。', '没有桌面的机器请改用: manyoyo playwright up vnc');
        }
        const { port } = this.config;
        if (!(await this.portPreflight('headed', port))) {
            return 1;
        }
        let useChrome;
        try {
            useChrome = this.ensureBrowserInstalled();
        } catch (error) {
            return this.startFailure('headed', error.message);
        }
        const token = this.ensureToken();
        const serverConfigPath = path.join(this.runDir, 'server.json');
        // 优先开沙箱；系统禁止非特权用户命名空间（如 Ubuntu 23.10+ 的 AppArmor 限制）时退回无沙箱
        let child = null;
        for (const chromiumSandbox of [true, false]) {
            writeConfigFileSecure(serverConfigPath, `${JSON.stringify(fingerprint.buildServerConfig({
                host: headedListenHost(),
                port,
                wsPath: `/${token}`,
                chromiumSandbox,
                useChrome,
                extensionArgs: extensions.buildExtensionLaunchArgs(extensionPaths),
                ...this.profile()
            }), null, 4)}\n`);
            fs.rmSync(this.logPath(), { force: true });
            // 语言与时区放进浏览器进程的原生环境（合并而不是替换 process.env，代理等变量要保留）
            child = this.spawnDetached(process.execPath,
                [path.join(__dirname, 'playwright-server.js'), this.corePath(), serverConfigPath], this.logPath(),
                { ...process.env, ...fingerprint.buildProcessEnv(this.profile()) });
            if (await this.waitForPort(port, child)) {
                break;
            }
            await this.killGroup(child.pid, { verify: false });
            if (!chromiumSandbox || !tailText(this.logPath(), 200).includes('No usable sandbox')) {
                return this.startFailure('headed', '浏览器服务没有启动成功。',
                    `${tailText(this.logPath(), 20)}${useChrome ? '' : `\n缺系统依赖时执行: sudo ${this.installCommand('install-deps chromium')}`}`);
            }
            this.out('[up] 系统不允许非特权用户命名空间，浏览器沙箱不可用，改为无沙箱启动。');
        }
        return { mode: 'headed', port, pid: child.pid, listenHost: headedListenHost(), extensionPaths };
    }

    async startChrome() {
        const { port } = this.config;
        const candidates = this.devtoolsCandidates();
        const enableHint = '请在 Chrome 地址栏进入 chrome://inspect/#remote-debugging，勾选“Allow remote debugging”（Chrome 没开就先打开它），然后重试。\n'
            + '（自定义用户目录时，用 plugins.playwright.devtoolsActivePortPath 指定 DevToolsActivePort 文件。）';
        const target = findDevToolsActivePort(candidates);
        if (!target) {
            return this.startFailure('chrome', '没有找到开启了远程调试的 Chrome。', enableHint);
        }
        // Chrome 退出后会留下旧的 DevToolsActivePort，所以还要确认调试端口真的在监听
        if (!(await portReady(target.port))) {
            return this.startFailure('chrome', 'Chrome 没有在运行（只找到上次留下的调试端口记录）。', enableHint);
        }
        if (!(await this.portPreflight('chrome', port))) {
            return 1;
        }
        fs.rmSync(this.logPath(), { force: true });
        const relayConfigPath = path.join(this.runDir, 'relay.json');
        writeConfigFileSecure(relayConfigPath, `${JSON.stringify({
            host: defaultListenHost(), port, token: this.ensureToken(), candidates
        }, null, 4)}\n`);
        const child = this.spawnDetached(process.execPath,
            [path.join(__dirname, 'playwright-relay.js'), relayConfigPath], this.logPath());
        if (!(await this.waitForPort(port, child))) {
            await this.killGroup(child.pid, { verify: false });
            return this.startFailure('chrome', '中继没有启动成功。', tailText(this.logPath(), 20));
        }
        return { mode: 'chrome', port, pid: child.pid, listenHost: defaultListenHost() };
    }

    devtoolsCandidates() {
        const h = this.homeDir;
        const local = path.join(h, 'AppData', 'Local');
        return [
            this.config.devtoolsActivePortPath,
            path.join(h, 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort'),
            path.join(h, 'Library', 'Application Support', 'Google', 'Chrome Canary', 'DevToolsActivePort'),
            path.join(h, 'Library', 'Application Support', 'Chromium', 'DevToolsActivePort'),
            path.join(h, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'DevToolsActivePort'),
            path.join(h, '.config', 'google-chrome', 'DevToolsActivePort'),
            path.join(h, '.config', 'google-chrome-beta', 'DevToolsActivePort'),
            path.join(h, '.config', 'google-chrome-unstable', 'DevToolsActivePort'),
            path.join(h, '.config', 'chromium', 'DevToolsActivePort'),
            path.join(h, '.config', 'BraveSoftware', 'Brave-Browser', 'DevToolsActivePort'),
            path.join(local, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort'),
            path.join(local, 'Google', 'Chrome Beta', 'User Data', 'DevToolsActivePort'),
            path.join(local, 'Chromium', 'User Data', 'DevToolsActivePort'),
            path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data', 'DevToolsActivePort')
        ].filter(Boolean);
    }

    baseImageRef() {
        const global = this.rootGlobalConfig;
        const run = this.rootRunConfig;
        const name = String(run.imageName || global.imageName || 'ghcr.io/xcanwin/manyoyo').trim();
        const version = String(run.imageVersion || global.imageVersion || require('../../package.json').imageVersion).trim();
        return { name, version, ref: `${name}:${version}` };
    }

    // vnc 容器直接用当前 manyoyo 镜像（已带 xvfb / x11vnc / noVNC），不需要额外构建
    ensureBaseImage() {
        const { ref } = this.baseImageRef();
        if (this.runtimeCall(['image', 'inspect', '--format', '{{.Id}}', ref]).status !== 0) {
            throw new Error(`镜像 ${ref} 不存在，请先运行一次 manyoyo run 拉取或构建镜像。`);
        }
        return ref;
    }

    async startVnc(extensionPaths) {
        const { port, vncPort, novncPort } = this.config;
        for (const item of [port, vncPort, novncPort]) {
            if (await portReady(item)) {
                return this.startFailure('vnc', `端口 ${item} 已被占用。`,
                    '在 ~/.manyoyo/manyoyo.json 的 plugins.playwright 里改 port / vncPort / novncPort，或先停掉占用它的进程。');
            }
        }
        let image;
        try {
            image = this.ensureBaseImage();
        } catch (error) {
            return this.startFailure('vnc', error.message);
        }
        const token = this.ensureToken();
        const password = this.ensureVncPassword();
        const mountDir = path.join(this.runDir, 'vnc');
        fs.mkdirSync(mountDir, { recursive: true, mode: 0o700 });
        const mounts = extensions.buildContainerExtensionMounts(extensionPaths);
        for (const name of ['vnc-entry.sh', 'playwright-server.js']) {
            const source = path.join(name === 'vnc-entry.sh' ? VNC_ASSET_DIR : __dirname, name);
            writeConfigFileSecure(path.join(mountDir, name), fs.readFileSync(source, 'utf8'));
        }
        writeConfigFileSecure(path.join(mountDir, 'server.json'), `${JSON.stringify(fingerprint.buildServerConfig({
            host: '0.0.0.0',
            port,
            wsPath: `/${token}`,
            window: 'virtual',
            chromiumSandbox: false,
            extensionArgs: extensions.buildExtensionLaunchArgs(mounts.containerPaths),
            ...this.profile()
        }), null, 4)}\n`);
        const envFile = path.join(mountDir, 'env');
        const noProxy = appendNoProxy(process.env.NO_PROXY ?? process.env.no_proxy);
        const nativeEnv = Object.entries(fingerprint.buildProcessEnv(this.profile())).map(([key, value]) => `${key}=${value}\n`).join('');
        writeConfigFileSecure(envFile, `VNC_PASSWORD=${password}\nNO_PROXY=${noProxy}\nno_proxy=${noProxy}\n${nativeEnv}`);
        this.runtimeCall(['rm', '-f', VNC_CONTAINER]);
        const listenHost = defaultListenHost();
        const args = [
            'run', '-d', '--name', VNC_CONTAINER,
            '--env-file', envFile,
            '--publish', `${listenHost}:${port}:${port}`,
            '--publish', `127.0.0.1:${vncPort}:5900`,
            '--publish', `127.0.0.1:${novncPort}:6080`,
            '--volume', `${mountDir}:${VNC_MOUNT_DIR}:ro`,
            ...mounts.volumes.flatMap(volume => ['--volume', volume]),
            '--entrypoint', 'sh',
            image, `${VNC_MOUNT_DIR}/vnc-entry.sh`
        ];
        const run = this.runtimeCall(args);
        if (run.status !== 0) {
            return this.startFailure('vnc', '容器启动失败。', run.stderr.trim());
        }
        // 发布端口由运行时转发，容器没起来时 TCP 也能连上，所以以浏览器服务打印的 ready 为准
        const isReady = () => /^ready$/m.test(this.runtimeCall(['logs', '--tail', '200', VNC_CONTAINER]).stdout);
        let started = false;
        for (let i = 0; i < 100 && !started; i += 1) {
            started = isReady();
            if (!started) {
                // eslint-disable-next-line no-await-in-loop
                await sleep(300);
            }
        }
        if (!started) {
            const logs = this.runtimeCall(['logs', '--tail', '30', VNC_CONTAINER]);
            this.runtimeCall(['rm', '-f', VNC_CONTAINER]);
            return this.startFailure('vnc', '浏览器服务没有启动成功。', `${logs.stdout}${logs.stderr}`.trim());
        }
        return { mode: 'vnc', port, container: VNC_CONTAINER, listenHost, novncPort, vncPort, extensionPaths };
    }

    novncUrl() {
        return `http://127.0.0.1:${this.config.novncPort}/vnc.html?autoconnect=1&resize=scale&password=${this.readPersisted('vnc-password')}`;
    }

    // ---------- 命令 ----------

    printOverview() {
        this.out('Playwright 浏览器模式（同一时间只有一个）:');
        for (const [name, desc] of MODE_HELP) {
            this.out(`  ${name.padEnd(8)}${desc}`);
        }
        this.out('');
        this.out('用法: manyoyo playwright up <headed|chrome|vnc>    切换模式');
        this.out('      manyoyo playwright down                     回到默认模式');
        this.out('      manyoyo playwright status                   查看当前模式与真实可用性');
    }

    printUsage(state) {
        this.out('');
        this.out('容器内 Agent: 自动生效，直接 manyoyo run；已打开浏览器的会话先执行 playwright-cli close 再重新 open。');
        if (state.mode === 'default') {
            return;
        }
        const configPath = this.userDisplayPath(this.writeHostConfig(state));
        this.out(`宿主机上的 Agent: PLAYWRIGHT_MCP_CONFIG=${shellValue(configPath)} claude`);
        if (state.mode === 'vnc') {
            this.out(`noVNC 观看: ${this.novncUrl()}`);
            this.out(`原生 VNC: 127.0.0.1:${state.vncPort}（密码见 manyoyo playwright status）`);
        }
        if (state.mode === 'chrome') {
            this.out('⚠️  风险: 容器内 Agent 能操作你 Chrome 里已登录的所有网站。Chrome 每次新连接（每次 playwright-cli open、每次 status）都会弹出“要允许远程调试吗？”，请点“允许”。');
        }
        if (state.mode !== 'default' && !(process.platform === 'darwin' && state.mode !== 'headed')) {
            this.out(`安全: 端口 ${state.port} 监听 0.0.0.0，仅靠 token 保护；建议用防火墙限制来源。`);
        }
    }

    async up(mode, { extensionPaths = [], extensionNames = [] } = {}) {
        if (!MODES.includes(mode)) {
            this.printOverview();
            if (mode) {
                this.err('');
                this.err(`未知模式: ${mode}，可用: ${MODES.join(', ')}`);
            }
            return 1;
        }
        const extPaths = extensions.resolveExtensionInputs(this.root, { extensionPaths, extensionNames });
        if (extPaths.length > 0 && mode === 'chrome') {
            this.err('chrome 模式控制的是你自己的 Chrome，不支持 --ext-path / --ext-name；扩展只支持 headed、vnc。');
            return 1;
        }
        this.ensureDirs();
        await this.stopCurrent(this.readState());
        this.writeState({ mode: 'default' });

        const started = mode === 'headed' ? await this.startHeaded(extPaths)
            : mode === 'chrome' ? await this.startChrome()
                : await this.startVnc(extPaths);
        if (typeof started === 'number') {
            this.writeCurrentConfig({ mode: 'default' }, this.runtimeCommand());
            return started;
        }
        const state = { ...started, startedAt: new Date().toISOString() };
        this.writeState(state);
        this.writeCurrentConfig(state, this.runtimeCommand());

        if (mode === 'chrome') {
            this.out('等待 Chrome 确认：请在 Chrome 弹出的“要允许远程调试吗？”里点“允许”（最多等 60 秒）…');
        }
        const result = await this.probeState(state);
        if (!result.ok) {
            if (mode === 'chrome') {
                this.err('[up] chrome 失败: 连不上 Chrome 的调试接口。');
                this.err('请确认已在 chrome://inspect/#remote-debugging 开启远程调试，并在 Chrome 弹出的“要允许远程调试吗？”里点“允许”（60 秒内），然后重试。');
            } else {
                this.err(`[up] ${mode} 失败: 浏览器服务已启动，但打不开页面（${result.error}）。`);
                this.err(tailText(this.logPath(), 10));
            }
            // 回滚：不让坏掉的模式留在配置里
            await this.stopCurrent(state);
            this.writeState({ mode: 'default' });
            this.writeCurrentConfig({ mode: 'default' }, this.runtimeCommand());
            this.err('已回到默认模式。');
            return 1;
        }
        this.out(`✅ ${mode} 模式已就绪（真实探测通过，${result.ms}ms）`);
        this.printUsage(state);
        return 0;
    }

    runtimeCommand() {
        try {
            return this.resolveRuntime().command;
        } catch {
            return 'docker';
        }
    }

    async down() {
        const state = this.readState();
        await this.stopCurrent(state);
        this.ensureDirs();
        fs.rmSync(this.tokenPath(), { force: true });
        fs.rmSync(this.hostConfigPath(), { force: true });
        this.writeState({ mode: 'default' });
        this.writeCurrentConfig({ mode: 'default' }, this.runtimeCommand());
        this.out(state.mode === 'default'
            ? '当前已是默认模式（容器内虚拟屏里的有头浏览器）。'
            : `已停止 ${state.mode} 模式，回到默认模式；已打开浏览器的容器会话先 playwright-cli close 再重新 open。`);
        return 0;
    }

    // 配置文件被删（或整个目录被删）时重建；返回是否重建过
    ensureCurrentFiles(state) {
        const missing = ['config.json', 'stealth.init.js'].some(name => !fs.existsSync(path.join(this.currentDir, name)));
        if (missing) {
            this.writeCurrentConfig(state, this.runtimeCommand());
        }
        return missing;
    }

    async status() {
        let state = this.readState();
        if (this.ensureCurrentFiles(state)) {
            this.out('[status] 容器内浏览器的配置文件缺失，已重建；运行中的容器会自动恢复（整个 ~/.manyoyo/plugin/playwright 目录被删过的容器需要重建）。');
        }
        if (state.mode === 'default') {
            this.out('当前模式: default（容器内虚拟屏里的有头浏览器，无需宿主机进程）');
            this.out('想换模式: manyoyo playwright   查看全部模式');
            return 0;
        }
        this.out(`当前模式: ${state.mode}（端口 ${state.port}${state.pid ? `，pid ${state.pid}` : ''}）`);
        const alive = await this.modeAlive(state);
        const result = alive ? await this.probeState(state) : { ok: false, error: state.mode === 'vnc' ? 'vnc 容器没有在运行' : '浏览器服务进程已不在' };
        if (result.ok) {
            this.out(`真实探测: 通过（${result.ms}ms）`);
            if (state.mode === 'vnc') {
                this.out(`noVNC: ${this.novncUrl()}`);
            }
            return 0;
        }
        this.err(`真实探测: 失败（${result.error}）`);
        state = { mode: 'default' };
        this.writeState(state);
        this.writeCurrentConfig(state, this.runtimeCommand());
        this.err('已把容器内浏览器回退到默认模式。恢复: manyoyo playwright up <headed|chrome|vnc>；排查: manyoyo playwright logs');
        return 1;
    }

    logs() {
        const state = this.readState();
        if (state.mode === 'vnc') {
            const logs = this.runtimeCall(['logs', '--tail', '80', VNC_CONTAINER]);
            this.out(`${logs.stdout}${logs.stderr}`.trimEnd() || '[logs] 没有日志');
            return logs.status === 0 ? 0 : 1;
        }
        this.out(tailText(this.logPath(), 80).trimEnd() || '[logs] 没有日志');
        return 0;
    }

    // 想用 MCP 的 Agent：在容器内以 stdio 注册，读同一个 $PLAYWRIGHT_MCP_CONFIG，自动跟随当前模式
    mcpAdd() {
        this.out('# 在容器内执行（playwright-mcp 随当前模式自动切换，无需重新注册）');
        this.out('claude mcp add -s user playwright -- playwright-mcp');
        this.out('codex mcp add playwright -- playwright-mcp');
        this.out('gemini mcp add -s user playwright playwright-mcp');
        return 0;
    }

    async run({ action, mode = '', extensionPaths = [], extensionNames = [], prodversion = '' }) {
        if (action === 'overview') {
            this.printOverview();
            return await this.status();
        }
        if (action === 'up') {
            return await this.up(mode, { extensionPaths, extensionNames });
        }
        if (action === 'down') {
            return await this.down();
        }
        if (action === 'status') {
            return await this.status();
        }
        if (action === 'logs') {
            return this.logs();
        }
        if (action === 'mcp-add') {
            return this.mcpAdd();
        }
        if (action === 'ext-download') {
            return await extensions.downloadExtensions({
                pluginRoot: this.root,
                prodversion: prodversion || this.config.extensionProdversion,
                log: line => this.out(line),
                logError: line => this.err(line)
            });
        }
        throw new Error(`未知 playwright 动作: ${action}`);
    }
}

module.exports = {
    MODES,
    PlaywrightPlugin,
    appendNoProxy,
    connectHostFor,
    defaultListenHost,
    googleChromeCandidates,
    headedListenHost
};
