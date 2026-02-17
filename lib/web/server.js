'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const JSON5 = require('json5');
const { buildContainerRunArgs } = require('../container-run');

const WEB_HISTORY_MAX_MESSAGES = 500;
const WEB_OUTPUT_MAX_CHARS = 16000;
const WEB_TERMINAL_MAX_SESSIONS = 20;
const WEB_TERMINAL_FORCE_KILL_MS = 2000;
const WEB_TERMINAL_DEFAULT_COLS = 120;
const WEB_TERMINAL_DEFAULT_ROWS = 36;
const WEB_TERMINAL_MIN_COLS = 40;
const WEB_TERMINAL_MIN_ROWS = 12;
const WEB_AUTH_COOKIE_NAME = 'manyoyo_web_auth';
const WEB_AUTH_TTL_SECONDS = 12 * 60 * 60;
const FRONTEND_DIR = path.join(__dirname, 'frontend');
const SAFE_CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const IMAGE_VERSION_TAG_PATTERN = /^(\d+\.\d+\.\d+)-([A-Za-z0-9][A-Za-z0-9_.-]*)$/;

const YOLO_COMMAND_MAP = {
    claude: 'IS_SANDBOX=1 claude --dangerously-skip-permissions',
    cc: 'IS_SANDBOX=1 claude --dangerously-skip-permissions',
    c: 'IS_SANDBOX=1 claude --dangerously-skip-permissions',
    gemini: 'gemini --yolo',
    gm: 'gemini --yolo',
    g: 'gemini --yolo',
    codex: 'codex --dangerously-bypass-approvals-and-sandbox',
    cx: 'codex --dangerously-bypass-approvals-and-sandbox',
    opencode: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode',
    oc: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode'
};

const DEFAULT_WEB_CONFIG_TEMPLATE = `{
    // MANYOYO 全局配置文件（JSON5）
    "containerName": "my-dev",
    "hostPath": "/path/to/your/project",
    "containerPath": "/path/to/your/project",
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.7.4-common",
    "containerMode": "common",
    "shellPrefix": "",
    "shell": "",
    "shellSuffix": "",
    "yolo": "",
    "env": {},
    "envFile": [],
    "volumes": [],
    "ports": []
}
`;

let XTERM_JS_FILE = null;
let XTERM_CSS_FILE = null;
let XTERM_ADDON_FIT_JS_FILE = null;
try {
    const xtermPackageDir = path.dirname(require.resolve('@xterm/xterm/package.json'));
    XTERM_JS_FILE = path.join(xtermPackageDir, 'lib', 'xterm.js');
    XTERM_CSS_FILE = path.join(xtermPackageDir, 'css', 'xterm.css');
} catch (e) {
    XTERM_JS_FILE = null;
    XTERM_CSS_FILE = null;
}
try {
    const xtermAddonFitPackageDir = path.dirname(require.resolve('@xterm/addon-fit/package.json'));
    XTERM_ADDON_FIT_JS_FILE = path.join(xtermAddonFitPackageDir, 'lib', 'addon-fit.js');
} catch (e) {
    XTERM_ADDON_FIT_JS_FILE = null;
}

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.html': 'text/html; charset=utf-8'
};

function formatUrlHost(host) {
    if (typeof host !== 'string' || !host) return '127.0.0.1';
    if (host.includes(':') && !host.startsWith('[')) {
        return `[${host}]`;
    }
    return host;
}

function ensureWebHistoryDir(webHistoryDir) {
    fs.mkdirSync(webHistoryDir, { recursive: true });
}

function getWebHistoryFile(webHistoryDir, containerName) {
    return path.join(webHistoryDir, `${containerName}.json`);
}

function loadWebSessionHistory(webHistoryDir, containerName) {
    ensureWebHistoryDir(webHistoryDir);
    const filePath = getWebHistoryFile(webHistoryDir, containerName);
    if (!fs.existsSync(filePath)) {
        return { containerName, updatedAt: null, messages: [] };
    }

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return {
            containerName,
            updatedAt: data.updatedAt || null,
            messages: Array.isArray(data.messages) ? data.messages : []
        };
    } catch (e) {
        return { containerName, updatedAt: null, messages: [] };
    }
}

function saveWebSessionHistory(webHistoryDir, containerName, history) {
    ensureWebHistoryDir(webHistoryDir);
    const filePath = getWebHistoryFile(webHistoryDir, containerName);
    fs.writeFileSync(filePath, JSON.stringify(history, null, 4));
}

function removeWebSessionHistory(webHistoryDir, containerName) {
    ensureWebHistoryDir(webHistoryDir);
    const filePath = getWebHistoryFile(webHistoryDir, containerName);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

function listWebHistorySessionNames(webHistoryDir, isValidContainerName) {
    ensureWebHistoryDir(webHistoryDir);
    return fs.readdirSync(webHistoryDir)
        .filter(file => file.endsWith('.json'))
        .map(file => path.basename(file, '.json'))
        .filter(name => isValidContainerName(name));
}

function appendWebSessionMessage(webHistoryDir, containerName, role, content, extra = {}) {
    const history = loadWebSessionHistory(webHistoryDir, containerName);
    const timestamp = new Date().toISOString();
    history.messages.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        role,
        content,
        timestamp,
        ...extra
    });

    if (history.messages.length > WEB_HISTORY_MAX_MESSAGES) {
        history.messages = history.messages.slice(-WEB_HISTORY_MAX_MESSAGES);
    }

    history.updatedAt = timestamp;
    saveWebSessionHistory(webHistoryDir, containerName, history);
}

