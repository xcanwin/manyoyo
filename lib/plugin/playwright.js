'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { playwrightCliVersion: PLAYWRIGHT_CLI_VERSION } = require('../../package.json');

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
const SCENE_ACTION_HANDLERS = {
    up: {
        container: (plugin, sceneName, options) => plugin.startContainer(sceneName, options),
        host: (plugin, sceneName, options) => plugin.startHost(sceneName, options)
    },
    down: {
        container: (plugin, sceneName) => plugin.stopContainer(sceneName),
        host: (plugin, sceneName) => plugin.stopHost(sceneName)
    },
    status: {
        container: (plugin, sceneName) => plugin.statusContainer(sceneName),
        host: (plugin, sceneName) => plugin.statusHost(sceneName)
    },
    health: {
        all: (plugin, sceneName) => plugin.healthScene(sceneName)
    },
    logs: {
        container: (plugin, sceneName) => plugin.logsContainer(sceneName),
        host: (plugin, sceneName) => plugin.logsHost(sceneName)
    }
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

function isHostPermission(value) {
    if (value === '<all_urls>') {
        return true;
    }
    return /^(?:\*|http|https|file|ftp):\/\//.test(value);
}

function scriptSourcesFromHtml(htmlFile) {
    const content = fs.readFileSync(htmlFile, { encoding: 'utf8' });
    const scripts = [...content.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
    return scripts.filter(src => !/^(?:https?:)?\/\//.test(src));
}

function convertManifestV2ToV3(extDir) {
    const manifestFile = path.join(extDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.manifest_version !== 2) {
        return false;
    }

    manifest.manifest_version = 3;

    if (manifest.browser_action && !manifest.action) {
        manifest.action = manifest.browser_action;
        delete manifest.browser_action;
    }
    if (manifest.page_action && !manifest.action) {
        manifest.action = manifest.page_action;
        delete manifest.page_action;
    }

    const background = manifest.background;
    if (background && typeof background === 'object' && !Array.isArray(background)) {
        let scripts = [];
        if (Array.isArray(background.scripts)) {
            scripts = background.scripts.filter(s => typeof s === 'string');
        } else if (typeof background.page === 'string') {
            const pagePath = path.join(extDir, background.page);
            if (fs.existsSync(pagePath)) {
                scripts = scriptSourcesFromHtml(pagePath);
            }
        }

        if (scripts.length > 0) {
            const swName = 'generated_background_sw.js';
            const swFile = path.join(extDir, swName);
            const swLines = [
                '// Auto-generated by manyoyo playwright ext-download for MV3.',
                `importScripts(${scripts.map(s => JSON.stringify(s)).join(', ')});`,
                ''
            ];
            fs.writeFileSync(swFile, swLines.join('\n'), 'utf8');
            manifest.background = { service_worker: swName };
        } else {
            delete manifest.background;
        }
    }

    if (typeof manifest.content_security_policy === 'string') {
        manifest.content_security_policy = { extension_pages: manifest.content_security_policy };
    }

    if (Array.isArray(manifest.permissions)) {
        const hostPermissions = Array.isArray(manifest.host_permissions) ? [...manifest.host_permissions] : [];
        const keptPermissions = [];

        for (const perm of manifest.permissions) {
            if (typeof perm === 'string' && isHostPermission(perm)) {
                if (!hostPermissions.includes(perm)) {
                    hostPermissions.push(perm);
                }
            } else {
                keptPermissions.push(perm);
            }
        }

        manifest.permissions = keptPermissions;
        if (hostPermissions.length > 0) {
            manifest.host_permissions = hostPermissions;
        }
    }

    const war = manifest.web_accessible_resources;
    if (Array.isArray(war) && war.length > 0 && war.every(v => typeof v === 'string')) {
        manifest.web_accessible_resources = [
            {
                resources: war,
                matches: ['<all_urls>']
            }
        ];
    }

    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return true;
}

function buildCrxUrl(extId, prodversion) {
    return (
        'https://clients2.google.com/service/update2/crx' +
        `?response=redirect&prodversion=${prodversion}` +
        '&acceptformat=crx2,crx3' +
        `&x=id%3D${extId}%26installsource%3Dondemand%26uc`
    );
}

function crxZipOffset(data) {
    if (data.subarray(0, 4).toString('ascii') !== 'Cr24') {
        throw new Error('not a CRX file');
    }

    const version = data.readUInt32LE(4);
    if (version === 2) {
        const pubLen = data.readUInt32LE(8);
        const sigLen = data.readUInt32LE(12);
        return 16 + pubLen + sigLen;
    }
    if (version === 3) {
        const headerLen = data.readUInt32LE(8);
        return 12 + headerLen;
    }
    throw new Error(`unsupported CRX version: ${version}`);
}

class PlaywrightPlugin {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot || path.join(__dirname, '..', '..');
        this.stdout = options.stdout || process.stdout;
        this.stderr = options.stderr || process.stderr;
        this.globalConfig = asObject(options.globalConfig);
        this.runConfig = asObject(options.runConfig);
        this.config = this.resolveConfig();
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
        return path.join(this.config.runDir, `${sceneName}.endpoint.json`);
    }

    readSceneEndpoint(sceneName) {
        const filePath = this.sceneEndpointPath(sceneName);
        if (!fs.existsSync(filePath)) {
            return null;
        }
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            return null;
        }
    }

    writeSceneEndpoint(sceneName, payload) {
        fs.mkdirSync(this.config.runDir, { recursive: true });
        fs.writeFileSync(this.sceneEndpointPath(sceneName), `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
    }

    removeSceneEndpoint(sceneName) {
        fs.rmSync(this.sceneEndpointPath(sceneName), { force: true });
    }

    sceneCliAttachConfigPath(sceneName) {
        return path.join(this.config.runDir, `${sceneName}.cli-attach.json`);
    }

    writeSceneCliAttachConfig(sceneName, payload) {
        fs.mkdirSync(this.config.runDir, { recursive: true });
        fs.writeFileSync(this.sceneCliAttachConfigPath(sceneName), `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
    }

    removeSceneCliAttachConfig(sceneName) {
        fs.rmSync(this.sceneCliAttachConfigPath(sceneName), { force: true });
    }

    sceneInitScriptPath(sceneName) {
        const configFile = path.basename(this.sceneConfigPath(sceneName), '.json');
        return path.join(this.config.configDir, `${configFile}.init.js`);
    }

    buildInitScriptContent() {
        const lines = [
            "'use strict';",
            '(function () {',
            `    const platformValue = ${JSON.stringify(this.config.navigatorPlatform)};`,
            '    try {',
            '        const navProto = Object.getPrototypeOf(navigator);',
            "        Object.defineProperty(navProto, 'platform', {",
            '            configurable: true,',
            '            get: () => platformValue',
            '        });',
            '    } catch (_) {}'
        ];

        if (this.config.disableWebRTC) {
            lines.push(
                '    try {',
                '        const scope = globalThis;',
                "        const blocked = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCDataChannel'];",
                '        for (const name of blocked) {',
                "            Object.defineProperty(scope, name, { configurable: true, writable: true, value: undefined });",
                '        }',
                '        if (navigator.mediaDevices) {',
                '            const errorFactory = () => {',
                '                try {',
                "                    return new DOMException('WebRTC is disabled', 'NotAllowedError');",
                '                } catch (_) {',
                "                    const error = new Error('WebRTC is disabled');",
                "                    error.name = 'NotAllowedError';",
                '                    return error;',
                '                }',
                '            };',
                "            Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {",
                '                configurable: true,',
                '                writable: true,',
                '                value: async () => { throw errorFactory(); }',
                '            });',
                '        }',
                '    } catch (_) {}'
            );
        }

        lines.push('})();', '');
        return lines.join('\n');
    }

    ensureSceneInitScript(sceneName) {
        const filePath = this.sceneInitScriptPath(sceneName);
        const content = this.buildInitScriptContent();
        fs.writeFileSync(filePath, content, 'utf8');
        return filePath;
    }

    defaultBrowserName(sceneName) {
        if (isCliScene(sceneName)) {
            return 'chromium';
        }
        const cfg = this.buildSceneConfig(sceneName);
        const browserName = cfg && cfg.browser && cfg.browser.browserName;
        return String(browserName || 'chromium');
    }

    ensureContainerScenePrerequisites(sceneName) {
        if (!this.sceneConfigMissing(sceneName)) {
            return;
        }
        const tag = String(this.config.dockerTag || 'latest').trim() || 'latest';
        const image = `mcr.microsoft.com/playwright/mcp:${tag}`;
        this.runCmd([this.config.containerRuntime, 'pull', image], { check: true });
    }

    ensureHostScenePrerequisites(sceneName) {
        if (!isCliScene(sceneName) && !this.sceneConfigMissing(sceneName)) {
            return;
        }
        this.runCmd([this.playwrightBinPath(sceneName), 'install', '--with-deps', this.defaultBrowserName(sceneName)], { check: true });
    }

    scenePidFile(sceneName) {
        return path.join(this.config.runDir, `${sceneName}.pid`);
    }

    sceneLogFile(sceneName) {
        return path.join(this.config.runDir, `${sceneName}.log`);
    }

    localBinPath(binName) {
        const filename = process.platform === 'win32' ? `${binName}.cmd` : binName;
        const binPath = path.join(this.projectRoot, 'node_modules', '.bin', filename);
        if (!fs.existsSync(binPath)) {
            throw new Error(`local binary not found: ${binPath}. Run npm install first.`);
        }
        return binPath;
    }

    playwrightBinPath(sceneName) {
        if (!isCliScene(sceneName)) {
            return this.localBinPath('playwright');
        }

        const filename = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
        const candidates = [
            path.join(this.projectRoot, 'node_modules', '@playwright', 'mcp', 'node_modules', '.bin', filename),
            path.join(this.projectRoot, 'node_modules', '.bin', filename)
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        throw new Error(`local binary not found for ${sceneName}. Run npm install first.`);
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
        const inputs = asStringArray(extensionArgs, []);
        const uniquePaths = [];
        const seen = new Set();

        for (const item of inputs) {
            const absPath = path.resolve(item);
            if (!fs.existsSync(absPath)) {
                throw new Error(`扩展路径不存在: ${absPath}`);
            }
            const stat = fs.statSync(absPath);
            if (!stat.isDirectory()) {
                throw new Error(`扩展路径必须是目录: ${absPath}`);
            }

            const manifestPath = path.join(absPath, 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                if (!seen.has(absPath)) {
                    seen.add(absPath);
                    uniquePaths.push(absPath);
                }
                continue;
            }

            const children = fs.readdirSync(absPath, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => path.join(absPath, dirent.name))
                .filter(child => fs.existsSync(path.join(child, 'manifest.json')));

            if (children.length === 0) {
                throw new Error(`目录下未找到扩展(manifest.json): ${absPath}`);
            }

            for (const childPath of children) {
                if (!seen.has(childPath)) {
                    seen.add(childPath);
                    uniquePaths.push(childPath);
                }
            }
        }

        return uniquePaths;
    }

    resolveNamedExtensionPaths(extensionNames = []) {
        const names = asStringArray(extensionNames, []);
        const extensionRoot = path.resolve(this.extensionDirPath());

        return names.map(name => {
            if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
                throw new Error(`扩展名称无效: ${name}`);
            }
            return path.join(extensionRoot, name);
        });
    }

    resolveExtensionInputs(options = {}) {
        const extensionPaths = asStringArray(options.extensionPaths, []);
        const namedPaths = this.resolveNamedExtensionPaths(options.extensionNames || []);
        return this.resolveExtensionPaths([...extensionPaths, ...namedPaths]);
    }

    buildExtensionLaunchArgs(extensionPaths) {
        const joined = extensionPaths.join(',');
        return [
            `--disable-extensions-except=${joined}`,
            `--load-extension=${joined}`
        ];
    }

    sanitizeExtensionMountName(value) {
        const sanitized = String(value || '')
            .trim()
            .replace(/[^A-Za-z0-9._-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        return sanitized || 'ext';
    }

    buildContainerExtensionMounts(extensionPaths = []) {
        const hostPaths = asStringArray(extensionPaths, []);
        const containerPaths = [];
        const volumeMounts = [];

        hostPaths.forEach((hostPath, idx) => {
            const safeName = this.sanitizeExtensionMountName(path.basename(hostPath));
            const containerPath = path.posix.join(CONTAINER_EXTENSION_ROOT, `ext-${idx + 1}-${safeName}`);
            containerPaths.push(containerPath);
            volumeMounts.push(`${hostPath}:${containerPath}:ro`);
        });

        return { containerPaths, volumeMounts };
    }

    baseLaunchArgs() {
        return [
            `--user-agent=${DEFAULT_FINGERPRINT_PROFILE.userAgent}`,
            `--lang=${DEFAULT_FINGERPRINT_PROFILE.locale}`,
            `--window-size=${DEFAULT_FINGERPRINT_PROFILE.width},${DEFAULT_FINGERPRINT_PROFILE.height}`,
            '--disable-blink-features=AutomationControlled',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
        ];
    }

    buildMcpSceneConfig(sceneName, options = {}) {
        const def = SCENE_DEFS[sceneName];
        const port = this.scenePort(sceneName);
        const extensionPaths = asStringArray(options.extensionPaths, []);
        const initScript = asStringArray(options.initScript, []);
        const launchOptions = {
            channel: 'chromium',
            headless: def.headless,
            args: [...this.baseLaunchArgs()]
        };

        if (extensionPaths.length > 0) {
            launchOptions.args.push(...this.buildExtensionLaunchArgs(extensionPaths));
        }
        if (this.config.disableWebRTC) {
            launchOptions.args.push(...DISABLE_WEBRTC_LAUNCH_ARGS);
        }

        const contextOptions = {
            userAgent: DEFAULT_FINGERPRINT_PROFILE.userAgent,
            locale: DEFAULT_FINGERPRINT_PROFILE.locale,
            timezoneId: DEFAULT_FINGERPRINT_PROFILE.timezoneId,
            extraHTTPHeaders: {
                'Accept-Language': DEFAULT_FINGERPRINT_PROFILE.acceptLanguage
            }
        };
        if (sceneName !== 'mcp-host-headed') {
            contextOptions.viewport = {
                width: DEFAULT_FINGERPRINT_PROFILE.width,
                height: DEFAULT_FINGERPRINT_PROFILE.height
            };
            contextOptions.screen = {
                width: DEFAULT_FINGERPRINT_PROFILE.width,
                height: DEFAULT_FINGERPRINT_PROFILE.height
            };
        }

        return {
            outputDir: '/tmp/.playwright-mcp',
            server: {
                host: def.listenHost,
                port,
                allowedHosts: [
                    `localhost:${port}`,
                    `127.0.0.1:${port}`,
                    `host.docker.internal:${port}`,
                    `host.containers.internal:${port}`
                ]
            },
            browser: {
                chromiumSandbox: true,
                browserName: 'chromium',
                initScript,
                launchOptions,
                contextOptions
            }
        };
    }

    buildCliSceneConfig(sceneName, options = {}) {
        const def = SCENE_DEFS[sceneName];
        const extensionPaths = asStringArray(options.extensionPaths, []);
        const payload = {
            host: def.listenHost,
            port: this.scenePort(sceneName),
            wsPath: `/${sceneName}-${crypto.randomBytes(8).toString('hex')}`,
            headless: def.headless,
            channel: 'chromium',
            chromiumSandbox: true,
            args: [...this.baseLaunchArgs()]
        };

        if (extensionPaths.length > 0) {
            payload.args.push(...this.buildExtensionLaunchArgs(extensionPaths));
        }
        if (this.config.disableWebRTC) {
            payload.args.push(...DISABLE_WEBRTC_LAUNCH_ARGS);
        }

        return payload;
    }

    buildSceneConfig(sceneName, options = {}) {
        if (isCliScene(sceneName)) {
            return this.buildCliSceneConfig(sceneName, options);
        }
        return this.buildMcpSceneConfig(sceneName, options);
    }

    ensureSceneConfig(sceneName, options = {}) {
        fs.mkdirSync(this.config.configDir, { recursive: true });
        if (isCliScene(sceneName)) {
            const payload = this.buildCliSceneConfig(sceneName, options);
            const filePath = this.sceneConfigPath(sceneName);
            fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
            return filePath;
        }
        const initScriptPath = this.ensureSceneInitScript(sceneName);
        const configuredInitScript = asStringArray(options.initScript, []);
        const initScript = configuredInitScript.length > 0 ? configuredInitScript : [initScriptPath];
        const payload = this.buildSceneConfig(sceneName, {
            ...options,
            initScript
        });
        const filePath = this.sceneConfigPath(sceneName);
        fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 4)}\n`, 'utf8');
        return filePath;
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
        const sceneName = this.config.cliSessionScene;
        if (!sceneName) {
            return { envEntries: [], extraArgs: [], volumeEntries: [] };
        }

        const endpoint = this.readSceneEndpoint(sceneName);
        if (!endpoint || !Number.isInteger(endpoint.port) || endpoint.port <= 0 || typeof endpoint.wsPath !== 'string' || !endpoint.wsPath) {
            return { envEntries: [], extraArgs: [], volumeEntries: [] };
        }

        const normalizedDockerCmd = String(dockerCmd || '').trim().toLowerCase();
        const connectHost = normalizedDockerCmd === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
        const remoteEndpoint = `ws://${connectHost}:${endpoint.port}${endpoint.wsPath}`;
        const hostConfigPath = this.sceneCliAttachConfigPath(sceneName);
        const containerConfigPath = `/tmp/manyoyo-playwright/${sceneName}.cli-attach.json`;
        this.writeSceneCliAttachConfig(sceneName, {
            browser: {
                remoteEndpoint
            }
        });
        const envEntries = [
            `PLAYWRIGHT_MCP_CONFIG=${containerConfigPath}`
        ];
        const extraArgs = normalizedDockerCmd === 'docker'
            ? ['--add-host', 'host.docker.internal:host-gateway']
            : [];
        const volumeEntries = ['--volume', `${hostConfigPath}:${containerConfigPath}:ro`];
        return { envEntries, extraArgs, volumeEntries };
    }

    async startContainer(sceneName, options = {}) {
        const runtime = this.config.containerRuntime;
        if (!this.ensureCommandAvailable(runtime)) {
            this.writeStderr(`[up] ${sceneName} failed: ${runtime} command not found.`);
            return 1;
        }

        try {
            this.ensureContainerScenePrerequisites(sceneName);
        } catch (error) {
            return error.returncode || 1;
        }

        const incomingExtensionPaths = asStringArray(options.extensionPaths, []);
        const hostInitScriptPath = this.sceneInitScriptPath(sceneName);
        const containerInitScriptPath = path.posix.join('/app/config', path.basename(hostInitScriptPath));
        let configOptions = {
            ...options,
            extensionPaths: incomingExtensionPaths,
            initScript: [containerInitScriptPath]
        };
        const composeFiles = [this.containerComposePath(sceneName)];
        const volumeMounts = [`${hostInitScriptPath}:${containerInitScriptPath}:ro`];

        if (incomingExtensionPaths.length > 0) {
            const mapped = this.buildContainerExtensionMounts(incomingExtensionPaths);
            volumeMounts.push(...mapped.volumeMounts);
            configOptions = {
                ...options,
                extensionPaths: mapped.containerPaths,
                initScript: [containerInitScriptPath]
            };
        }
        const cfgPath = this.ensureSceneConfig(sceneName, configOptions);
        const overridePath = this.ensureContainerComposeOverride(sceneName, volumeMounts);
        if (overridePath) {
            composeFiles.push(overridePath);
        }

        const env = this.containerEnv(sceneName, cfgPath, { requireVncPassword: true });
        const def = SCENE_DEFS[sceneName];

        try {
            const args = [
                runtime,
                'compose',
                '-p',
                def.projectName
            ];
            composeFiles.forEach(filePath => {
                args.push('-f', filePath);
            });
            args.push('up', '-d');
            this.runCmd(args, { env, check: true });
        } catch (error) {
            return error.returncode || 1;
        }

        const port = this.scenePort(sceneName);
        if (await this.waitForPort(port)) {
            this.writeStdout(`[up] ${sceneName} ready on 127.0.0.1:${port}`);
            return 0;
        }

        this.writeStderr(`[up] ${sceneName} did not become ready on 127.0.0.1:${port}`);
        return 1;
    }

    stopContainer(sceneName) {
        const runtime = this.config.containerRuntime;
        if (!this.ensureCommandAvailable(runtime)) {
            this.writeStderr(`[down] ${sceneName} failed: ${runtime} command not found.`);
            return 1;
        }

        this.ensureContainerComposeOverride(sceneName, []);
        const cfgPath = this.sceneConfigPath(sceneName);
        const env = this.containerEnv(sceneName, cfgPath);
        const def = SCENE_DEFS[sceneName];

        try {
            this.runCmd([
                runtime,
                'compose',
                '-p',
                def.projectName,
                '-f',
                this.containerComposePath(sceneName),
                'down'
            ], { env, check: true });
        } catch (error) {
            return error.returncode || 1;
        }

        this.writeStdout(`[down] ${sceneName}`);
        return 0;
    }

    statusContainer(sceneName) {
        const runtime = this.config.containerRuntime;
        if (!this.ensureCommandAvailable(runtime)) {
            this.writeStderr(`[status] ${sceneName} failed: ${runtime} command not found.`);
            return 1;
        }

        const def = SCENE_DEFS[sceneName];
        const cp = this.runCmd([
            runtime,
            'ps',
            '--filter',
            `name=${def.containerName}`,
            '--format',
            '{{.Names}}'
        ], { captureOutput: true, check: false });

        const names = new Set(
            cp.stdout
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)
        );

        if (names.has(def.containerName)) {
            this.writeStdout(`[status] ${sceneName} running`);
        } else {
            this.writeStdout(`[status] ${sceneName} stopped`);
        }
        return 0;
    }

    logsContainer(sceneName) {
        const runtime = this.config.containerRuntime;
        if (!this.ensureCommandAvailable(runtime)) {
            this.writeStderr(`[logs] ${sceneName} failed: ${runtime} command not found.`);
            return 1;
        }

        const def = SCENE_DEFS[sceneName];
        const cp = this.runCmd([
            runtime,
            'logs',
            '--tail',
            '80',
            def.containerName
        ], { captureOutput: true, check: false });

        const output = cp.stdout || cp.stderr;
        if (output.trim()) {
            this.writeStdout(output.trimEnd());
        } else {
            this.writeStdout(`[logs] ${sceneName} no logs`);
        }

        return cp.returncode === 0 ? 0 : 1;
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

    async startHost(sceneName, options = {}) {
        try {
            this.ensureCliHostHeadedCacheDir(sceneName);
            this.ensureHostScenePrerequisites(sceneName);
        } catch (error) {
            this.writeStderr(`[up] ${sceneName} failed: ${error.message || String(error)}`);
            return error.returncode || 1;
        }

        fs.mkdirSync(this.config.runDir, { recursive: true });
        const cfgPath = this.ensureSceneConfig(sceneName, options);
        const pidFile = this.scenePidFile(sceneName);
        const logFile = this.sceneLogFile(sceneName);
        const port = this.scenePort(sceneName);
        this.removeSceneEndpoint(sceneName);
        this.removeSceneCliAttachConfig(sceneName);

        let managedPids = this.hostScenePids(sceneName);
        if (managedPids.length > 0 && (await this.portReady(port))) {
            this.writeStdout(`[up] ${sceneName} already running (pid(s) ${managedPids.join(' ')})`);
            return 0;
        }

        if (await this.portReady(port)) {
            this.writeStderr(`[up] ${sceneName} failed: port ${port} is already in use by another process.`);
            this.writeStderr('Stop the conflicting process first, then retry.');
            return 1;
        }

        fs.rmSync(pidFile, { force: true });
        const logFd = fs.openSync(logFile, 'a');
        let launchCommand = null;
        try {
            launchCommand = this.hostLaunchCommand(sceneName, cfgPath);
        } catch (error) {
            fs.closeSync(logFd);
            this.writeStderr(`[up] ${sceneName} failed: ${error.message || String(error)}`);
            return 1;
        }

        const starter = this.spawnHostProcess(launchCommand.command, launchCommand.args, logFd);
        fs.closeSync(logFd);
        if (typeof starter.unref === 'function') {
            starter.unref();
        }

        if (await this.waitForPort(port)) {
            if (isCliScene(sceneName)) {
                const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
                this.writeSceneEndpoint(sceneName, {
                    port,
                    wsPath: String(cfg.wsPath || '')
                });
            }
            managedPids = await this.waitForHostPids(sceneName, starter.pid);
            if (managedPids.length > 0) {
                fs.writeFileSync(pidFile, `${managedPids[0]}`, 'utf8');
                this.writeStdout(`[up] ${sceneName} ready on 127.0.0.1:${port} (pid(s) ${managedPids.join(' ')})`);
                this.remindCliSessionScene(sceneName);
                return 0;
            }
        }

        this.writeStderr(`[up] ${sceneName} failed to start. tail ${logFile}:`);
        const tail = tailText(logFile, 30);
        if (tail) {
            this.writeStderr(tail);
        }

        if (starter.exitCode === null && !starter.killed) {
            this.stopHostStarter(starter.pid);
        }

        return 1;
    }

    async stopHost(sceneName) {
        const pidFile = this.scenePidFile(sceneName);
        const port = this.scenePort(sceneName);
        const managedPids = this.hostScenePids(sceneName);
        this.removeSceneEndpoint(sceneName);
        this.removeSceneCliAttachConfig(sceneName);

        for (const pid of managedPids) {
            try {
                process.kill(pid, 'SIGTERM');
            } catch {
                // no-op
            }
        }

        if (managedPids.length > 0) {
            await sleep(300);
        }

        if (fs.existsSync(pidFile)) {
            const text = fs.readFileSync(pidFile, 'utf8').trim();
            if (/^\d+$/.test(text)) {
                try {
                    process.kill(Number(text), 'SIGTERM');
                } catch {
                    // no-op
                }
            }
            fs.rmSync(pidFile, { force: true });
        }

        if (await this.portReady(port)) {
            this.writeStderr(`[down] ${sceneName} warning: port ${port} is still in use (possibly unmanaged process)`);
            return 1;
        }

        this.writeStdout(`[down] ${sceneName}`);
        return 0;
    }

    async statusHost(sceneName) {
        const pidFile = this.scenePidFile(sceneName);
        const port = this.scenePort(sceneName);
        const managedPids = this.hostScenePids(sceneName);

        if (managedPids.length > 0 && (await this.portReady(port))) {
            this.writeStdout(`[status] ${sceneName} running (pid(s) ${managedPids.join(' ')})`);
            const pidfileValid = fs.existsSync(pidFile) && /^\d+$/.test(fs.readFileSync(pidFile, 'utf8').trim());
            if (!pidfileValid) {
                fs.mkdirSync(path.dirname(pidFile), { recursive: true });
                fs.writeFileSync(pidFile, `${managedPids[0]}`, 'utf8');
            }
            return 0;
        }

        if (managedPids.length > 0 && !(await this.portReady(port))) {
            this.writeStdout(`[status] ${sceneName} degraded (pid(s) ${managedPids.join(' ')}, port ${port} not reachable)`);
            return 0;
        }

        fs.rmSync(pidFile, { force: true });
        if (await this.portReady(port)) {
            this.writeStdout(`[status] ${sceneName} conflict (port ${port} in use by unmanaged process)`);
        } else {
            this.writeStdout(`[status] ${sceneName} stopped`);
        }
        return 0;
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
        const logFile = this.sceneLogFile(sceneName);
        if (!fs.existsSync(logFile)) {
            this.writeStdout(`[logs] ${sceneName} no log file: ${logFile}`);
            return 0;
        }

        const tail = tailText(logFile, 80);
        if (tail) {
            this.writeStdout(tail);
        }
        return 0;
    }

    async downloadFile(url, output, retries = 3, timeoutMs = 60_000) {
        const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
        if (!this.ensureCommandAvailable('curl')) {
            throw new Error('curl command not found');
        }

        let lastError = null;
        for (let i = 1; i <= retries; i += 1) {
            try {
                const result = this.runCmd([
                    'curl',
                    '--fail',
                    '--location',
                    '--silent',
                    '--show-error',
                    '--connect-timeout',
                    String(timeoutSec),
                    '--max-time',
                    String(timeoutSec),
                    '--output',
                    output,
                    url
                ], { captureOutput: true, check: false });
                if (result.returncode !== 0) {
                    throw new Error(result.stderr || `curl failed with exit code ${result.returncode}`);
                }
                return;
            } catch (error) {
                lastError = error;
                if (i < retries) {
                    // eslint-disable-next-line no-await-in-loop
                    await sleep(1000);
                }
            }
        }

        throw new Error(`download failed after ${retries} attempts: ${url}; ${String(lastError)}`);
    }

    extractZipBuffer(zipBuffer, outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        const tempZip = path.join(os.tmpdir(), `manyoyo-playwright-ext-${process.pid}-${Date.now()}.zip`);
        fs.writeFileSync(tempZip, zipBuffer);

        const result = spawnSync('unzip', ['-oq', tempZip, '-d', outDir], { encoding: 'utf8' });
        fs.rmSync(tempZip, { force: true });

        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            throw new Error(result.stderr || `unzip failed with exit code ${result.status}`);
        }
    }

    extractCrx(crxFile, outDir) {
        const data = fs.readFileSync(crxFile);
        const offset = crxZipOffset(data);
        const zipBuffer = data.subarray(offset);

        this.extractZipBuffer(zipBuffer, outDir);

        const manifest = path.join(outDir, 'manifest.json');
        if (!fs.existsSync(manifest)) {
            throw new Error(`${crxFile} extracted but manifest.json missing`);
        }

        if (convertManifestV2ToV3(outDir)) {
            this.writeStdout(`[manifest] upgraded to MV3: ${path.basename(outDir)}`);
        }
    }

    async downloadExtensions(options = {}) {
        if (!this.ensureCommandAvailable('unzip')) {
            this.writeStderr('[ext-download] failed: unzip command not found.');
            return 1;
        }

        const prodversion = String(options.prodversion || this.config.extensionProdversion || '132.0.0.0').trim();
        const extDir = path.resolve(this.extensionDirPath());
        const tmpDir = path.resolve(this.extensionTmpDirPath());

        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.mkdirSync(extDir, { recursive: true });
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            this.writeStdout(`[info] ext dir: ${extDir}`);
            this.writeStdout(`[info] tmp dir: ${tmpDir}`);

            for (const [name, extId] of EXTENSIONS) {
                const url = buildCrxUrl(extId, prodversion);
                const crxFile = path.join(tmpDir, `${name}.crx`);
                const outDir = path.join(extDir, name);

                this.writeStdout(`[download] ${name}`);
                // eslint-disable-next-line no-await-in-loop
                await this.downloadFile(url, crxFile);

                this.writeStdout(`[extract] ${name}`);
                fs.rmSync(outDir, { recursive: true, force: true });
                this.extractCrx(crxFile, outDir);
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            this.writeStdout(`[cleanup] removed ${tmpDir}`);
        }

        this.writeStdout(`[done] all extensions are ready: ${extDir}`);
        return 0;
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
        const actionHandlers = SCENE_ACTION_HANDLERS[action];
        const handler = actionHandlers && (actionHandlers[def.type] || actionHandlers.all);
        if (!handler) {
            this.writeStderr(`unknown action: ${action}`);
            return 1;
        }
        return await handler(this, sceneName, options);
    }

    async run({ action, scene = 'mcp-host-headless', host = '', extensionPaths = [], extensionNames = [], prodversion = '' }) {
        if (action === 'ls') {
            return this.printSummary();
        }

        if (action === 'mcp-add') {
            return this.printMcpAdd(host);
        }

        if (action === 'cli-add') {
            return this.printCliAdd();
        }

        if (action === 'ext-download') {
            return await this.downloadExtensions({ prodversion });
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

        let rc = 0;
        for (const sceneName of targets) {
            // eslint-disable-next-line no-await-in-loop
            const code = await this.runOnScene(action, sceneName, { extensionPaths: resolvedExtensionPaths });
            if (code !== 0) {
                rc = 1;
            }
        }

        return rc;
    }
}

module.exports = {
    EXTENSIONS,
    SCENE_ORDER,
    SCENE_DEFS,
    PlaywrightPlugin
};
