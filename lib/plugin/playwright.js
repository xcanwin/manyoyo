'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { playwrightCliVersion: PLAYWRIGHT_CLI_VERSION } = require('../../package.json');
const { PlaywrightExtensionManager } = require('./playwright-extension-manager');
const { createPlaywrightExtensionPathManager } = require('./playwright-extension-paths');
const { createPlaywrightBootstrapManager } = require('./playwright-bootstrap');
const { createPlaywrightSceneConfigManager } = require('./playwright-scene-config');
const { createPlaywrightSceneDrivers } = require('./playwright-scene-drivers');
const { createPlaywrightSceneStateManager } = require('./playwright-scene-state');

const EXTENSIONS = [
    ['ublock-origin-lite', 'ddkjiahejlhfcafbddmgiahcphecmpfh'],
    ['adguard', 'bgnkhhnnamicmpeenaelnjfhikgbkllg'],
    ['privacy-badger', 'pkehgijcmpdhfbdbbnkijodmdjhbjlgp'],
    ['webrtc-leak-shield', 'bppamachkoflopbagkdoflbgfjflfnfl'],
    ['webgl-fingerprint-defender', 'olnbjpaejebpnokblkepbphhembdicik']
];

const SCENE_ORDER = ['mcp-cont-headless', 'mcp-cont-headed', 'mcp-host-headless', 'mcp-host-headed', 'cli-host-headless', 'cli-host-headed'];

const SCENE_DEFS = {
    'mcp-cont-headless': {
        type: 'container',
        engine: 'mcp',
        configFile: 'mcp-cont-headless.json',
        composeFile: 'compose-headless.yaml',
        projectName: 'my-playwright-mcp-cont-headless',
        containerName: 'my-playwright-mcp-cont-headless',
        portKey: 'mcpContHeadless',
        headless: true,
        listenHost: '0.0.0.0'
    },
    'mcp-cont-headed': {
        type: 'container',
        engine: 'mcp',
        configFile: 'mcp-cont-headed.json',
        composeFile: 'compose-headed.yaml',
        projectName: 'my-playwright-mcp-cont-headed',
        containerName: 'my-playwright-mcp-cont-headed',
        portKey: 'mcpContHeaded',
        headless: false,
        listenHost: '0.0.0.0'
    },
    'mcp-host-headless': {
        type: 'host',
        engine: 'mcp',
        configFile: 'mcp-host-headless.json',
        portKey: 'mcpHostHeadless',
        headless: true,
        listenHost: '127.0.0.1'
    },
    'mcp-host-headed': {
        type: 'host',
        engine: 'mcp',
        configFile: 'mcp-host-headed.json',
        portKey: 'mcpHostHeaded',
        headless: false,
        listenHost: '127.0.0.1'
    },
    'cli-host-headless': {
        type: 'host',
        engine: 'cli',
        configFile: 'cli-host-headless.json',
        portKey: 'cliHostHeadless',
        headless: true,
        listenHost: '0.0.0.0'
    },
    'cli-host-headed': {
        type: 'host',
        engine: 'cli',
        configFile: 'cli-host-headed.json',
        portKey: 'cliHostHeaded',
        headless: false,
        listenHost: '0.0.0.0'
    }
};

const VALID_RUNTIME = new Set(['container', 'host', 'mixed']);
const VALID_ACTIONS = new Set(['up', 'down', 'status', 'health', 'logs']);
const DIRECT_ACTION_HANDLERS = {
    ls: (plugin) => plugin.printSummary(),
    'mcp-add': (plugin, options) => plugin.printMcpAdd(options.host),
    'cli-add': (plugin) => plugin.printCliAdd(),
    'ext-download': (plugin, options) => plugin.downloadExtensions({ prodversion: options.prodversion })
};
const CONTAINER_EXTENSION_ROOT = '/app/extensions';
const DEFAULT_FINGERPRINT_PROFILE = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    acceptLanguage: 'zh-CN,zh;q=0.9',
    timezoneId: 'Asia/Shanghai',
    width: 1366,
    height: 768
};
const DISABLE_WEBRTC_LAUNCH_ARGS = ['--disable-webrtc'];