function stripAnsi(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function clipText(text, maxChars = WEB_OUTPUT_MAX_CHARS) {
    if (typeof text !== 'string') return '';
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function secureStringEqual(a, b) {
    const aStr = String(a || '');
    const bStr = String(b || '');
    const aBuffer = Buffer.from(aStr, 'utf-8');
    const bBuffer = Buffer.from(bStr, 'utf-8');
    if (aBuffer.length !== bBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function parseCookies(req) {
    const cookieHeader = req.headers.cookie || '';
    if (!cookieHeader) {
        return {};
    }

    const cookies = {};
    cookieHeader.split(';').forEach(part => {
        const index = part.indexOf('=');
        if (index <= 0) return;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (!key) return;
        try {
            cookies[key] = decodeURIComponent(value);
        } catch (e) {
            cookies[key] = value;
        }
    });
    return cookies;
}

function pruneExpiredWebAuthSessions(state) {
    const now = Date.now();
    for (const [sessionId, session] of state.authSessions.entries()) {
        if (!session || session.expiresAt <= now) {
            state.authSessions.delete(sessionId);
        }
    }
}

function createWebAuthSession(state, username) {
    pruneExpiredWebAuthSessions(state);
    const sessionId = crypto.randomBytes(24).toString('hex');
    state.authSessions.set(sessionId, {
        username,
        expiresAt: Date.now() + WEB_AUTH_TTL_SECONDS * 1000
    });
    return sessionId;
}

function getWebAuthSession(state, req) {
    pruneExpiredWebAuthSessions(state);
    const cookies = parseCookies(req);
    const sessionId = cookies[WEB_AUTH_COOKIE_NAME];
    if (!sessionId) return null;

    const session = state.authSessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        state.authSessions.delete(sessionId);
        return null;
    }

    // Sliding session expiration
    session.expiresAt = Date.now() + WEB_AUTH_TTL_SECONDS * 1000;
    return { sessionId, username: session.username };
}

function clearWebAuthSession(state, req) {
    const cookies = parseCookies(req);
    const sessionId = cookies[WEB_AUTH_COOKIE_NAME];
    if (sessionId) {
        state.authSessions.delete(sessionId);
    }
}

function getWebAuthCookie(sessionId) {
    return `${WEB_AUTH_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${WEB_AUTH_TTL_SECONDS}`;
}

function getWebAuthClearCookie() {
    return `${WEB_AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function getDefaultWebConfigPath() {
    return path.join(os.homedir(), '.manyoyo', 'manyoyo.json');
}

function hasOwn(obj, key) {
    return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function toPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value;
}

function pickFirstString() {
    for (let i = 0; i < arguments.length; i += 1) {
        const value = arguments[i];
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed) {
                return trimmed;
            }
        }
    }
    return '';
}

function resolveNowTemplate(value, formatDate) {
    if (typeof value !== 'string') {
        return value;
    }
    const nowText = typeof formatDate === 'function' ? formatDate() : '';
    return value.replace(/\{now\}|\$\{now\}/g, nowText);
}

function validateContainerNameStrict(containerName) {
    if (!SAFE_CONTAINER_NAME_PATTERN.test(containerName)) {
        throw new Error(`containerName 非法: ${containerName}`);
    }
}

function validateImageVersionStrict(imageVersion) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(imageVersion)) {
        throw new Error(`imageVersion 非法: ${imageVersion}`);
    }
    if (!IMAGE_VERSION_TAG_PATTERN.test(imageVersion)) {
        throw new Error(`imageVersion 格式必须为 <x.y.z-后缀>，例如 1.7.4-common。当前值: ${imageVersion}`);
    }
}

function validateWebHostPath(hostPath) {
    if (typeof hostPath !== 'string' || !hostPath.trim()) {
        throw new Error('hostPath 不能为空');
    }
    if (!fs.existsSync(hostPath)) {
        throw new Error(`宿主机路径不存在: ${hostPath}`);
    }
    const realHostPath = fs.realpathSync(hostPath);
    const homeDir = process.env.HOME || os.homedir() || '/home';
    if (realHostPath === '/' || realHostPath === '/home' || realHostPath === homeDir) {
        throw new Error('不允许挂载根目录或home目录。');
    }
}

function parseEnvEntry(entryText) {
    const text = String(entryText || '');
    const idx = text.indexOf('=');
    if (idx <= 0) {
        throw new Error(`env 格式应为 KEY=VALUE: ${text}`);
    }
    const key = text.slice(0, idx);
    const value = text.slice(idx + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`env key 非法: ${key}`);
    }
    if (/[\r\n\0]/.test(value) || /[;&|`$<>]/.test(value)) {
        throw new Error(`env value 含非法字符: ${key}`);
    }
    return { key, value };
}

function normalizeEnvMap(envConfig, sourceLabel) {
    if (envConfig === undefined || envConfig === null) {
        return {};
    }
    if (typeof envConfig !== 'object' || Array.isArray(envConfig)) {
        throw new Error(`${sourceLabel} 必须是对象(map)`);
    }
    const result = {};
    for (const [key, rawValue] of Object.entries(envConfig)) {
        if (rawValue !== null && !['string', 'number', 'boolean'].includes(typeof rawValue)) {
            throw new Error(`${sourceLabel}.${key} 必须是 string/number/boolean/null`);
        }
        const parsed = parseEnvEntry(`${key}=${rawValue === null ? '' : String(rawValue)}`);
        result[parsed.key] = parsed.value;
    }
    return result;
}

function normalizeStringArray(value, sourceLabel) {
    if (value === undefined || value === null) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error(`${sourceLabel} 必须是数组`);
    }
    return value
        .map(item => String(item || '').trim())
        .filter(Boolean);
}