function isMcpScene(sceneName) {
    return Boolean(SCENE_DEFS[sceneName] && SCENE_DEFS[sceneName].engine === 'mcp');
}

function isCliScene(sceneName) {
    return Boolean(SCENE_DEFS[sceneName] && SCENE_DEFS[sceneName].engine === 'cli');
}

function platformFromUserAgent(userAgent) {
    const ua = String(userAgent || '').toLowerCase();
    if (ua.includes('macintosh') || ua.includes('mac os x')) {
        return 'MacIntel';
    }
    if (ua.includes('windows')) {
        return 'Win32';
    }
    if (ua.includes('android') || ua.includes('linux')) {
        return 'Linux x86_64';
    }
    return 'MacIntel';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function tailText(filePath, lineCount) {
    if (!fs.existsSync(filePath)) {
        return '';
    }
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    return lines.slice(-lineCount).join('\n');
}

function asObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value;
}

function asStringArray(value, fallback) {
    if (!Array.isArray(value)) {
        return fallback;
    }
    return value
        .map(item => String(item || '').trim())
        .filter(Boolean);
}

function asBoolean(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') {
            return true;
        }
        if (normalized === 'false') {
            return false;
        }
    }
    return fallback;
}

class PlaywrightPlugin {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot || path.join(__dirname, '..', '..');
        this.stdout = options.stdout || process.stdout;
        this.stderr = options.stderr || process.stderr;
        this.globalConfig = asObject(options.globalConfig);
        this.runConfig = asObject(options.runConfig);
        this.config = this.resolveConfig();
        this.extensionManager = new PlaywrightExtensionManager({
            extensions: EXTENSIONS,
            ensureCommandAvailable: this.ensureCommandAvailable.bind(this),
            runCmd: this.runCmd.bind(this),
            writeStdout: this.writeStdout.bind(this),
            writeStderr: this.writeStderr.bind(this),
            extensionDirPath: this.extensionDirPath.bind(this),
            extensionTmpDirPath: this.extensionTmpDirPath.bind(this),
            defaultProdversion: this.config.extensionProdversion
        });
        this.extensionPathManager = createPlaywrightExtensionPathManager({
            plugin: this,
            asStringArray,
            containerExtensionRoot: CONTAINER_EXTENSION_ROOT
        });
        this.bootstrapManager = createPlaywrightBootstrapManager({
            plugin: this,
            isCliScene
        });
        this.sceneConfigManager = createPlaywrightSceneConfigManager({
            plugin: this,
            sceneDefs: SCENE_DEFS,
            isCliScene,
            asStringArray,
            defaultFingerprintProfile: DEFAULT_FINGERPRINT_PROFILE,
            disableWebRtcLaunchArgs: DISABLE_WEBRTC_LAUNCH_ARGS
        });
        this.sceneStateManager = createPlaywrightSceneStateManager({
            plugin: this
        });
        this.sceneDrivers = createPlaywrightSceneDrivers({
            plugin: this,
            sceneDefs: SCENE_DEFS,
            isCliScene,
            asStringArray,
            tailText,
            sleep
        });
    }

    resolveConfig() {
        const homeDir = os.homedir();
        const pluginRootDir = path.join(homeDir, '.manyoyo', 'plugin', 'playwright');
        const defaultConfig = {
            homeDir,
            runtime: 'mixed',
            enabledScenes: [...SCENE_ORDER],
            cliSessionScene: 'cli-host-headless',
            mcpDefaultHost: 'host.docker.internal',
            dockerTag: process.env.PLAYWRIGHT_MCP_DOCKER_TAG || 'latest',
            containerRuntime: '',
            vncPasswordEnvKey: 'VNC_PASSWORD',
            headedImage: 'localhost/xcanwin/manyoyo-playwright-headed',
            configDir: path.join(pluginRootDir, 'config'),
            runDir: path.join(pluginRootDir, 'run'),
            extensionProdversion: '132.0.0.0',
            navigatorPlatform: platformFromUserAgent(DEFAULT_FINGERPRINT_PROFILE.userAgent),
            disableWebRTC: false,
            composeDir: path.join(__dirname, 'playwright-assets'),
            ports: {
                mcpContHeadless: 8931,
                mcpContHeaded: 8932,
                mcpHostHeadless: 8933,
                mcpHostHeaded: 8934,
                cliHostHeadless: 8935,
                cliHostHeaded: 8936,
                mcpContHeadedNoVnc: 6080
            }
        };

        const merged = {
            ...defaultConfig,
            ...this.globalConfig,
            ...this.runConfig,
            ports: {
                ...defaultConfig.ports,
                ...asObject(this.globalConfig.ports),
                ...asObject(this.runConfig.ports)
            }
        };

        merged.runtime = String(merged.runtime || defaultConfig.runtime).trim().toLowerCase();
        if (!VALID_RUNTIME.has(merged.runtime)) {
            throw new Error(`playwright.runtime 无效: ${merged.runtime}`);
        }

        merged.enabledScenes = asStringArray(
            this.runConfig.enabledScenes,
            asStringArray(this.globalConfig.enabledScenes, [...defaultConfig.enabledScenes])
        );
        merged.containerRuntime = this.resolveContainerRuntime(merged.containerRuntime);
        merged.cliSessionScene = String(merged.cliSessionScene || defaultConfig.cliSessionScene).trim();
        merged.navigatorPlatform = String(merged.navigatorPlatform || defaultConfig.navigatorPlatform).trim() || defaultConfig.navigatorPlatform;
        merged.disableWebRTC = asBoolean(merged.disableWebRTC, defaultConfig.disableWebRTC);

        if (merged.enabledScenes.length === 0) {
            throw new Error('playwright.enabledScenes 不能为空');
        }

        const invalidScene = merged.enabledScenes.find(scene => !SCENE_DEFS[scene]);
        if (invalidScene) {
            throw new Error(`playwright.enabledScenes 包含未知场景: ${invalidScene}`);
        }
        if (merged.cliSessionScene && !isCliScene(merged.cliSessionScene)) {
            throw new Error(`playwright.cliSessionScene 无效: ${merged.cliSessionScene}`);
        }

        return merged;
    }

    resolveContainerRuntime(configuredRuntime) {
        const configured = String(configuredRuntime || '').trim().toLowerCase();
        if (configured) {
            return configured;
        }

        const candidates = ['docker', 'podman'];
        for (const cmd of candidates) {
            if (this.ensureCommandAvailable(cmd)) {
                return cmd;
            }
        }

        return 'docker';
    }

    writeStdout(line = '') {
        this.stdout.write(`${line}\n`);
    }

    writeStderr(line = '') {
        this.stderr.write(`${line}\n`);
    }

    remindCliSessionScene(sceneName) {
        if (!isCliScene(sceneName)) {
            return;
        }
        if (sceneName !== 'cli-host-headed') {
            return;
        }
        if (this.config.cliSessionScene === sceneName) {
            return;
        }
        this.writeStdout('[tip] 如果希望容器内 manyoyo run 自动附着到当前 CLI 宿主场景，请在 ~/.manyoyo/manyoyo.json 中设置:');
        this.writeStdout('{');
        this.writeStdout('    "volumes": [');
        this.writeStdout('        "~/.manyoyo/.cache/ms-playwright:/root/.cache/ms-playwright"');
        this.writeStdout('    ],');
        this.writeStdout('    "plugins": {');
        this.writeStdout('        "playwright": {');
        this.writeStdout('            "cliSessionScene": "cli-host-headed"');
        this.writeStdout('        }');
        this.writeStdout('    }');
        this.writeStdout('}');
    }

    randomAlnum(length = 16) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let out = '';
        for (let i = 0; i < length; i += 1) {
            out += chars[crypto.randomInt(0, chars.length)];
        }
        return out;
    }

    runCmd(args, { env = null, captureOutput = false, check = true } = {}) {
        const result = spawnSync(args[0], args.slice(1), {
            encoding: 'utf8',
            env: env || process.env,
            stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit'
        });

        const completed = {
            returncode: result.status === null ? 1 : result.status,
            stdout: typeof result.stdout === 'string' ? result.stdout : '',
            stderr: typeof result.stderr === 'string' ? result.stderr : ''
        };

        if (result.error) {
            if (check) {
                throw result.error;
            }
            completed.returncode = 1;
            return completed;
        }

        if (check && completed.returncode !== 0) {
            const error = new Error(`command failed with exit code ${completed.returncode}`);
            error.returncode = completed.returncode;
            error.stdout = completed.stdout;
            error.stderr = completed.stderr;
            throw error;
        }

        return completed;
    }

    ensureCommandAvailable(command) {
        const name = String(command || '').trim();
        if (!/^[A-Za-z0-9._-]+$/.test(name)) {
            return false;
        }
        const result = spawnSync('sh', ['-c', `command -v ${name}`], {
            encoding: 'utf8',
            stdio: ['ignore', 'ignore', 'ignore']
        });
        return result.status === 0;
    }

    scenePort(sceneName) {
        const def = SCENE_DEFS[sceneName];
        return Number(this.config.ports[def.portKey]);
    }

    sceneConfigPath(sceneName) {
        const def = SCENE_DEFS[sceneName];
        return path.join(this.config.configDir, def.configFile);
    }

    sceneConfigMissing(sceneName) {
        return !fs.existsSync(this.sceneConfigPath(sceneName));
    }

    sceneEndpointPath(sceneName) {
        return this.sceneStateManager.sceneEndpointPath(sceneName);
    }

    readSceneEndpoint(sceneName) {
        return this.sceneStateManager.readSceneEndpoint(sceneName);
    }

    writeSceneEndpoint(sceneName, payload) {
        this.sceneStateManager.writeSceneEndpoint(sceneName, payload);
    }

    removeSceneEndpoint(sceneName) {
        this.sceneStateManager.removeSceneEndpoint(sceneName);
    }

    sceneCliAttachConfigPath(sceneName) {
        return this.sceneStateManager.sceneCliAttachConfigPath(sceneName);
    }

    writeSceneCliAttachConfig(sceneName, payload) {
        this.sceneStateManager.writeSceneCliAttachConfig(sceneName, payload);
    }

    removeSceneCliAttachConfig(sceneName) {
        this.sceneStateManager.removeSceneCliAttachConfig(sceneName);
    }

    sceneInitScriptPath(sceneName) {
        const configFile = path.basename(this.sceneConfigPath(sceneName), '.json');
        return path.join(this.config.configDir, `${configFile}.init.js`);
    }

    buildInitScriptContent() {
        return this.bootstrapManager.buildInitScriptContent();
    }

    ensureSceneInitScript(sceneName) {
        return this.bootstrapManager.ensureSceneInitScript(sceneName);
    }

    defaultBrowserName(sceneName) {
        return this.bootstrapManager.defaultBrowserName(sceneName);
    }

    ensureContainerScenePrerequisites(sceneName) {
        this.bootstrapManager.ensureContainerScenePrerequisites(sceneName);
    }

    ensureHostScenePrerequisites(sceneName) {
        this.bootstrapManager.ensureHostScenePrerequisites(sceneName);
    }

    scenePidFile(sceneName) {
        return path.join(this.config.runDir, `${sceneName}.pid`);
    }

    sceneLogFile(sceneName) {
        return path.join(this.config.runDir, `${sceneName}.log`);
    }

    localBinPath(binName) {
        return this.bootstrapManager.localBinPath(binName);
    }

    playwrightBinPath(sceneName) {
        return this.bootstrapManager.playwrightBinPath(sceneName);
    }

    extensionDirPath() {
        return path.join(this.config.homeDir, '.manyoyo', 'plugin', 'playwright', 'extensions');
    }

    extensionTmpDirPath() {
        return path.join(this.config.homeDir, '.manyoyo', 'plugin', 'playwright', 'tmp-crx');
    }

    cliBrowserCacheDirPath() {
        return path.join(this.config.homeDir, '.manyoyo', '.cache', 'ms-playwright');
    }

    ensureCliHostHeadedCacheDir(sceneName) {
        if (sceneName !== 'cli-host-headed') {
            return;
        }
        fs.mkdirSync(this.cliBrowserCacheDirPath(), { recursive: true });
    }

    resolveTargets(sceneName = 'all') {
        const requested = String(sceneName || 'all').trim();
        const enabledSet = new Set(this.config.enabledScenes);
        const runtime = this.config.runtime;

        const isAllowedByRuntime = (scene) => {
            const type = SCENE_DEFS[scene].type;
            if (runtime === 'mixed') {
                return true;
            }
            return runtime === type;
        };

        if (requested !== 'all') {
            if (!SCENE_DEFS[requested]) {
                throw new Error(`未知场景: ${requested}`);
            }
            if (!enabledSet.has(requested)) {
                throw new Error(`场景未启用: ${requested}`);
            }
            if (!isAllowedByRuntime(requested)) {
                throw new Error(`当前 runtime=${runtime}，不允许场景: ${requested}`);
            }
            return [requested];
        }

        return SCENE_ORDER
            .filter(scene => enabledSet.has(scene))
            .filter(scene => isAllowedByRuntime(scene));
    }

    resolveExtensionPaths(extensionArgs = []) {
        return this.extensionPathManager.resolveExtensionPaths(extensionArgs);
    }

    resolveNamedExtensionPaths(extensionNames = []) {
        return this.extensionPathManager.resolveNamedExtensionPaths(extensionNames);
    }

    resolveExtensionInputs(options = {}) {
        return this.extensionPathManager.resolveExtensionInputs(options);
    }

    buildExtensionLaunchArgs(extensionPaths) {
        return this.sceneConfigManager.buildExtensionLaunchArgs(extensionPaths);
    }

    sanitizeExtensionMountName(value) {
        return this.extensionPathManager.sanitizeExtensionMountName(value);
    }

    buildContainerExtensionMounts(extensionPaths = []) {
        return this.extensionPathManager.buildContainerExtensionMounts(extensionPaths);
    }

    baseLaunchArgs() {
        return this.sceneConfigManager.baseLaunchArgs();
    }

    buildSceneLaunchArgs(extensionPaths = []) {
        return this.sceneConfigManager.buildSceneLaunchArgs(extensionPaths);
    }

    buildMcpSceneConfig(sceneName, options = {}) {
        return this.sceneConfigManager.buildMcpSceneConfig(sceneName, options);
    }

    buildCliSceneConfig(sceneName, options = {}) {
        return this.sceneConfigManager.buildCliSceneConfig(sceneName, options);
    }

    buildSceneConfig(sceneName, options = {}) {
        return this.sceneConfigManager.buildSceneConfig(sceneName, options);
    }

    writeSceneConfigFile(sceneName, payload) {
        return this.sceneConfigManager.writeSceneConfigFile(sceneName, payload);
    }

    ensureSceneConfig(sceneName, options = {}) {
        return this.sceneConfigManager.ensureSceneConfig(sceneName, options);
    }

    async portReady(port) {
        return await new Promise((resolve) => {
            let settled = false;
            const socket = net.createConnection({ host: '127.0.0.1', port });

            const finish = (value) => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                resolve(value);
            };

            socket.setTimeout(300);
            socket.once('connect', () => finish(true));
            socket.once('timeout', () => finish(false));
            socket.once('error', () => finish(false));
        });
    }

    async waitForPort(port) {
        for (let i = 0; i < 60; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            if (await this.portReady(port)) {
                return true;
            }
            // eslint-disable-next-line no-await-in-loop
            await sleep(500);
        }
        return false;
    }

    containerEnv(sceneName, cfgPath, options = {}) {
        const def = SCENE_DEFS[sceneName];
        const requireVncPassword = options.requireVncPassword === true;
        const env = {
            ...process.env,
            PLAYWRIGHT_MCP_DOCKER_TAG: this.config.dockerTag,
            PLAYWRIGHT_MCP_PORT: String(this.scenePort(sceneName)),
            PLAYWRIGHT_MCP_CONFIG_PATH: cfgPath,
            PLAYWRIGHT_MCP_CONTAINER_NAME: def.containerName,
            PLAYWRIGHT_MCP_IMAGE: this.config.headedImage,
            PLAYWRIGHT_MCP_NOVNC_PORT: String(this.config.ports.mcpContHeadedNoVnc)
        };

        if (sceneName === 'mcp-cont-headed') {
            const envKey = this.config.vncPasswordEnvKey;
            let password = process.env[envKey];
            if (!password) {
                password = this.randomAlnum(16);
                if (requireVncPassword) {
                    this.writeStdout(`[up] mcp-cont-headed ${envKey} not set; generated random 16-char password: ${password}`);
                }
            }
            env.VNC_PASSWORD = password;
        }

        return env;
    }

    containerComposePath(sceneName) {
        const def = SCENE_DEFS[sceneName];
        return path.join(this.config.composeDir, def.composeFile);
    }

    sceneComposeOverridePath(sceneName) {
        return path.join(this.config.runDir, `${sceneName}.compose.override.yaml`);
    }

    ensureContainerComposeOverride(sceneName, volumeMounts = []) {
        const overridePath = this.sceneComposeOverridePath(sceneName);
        if (!Array.isArray(volumeMounts) || volumeMounts.length === 0) {
            fs.rmSync(overridePath, { force: true });
            return '';
        }

        fs.mkdirSync(this.config.runDir, { recursive: true });
        const lines = [
            'services:',
            '  playwright:',
            '    volumes:'
        ];
        volumeMounts.forEach(item => {
            lines.push(`      - ${JSON.stringify(String(item))}`);
        });
        fs.writeFileSync(overridePath, `${lines.join('\n')}\n`, 'utf8');
        return overridePath;
    }

    buildCliSessionIntegration(dockerCmd) {
        return this.sceneStateManager.buildCliSessionIntegration(dockerCmd);
    }

    async startContainer(sceneName, options = {}) {
        return await this.sceneDrivers.container.up(sceneName, options);
    }

    stopContainer(sceneName) {
        return this.sceneDrivers.container.down(sceneName);
    }

    statusContainer(sceneName) {
        return this.sceneDrivers.container.status(sceneName);
    }

    logsContainer(sceneName) {
        return this.sceneDrivers.container.logs(sceneName);
    }

    ensureContainerRuntimeAvailable(action, sceneName) {
        const runtime = this.config.containerRuntime;
        if (!this.ensureCommandAvailable(runtime)) {
            this.writeStderr(`[${action}] ${sceneName} failed: ${runtime} command not found.`);
            return '';
        }
        return runtime;
    }

    buildContainerComposeCommand(sceneName, composeFiles = [], trailingArgs = []) {
        const def = SCENE_DEFS[sceneName];
        const files = Array.isArray(composeFiles) && composeFiles.length > 0
            ? composeFiles
            : [this.containerComposePath(sceneName)];
        const args = [
            this.config.containerRuntime,
            'compose',
            '-p',
            def.projectName
        ];
        files.forEach(filePath => {
            args.push('-f', filePath);
        });
        args.push(...trailingArgs);
        return args;
    }

    hostLaunchCommand(sceneName, cfgPath) {
        if (isCliScene(sceneName)) {
            return {
                command: this.playwrightBinPath(sceneName),
                args: ['launch-server', '--browser', this.defaultBrowserName(sceneName), '--config', String(cfgPath)]
            };
        }
        return {
            command: this.localBinPath('playwright-mcp'),
            args: ['--config', String(cfgPath)]
        };
    }

    spawnHostProcess(command, args, logFd) {
        return spawn(command, args, {
            detached: true,
            stdio: ['ignore', logFd, logFd]
        });
    }

    stopHostStarter(pid) {
        if (!Number.isInteger(pid) || pid <= 0) {
            return;
        }
        try {
            process.kill(-pid, 'SIGTERM');
            return;
        } catch {
            // no-op
        }
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            // no-op
        }
    }

    hostScenePids(sceneName) {
        const cfgPath = this.sceneConfigPath(sceneName);
        const pattern = isCliScene(sceneName)
            ? `playwright.*launch-server.*--config ${cfgPath}`
            : `playwright-mcp.*--config ${cfgPath}`;
        const cp = this.runCmd(['pgrep', '-f', pattern], { captureOutput: true, check: false });

        if (cp.returncode !== 0 || !cp.stdout.trim()) {
            return [];
        }

        const pids = [];
        for (const line of cp.stdout.split(/\r?\n/)) {
            const text = line.trim();
            if (/^\d+$/.test(text)) {
                pids.push(Number(text));
            }
        }
        return pids;
    }

    async waitForHostPids(sceneName, fallbackPid) {
        for (let i = 0; i < 5; i += 1) {
            const pids = this.hostScenePids(sceneName);
            if (pids.length > 0) {
                return pids;
            }
            // eslint-disable-next-line no-await-in-loop
            await sleep(100);
        }
        if (Number.isInteger(fallbackPid) && fallbackPid > 0) {
            return [fallbackPid];
        }
        return [];
    }

    clearHostSceneRuntimeState(sceneName) {
        this.sceneStateManager.clearHostSceneRuntimeState(sceneName);
    }

    async getHostSceneRuntimeInfo(sceneName) {
        const pidFile = this.scenePidFile(sceneName);
        const port = this.scenePort(sceneName);
        const managedPids = this.hostScenePids(sceneName);
        const portReachable = await this.portReady(port);
        return { pidFile, port, managedPids, portReachable };
    }

    signalPids(pids, signal = 'SIGTERM') {
        const values = Array.isArray(pids) ? pids : [];
        values.forEach(pid => {
            try {
                process.kill(pid, signal);
            } catch {
                // no-op
            }
        });
    }

    readPidFilePid(pidFile) {
        if (!fs.existsSync(pidFile)) {
            return 0;
        }
        const text = fs.readFileSync(pidFile, 'utf8').trim();
        return /^\d+$/.test(text) ? Number(text) : 0;
    }

    writeScenePidFile(pidFile, pid) {
        fs.mkdirSync(path.dirname(pidFile), { recursive: true });
        fs.writeFileSync(pidFile, `${pid}`, 'utf8');
    }

    async startHost(sceneName, options = {}) {
        return await this.sceneDrivers.host.up(sceneName, options);
    }

    async stopHost(sceneName) {
        return await this.sceneDrivers.host.down(sceneName);
    }

    async statusHost(sceneName) {
        return await this.sceneDrivers.host.status(sceneName);
    }

    async healthScene(sceneName) {
        const port = this.scenePort(sceneName);
        if (await this.portReady(port)) {
            this.writeStdout(`[health] ${sceneName} ok (127.0.0.1:${port})`);
            return 0;
        }
        this.writeStdout(`[health] ${sceneName} fail (127.0.0.1:${port})`);
        return 1;
    }

    logsHost(sceneName) {
        return this.sceneDrivers.host.logs(sceneName);
    }

    async downloadExtensions(options = {}) {
        return await this.extensionManager.downloadExtensions(options);
    }

    detectCurrentIPv4() {
        const interfaces = os.networkInterfaces();
        for (const values of Object.values(interfaces)) {
            if (!Array.isArray(values)) {
                continue;
            }
            for (const item of values) {
                if (!item || item.internal) {
                    continue;
                }
                if (item.family === 'IPv4') {
                    return item.address;
                }
            }
        }
        return '';
    }

    resolveMcpAddHost(hostArg) {
        if (!hostArg) {
            return this.config.mcpDefaultHost;
        }
        const value = String(hostArg).trim();
        if (!value) {
            return '';
        }
        if (value === 'current-ip') {
            return this.detectCurrentIPv4();
        }
        return value;
    }

    printMcpAdd(hostArg) {
        const host = this.resolveMcpAddHost(hostArg);
        if (!host) {
            this.writeStderr('[mcp-add] failed: cannot determine host. Use --host <host> to set one explicitly.');
            return 1;
        }

        const scenes = this.resolveTargets('all').filter(sceneName => isMcpScene(sceneName));
        for (const sceneName of scenes) {
            const url = `http://${host}:${this.scenePort(sceneName)}/mcp`;
            this.writeStdout(`claude mcp add -t http -s user playwright-${sceneName} ${url}`);
        }
        this.writeStdout('');
        for (const sceneName of scenes) {
            const url = `http://${host}:${this.scenePort(sceneName)}/mcp`;
            this.writeStdout(`codex mcp add playwright-${sceneName} --url ${url}`);
        }
        this.writeStdout('');
        for (const sceneName of scenes) {
            const url = `http://${host}:${this.scenePort(sceneName)}/mcp`;
            this.writeStdout(`gemini mcp add -t http -s user playwright-${sceneName} ${url}`);
        }

        return 0;
    }

    printCliAdd() {
        const lines = [
            'PLAYWRIGHT_CLI_INSTALL_DIR="${TMPDIR:-/tmp}/manyoyo-playwright-cli-install-$$"',
            'mkdir -p "$PLAYWRIGHT_CLI_INSTALL_DIR/.playwright"',
            'echo \'{"browser":{"browserName":"chromium","launchOptions":{"channel":"chromium"}}}\' > "$PLAYWRIGHT_CLI_INSTALL_DIR/.playwright/cli.config.json"',
            'cd "$PLAYWRIGHT_CLI_INSTALL_DIR"',
            `npm install -g @playwright/cli@${PLAYWRIGHT_CLI_VERSION}`,
            'playwright-cli install --skills',
            'PLAYWRIGHT_CLI_SKILL_SOURCE="$PLAYWRIGHT_CLI_INSTALL_DIR/.claude/skills/playwright-cli"',
            'for target in ~/.claude/skills/playwright-cli ~/.codex/skills/playwright-cli ~/.gemini/skills/playwright-cli; do',
            '    mkdir -p "$target"',
            '    cp -R "$PLAYWRIGHT_CLI_SKILL_SOURCE/." "$target/"',
            'done',
            'cd "$OLDPWD"',
            'rm -rf "$PLAYWRIGHT_CLI_INSTALL_DIR"'
        ];
        this.writeStdout(lines.join('\n'));
        return 0;
    }

    printSummary() {
        const scenes = this.resolveTargets('all');
        this.writeStdout(`playwright\truntime=${this.config.runtime}\tscenes=${scenes.join(',')}`);
        return 0;
    }

    async runOnScene(action, sceneName, options = {}) {
        const def = SCENE_DEFS[sceneName];
        const handler = action === 'health'
            ? () => this.healthScene(sceneName)
            : this.sceneDrivers[def.type] && this.sceneDrivers[def.type][action];
        if (!handler) {
            this.writeStderr(`unknown action: ${action}`);
            return 1;
        }
        return await handler(sceneName, options);
    }

    async runOnTargets(action, targets, options = {}) {
        let rc = 0;
        for (const sceneName of targets) {
            // eslint-disable-next-line no-await-in-loop
            const code = await this.runOnScene(action, sceneName, options);
            if (code !== 0) {
                rc = 1;
            }
        }
        return rc;
    }

    async run({ action, scene = 'mcp-host-headless', host = '', extensionPaths = [], extensionNames = [], prodversion = '' }) {
        const directHandler = DIRECT_ACTION_HANDLERS[action];
        if (directHandler) {
            return await directHandler(this, { host, prodversion });
        }

        if (!VALID_ACTIONS.has(action)) {
            throw new Error(`未知 plugin 动作: ${action}`);
        }

        const targets = this.resolveTargets(scene);
        if (targets.length === 0) {
            this.writeStderr('没有可执行场景，请检查 runtime 与 enabledScenes 配置');
            return 1;
        }

        const resolvedExtensionPaths = action === 'up'
            ? this.resolveExtensionInputs({ extensionPaths, extensionNames })
            : [];
        return await this.runOnTargets(action, targets, { extensionPaths: resolvedExtensionPaths });
    }
}

module.exports = {
    EXTENSIONS,
    SCENE_ORDER,
    SCENE_DEFS,
    PlaywrightPlugin
};