function parseEnvFileToArgs(filePath) {
    if (!path.isAbsolute(filePath)) {
        throw new Error(`envFile 仅支持绝对路径: ${filePath}`);
    }
    if (!fs.existsSync(filePath)) {
        throw new Error(`未找到环境文件: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const args = [];
    const lines = content.split('\n');

    for (let line of lines) {
        const match = line.match(/^(?:export\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/);
        if (!match) {
            continue;
        }

        const key = match[1];
        let value = match[2].trim();
        if (/[\r\n\0]/.test(value)) continue;
        if (/[\$\(\)\`\|\&\*\{\};<>]/.test(value)) continue;
        if (/^\(/.test(value)) continue;

        if (/^"(.*)"$/.test(value)) {
            value = value.slice(1, -1);
        } else if (/^'(.*)'$/.test(value)) {
            value = value.slice(1, -1);
        }
        args.push('--env', `${key}=${value}`);
    }

    return args;
}

function resolveContainerModeArgs(mode) {
    const modeAliasMap = {
        common: 'common',
        'docker-in-docker': 'dind',
        dind: 'dind',
        d: 'dind',
        'mount-docker-socket': 'sock',
        sock: 'sock',
        s: 'sock'
    };
    const normalized = modeAliasMap[String(mode || '').trim().toLowerCase()];
    if (!normalized) {
        throw new Error(`未知 containerMode: ${mode}`);
    }
    if (normalized === 'common') {
        return { mode: 'common', args: [] };
    }
    if (normalized === 'dind') {
        return { mode: 'dind', args: ['--privileged'] };
    }
    return {
        mode: 'sock',
        args: [
            '--privileged',
            '--volume', '/var/run/docker.sock:/var/run/docker.sock',
            '--env', 'DOCKER_HOST=unix:///var/run/docker.sock',
            '--env', 'CONTAINER_HOST=unix:///var/run/docker.sock'
        ]
    };
}

function resolveYoloCommand(yolo) {
    const key = String(yolo || '').trim().toLowerCase();
    if (!key) {
        return '';
    }
    const mapped = YOLO_COMMAND_MAP[key];
    if (!mapped) {
        throw new Error(`未知 yolo 值: ${yolo}`);
    }
    return mapped;
}

function buildDefaultCommand(shellPrefix, shell, shellSuffix) {
    const parts = [];
    if (shellPrefix && String(shellPrefix).trim()) {
        parts.push(String(shellPrefix).trim());
    }
    if (shell && String(shell).trim()) {
        parts.push(String(shell).trim());
    }
    if (shellSuffix && String(shellSuffix).trim()) {
        parts.push(String(shellSuffix).trim());
    }
    return parts.join(' ').trim();
}

function validateWebConfigShape(configObject) {
    const config = toPlainObject(configObject);

    if (hasOwn(config, 'containerName') && String(config.containerName || '').trim()) {
        validateContainerNameStrict(resolveNowTemplate(String(config.containerName), () => '0101-0000'));
    }
    if (hasOwn(config, 'imageVersion') && String(config.imageVersion || '').trim()) {
        validateImageVersionStrict(String(config.imageVersion).trim());
    }
    if (hasOwn(config, 'env')) {
        normalizeEnvMap(config.env, 'env');
    }
    if (hasOwn(config, 'envFile')) {
        normalizeStringArray(config.envFile, 'envFile');
    }
    if (hasOwn(config, 'volumes')) {
        normalizeStringArray(config.volumes, 'volumes');
    }
    if (hasOwn(config, 'ports')) {
        normalizeStringArray(config.ports, 'ports');
    }
    if (hasOwn(config, 'runs')) {
        const runs = config.runs;
        if (runs !== undefined && (typeof runs !== 'object' || runs === null || Array.isArray(runs))) {
            throw new Error('runs 必须是对象(map)');
        }
    }
}

function readWebConfigSnapshot(configPath) {
    const resolvedPath = path.resolve(configPath || getDefaultWebConfigPath());
    if (!fs.existsSync(resolvedPath)) {
        return {
            path: resolvedPath,
            raw: DEFAULT_WEB_CONFIG_TEMPLATE,
            parsed: {},
            parseError: null,
            exists: false
        };
    }

    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    if (!String(raw || '').trim()) {
        return {
            path: resolvedPath,
            raw,
            parsed: {},
            parseError: null,
            exists: true
        };
    }

    try {
        const parsed = JSON5.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('配置根节点必须是对象(map)');
        }
        const config = toPlainObject(parsed);
        validateWebConfigShape(config);
        return {
            path: resolvedPath,
            raw,
            parsed: config,
            parseError: null,
            exists: true
        };
    } catch (e) {
        return {
            path: resolvedPath,
            raw,
            parsed: {},
            parseError: e && e.message ? e.message : '配置解析失败',
            exists: true
        };
    }
}

function parseAndValidateConfigRaw(raw) {
    const parsed = JSON5.parse(String(raw || ''));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('配置根节点必须是对象(map)');
    }
    const config = toPlainObject(parsed);
    validateWebConfigShape(config);
    return config;
}

function buildConfigDefaults(ctx, config) {
    const parsed = toPlainObject(config);
    const defaults = {
        containerName: hasOwn(parsed, 'containerName') ? String(parsed.containerName || '') : '',
        hostPath: pickFirstString(parsed.hostPath, ctx.hostPath),
        containerPath: pickFirstString(parsed.containerPath, ctx.containerPath),
        imageName: pickFirstString(parsed.imageName, ctx.imageName),
        imageVersion: pickFirstString(parsed.imageVersion, ctx.imageVersion),
        containerMode: hasOwn(parsed, 'containerMode') ? String(parsed.containerMode || '') : '',
        shellPrefix: hasOwn(parsed, 'shellPrefix') ? String(parsed.shellPrefix || '') : '',
        shell: hasOwn(parsed, 'shell') ? String(parsed.shell || '') : '',
        shellSuffix: hasOwn(parsed, 'shellSuffix') ? String(parsed.shellSuffix || '') : '',
        yolo: hasOwn(parsed, 'yolo') ? String(parsed.yolo || '') : '',
        env: {},
        envFile: [],
        volumes: [],
        ports: []
    };

    try {
        defaults.env = normalizeEnvMap(parsed.env, 'env');
    } catch (e) {
        defaults.env = {};
    }
    try {
        defaults.envFile = normalizeStringArray(parsed.envFile, 'envFile');
    } catch (e) {
        defaults.envFile = [];
    }
    try {
        defaults.volumes = normalizeStringArray(parsed.volumes, 'volumes');
    } catch (e) {
        defaults.volumes = [];
    }
    try {
        defaults.ports = normalizeStringArray(parsed.ports, 'ports');
    } catch (e) {
        defaults.ports = [];
    }

    return defaults;
}

function buildStaticContainerRuntime(ctx, containerName) {
    return {
        containerName,
        hostPath: ctx.hostPath,
        containerPath: ctx.containerPath,
        imageName: ctx.imageName,
        imageVersion: ctx.imageVersion,
        contModeArgs: Array.isArray(ctx.contModeArgs) ? ctx.contModeArgs.slice() : [],
        containerEnvs: Array.isArray(ctx.containerEnvs) ? ctx.containerEnvs.slice() : [],
        containerVolumes: Array.isArray(ctx.containerVolumes) ? ctx.containerVolumes.slice() : [],
        containerPorts: Array.isArray(ctx.containerPorts) ? ctx.containerPorts.slice() : [],
        defaultCommand: buildDefaultCommand(ctx.execCommandPrefix, ctx.execCommand, ctx.execCommandSuffix) || '/bin/bash'
    };
}

function buildCreateRuntime(ctx, state, payload) {
    const body = toPlainObject(payload);
    const requestOptions = toPlainObject(body.createOptions);
    const snapshot = readWebConfigSnapshot(state.webConfigPath);
    const config = snapshot.parseError ? {} : snapshot.parsed;

    const hasRequestEnv = hasOwn(requestOptions, 'env');
    const hasRequestEnvFile = hasOwn(requestOptions, 'envFile');
    const hasRequestVolumes = hasOwn(requestOptions, 'volumes');
    const hasRequestPorts = hasOwn(requestOptions, 'ports');
    const hasConfigEnv = hasOwn(config, 'env');
    const hasConfigEnvFile = hasOwn(config, 'envFile');
    const hasConfigVolumes = hasOwn(config, 'volumes');
    const hasConfigPorts = hasOwn(config, 'ports');

    const requestName = pickFirstString(requestOptions.containerName, body.name);
    let containerName = pickFirstString(requestName, config.containerName);
    if (!containerName) {
        containerName = `my-${ctx.formatDate()}`;
    }
    containerName = resolveNowTemplate(containerName, ctx.formatDate);
    validateContainerNameStrict(containerName);

    const hostPath = pickFirstString(requestOptions.hostPath, config.hostPath, ctx.hostPath);
    validateWebHostPath(hostPath);

    const containerPath = pickFirstString(requestOptions.containerPath, config.containerPath, ctx.containerPath, hostPath) || hostPath;
    const imageName = pickFirstString(requestOptions.imageName, config.imageName, ctx.imageName);
    const imageVersion = pickFirstString(requestOptions.imageVersion, config.imageVersion, ctx.imageVersion);

    if (!/^[A-Za-z0-9][A-Za-z0-9._/:-]*$/.test(imageName)) {
        throw new Error(`imageName 非法: ${imageName}`);
    }
    validateImageVersionStrict(imageVersion);

    let contModeArgs = Array.isArray(ctx.contModeArgs) ? ctx.contModeArgs.slice() : [];
    let containerMode = '';
    const modeValue = pickFirstString(requestOptions.containerMode, config.containerMode);
    if (modeValue) {
        const mode = resolveContainerModeArgs(modeValue);
        containerMode = mode.mode;
        contModeArgs = mode.args;
    }

    const shellPrefix = hasOwn(requestOptions, 'shellPrefix')
        ? String(requestOptions.shellPrefix || '')
        : (hasOwn(config, 'shellPrefix') ? String(config.shellPrefix || '') : String(ctx.execCommandPrefix || ''));
    let shell = hasOwn(requestOptions, 'shell')
        ? String(requestOptions.shell || '')
        : (hasOwn(config, 'shell') ? String(config.shell || '') : String(ctx.execCommand || ''));
    const shellSuffix = hasOwn(requestOptions, 'shellSuffix')
        ? String(requestOptions.shellSuffix || '')
        : (hasOwn(config, 'shellSuffix') ? String(config.shellSuffix || '') : String(ctx.execCommandSuffix || ''));
    const yolo = hasOwn(requestOptions, 'yolo')
        ? String(requestOptions.yolo || '')
        : (hasOwn(config, 'yolo') ? String(config.yolo || '') : '');
    const yoloCommand = resolveYoloCommand(yolo);
    if (yoloCommand) {
        shell = yoloCommand;
    }

    let containerEnvs = Array.isArray(ctx.containerEnvs) ? ctx.containerEnvs.slice() : [];
    if (hasRequestEnv || hasRequestEnvFile || hasConfigEnv || hasConfigEnvFile) {
        const configEnv = normalizeEnvMap(config.env, 'config.env');
        const requestEnv = hasRequestEnv ? normalizeEnvMap(requestOptions.env, 'createOptions.env') : {};
        const mergedEnv = { ...configEnv, ...requestEnv };
        const envArgs = [];
        Object.entries(mergedEnv).forEach(([key, value]) => {
            const parsed = parseEnvEntry(`${key}=${value}`);
            envArgs.push('--env', `${parsed.key}=${parsed.value}`);
        });

        const envFileList = hasRequestEnvFile
            ? normalizeStringArray(requestOptions.envFile, 'createOptions.envFile')
            : normalizeStringArray(config.envFile, 'config.envFile');
        const envFileArgs = [];
        envFileList.forEach(filePath => {
            envFileArgs.push(...parseEnvFileToArgs(filePath));
        });

        containerEnvs = [...envArgs, ...envFileArgs];
    }

    let containerVolumes = Array.isArray(ctx.containerVolumes) ? ctx.containerVolumes.slice() : [];
    if (hasRequestVolumes || hasConfigVolumes) {
        const volumeList = hasRequestVolumes
            ? normalizeStringArray(requestOptions.volumes, 'createOptions.volumes')
            : normalizeStringArray(config.volumes, 'config.volumes');
        containerVolumes = [];
        volumeList.forEach(volume => {
            containerVolumes.push('--volume', volume);
        });
    }

    let containerPorts = Array.isArray(ctx.containerPorts) ? ctx.containerPorts.slice() : [];
    if (hasRequestPorts || hasConfigPorts) {
        const portList = hasRequestPorts
            ? normalizeStringArray(requestOptions.ports, 'createOptions.ports')
            : normalizeStringArray(config.ports, 'config.ports');
        containerPorts = [];
        portList.forEach(port => {
            containerPorts.push('--publish', port);
        });
    }

    return {
        containerName,
        hostPath,
        containerPath,
        imageName,
        imageVersion,
        contModeArgs,
        containerEnvs,
        containerVolumes,
        containerPorts,
        defaultCommand: buildDefaultCommand(shellPrefix, shell, shellSuffix) || '/bin/bash',
        applied: {
            containerName,
            hostPath,
            containerPath,
            imageName,
            imageVersion,
            containerMode,
            shellPrefix: shellPrefix || '',
            shell: shell || '',
            shellSuffix: shellSuffix || '',
            yolo: yolo || '',
            envCount: Math.floor(containerEnvs.length / 2),
            volumeCount: Math.floor(containerVolumes.length / 2),
            portCount: Math.floor(containerPorts.length / 2)
        }
    };
}

function listWebManyoyoContainers(ctx) {
    const output = ctx.dockerExecArgs(
        ['ps', '-a', '--filter', 'label=manyoyo.default_cmd', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}'],
        { ignoreError: true }
    );

    const map = {};
    if (!output.trim()) {
        return map;
    }

    output.trim().split('\n').forEach(line => {
        const [name, status, image] = line.split('\t');
        if (!ctx.isValidContainerName(name)) {
            return;
        }
        map[name] = {
            name,
            status: status || 'unknown',
            image: image || ''
        };
    });

    return map;
}

async function ensureWebContainer(ctx, state, containerInput) {
    const runtime = typeof containerInput === 'string'
        ? buildStaticContainerRuntime(ctx, containerInput)
        : containerInput;

    if (!runtime || !runtime.containerName) {
        throw new Error('containerName 不能为空');
    }

    if (!ctx.containerExists(runtime.containerName)) {
        const args = buildContainerRunArgs({
            containerName: runtime.containerName,
            hostPath: runtime.hostPath,
            containerPath: runtime.containerPath,
            imageName: runtime.imageName,
            imageVersion: runtime.imageVersion,
            contModeArgs: runtime.contModeArgs,
            containerEnvs: runtime.containerEnvs,
            containerVolumes: runtime.containerVolumes,
            containerPorts: runtime.containerPorts,
            defaultCommand: runtime.defaultCommand
        });

        try {
            ctx.dockerExecArgs(args, { stdio: 'pipe' });
        } catch (e) {
            ctx.showImagePullHint(e);
            throw e;
        }

        await ctx.waitForContainerReady(runtime.containerName);
        appendWebSessionMessage(state.webHistoryDir, runtime.containerName, 'system', `容器 ${runtime.containerName} 已创建并启动。`);
        return;
    }

    const status = ctx.getContainerStatus(runtime.containerName);
    if (status !== 'running') {
        ctx.dockerExecArgs(['start', runtime.containerName], { stdio: 'pipe' });
        appendWebSessionMessage(state.webHistoryDir, runtime.containerName, 'system', `容器 ${runtime.containerName} 已启动。`);
    }
}

async function execCommandInWebContainer(ctx, containerName, command) {
    return await new Promise((resolve, reject) => {
        const process = spawn(
            ctx.dockerCmd,
            ['exec', containerName, '/bin/bash', '-lc', command],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        const MAX_RAW_OUTPUT_CHARS = 32 * 1024 * 1024;
        let rawOutput = '';
        let outputTruncated = false;

        function appendChunk(chunk) {
            if (!chunk) return;
            const text = chunk.toString('utf-8');
            if (!text) return;
            if (rawOutput.length >= MAX_RAW_OUTPUT_CHARS) {
                outputTruncated = true;
                return;
            }
            const remain = MAX_RAW_OUTPUT_CHARS - rawOutput.length;
            if (text.length > remain) {
                rawOutput += text.slice(0, remain);
                outputTruncated = true;
                return;
            }
            rawOutput += text;
        }

        process.stdout.on('data', appendChunk);
        process.stderr.on('data', appendChunk);

        process.on('error', reject);
        process.on('close', code => {
            const exitCode = typeof code === 'number' ? code : 1;
            const clippedRaw = outputTruncated ? `${rawOutput}\n...[raw-truncated]` : rawOutput;
            const output = clipText(stripAnsi(clippedRaw).trim() || '(无输出)');
            resolve({ exitCode, output });
        });
    });
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString('utf-8');
            if (body.length > 1024 * 1024) {
                reject(new Error('请求体过大'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

async function readJsonBody(req) {
    const body = await readRequestBody(req);
    if (!body.trim()) {
        return {};
    }
    try {
        return JSON.parse(body);
    } catch (e) {
        throw new Error('JSON body 格式错误');
    }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders
    });
    res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html, extraHeaders = {}) {
    res.writeHead(statusCode, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders
    });
    res.end(html);
}

function decodeSessionName(encoded) {
    try {
        return decodeURIComponent(encoded);
    } catch (e) {
        return encoded;
    }
}

function getValidSessionName(ctx, res, encodedName) {
    const containerName = decodeSessionName(encodedName);
    if (!ctx.isValidContainerName(containerName)) {
        sendJson(res, 400, { error: `containerName 非法: ${containerName}` });
        return null;
    }
    return containerName;
}

function buildSessionSummary(ctx, state, containerMap, name) {
    const history = loadWebSessionHistory(state.webHistoryDir, name);
    const latestMessage = history.messages.length ? history.messages[history.messages.length - 1] : null;
    const containerInfo = containerMap[name] || {};
    const updatedAt = history.updatedAt || (latestMessage && latestMessage.timestamp) || null;
    return {
        name,
        status: containerInfo.status || 'history',
        image: containerInfo.image || '',
        updatedAt,
        messageCount: history.messages.length
    };
}

function isSafeStaticAssetName(name) {
    return /^[A-Za-z0-9._-]+$/.test(name);
}

function resolveStaticAsset(name) {
    if (!isSafeStaticAssetName(name)) {
        return null;
    }
    const fullPath = path.join(FRONTEND_DIR, name);
    return fs.existsSync(fullPath) ? fullPath : null;
}

function resolveVendorAsset(name) {
    if (!isSafeStaticAssetName(name)) {
        return null;
    }
    if (name === 'xterm.js') {
        return XTERM_JS_FILE && fs.existsSync(XTERM_JS_FILE) ? XTERM_JS_FILE : null;
    }
    if (name === 'xterm.css') {
        return XTERM_CSS_FILE && fs.existsSync(XTERM_CSS_FILE) ? XTERM_CSS_FILE : null;
    }
    if (name === 'xterm-addon-fit.js') {
        return XTERM_ADDON_FIT_JS_FILE && fs.existsSync(XTERM_ADDON_FIT_JS_FILE) ? XTERM_ADDON_FIT_JS_FILE : null;
    }
    return null;
}

function sendFileAsset(res, filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        sendHtml(res, 404, '<h1>404 Not Found</h1>');
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
    });
    res.end(content);
}

function sendStaticAsset(res, assetName) {
    sendFileAsset(res, resolveStaticAsset(assetName));
}

function sendVendorAsset(res, assetName) {
    sendFileAsset(res, resolveVendorAsset(assetName));
}

function loadTemplate(name) {
    const filePath = resolveStaticAsset(name);
    if (!filePath) {
        return '<h1>Template Not Found</h1>';
    }
    return fs.readFileSync(filePath, 'utf-8');
}

function toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}

function normalizeTerminalSize(cols, rows) {
    return {
        cols: Math.max(WEB_TERMINAL_MIN_COLS, toPositiveInt(cols, WEB_TERMINAL_DEFAULT_COLS)),
        rows: Math.max(WEB_TERMINAL_MIN_ROWS, toPositiveInt(rows, WEB_TERMINAL_DEFAULT_ROWS))
    };
}

function getUpgradeStatusText(statusCode) {
    if (statusCode === 400) return 'Bad Request';
    if (statusCode === 401) return 'Unauthorized';
    if (statusCode === 404) return 'Not Found';
    if (statusCode === 429) return 'Too Many Requests';
    if (statusCode === 500) return 'Internal Server Error';
    return 'Error';
}

function sendWebSocketUpgradeError(socket, statusCode, message) {
    const body = String(message || getUpgradeStatusText(statusCode));
    const reason = getUpgradeStatusText(statusCode);
    if (!socket.destroyed) {
        socket.write(
            `HTTP/1.1 ${statusCode} ${reason}\r\n` +
            'Content-Type: text/plain; charset=utf-8\r\n' +
            'Connection: close\r\n' +
            `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n` +
            '\r\n' +
            body
        );
    }
    socket.destroy();
}

function sendTerminalEvent(ws, type, payload = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }
    ws.send(JSON.stringify({ type, ...payload }));
}

function spawnWebTerminalProcess(ctx, containerName, cols, rows) {
    const terminalBootstrap = [
        'MANYOYO_WEB_BASHRC="$(mktemp /tmp/manyoyo-web-bashrc.XXXXXX 2>/dev/null || mktemp)"',
        'cat > "$MANYOYO_WEB_BASHRC" <<\'EOF_MANYOYO_RC\'',
        'if [ -f /etc/bash.bashrc ]; then',
        '    . /etc/bash.bashrc',
        'fi',
        'if [ -f ~/.bashrc ]; then',
        '    . ~/.bashrc',
        'fi',
        'if [ -n "${MANYOYO_TERM_COLS:-}" ] && [ -n "${MANYOYO_TERM_ROWS:-}" ]; then',
        '    COLUMNS="$MANYOYO_TERM_COLS"',
        '    LINES="$MANYOYO_TERM_ROWS"',
        '    export COLUMNS LINES',
        '    stty cols "$MANYOYO_TERM_COLS" rows "$MANYOYO_TERM_ROWS" >/dev/null 2>&1 || true',
        'fi',
        'EOF_MANYOYO_RC',
        'chmod 600 "$MANYOYO_WEB_BASHRC" >/dev/null 2>&1 || true',
        'if command -v script >/dev/null 2>&1; then',
        '  exec script -qefc "/bin/bash --rcfile $MANYOYO_WEB_BASHRC -i" /dev/null;',
        'fi;',
        'if command -v python3 >/dev/null 2>&1; then',
        '  exec python3 -c \'import os, pty; pty.spawn(["/bin/bash","--rcfile",os.environ.get("MANYOYO_WEB_BASHRC","/dev/null"),"-i"])\';',
        'fi;',
        'if command -v python >/dev/null 2>&1; then',
        '  exec python -c \'import os, pty; pty.spawn(["/bin/bash","--rcfile",os.environ.get("MANYOYO_WEB_BASHRC","/dev/null"),"-i"])\';',
        'fi;',
        'echo "[manyoyo] 容器内未找到 script/python，终端将降级为非 TTY 模式" >&2;',
        'exec /bin/bash --rcfile "$MANYOYO_WEB_BASHRC" -i'
    ].join('\n');

    const termValue = process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color';
    const colorTermValue = process.env.COLORTERM || 'truecolor';
    const dockerExecArgs = [
        'exec',
        '-i',
        '-e', `TERM=${termValue}`,
        '-e', `COLORTERM=${colorTermValue}`,
        '-e', `MANYOYO_TERM_COLS=${String(cols)}`,
        '-e', `MANYOYO_TERM_ROWS=${String(rows)}`,
        containerName,
        '/bin/bash',
        '-lc',
        terminalBootstrap
    ];

    return spawn(ctx.dockerCmd, dockerExecArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
}

function bindTerminalWebSocket(ctx, state, ws, containerName, cols, rows) {
    const sessionId = `${containerName}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const ptyProcess = spawnWebTerminalProcess(ctx, containerName, cols, rows);
    const session = {
        id: sessionId,
        containerName,
        ptyProcess,
        closing: false
    };

    state.terminalSessions.set(sessionId, session);
    sendTerminalEvent(ws, 'status', {
        phase: 'ready',
        sessionId,
        containerName,
        cols,
        rows
    });

    const cleanup = () => {
        if (session.closing) {
            return;
        }
        session.closing = true;
        state.terminalSessions.delete(sessionId);
        if (ptyProcess && !ptyProcess.killed) {
            ptyProcess.kill('SIGTERM');
            setTimeout(() => {
                if (!ptyProcess.killed) {
                    ptyProcess.kill('SIGKILL');
                }
            }, WEB_TERMINAL_FORCE_KILL_MS);
        }
    };

    ptyProcess.stdout.on('data', chunk => {
        sendTerminalEvent(ws, 'output', { data: chunk.toString('utf-8') });
    });

    ptyProcess.stderr.on('data', chunk => {
        sendTerminalEvent(ws, 'output', { data: chunk.toString('utf-8') });
    });

    ptyProcess.on('error', err => {
        sendTerminalEvent(ws, 'error', {
            error: err && err.message ? err.message : '终端进程启动失败'
        });
    });

    ptyProcess.on('close', (code, signal) => {
        sendTerminalEvent(ws, 'status', {
            phase: 'closed',
            code: typeof code === 'number' ? code : null,
            signal: signal || null
        });
        cleanup();
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    });

    ws.on('message', raw => {
        let payload = null;
        try {
            payload = JSON.parse(raw.toString('utf-8'));
        } catch (e) {
            payload = {
                type: 'input',
                data: raw.toString('utf-8')
            };
        }
        if (!payload || typeof payload !== 'object') {
            return;
        }

        if (payload.type === 'input' && typeof payload.data === 'string' && payload.data.length) {
            ptyProcess.stdin.write(payload.data);
            return;
        }

        if (payload.type === 'resize') {
            // 当前后端不直接驱动 docker exec 的 TTY 动态 resize，保留事件以便后续扩展。
            return;
        }

        if (payload.type === 'close') {
            ws.close();
        }
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
}

async function handleWebAuthRoutes(req, res, pathname, ctx, state) {
    if (req.method === 'GET' && pathname === '/auth/login') {
        sendHtml(res, 200, loadTemplate('login.html'));
        return true;
    }

    const authFrontendMatch = pathname.match(/^\/auth\/frontend\/([A-Za-z0-9._-]+)$/);
    if (req.method === 'GET' && authFrontendMatch) {
        const assetName = authFrontendMatch[1];
        if (!(assetName === 'login.css' || assetName === 'login.js')) {
            sendHtml(res, 404, '<h1>404 Not Found</h1>');
            return true;
        }
        sendStaticAsset(res, assetName);
        return true;
    }

    if (req.method === 'POST' && pathname === '/auth/login') {
        const payload = await readJsonBody(req);
        const username = String(payload.username || '').trim();
        const password = String(payload.password || '');

        if (!username || !password) {
            sendJson(res, 400, { error: '用户名和密码不能为空' });
            return true;
        }

        const userOk = secureStringEqual(username, ctx.authUser);
        const passOk = secureStringEqual(password, ctx.authPass);
        if (!(userOk && passOk)) {
            sendJson(res, 401, { error: '用户名或密码错误' });
            return true;
        }

        const sessionId = createWebAuthSession(state, username);
        sendJson(
            res,
            200,
            { ok: true, username },
            { 'Set-Cookie': getWebAuthCookie(sessionId) }
        );
        return true;
    }

    if (req.method === 'POST' && pathname === '/auth/logout') {
        clearWebAuthSession(state, req);
        sendJson(
            res,
            200,
            { ok: true },
            { 'Set-Cookie': getWebAuthClearCookie() }
        );
        return true;
    }

    return false;
}

function sendWebUnauthorized(res, pathname) {
    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
        sendJson(res, 401, { error: 'UNAUTHORIZED' });
        return;
    }
    sendHtml(
        res,
        401,
        loadTemplate('login.html'),
        { 'Set-Cookie': getWebAuthClearCookie() }
    );
}

async function handleWebApi(req, res, pathname, ctx, state) {
    const routes = [
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/config' ? [] : null,
            handler: async () => {
                const snapshot = readWebConfigSnapshot(state.webConfigPath);
                const defaults = buildConfigDefaults(ctx, snapshot.parseError ? {} : snapshot.parsed);
                sendJson(res, 200, {
                    path: snapshot.path,
                    raw: snapshot.raw,
                    parsed: snapshot.parseError ? null : snapshot.parsed,
                    parseError: snapshot.parseError,
                    defaults
                });
            }
        },
        {
            method: 'PUT',
            match: currentPath => currentPath === '/api/config' ? [] : null,
            handler: async () => {
                const payload = await readJsonBody(req);
                const raw = typeof payload.raw === 'string' ? payload.raw : '';
                if (!raw.trim()) {
                    sendJson(res, 400, { error: '配置内容不能为空' });
                    return;
                }

                let parsed = null;
                try {
                    parsed = parseAndValidateConfigRaw(raw);
                } catch (e) {
                    sendJson(res, 400, { error: '配置格式错误', detail: e.message || '解析失败' });
                    return;
                }

                const savePath = path.resolve(state.webConfigPath);
                fs.mkdirSync(path.dirname(savePath), { recursive: true });
                fs.writeFileSync(savePath, raw, 'utf-8');

                sendJson(res, 200, {
                    saved: true,
                    path: savePath,
                    defaults: buildConfigDefaults(ctx, parsed)
                });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/sessions' ? [] : null,
            handler: async () => {
                const containerMap = listWebManyoyoContainers(ctx);
                const names = new Set([
                    ...Object.keys(containerMap),
                    ...listWebHistorySessionNames(state.webHistoryDir, ctx.isValidContainerName)
                ]);

                const sessions = Array.from(names)
                    .map(name => buildSessionSummary(ctx, state, containerMap, name))
                    .sort((a, b) => {
                        const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                        const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                        return timeB - timeA;
                    });

                sendJson(res, 200, { sessions });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath === '/api/sessions' ? [] : null,
            handler: async () => {
                const payload = await readJsonBody(req);
                let runtime = null;
                try {
                    runtime = buildCreateRuntime(ctx, state, payload);
                } catch (e) {
                    sendJson(res, 400, { error: e.message || '创建参数错误' });
                    return;
                }

                await ensureWebContainer(ctx, state, runtime);
                sendJson(res, 200, { name: runtime.containerName, applied: runtime.applied });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/messages$/),
            handler: async match => {
                const containerName = getValidSessionName(ctx, res, match[1]);
                if (!containerName) {
                    return;
                }
                const history = loadWebSessionHistory(state.webHistoryDir, containerName);
                sendJson(res, 200, { name: containerName, messages: history.messages });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/run$/),
            handler: async match => {
                const containerName = getValidSessionName(ctx, res, match[1]);
                if (!containerName) {
                    return;
                }

                const payload = await readJsonBody(req);
                const command = (payload.command || '').trim();
                if (!command) {
                    sendJson(res, 400, { error: 'command 不能为空' });
                    return;
                }

                await ensureWebContainer(ctx, state, containerName);
                appendWebSessionMessage(state.webHistoryDir, containerName, 'user', command);
                const result = await execCommandInWebContainer(ctx, containerName, command);
                appendWebSessionMessage(
                    state.webHistoryDir,
                    containerName,
                    'assistant',
                    result.output,
                    { exitCode: result.exitCode }
                );
                sendJson(res, 200, { exitCode: result.exitCode, output: result.output });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/remove$/),
            handler: async match => {
                const containerName = getValidSessionName(ctx, res, match[1]);
                if (!containerName) {
                    return;
                }

                if (ctx.containerExists(containerName)) {
                    ctx.removeContainer(containerName);
                    appendWebSessionMessage(state.webHistoryDir, containerName, 'system', `容器 ${containerName} 已删除。`);
                }

                sendJson(res, 200, { removed: true, name: containerName });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/remove-with-history$/),
            handler: async match => {
                const containerName = getValidSessionName(ctx, res, match[1]);
                if (!containerName) {
                    return;
                }

                removeWebSessionHistory(state.webHistoryDir, containerName);
                sendJson(res, 200, { removedHistory: true, name: containerName });
            }
        }
    ];

    for (const route of routes) {
        if (route.method !== req.method) {
            continue;
        }
        const matched = route.match(pathname);
        if (!matched) {
            continue;
        }
        await route.handler(matched);
        return true;
    }

    return false;
}

async function startWebServer(options) {
    const ctx = {
        serverHost: options.serverHost || '127.0.0.1',
        serverPort: options.serverPort,
        authUser: options.authUser,
        authPass: options.authPass,
        authPassAuto: options.authPassAuto,
        dockerCmd: options.dockerCmd,
        hostPath: options.hostPath,
        containerPath: options.containerPath,
        imageName: options.imageName,
        imageVersion: options.imageVersion,
        execCommandPrefix: options.execCommandPrefix,
        execCommand: options.execCommand,
        execCommandSuffix: options.execCommandSuffix,
        contModeArgs: options.contModeArgs,
        containerEnvs: options.containerEnvs,
        containerVolumes: options.containerVolumes,
        containerPorts: options.containerPorts,
        validateHostPath: options.validateHostPath,
        formatDate: options.formatDate,
        isValidContainerName: options.isValidContainerName,
        containerExists: options.containerExists,
        getContainerStatus: options.getContainerStatus,
        waitForContainerReady: options.waitForContainerReady,
        dockerExecArgs: options.dockerExecArgs,
        showImagePullHint: options.showImagePullHint,
        removeContainer: options.removeContainer,
        colors: options.colors || {
            GREEN: '',
            CYAN: '',
            YELLOW: '',
            NC: ''
        }
    };

    if (!ctx.authUser || !ctx.authPass) {
        throw new Error('Web 认证配置缺失，请设置 --server-user / --server-pass');
    }

    const state = {
        webHistoryDir: options.webHistoryDir || path.join(os.homedir(), '.manyoyo', 'web-history'),
        webConfigPath: options.webConfigPath || getDefaultWebConfigPath(),
        authSessions: new Map(),
        terminalSessions: new Map()
    };

    ctx.validateHostPath();
    ensureWebHistoryDir(state.webHistoryDir);

    const wsServer = new WebSocket.Server({
        noServer: true,
        maxPayload: 1024 * 1024
    });

    wsServer.on('connection', (ws, req, meta = {}) => {
        const containerName = meta.containerName;
        if (!containerName || !ctx.isValidContainerName(containerName)) {
            ws.close();
            return;
        }
        const { cols, rows } = normalizeTerminalSize(meta.cols, meta.rows);
        bindTerminalWebSocket(ctx, state, ws, containerName, cols, rows);
    });

    const server = http.createServer(async (req, res) => {
        try {
            const fallbackHost = `${formatUrlHost(ctx.serverHost)}:${ctx.serverPort}`;
            const url = new URL(req.url, `http://${req.headers.host || fallbackHost}`);
            const pathname = url.pathname;

            // 全局认证入口：除登录路由外，默认全部请求都要求认证
            if (await handleWebAuthRoutes(req, res, pathname, ctx, state)) {
                return;
            }

            const authSession = getWebAuthSession(state, req);
            if (!authSession) {
                sendWebUnauthorized(res, pathname);
                return;
            }

            if (req.method === 'GET' && pathname === '/') {
                sendHtml(res, 200, loadTemplate('app.html'));
                return;
            }

            const appFrontendMatch = pathname.match(/^\/app\/frontend\/([A-Za-z0-9._-]+)$/);
            if (req.method === 'GET' && appFrontendMatch) {
                const assetName = appFrontendMatch[1];
                if (!(assetName === 'app.css' || assetName === 'app.js')) {
                    sendHtml(res, 404, '<h1>404 Not Found</h1>');
                    return;
                }
                sendStaticAsset(res, assetName);
                return;
            }

            const appVendorMatch = pathname.match(/^\/app\/vendor\/([A-Za-z0-9._-]+)$/);
            if (req.method === 'GET' && appVendorMatch) {
                const assetName = appVendorMatch[1];
                if (!(assetName === 'xterm.css' || assetName === 'xterm.js' || assetName === 'xterm-addon-fit.js')) {
                    sendHtml(res, 404, '<h1>404 Not Found</h1>');
                    return;
                }
                sendVendorAsset(res, assetName);
                return;
            }

            if (pathname === '/healthz') {
                sendJson(res, 200, { ok: true });
                return;
            }

            if (pathname.startsWith('/api/')) {
                const handled = await handleWebApi(req, res, pathname, ctx, state);
                if (!handled) {
                    sendJson(res, 404, { error: 'Not Found' });
                }
                return;
            }

            sendHtml(res, 404, '<h1>404 Not Found</h1>');
        } catch (e) {
            if ((req.url || '').startsWith('/api/')) {
                sendJson(res, 500, { error: e.message || 'Server Error' });
            } else {
                sendHtml(res, 500, '<h1>500 Server Error</h1>');
            }
        }
    });

    server.on('upgrade', (req, socket, head) => {
        const fallbackHost = `${formatUrlHost(ctx.serverHost)}:${ctx.serverPort}`;
        let url;
        try {
            url = new URL(req.url || '/', `http://${req.headers.host || fallbackHost}`);
        } catch (e) {
            sendWebSocketUpgradeError(socket, 400, 'Invalid URL');
            return;
        }

        const terminalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/terminal\/ws$/);
        if (!terminalMatch) {
            socket.destroy();
            return;
        }

        const authSession = getWebAuthSession(state, req);
        if (!authSession) {
            sendWebSocketUpgradeError(socket, 401, 'UNAUTHORIZED');
            return;
        }

        const containerName = decodeSessionName(terminalMatch[1]);
        if (!ctx.isValidContainerName(containerName)) {
            sendWebSocketUpgradeError(socket, 400, `containerName 非法: ${containerName}`);
            return;
        }

        if (state.terminalSessions.size >= WEB_TERMINAL_MAX_SESSIONS) {
            sendWebSocketUpgradeError(socket, 429, 'TERMINAL_LIMIT_REACHED');
            return;
        }

        const { cols, rows } = normalizeTerminalSize(
            url.searchParams.get('cols'),
            url.searchParams.get('rows')
        );

        ensureWebContainer(ctx, state, containerName)
            .then(() => {
                wsServer.handleUpgrade(req, socket, head, ws => {
                    wsServer.emit('connection', ws, req, {
                        containerName,
                        cols,
                        rows
                    });
                });
            })
            .catch(e => {
                sendWebSocketUpgradeError(socket, 500, e && e.message ? e.message : '终端创建失败');
            });
    });

    let listenPort = ctx.serverPort;

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(ctx.serverPort, ctx.serverHost, () => {
            const address = server.address();
            if (address && typeof address === 'object' && typeof address.port === 'number') {
                listenPort = address.port;
            }
            const { GREEN, CYAN, YELLOW, NC } = ctx.colors;
            const listenHost = formatUrlHost(ctx.serverHost);
            console.log(`${GREEN}✅ MANYOYO Web 服务已启动: http://${listenHost}:${listenPort}${NC}`);
            console.log(`${CYAN}提示: 左侧是 manyoyo 容器会话列表，右侧支持命令模式与交互式终端模式。${NC}`);
            if (ctx.serverHost === '0.0.0.0') {
                console.log(`${CYAN}提示: 当前监听全部网卡，请用本机局域网 IP 访问。${NC}`);
            }
            console.log(`${CYAN}🔐 登录用户名: ${YELLOW}${ctx.authUser}${NC}`);
            if (ctx.authPassAuto) {
                console.log(`${CYAN}🔐 登录密码(本次随机): ${YELLOW}${ctx.authPass}${NC}`);
            } else {
                console.log(`${CYAN}🔐 登录密码: 使用你配置的 --server-pass / serverPass / MANYOYO_SERVER_PASS${NC}`);
            }
            resolve();
        });
    });

    return {
        server,
        wsServer,
        host: ctx.serverHost,
        port: listenPort,
        close: () => new Promise(resolve => {
            for (const session of state.terminalSessions.values()) {
                const ptyProcess = session && session.ptyProcess;
                if (ptyProcess && !ptyProcess.killed) {
                    try { ptyProcess.kill('SIGTERM'); } catch (e) {}
                }
            }
            state.terminalSessions.clear();

            const closeHttp = () => {
                if (!server.listening) {
                    resolve();
                    return;
                }
                server.close(() => resolve());
            };

            try {
                wsServer.close(() => closeHttp());
            } catch (e) {
                closeHttp();
            }
        })
    };
}

module.exports = {
    startWebServer
};
