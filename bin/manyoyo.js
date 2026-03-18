#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const readline = require('readline');
const { Command } = require('commander');
const { startWebServer } = require('../lib/web/server');
const { buildContainerRunArgs, buildContainerRunCommand } = require('../lib/container-run');
const { getManyoyoConfigPath, readManyoyoConfig, syncGlobalImageVersion } = require('../lib/global-config');
const { initAgentConfigs } = require('../lib/init-config');
const { buildImage } = require('../lib/image-build');
const { resolveAgentResumeArg, buildAgentResumeCommand } = require('../lib/agent-resume');
const { runPluginCommand, createPlugin } = require('../lib/plugin');
const { buildManyoyoLogPath } = require('../lib/log-path');
const {
    sanitizeSensitiveData,
    sanitizeServeLogText,
    formatServeLogValue,
    getServeProcessSnapshot
} = require('../lib/serve-log');
const { version: BIN_VERSION, imageVersion: IMAGE_VERSION_DEFAULT } = require('../package.json');
const IMAGE_VERSION_BASE = String(IMAGE_VERSION_DEFAULT || '1.0.0').split('-')[0];
const IMAGE_VERSION_HELP_EXAMPLE = IMAGE_VERSION_DEFAULT || `${IMAGE_VERSION_BASE}-common`;

// Helper function to format date like bash $(date +%m%d-%H%M)
function formatDate() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    return `${month}${day}-${hour}${minute}`;
}

function detectCommandName() {
    const rawArgv1 = process.argv[1] || '';
    const baseName = path.basename(rawArgv1).replace(/\.(cjs|mjs|js)$/i, '');

    if (baseName === 'docker-manyoyo') {
        const pluginCommand = String(process.argv[2] || '').trim();
        return pluginCommand || 'manyoyo';
    }

    return baseName || 'manyoyo';
}

const CONFIG = {
    CONTAINER_READY_MAX_RETRIES: 30,      // 容器就绪最大重试次数
    CONTAINER_READY_INITIAL_DELAY: 100,   // 容器就绪初始延迟(ms)
    CONTAINER_READY_MAX_DELAY: 2000,      // 容器就绪最大延迟(ms)
};

// Default configuration
let CONTAINER_NAME = `my-${formatDate()}`;
let HOST_PATH = process.cwd();
let CONTAINER_PATH = HOST_PATH;
let IMAGE_NAME = "localhost/xcanwin/manyoyo";
let IMAGE_VERSION = IMAGE_VERSION_DEFAULT || `${IMAGE_VERSION_BASE}-common`;
let EXEC_COMMAND = "";
let EXEC_COMMAND_PREFIX = "";
let EXEC_COMMAND_SUFFIX = "";
let FIRST_EXEC_COMMAND = "";
let FIRST_EXEC_COMMAND_PREFIX = "";
let FIRST_EXEC_COMMAND_SUFFIX = "";
let IMAGE_BUILD_ARGS = [];
let CONTAINER_ENVS = [];
let FIRST_CONTAINER_ENVS = [];
let CONTAINER_VOLUMES = [];
let CONTAINER_PORTS = [];
let CONTAINER_EXTRA_ARGS = [];
const MANYOYO_NAME = detectCommandName();
let CONT_MODE_ARGS = [];
let QUIET = {};
let RM_ON_EXIT = false;
let SERVER_HOST = '127.0.0.1';
let SERVER_PORT = 3000;
let SERVER_AUTH_USER = "";
let SERVER_AUTH_PASS = "";
let SERVER_AUTH_PASS_AUTO = false;
const SAFE_CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// Color definitions using ANSI codes
const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const CYAN = '\x1b[0;36m';
const NC = '\x1b[0m'; // No Color
const IMAGE_VERSION_TAG_PATTERN = /^(\d+\.\d+\.\d+)-([A-Za-z0-9][A-Za-z0-9_.-]*)$/;

// Docker command (will be set by ensure_docker)
let DOCKER_CMD = 'docker';
const SUPPORTED_INIT_AGENTS = ['claude', 'codex', 'gemini', 'opencode'];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeCommandSuffix(suffix) {
    if (typeof suffix !== 'string') return "";
    const trimmed = suffix.trim();
    return trimmed ? ` ${trimmed}` : "";
}

function resolveContainerNameTemplate(name) {
    if (typeof name !== 'string') {
        return name;
    }
    const nowValue = formatDate();
    return name.replace(/\{now\}|\$\{now\}/g, nowValue);
}

function pickConfigValue(...values) {
    for (const value of values) {
        if (value) {
            return value;
        }
    }
    return undefined;
}

function mergeArrayConfig(globalValue, runValue, cliValue) {
    return [...(globalValue || []), ...(runValue || []), ...(cliValue || [])];
}

function validateServerHost(host, rawServer) {
    const value = String(host || '').trim();
    const isIp = net.isIP(value) !== 0;

    if (isIp) {
        return value;
    }

    console.error(`${RED}⚠️  错误: serve 地址格式必须为 <ip:port> (例如 127.0.0.1:3000 / 0.0.0.0:3000): ${rawServer}${NC}`);
    process.exit(1);
}

function parseServerListen(rawServer) {
    if (rawServer === true || rawServer === undefined || rawServer === null || rawServer === '') {
        return { host: '127.0.0.1', port: 3000 };
    }

    const value = String(rawServer).trim();
    if (!value) {
        return { host: '127.0.0.1', port: 3000 };
    }

    let host = '';
    let portText = '';

    const ipv6Match = value.match(/^\[([^\]]+)\]:(\d+)$/);
    if (ipv6Match) {
        host = ipv6Match[1].trim();
        portText = ipv6Match[2].trim();
    } else {
        const lastColonIndex = value.lastIndexOf(':');
        if (lastColonIndex <= 0) {
            console.error(`${RED}⚠️  错误: serve 地址格式必须为 <ip:port> (例如 127.0.0.1:3000 / 0.0.0.0:3000): ${rawServer}${NC}`);
            process.exit(1);
        }
        const maybePort = value.slice(lastColonIndex + 1).trim();
        if (/^\d+$/.test(maybePort)) {
            host = value.slice(0, lastColonIndex).trim();
            portText = maybePort;
        }
    }

    if (!/^\d+$/.test(portText)) {
        console.error(`${RED}⚠️  错误: serve 端口必须是 1-65535 的整数: ${rawServer}${NC}`);
        process.exit(1);
    }

    const port = Number(portText);
    if (port < 1 || port > 65535) {
        console.error(`${RED}⚠️  错误: serve 端口超出范围 (1-65535): ${rawServer}${NC}`);
        process.exit(1);
    }

    return {
        host: validateServerHost(host, rawServer),
        port
    };
}

function ensureWebServerAuthCredentials() {
    if (!SERVER_AUTH_USER) {
        SERVER_AUTH_USER = 'admin';
    }

    if (!SERVER_AUTH_PASS) {
        SERVER_AUTH_PASS = crypto.randomBytes(12).toString('hex');
        SERVER_AUTH_PASS_AUTO = true;
    }
}

function createServeLogger() {
    function formatLocalTimestamp(date = new Date()) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        const ss = String(date.getSeconds()).padStart(2, '0');
        const ms = String(date.getMilliseconds()).padStart(3, '0');
        const offsetMinutes = -date.getTimezoneOffset();
        const sign = offsetMinutes >= 0 ? '+' : '-';
        const abs = Math.abs(offsetMinutes);
        const offH = String(Math.floor(abs / 60)).padStart(2, '0');
        const offM = String(abs % 60).padStart(2, '0');
        return `${y}-${m}-${d}T${hh}:${mm}:${ss}.${ms}${sign}${offH}:${offM}`;
    }

    const serveLog = buildManyoyoLogPath('serve');
    const logDir = serveLog.dir;
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = serveLog.path;

    function write(level, message, extra) {
        const ts = formatLocalTimestamp();
        const parts = [
            `[${ts}]`,
            `[pid:${process.pid}]`,
            `[${String(level || 'INFO').toUpperCase()}]`,
            formatServeLogValue(message)
        ];
        if (extra !== undefined) {
            parts.push(formatServeLogValue(extra));
        }
        fs.appendFileSync(logPath, `${parts.join(' ')}\n`);
    }

    return {
        path: logPath,
        info: (message, extra) => write('INFO', message, extra),
        warn: (message, extra) => write('WARN', message, extra),
        error: (message, extra) => write('ERROR', message, extra)
    };
}

function installServeProcessDiagnostics(logger) {
    if (!logger || typeof logger.info !== 'function') return;
    if (global.__manyoyoServeDiagInstalled) return;
    global.__manyoyoServeDiagInstalled = true;

    const signalExitCode = {
        SIGINT: 130,
        SIGTERM: 143,
        SIGHUP: 129
    };

    process.on('uncaughtException', err => {
        logger.error('uncaughtException', {
            error: err,
            process: getServeProcessSnapshot()
        });
        process.exit(1);
    });

    process.on('unhandledRejection', reason => {
        logger.error('unhandledRejection', {
            reason,
            process: getServeProcessSnapshot()
        });
        process.exit(1);
    });

    ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(signal => {
        process.on(signal, () => {
            logger.warn(`received ${signal}, process will exit`, {
                signal,
                process: getServeProcessSnapshot()
            });
            process.exit(signalExitCode[signal] || 1);
        });
    });

    process.on('exit', code => {
        logger.info(`process exit with code=${code}`, {
            process: getServeProcessSnapshot()
        });
    });
}

/**
 * @typedef {Object} Config
 * @property {string} [containerName] - 容器名称
 * @property {string} [hostPath] - 宿主机路径
 * @property {string} [containerPath] - 容器路径
 * @property {string} [imageName] - 镜像名称
 * @property {string} [imageVersion] - 镜像版本
 * @property {Object.<string, string|number|boolean>} [env] - 环境变量映射
 * @property {string[]} [envFile] - 环境文件数组
 * @property {{shellPrefix?:string,shell?:string,shellSuffix?:string,env?:Object.<string,string|number|boolean>,envFile?:string[]}} [first] - 仅首次创建容器执行的一次性命令配置
 * @property {string[]} [volumes] - 挂载卷数组
 * @property {Object.<string, Object>} [plugins] - 可选插件配置映射（如 plugins.playwright）
 * @property {Object.<string, Object>} [runs] - 运行配置映射（-r <name>）
 * @property {string} [yolo] - YOLO 模式
 * @property {string} [containerMode] - 容器模式
 * @property {number} [cacheTTL] - 缓存过期天数
 * @property {string} [nodeMirror] - Node.js 镜像源
 */

/**
 * 加载全局配置文件
 * @returns {Config} 配置对象
 */
function loadConfig() {
    const result = readManyoyoConfig();
    if (result.exists) {
        if (result.parseError) {
            console.error(`${YELLOW}⚠️  配置文件格式错误: ${result.path}${NC}`);
            return {};
        }
        return result.config;
    }
    return {};
}

function syncBuiltImageVersionToGlobalConfig(imageVersion) {
    const syncResult = syncGlobalImageVersion(imageVersion);
    if (syncResult.updated) {
        console.log(`${GREEN}✅ 已同步 ${path.basename(getManyoyoConfigPath())} 的 imageVersion: ${imageVersion}${NC}`);
        return;
    }
    if (syncResult.reason === 'unchanged') {
        return;
    }
    console.log(`${YELLOW}⚠️  镜像构建成功，但未更新 imageVersion: ${syncResult.path}${NC}`);
}

function loadRunConfig(name, config) {
    const runName = String(name || '').trim();
    if (!runName) {
        console.error(`${RED}⚠️  错误: --run 不能为空${NC}`);
        process.exit(1);
    }
    if (runName.includes('/') || runName.includes('\\')) {
        console.error(`${RED}⚠️  错误: --run 仅支持 runs 配置名: ${name}${NC}`);
        process.exit(1);
    }

    const runs = config && config.runs;
    if (runs !== undefined && (typeof runs !== 'object' || runs === null || Array.isArray(runs))) {
        console.error(`${RED}⚠️  错误: ~/.manyoyo/manyoyo.json 的 runs 必须是对象(map)${NC}`);
        process.exit(1);
    }

    const runConfig = runs && Object.prototype.hasOwnProperty.call(runs, runName) ? runs[runName] : undefined;
    if (!runConfig || typeof runConfig !== 'object' || Array.isArray(runConfig)) {
        console.error(`${RED}⚠️  未找到运行配置: runs.${runName}${NC}`);
        process.exit(1);
    }

    return runConfig;
}

function getHelloTip(containerName, defaultCommand, runningCommand) {
    if ( !(QUIET.tip || QUIET.full) ) {
        const resumeArg = resolveAgentResumeArg(runningCommand);
        console.log("");
        console.log(`${BLUE}----------------------------------------${NC}`);
        console.log(`📦 首次命令        : ${defaultCommand}`);
        if (resumeArg) {
            console.log(`⚫ 恢复首次命令会话: ${CYAN}${MANYOYO_NAME} run -n ${containerName} -- ${resumeArg}${NC}`);
        }
        console.log(`⚫ 执行首次命令    : ${GREEN}${MANYOYO_NAME} run -n ${containerName}${NC}`);
        console.log(`⚫ 执行指定命令    : ${GREEN}${MANYOYO_NAME} run -n ${containerName} -x /bin/bash${NC}`);
        console.log(`⚫ 执行指定命令    : ${GREEN}docker exec -it ${containerName} /bin/bash${NC}`);
        console.log(`⚫ 删除容器        : ${MANYOYO_NAME} rm ${containerName}`);
        console.log("");
    }
}

function setQuiet(actions) {
    // Support both string and array input
    const actionArray = Array.isArray(actions) ? actions : [actions];
    actionArray.forEach(action => {
        // Remove comma splitting - each action should be a single quiet option
        const ac = action.trim();
        switch (ac) {
            case 'cnew':
                QUIET.cnew = 1;
                break;
            case 'crm':
                QUIET.crm = 1;
                break;
            case 'tip':
                QUIET.tip = 1;
                break;
            case 'askkeep':
                QUIET.askkeep = 1;
                break;
            case 'cmd':
                QUIET.cmd = 1;
                break;
            case 'full':
                QUIET.full = 1;
                break;
        }
    });
}

function validateName(label, value, pattern) {
    if (!value) return;
    if (!pattern.test(value)) {
        console.error(`${RED}⚠️  错误: ${label} 非法: ${value}${NC}`);
        process.exit(1);
    }
}

function parseImageVersionTag(version) {
    const match = String(version || '').trim().match(IMAGE_VERSION_TAG_PATTERN);
    if (!match) {
        return null;
    }
    return {
        baseVersion: match[1],
        tool: match[2]
    };
}

function validateImageVersion(value) {
    validateName('imageVersion', value, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
    if (!parseImageVersionTag(value)) {
        console.error(`${RED}⚠️  错误: imageVersion 格式必须为 <x.y.z-后缀>，例如 1.7.4-common。当前值: ${value}${NC}`);
        process.exit(1);
    }
}

function isValidContainerName(value) {
    return typeof value === 'string' && SAFE_CONTAINER_NAME_PATTERN.test(value);
}

async function askQuestion(prompt) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

/**
 * 添加环境变量
 * @param {string} env - 环境变量字符串 (KEY=VALUE)
 */
function parseEnvEntry(env) {
    const envText = String(env);
    const idx = envText.indexOf('=');
    if (idx <= 0) {
        console.error(`${RED}⚠️  错误: env 格式应为 KEY=VALUE: ${envText}${NC}`);
        process.exit(1);
    }
    const key = envText.slice(0, idx);
    const value = envText.slice(idx + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        console.error(`${RED}⚠️  错误: env key 非法: ${key}${NC}`);
        process.exit(1);
    }
    if (/[\r\n\0]/.test(value) || /[;&|`$<>]/.test(value)) {
        console.error(`${RED}⚠️  错误: env value 含非法字符: ${key}${NC}`);
        process.exit(1);
    }
    return { key, value };
}

function normalizeJsonEnvMap(envConfig, sourceLabel) {
    if (envConfig === undefined || envConfig === null) {
        return {};
    }

    if (typeof envConfig !== 'object' || Array.isArray(envConfig)) {
        console.error(`${RED}⚠️  错误: ${sourceLabel} 的 env 必须是对象(map)，例如 {"KEY":"VALUE"}${NC}`);
        process.exit(1);
    }

    const envMap = {};
    for (const [key, rawValue] of Object.entries(envConfig)) {
        if (rawValue !== null && !['string', 'number', 'boolean'].includes(typeof rawValue)) {
            console.error(`${RED}⚠️  错误: ${sourceLabel} 的 env.${key} 必须是 string/number/boolean/null${NC}`);
            process.exit(1);
        }
        const value = rawValue === null ? '' : String(rawValue);
        const parsed = parseEnvEntry(`${key}=${value}`);
        envMap[parsed.key] = parsed.value;
    }
    return envMap;
}

function normalizeCliEnvMap(envList) {
    const envMap = {};
    for (const envText of (envList || [])) {
        const parsed = parseEnvEntry(envText);
        envMap[parsed.key] = parsed.value;
    }
    return envMap;
}

function normalizeFirstConfig(firstConfig, sourceLabel) {
    if (firstConfig === undefined || firstConfig === null) {
        return {};
    }
    if (typeof firstConfig !== 'object' || Array.isArray(firstConfig)) {
        console.error(`${RED}⚠️  错误: ${sourceLabel} 的 first 必须是对象(map)，例如 {"shell":"init.sh"}${NC}`);
        process.exit(1);
    }
    return firstConfig;
}

function addEnvTo(targetEnvs, env) {
    const parsed = parseEnvEntry(env);
    targetEnvs.push("--env", `${parsed.key}=${parsed.value}`);
}

function addEnv(env) {
    addEnvTo(CONTAINER_ENVS, env);
}

function addEnvFileTo(targetEnvs, envFile) {
    const filePath = String(envFile || '').trim();
    if (!path.isAbsolute(filePath)) {
        console.error(`${RED}⚠️  错误: --env-file 仅支持绝对路径: ${envFile}${NC}`);
        process.exit(1);
    }

    if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let line of lines) {
            // Match pattern: (export )?(KEY)=(VALUE)
            const match = line.match(/^(?:export\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/);
            if (match) {
                let key = match[1];
                let value = match[2].trim();

                // Filter malicious characters
                if (/[\r\n\0]/.test(value)) continue;
                if (/[\$\(\)\`\|\&\*\{\};<>]/.test(value)) continue;
                if (/^\(/.test(value)) continue;

                // Remove quotes
                if (/^"(.*)"$/.test(value)) {
                    value = value.slice(1, -1);
                } else if (/^'(.*)'$/.test(value)) {
                    value = value.slice(1, -1);
                }

                if (key) {
                    targetEnvs.push("--env", `${key}=${value}`);
                }
            }
        }
        return {};
    }
    console.error(`${RED}⚠️  未找到环境文件: ${envFile}${NC}`);
    return {};
}

function addEnvFile(envFile) {
    return addEnvFileTo(CONTAINER_ENVS, envFile);
}

function hasEnvKey(targetEnvs, key) {
    for (let i = 0; i < targetEnvs.length; i += 2) {
        if (targetEnvs[i] !== '--env') {
            continue;
        }
        const text = String(targetEnvs[i + 1] || '');
        const idx = text.indexOf('=');
        if (idx > 0 && text.slice(0, idx) === key) {
            return true;
        }
    }
    return false;
}

function appendUniqueArgs(targetArgs, extraArgs) {
    const joinedExisting = new Set();
    for (let i = 0; i < targetArgs.length; i += 2) {
        const head = String(targetArgs[i] || '');
        const value = String(targetArgs[i + 1] || '');
        if (head.startsWith('--')) {
            joinedExisting.add(`${head}\u0000${value}`);
        }
    }

    for (let i = 0; i < extraArgs.length; i += 2) {
        const head = String(extraArgs[i] || '');
        const value = String(extraArgs[i + 1] || '');
        const signature = `${head}\u0000${value}`;
        if (!joinedExisting.has(signature)) {
            joinedExisting.add(signature);
            targetArgs.push(head, value);
        }
    }
}

function applyPlaywrightCliSessionIntegration(config, runConfig) {
    try {
        const plugin = createPlugin('playwright', {
            globalConfig: config,
            runConfig,
            projectRoot: path.join(__dirname, '..')
        });
        const integration = plugin.buildCliSessionIntegration(DOCKER_CMD);
        for (const entry of integration.envEntries) {
            const parsed = parseEnvEntry(entry);
            if (!hasEnvKey(CONTAINER_ENVS, parsed.key)) {
                addEnv(`${parsed.key}=${parsed.value}`);
            }
        }
        appendUniqueArgs(CONTAINER_EXTRA_ARGS, integration.extraArgs);
        appendUniqueArgs(CONTAINER_VOLUMES, integration.volumeEntries || []);
    } catch (error) {
        console.error(`${RED}⚠️  错误: Playwright CLI 会话注入失败: ${error.message || String(error)}${NC}`);
        process.exit(1);
    }
}

function addVolume(volume) {
    CONTAINER_VOLUMES.push("--volume", volume);
}

function addPort(port) {
    CONTAINER_PORTS.push("--publish", String(port));
}

function addImageBuildArg(value) {
    IMAGE_BUILD_ARGS.push("--build-arg", value);
}

const YOLO_COMMAND_MAP = {
    claude: "IS_SANDBOX=1 claude --dangerously-skip-permissions",
    cc: "IS_SANDBOX=1 claude --dangerously-skip-permissions",
    c: "IS_SANDBOX=1 claude --dangerously-skip-permissions",
    gemini: "gemini --yolo",
    gm: "gemini --yolo",
    g: "gemini --yolo",
    codex: "codex --dangerously-bypass-approvals-and-sandbox",
    cx: "codex --dangerously-bypass-approvals-and-sandbox",
    opencode: "OPENCODE_PERMISSION='{\"*\":\"allow\"}' opencode",
    oc: "OPENCODE_PERMISSION='{\"*\":\"allow\"}' opencode"
};

function setYolo(cli) {
    const key = String(cli || '').trim().toLowerCase();
    const mappedCommand = YOLO_COMMAND_MAP[key];
    if (!mappedCommand) {
        console.log(`${RED}⚠️  未知LLM CLI: ${cli}${NC}`);
        process.exit(0);
    }
    EXEC_COMMAND = mappedCommand;
}

/**
 * 设置容器嵌套模式
 * @param {string} mode - 模式名称 (common, dind, sock)
 */
function setContMode(mode) {
    const modeAliasMap = {
        common: 'common',
        'docker-in-docker': 'dind',
        dind: 'dind',
        d: 'dind',
        'mount-docker-socket': 'sock',
        sock: 'sock',
        s: 'sock'
    };
    const normalizedMode = modeAliasMap[String(mode || '').trim().toLowerCase()];

    if (normalizedMode === 'common') {
        CONT_MODE_ARGS = [];
        return;
    }

    if (normalizedMode === 'dind') {
        CONT_MODE_ARGS = ['--privileged'];
        console.log(`${GREEN}✅ 开启安全的容器嵌套容器模式, 手动在容器内启动服务: nohup dockerd &${NC}`);
        return;
    }

    if (normalizedMode === 'sock') {
        CONT_MODE_ARGS = [
            '--privileged',
            '--volume', '/var/run/docker.sock:/var/run/docker.sock',
            '--env', 'DOCKER_HOST=unix:///var/run/docker.sock',
            '--env', 'CONTAINER_HOST=unix:///var/run/docker.sock'
        ];
        console.log(`${RED}⚠️  开启危险的容器嵌套容器模式, 危害: 容器可访问宿主机文件${NC}`);
        return;
    }

    console.log(`${RED}⚠️  未知模式: ${mode}${NC}`);
    process.exit(0);
}

function showImagePullHint(err) {
    const stderr = err && err.stderr ? err.stderr.toString() : '';
    const stdout = err && err.stdout ? err.stdout.toString() : '';
    const message = err && err.message ? err.message : '';
    const combined = `${message}\n${stderr}\n${stdout}`;
    if (!/localhost\/v2|pinging container registry localhost|connection refused|dial tcp .*:443/i.test(combined)) {
        return;
    }
    const image = `${IMAGE_NAME}:${IMAGE_VERSION}`;
    console.log(`${YELLOW}💡 提示: 本地未找到镜像 ${image}，并且从 localhost 注册表拉取失败。${NC}`);
    console.log(`${YELLOW}   你可以: (1) 更新 ~/.manyoyo/manyoyo.json 的 imageVersion。 (2) 或先执行 ${MANYOYO_NAME} build --iv <x.y.z-后缀> 构建镜像。${NC}`);
}

function runCmd(cmd, args, options = {}) {
    const result = spawnSync(cmd, args, { encoding: 'utf-8', ...options });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        if (options.ignoreError) {
            return result.stdout || '';
        }
        const err = new Error(`Command failed: ${cmd} ${args.join(' ')}`);
        err.stdout = result.stdout;
        err.stderr = result.stderr;
        err.status = result.status;
        throw err;
    }
    return result.stdout || '';
}

function dockerExecArgs(args, options = {}) {
    return runCmd(DOCKER_CMD, args, options);
}

function containerExists(name) {
    const containers = dockerExecArgs(['ps', '-a', '--format', '{{.Names}}']);
    return containers.split('\n').some(n => n.trim() === name);
}

function getContainerStatus(name) {
    return dockerExecArgs(['inspect', '-f', '{{.State.Status}}', name]).trim();
}

function removeContainer(name) {
    if ( !(QUIET.crm || QUIET.full) ) console.log(`${YELLOW}🗑️ 正在删除容器: ${name}...${NC}`);
    dockerExecArgs(['rm', '-f', name], { stdio: 'pipe' });
    if ( !(QUIET.crm || QUIET.full) ) console.log(`${GREEN}✅ 已彻底删除。${NC}`);
}

function ensureDocker() {
    const commands = ['docker', 'podman'];
    for (const cmd of commands) {
        try {
            runCmd(cmd, ['--version'], { stdio: 'pipe' });
            DOCKER_CMD = cmd;
            return true;
        } catch (e) {
            // Try next command
        }
    }
    console.error("docker/podman not found");
    process.exit(1);
}

function installManyoyo(name) {
    const MANYOYO_FILE = fs.realpathSync(__filename);
    switch (name) {
        case 'docker-cli-plugin':
            const pluginDir = path.join(process.env.HOME, '.docker/cli-plugins');
            fs.mkdirSync(pluginDir, { recursive: true });
            const targetPath = path.join(pluginDir, 'docker-manyoyo');
            if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
            }
            fs.symlinkSync(MANYOYO_FILE, targetPath);
            break;
        default:
            console.log("");
    }
    process.exit(0);
}

function updateManyoyo() {
    let isLocalFileInstall = false;
    let currentVersion = 'unknown';

    try {
        const listOutput = runCmd('npm', ['ls', '-g', '@xcanwin/manyoyo', '--json', '--long'], { stdio: 'pipe' });
        const listJson = JSON.parse(listOutput || '{}');
        const dep = listJson && listJson.dependencies && listJson.dependencies['@xcanwin/manyoyo'];

        // 获取当前版本
        if (dep && dep.version) {
            currentVersion = dep.version;
        }

        const resolved = dep && typeof dep.resolved === 'string' ? dep.resolved : '';
        const depPath = dep && typeof dep.path === 'string' ? dep.path : '';

        if (resolved.startsWith('file:')) {
            isLocalFileInstall = true;
        } else if (depPath && fs.existsSync(depPath)) {
            isLocalFileInstall = fs.lstatSync(depPath).isSymbolicLink();
        }
    } catch (e) {
        // ignore detect errors and fallback to registry update
    }

    if (isLocalFileInstall) {
        console.log(`${YELLOW}ℹ️  检测到 MANYOYO 为本地 file 安装（npm install -g . / npm link），跳过在线更新。${NC}`);
        console.log(`${YELLOW}   如需更新，请在本地仓库拉取最新代码后重新安装。${NC}`);
        return;
    }

    console.log(`${CYAN}🔄 当前版本: ${currentVersion}${NC}`);
    console.log(`${CYAN}🔄 正在更新 ${MANYOYO_NAME} 到最新版本...${NC}`);
    runCmd('npm', ['update', '-g', '@xcanwin/manyoyo'], { stdio: 'inherit' });

    // 升级后获取新版本
    let newVersion = 'unknown';
    try {
        const listOutput = runCmd('npm', ['ls', '-g', '@xcanwin/manyoyo', '--json'], { stdio: 'pipe' });
        const listJson = JSON.parse(listOutput || '{}');
        const dep = listJson && listJson.dependencies && listJson.dependencies['@xcanwin/manyoyo'];
        if (dep && dep.version) {
            newVersion = dep.version;
        }
    } catch (e) {
        // ignore
    }

    if (currentVersion === newVersion) {
        console.log(`${GREEN}✅ 已是最新版本 ${newVersion}${NC}`);
    } else {
        console.log(`${GREEN}✅ 更新完成: ${currentVersion} → ${newVersion}${NC}`);
    }
}

function getContList() {
    try {
        const output = dockerExecArgs([
            'ps', '-a', '--size',
            '--format', '{{.Names}}\t{{.Status}}\t{{.Size}}\t{{.ID}}\t{{.Image}}\t{{.Ports}}\t{{.Networks}}\t{{.Mounts}}'
        ], { stdio: 'pipe' });

        const rows = output
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .filter(line => {
                const cols = line.split('\t');
                const name = cols[0] || '';
                const image = cols[4] || '';
                // include manyoyo runtime containers (image match)
                // and plugin containers (both legacy manyoyo-* and new my-* prefixes)
                return image.includes('manyoyo') || name.startsWith('manyoyo-') || name.startsWith('my-');
            });

        console.log('NO.\tNAMES\tSTATUS\tSIZE\tCONTAINER ID\tIMAGE\tPORTS\tNETWORKS\tMOUNTS');
        if (rows.length > 0) {
            const numberedRows = rows.map((line, index) => {
                return `${index + 1}.\t${line}`;
            });
            console.log(numberedRows.join('\n'));
        }
    } catch (e) {
        console.log((e && e.stdout) || '');
    }
}

function getImageList() {
    try {
        const output = dockerExecArgs(['images', '-a', '--format', '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}\t{{.Size}}']);
        const lines = output
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && line.includes('manyoyo'));
        console.log('REPOSITORY\tTAG\tIMAGE ID\tCREATED\tSIZE');
        if (lines.length > 0) {
            console.log(lines.join('\n'));
        }
    } catch (e) {
        console.log((e && e.stdout) || '');
    }
}

function pruneDanglingImages() {
    console.log(`\n${YELLOW}清理悬空镜像...${NC}`);
    dockerExecArgs(['image', 'prune', '-f'], { stdio: 'inherit' });

    // Remove remaining <none> images
    try {
        const imagesOutput = dockerExecArgs(['images', '-a', '--format', '{{.ID}} {{.Repository}}']);
        const noneImages = imagesOutput
            .split('\n')
            .filter(line => line.includes('<none>'))
            .map(line => line.split(' ')[0])
            .filter(id => id);

        if (noneImages.length > 0) {
            console.log(`${YELLOW}清理剩余的 <none> 镜像 (${noneImages.length} 个)...${NC}`);
            dockerExecArgs(['rmi', '-f', ...noneImages], { stdio: 'inherit' });
        }
    } catch (e) {
        // Ignore errors if no <none> images found
    }

    console.log(`${GREEN}✅ 清理完成${NC}`);
}

function maybeHandleDockerPluginMetadata(argv) {
    if (argv[2] !== 'docker-cli-plugin-metadata') {
        return false;
    }
    console.log(JSON.stringify({
        "SchemaVersion": "0.1.0",
        "Vendor": "xcanwin",
        "Version": "v1.0.0",
        "Description": "AI Agent CLI Sandbox"
    }, null, 4));
    return true;
}

function normalizeDockerPluginArgv(argv) {
    const dockerPluginPath = path.join(process.env.HOME || '', '.docker/cli-plugins/docker-manyoyo');
    if (argv[1] === dockerPluginPath && argv[2] === 'manyoyo') {
        argv.splice(2, 1);
    }
}

function normalizeShellFullArgv(argv) {
    const shellFullIndex = argv.findIndex(arg => arg === '-x' || arg === '--shell-full');
    if (shellFullIndex !== -1 && shellFullIndex < argv.length - 1) {
        const shellFullArgs = argv.slice(shellFullIndex + 1).join(' ');
        argv.splice(shellFullIndex + 1, argv.length - (shellFullIndex + 1), shellFullArgs);
    }
}

function appendArrayOption(command, flags, description) {
    return command.option(
        flags,
        description,
        (value, previous) => [...(previous || []), value],
        []
    );
}

function applyRunStyleOptions(command, options = {}) {
    const includeRmOnExit = options.includeRmOnExit !== false;
    const includeServePreview = options.includeServePreview === true;
    const includeWebAuthOptions = options.includeWebAuthOptions === true;

    command
        .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
        .option('--hp, --host-path <path>', '设置宿主机工作目录 (默认: 当前路径)')
        .option('-n, --cont-name <name>', '设置容器名称')
        .option('--cp, --cont-path <path>', '设置容器工作目录')
        .option('-m, --cont-mode <mode>', '设置容器嵌套模式 (common, dind, sock; 注意: sock 模式可访问宿主机 Docker socket，风险较高)')
        .option('--in, --image-name <name>', '指定镜像名称')
        .option('--iv, --image-ver <version>', '指定镜像版本 (格式: x.y.z-后缀，如 1.7.4-common)');

    appendArrayOption(command, '-e, --env <env>', '设置环境变量 XXX=YYY (可多次使用)');
    appendArrayOption(command, '--ef, --env-file <file>', '从环境文件加载变量 (仅支持绝对路径，如 /abs/path.env; 相对路径会报错)');
    appendArrayOption(command, '-v, --volume <volume>', '绑定挂载卷 XXX:YYY (可多次使用)');
    appendArrayOption(command, '-p, --port <port>', '设置端口映射 XXX:YYY (可多次使用)');

    command
        .option('--sp, --shell-prefix <command>', '主命令前缀 (常用于临时环境变量)')
        .option('-s, --shell <command>', '主命令')
        .option('--ss, --shell-suffix <command>', '主命令后缀 (追加到 -s 之后，等价于 -- <args>)')
        .option('--first-shell-prefix <command>', '首次预执行命令前缀 (仅新建容器生效; 容器已存在时忽略)')
        .option('--first-shell <command>', '首次预执行命令 (仅新建容器生效; 容器已存在时忽略)')
        .option('--first-shell-suffix <command>', '首次预执行命令后缀 (仅新建容器生效; 容器已存在时忽略)')
        .option('-x, --shell-full <command...>', '完整命令 (与 --sp/-s/--ss/-- 互斥)')
        .option('-y, --yolo <cli>', '使 AGENT 无需确认 (claude(c), gemini(gm), codex(cx), opencode(oc))');
    appendArrayOption(command, '--first-env <env>', '首次预执行环境变量 XXX=YYY (可多次使用)');
    appendArrayOption(command, '--first-env-file <file>', '首次预执行环境变量文件 (仅支持绝对路径，如 /abs/path.env)');

    if (includeRmOnExit) {
        command.option('--rm-on-exit', '退出后自动删除容器 (一次性模式)');
    }

    appendArrayOption(command, '-q, --quiet <item>', '静默输出 (可多次使用: cnew, crm, tip, cmd, full)');

    if (includeServePreview) {
        command
            .option('--serve [listen]', '按 serve 模式解析配置 (仅支持 <ip:port>)')
            .option('-U, --user <username>', '网页服务登录用户名 (默认 admin)')
            .option('-P, --pass <password>', '网页服务登录密码 (默认自动生成随机密码)');
    }

    if (includeWebAuthOptions) {
        command
            .option('-U, --user <username>', '网页服务登录用户名 (默认 admin)')
            .option('-P, --pass <password>', '网页服务登录密码 (默认自动生成随机密码)');
    }

    return command;
}

async function setupCommander() {
    // Load config file
    const config = loadConfig();

    const program = new Command();
    program.enablePositionalOptions();
    let selectedAction = '';
    let selectedOptions = {};
    const selectAction = (action, options = {}) => {
        selectedAction = action;
        selectedOptions = options;
    };
    const selectPluginAction = (params = {}, options = {}) => {
        selectAction('plugin', {
            ...options,
            pluginAction: params.action || 'ls',
            pluginName: params.pluginName || 'playwright',
            pluginScene: params.scene || 'mcp-host-headless',
            pluginHost: params.host || '',
            pluginExtensionPaths: Array.isArray(params.extensionPaths) ? params.extensionPaths : [],
            pluginExtensionNames: Array.isArray(params.extensionNames) ? params.extensionNames : [],
            pluginProdversion: params.prodversion || ''
        });
    };

    const registerPlaywrightAliasCommands = (command) => {
        command.command('ls')
            .description('列出 playwright 启用场景')
            .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
            .action(options => selectPluginAction({
                action: 'ls',
                pluginName: 'playwright',
                scene: 'all'
            }, options));

        const actions = ['up', 'down', 'status', 'health', 'logs'];
        actions.forEach(action => {
            const sceneCommand = command.command(`${action} [scene]`)
                .description(`执行 playwright ${action} 场景（scene 默认 mcp-host-headless）`)
                .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)');

            if (action === 'up') {
                appendArrayOption(sceneCommand, '--ext-path <path>', '追加浏览器扩展目录（可多次传入；目录需包含 manifest.json）');
                appendArrayOption(sceneCommand, '--ext-name <name>', '追加 ~/.manyoyo/plugin/playwright/extensions/ 下的扩展目录名（可多次传入）');
            }

            sceneCommand.action((scene, options) => selectPluginAction({
                action,
                pluginName: 'playwright',
                scene: scene || 'mcp-host-headless',
                extensionPaths: action === 'up' ? (options.extPath || []) : [],
                extensionNames: action === 'up' ? (options.extName || []) : []
            }, options));
        });

        command.command('mcp-add')
            .description('输出 playwright 的 MCP 接入命令')
            .option('--host <host>', 'MCP URL 使用的主机名或IP (默认 host.docker.internal)')
            .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
            .action(options => selectPluginAction({
                action: 'mcp-add',
                pluginName: 'playwright',
                scene: 'all',
                host: options.host || ''
            }, options));

        command.command('cli-add')
            .description('输出 playwright-cli skill 安装命令')
            .action(() => selectPluginAction({
                action: 'cli-add',
                pluginName: 'playwright',
                scene: 'all'
            }));

        command.command('ext-download')
            .description('下载并解压 Playwright 扩展到 ~/.manyoyo/plugin/playwright/extensions/')
            .option('--prodversion <ver>', 'CRX 下载使用的 Chrome 版本号 (默认 132.0.0.0)')
            .action(options => selectPluginAction({
                action: 'ext-download',
                pluginName: 'playwright',
                scene: 'all',
                prodversion: options.prodversion || ''
            }, options));
    };

    program
        .name(MANYOYO_NAME)
        .version(BIN_VERSION, '-v, --version', '显示版本')
        .description('MANYOYO - AI Agent CLI Sandbox\nhttps://github.com/xcanwin/manyoyo')
        .addHelpText('after', `
配置文件:
  ~/.manyoyo/manyoyo.json   全局配置文件 (JSON5格式，支持注释)
  ~/.manyoyo/run/c.json     运行配置示例

路径规则:
  run -r name               → ~/.manyoyo/manyoyo.json 的 runs.name
  run --ef /abs/path.env    → 绝对路径环境文件
  run --ss "<args>"         → 显式设置命令后缀
  run -- <args...>          → 直接透传命令后缀（优先级最高）

示例:
  ${MANYOYO_NAME} update                              更新 MANYOYO 到最新版本
  ${MANYOYO_NAME} build --iv ${IMAGE_VERSION_HELP_EXAMPLE} --yes       构建镜像
  ${MANYOYO_NAME} init all                            从本机 Agent 配置初始化 ~/.manyoyo
  ${MANYOYO_NAME} run -r claude                       使用 manyoyo.json 的 runs.claude 快速启动
  ${MANYOYO_NAME} run -r codex --ss "resume --last"   使用命令后缀
  ${MANYOYO_NAME} run -n test --ef /path/ab.env -y c  使用绝对路径环境变量文件
  ${MANYOYO_NAME} run -n test -- -c                   恢复之前会话
  ${MANYOYO_NAME} run -x "echo 123"                   使用完整命令
  ${MANYOYO_NAME} serve 127.0.0.1:3000                启动本机网页服务
  ${MANYOYO_NAME} serve 127.0.0.1:3000 -d             后台启动；未设密码时会打印本次随机密码
  ${MANYOYO_NAME} serve 0.0.0.0:3000 -U admin -P 123 -d  后台启动并监听全部网卡
  ${MANYOYO_NAME} playwright up mcp-host-headless         启动 playwright 默认场景（推荐）
  ${MANYOYO_NAME} plugin playwright up mcp-host-headless  通过 plugin 命名空间启动
  ${MANYOYO_NAME} run -n test -q tip -q cmd           多次使用静默选项
        `);

    const runCommand = program.command('run').description('启动（容器不存在时）或连接（容器已存在时）容器并执行命令');
    runCommand.addHelpText('after', `
Examples:
  ${MANYOYO_NAME} run -r codex
  ${MANYOYO_NAME} run --rm-on-exit -x /bin/bash -lc "node -v"
  ${MANYOYO_NAME} run -n demo --first-shell "npm ci" -s "npm test"

Notes:
  参数优先级与合并规则（标量覆盖、数组追加、env 按 key 合并）请用 ${MANYOYO_NAME} config show --help 或查看文档。
`);
    applyRunStyleOptions(runCommand);
    runCommand.action(options => selectAction('run', options));

    const buildCommand = program.command('build').description('构建 manyoyo 沙箱镜像');
    buildCommand
        .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
        .option('--in, --image-name <name>', '指定镜像名称')
        .option('--iv, --image-ver <version>', '指定镜像版本 (格式: x.y.z-后缀，如 1.7.4-common)')
        .option('--yes', '所有提示自动确认 (用于CI/脚本)');
    appendArrayOption(buildCommand, '--iba, --image-build-arg <arg>', '构建镜像时传参给dockerfile (可多次使用)');
    buildCommand.action(options => selectAction('build', options));

    const removeCommand = program.command('rm <name>').description('删除指定容器');
    removeCommand
        .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
        .action((name, options) => selectAction('rm', { ...options, contName: name }));

    program.command('ps')
        .description('列举容器')
        .action(() => selectAction('ps', { contList: true }));

    program.command('images')
        .description('列举镜像')
        .action(() => selectAction('images', { imageList: true }));

    const serveCommand = program.command('serve [listen]').description('启动网页交互服务 (默认 127.0.0.1:3000)');
    applyRunStyleOptions(serveCommand, { includeRmOnExit: false, includeWebAuthOptions: true });
    serveCommand.option('-d, --detach', '后台启动网页服务并立即返回');
    serveCommand.action((listen, options) => {
        selectAction('serve', {
            ...options,
            server: listen === undefined ? true : listen,
            serverUser: options.user,
            serverPass: options.pass
        });
    });

    const playwrightCommand = program.command('playwright').description('管理 playwright 插件服务（推荐）');
    registerPlaywrightAliasCommands(playwrightCommand);

    const pluginCommand = program.command('plugin').description('管理 manyoyo 插件');
    pluginCommand.command('ls')
        .description('列出可用插件与启用场景')
        .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
        .action(options => selectPluginAction({
            action: 'ls',
            pluginName: 'playwright',
            scene: 'all'
        }, options));
    const pluginPlaywrightCommand = pluginCommand.command('playwright').description('管理 playwright 插件服务');
    registerPlaywrightAliasCommands(pluginPlaywrightCommand);

    const configCommand = program.command('config').description('查看解析后的配置或命令');
    const configShowCommand = configCommand.command('show').description('显示最终生效配置并退出');
    applyRunStyleOptions(configShowCommand, { includeRmOnExit: false, includeServePreview: true });
    configShowCommand.action(options => {
        const finalOptions = {
            ...options,
            showConfig: true
        };
        if (options.serve !== undefined) {
            finalOptions.server = options.serve;
            finalOptions.serverUser = options.user;
            finalOptions.serverPass = options.pass;
        }
        selectAction('config-show', finalOptions);
    });

    const configRunCommand = configCommand.command('command').description('显示将执行的 docker run 命令并退出');
    applyRunStyleOptions(configRunCommand, { includeRmOnExit: false });
    configRunCommand.action(options => selectAction('config-command', options));

    const initCommand = program.command('init [agents]').description('初始化 Agent 配置到 ~/.manyoyo');
    initCommand
        .option('--yes', '所有提示自动确认 (用于CI/脚本)')
        .action((agents, options) => selectAction('init', { ...options, initConfig: agents === undefined ? 'all' : agents }));

    program.command('update')
        .description('更新 MANYOYO（若检测为本地 file 安装则跳过）')
        .action(() => selectAction('update', { update: true }));

    program.command('install <name>')
        .description(`安装 ${MANYOYO_NAME} 命令 (docker-cli-plugin)`)
        .action(name => selectAction('install', { install: name }));

    program.command('prune')
        .description('清理悬空镜像和 <none> 镜像')
        .action(() => selectAction('prune', { imageRemove: true }));

    // Docker CLI plugin metadata check
    if (maybeHandleDockerPluginMetadata(process.argv)) {
        process.exit(0);
    }

    // Docker CLI plugin mode - remove first arg if running as plugin
    normalizeDockerPluginArgv(process.argv);

    // No args: show help instead of starting container
    if (process.argv.length <= 2) {
        program.help();
    }

    // Pre-handle -x/--shell-full: treat all following args as a single command
    normalizeShellFullArgv(process.argv);

    // Parse arguments
    program.allowUnknownOption(false);
    await program.parseAsync(process.argv);

    if (!selectedAction) {
        program.help();
    }

    const options = selectedOptions;
    const yesMode = Boolean(options.yes);
    const isBuildMode = selectedAction === 'build';
    const isRemoveMode = selectedAction === 'rm';
    const isPsMode = selectedAction === 'ps';
    const isImagesMode = selectedAction === 'images';
    const isPruneMode = selectedAction === 'prune';
    const isShowConfigMode = selectedAction === 'config-show';
    const isShowCommandMode = selectedAction === 'config-command';
    const isServerMode = options.server !== undefined;

    const noDockerActions = new Set(['init', 'update', 'install', 'config-show', 'plugin']);
    if (!noDockerActions.has(selectedAction)) {
        ensureDocker();
    }

    if (options.update) {
        updateManyoyo();
        process.exit(0);
    }

    if (options.initConfig !== undefined) {
        await initAgentConfigs(options.initConfig, {
            yesMode,
            askQuestion,
            loadConfig,
            supportedAgents: SUPPORTED_INIT_AGENTS,
            colors: { RED, GREEN, YELLOW, CYAN, NC }
        });
        process.exit(0);
    }

    if (selectedAction === 'plugin') {
        const runConfig = options.run ? loadRunConfig(options.run, config) : {};
        return {
            isPluginMode: true,
            pluginRequest: {
                action: options.pluginAction,
                pluginName: options.pluginName,
                scene: options.pluginScene || 'mcp-host-headless',
                host: options.pluginHost || '',
                extensionPaths: Array.isArray(options.pluginExtensionPaths) ? options.pluginExtensionPaths : [],
                extensionNames: Array.isArray(options.pluginExtensionNames) ? options.pluginExtensionNames : [],
                prodversion: options.pluginProdversion || ''
            },
            pluginGlobalConfig: config,
            pluginRunConfig: runConfig
        };
    }

    // Load run config if specified
    const runConfig = options.run ? loadRunConfig(options.run, config) : {};
    const globalFirstConfig = normalizeFirstConfig(config.first, '全局配置');
    const runFirstConfig = normalizeFirstConfig(runConfig.first, '运行配置');

    // Merge configs: command line > run config > global config > defaults
    // Override mode (scalar values): use first defined value
    HOST_PATH = pickConfigValue(options.hostPath, runConfig.hostPath, config.hostPath, HOST_PATH) || HOST_PATH;
    const mergedContainerName = pickConfigValue(options.contName, runConfig.containerName, config.containerName);
    if (mergedContainerName) {
        CONTAINER_NAME = mergedContainerName;
    }
    CONTAINER_NAME = resolveContainerNameTemplate(CONTAINER_NAME);
    const mergedContainerPath = pickConfigValue(options.contPath, runConfig.containerPath, config.containerPath);
    if (mergedContainerPath) {
        CONTAINER_PATH = mergedContainerPath;
    }
    IMAGE_NAME = pickConfigValue(options.imageName, runConfig.imageName, config.imageName, IMAGE_NAME) || IMAGE_NAME;
    const mergedImageVersion = pickConfigValue(options.imageVer, runConfig.imageVersion, config.imageVersion);
    if (mergedImageVersion) {
        IMAGE_VERSION = mergedImageVersion;
    }
    const mergedShellPrefix = pickConfigValue(options.shellPrefix, runConfig.shellPrefix, config.shellPrefix);
    if (mergedShellPrefix) {
        EXEC_COMMAND_PREFIX = `${mergedShellPrefix} `;
    }
    const mergedShell = pickConfigValue(options.shell, runConfig.shell, config.shell);
    if (mergedShell) {
        EXEC_COMMAND = mergedShell;
    }
    const mergedShellSuffix = pickConfigValue(options.shellSuffix, runConfig.shellSuffix, config.shellSuffix);
    if (mergedShellSuffix) {
        EXEC_COMMAND_SUFFIX = normalizeCommandSuffix(mergedShellSuffix);
    }
    const mergedFirstShellPrefix = pickConfigValue(options.firstShellPrefix, runFirstConfig.shellPrefix, globalFirstConfig.shellPrefix);
    if (mergedFirstShellPrefix) {
        FIRST_EXEC_COMMAND_PREFIX = `${mergedFirstShellPrefix} `;
    }
    const mergedFirstShell = pickConfigValue(options.firstShell, runFirstConfig.shell, globalFirstConfig.shell);
    if (mergedFirstShell) {
        FIRST_EXEC_COMMAND = mergedFirstShell;
    }
    const mergedFirstShellSuffix = pickConfigValue(options.firstShellSuffix, runFirstConfig.shellSuffix, globalFirstConfig.shellSuffix);
    if (mergedFirstShellSuffix) {
        FIRST_EXEC_COMMAND_SUFFIX = normalizeCommandSuffix(mergedFirstShellSuffix);
    }

    // Basic name validation to reduce injection risk
    validateName('containerName', CONTAINER_NAME, SAFE_CONTAINER_NAME_PATTERN);
    validateName('imageName', IMAGE_NAME, /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/);
    validateImageVersion(IMAGE_VERSION);

    // Merge mode (array values): concatenate all sources
    const toArray = (val) => Array.isArray(val) ? val : (val ? [val] : []);
    const envFileList = [
        ...toArray(config.envFile),
        ...toArray(runConfig.envFile),
        ...(options.envFile || [])
    ].filter(Boolean);
    envFileList.forEach(ef => addEnvFile(ef));

    // env in JSON config uses map type, and is merged by key with CLI priority.
    const envMap = {
        ...normalizeJsonEnvMap(config.env, '全局配置'),
        ...normalizeJsonEnvMap(runConfig.env, '运行配置'),
        ...normalizeCliEnvMap(options.env)
    };
    Object.entries(envMap).forEach(([key, value]) => addEnv(`${key}=${value}`));

    const firstEnvFileList = [
        ...toArray(globalFirstConfig.envFile),
        ...toArray(runFirstConfig.envFile),
        ...(options.firstEnvFile || [])
    ].filter(Boolean);
    firstEnvFileList.forEach(ef => addEnvFileTo(FIRST_CONTAINER_ENVS, ef));

    const firstEnvMap = {
        ...normalizeJsonEnvMap(globalFirstConfig.env, '全局配置 first'),
        ...normalizeJsonEnvMap(runFirstConfig.env, '运行配置 first'),
        ...normalizeCliEnvMap(options.firstEnv)
    };
    Object.entries(firstEnvMap).forEach(([key, value]) => addEnvTo(FIRST_CONTAINER_ENVS, `${key}=${value}`));

    applyPlaywrightCliSessionIntegration(config, runConfig);

    const volumeList = mergeArrayConfig(config.volumes, runConfig.volumes, options.volume);
    volumeList.forEach(v => addVolume(v));

    const portList = mergeArrayConfig(config.ports, runConfig.ports, options.port);
    portList.forEach(p => addPort(p));

    const buildArgList = mergeArrayConfig(config.imageBuildArgs, runConfig.imageBuildArgs, options.imageBuildArg);
    buildArgList.forEach(arg => addImageBuildArg(arg));

    // Override mode for special options
    const yoloValue = pickConfigValue(options.yolo, runConfig.yolo, config.yolo);
    if (yoloValue) setYolo(yoloValue);

    const contModeValue = pickConfigValue(options.contMode, runConfig.containerMode, config.containerMode);
    if (contModeValue) setContMode(contModeValue);

    const quietValue = pickConfigValue(options.quiet, runConfig.quiet, config.quiet);
    if (quietValue) setQuiet(quietValue);

    // Handle shell-full (variadic arguments)
    if (options.shellFull) {
        EXEC_COMMAND = options.shellFull.join(' ');
        EXEC_COMMAND_PREFIX = "";
        EXEC_COMMAND_SUFFIX = "";
    }

    // Handle -- suffix arguments
    if (!options.shellFull) {
        const doubleDashIndex = process.argv.indexOf('--');
        if (doubleDashIndex !== -1 && doubleDashIndex < process.argv.length - 1) {
            EXEC_COMMAND_SUFFIX = normalizeCommandSuffix(process.argv.slice(doubleDashIndex + 1).join(' '));
        }
    }

    if (options.rmOnExit) {
        RM_ON_EXIT = true;
    }

    if (isServerMode) {
        const serverListen = parseServerListen(options.server);
        SERVER_HOST = serverListen.host;
        SERVER_PORT = serverListen.port;
    }

    const serverUserValue = pickConfigValue(options.serverUser, runConfig.serverUser, config.serverUser, process.env.MANYOYO_SERVER_USER);
    if (serverUserValue) {
        SERVER_AUTH_USER = String(serverUserValue);
    }

    const serverPassValue = pickConfigValue(options.serverPass, runConfig.serverPass, config.serverPass, process.env.MANYOYO_SERVER_PASS);
    if (serverPassValue) {
        SERVER_AUTH_PASS = String(serverPassValue);
        SERVER_AUTH_PASS_AUTO = false;
    }

    if (isServerMode) {
        ensureWebServerAuthCredentials();
    }

    if (isShowConfigMode) {
        const finalConfig = {
            hostPath: HOST_PATH,
            containerName: CONTAINER_NAME,
            containerPath: CONTAINER_PATH,
            imageName: IMAGE_NAME,
            imageVersion: IMAGE_VERSION,
            envFile: envFileList,
            env: envMap,
            volumes: volumeList,
            ports: portList,
            imageBuildArgs: buildArgList,
            containerMode: contModeValue || "",
            shellPrefix: EXEC_COMMAND_PREFIX.trim(),
            shell: EXEC_COMMAND || "",
            shellSuffix: EXEC_COMMAND_SUFFIX || "",
            yolo: yoloValue || "",
            quiet: quietValue || [],
            server: isServerMode,
            serverHost: isServerMode ? SERVER_HOST : null,
            serverPort: isServerMode ? SERVER_PORT : null,
            serverUser: SERVER_AUTH_USER || "",
            serverPass: SERVER_AUTH_PASS || "",
            exec: {
                prefix: EXEC_COMMAND_PREFIX,
                shell: EXEC_COMMAND,
                suffix: EXEC_COMMAND_SUFFIX
            },
            first: {
                envFile: firstEnvFileList,
                env: firstEnvMap,
                shellPrefix: FIRST_EXEC_COMMAND_PREFIX.trim(),
                shell: FIRST_EXEC_COMMAND || "",
                shellSuffix: FIRST_EXEC_COMMAND_SUFFIX || "",
                exec: {
                    prefix: FIRST_EXEC_COMMAND_PREFIX,
                    shell: FIRST_EXEC_COMMAND,
                    suffix: FIRST_EXEC_COMMAND_SUFFIX
                }
            }
        };
        // 敏感信息脱敏
        const sanitizedConfig = sanitizeSensitiveData(finalConfig);
        console.log(JSON.stringify(sanitizedConfig, null, 4));
        process.exit(0);
    }

    if (isPsMode) { getContList(); process.exit(0); }
    if (isImagesMode) { getImageList(); process.exit(0); }
    if (isPruneMode) { pruneDanglingImages(); process.exit(0); }
    if (selectedAction === 'install') { installManyoyo(options.install); process.exit(0); }

    return {
        yesMode,
        isBuildMode,
        isRemoveMode,
        isShowCommandMode,
        isServerMode,
        isServerDetach: Boolean(selectedAction === 'serve' && options.detach),
        isPluginMode: false
    };
}

function createRuntimeContext(modeState = {}) {
    return {
        containerName: CONTAINER_NAME,
        hostPath: HOST_PATH,
        containerPath: CONTAINER_PATH,
        imageName: IMAGE_NAME,
        imageVersion: IMAGE_VERSION,
        execCommand: EXEC_COMMAND,
        execCommandPrefix: EXEC_COMMAND_PREFIX,
        execCommandSuffix: EXEC_COMMAND_SUFFIX,
        firstExecCommand: FIRST_EXEC_COMMAND,
        firstExecCommandPrefix: FIRST_EXEC_COMMAND_PREFIX,
        firstExecCommandSuffix: FIRST_EXEC_COMMAND_SUFFIX,
        contModeArgs: CONT_MODE_ARGS,
        containerExtraArgs: CONTAINER_EXTRA_ARGS,
        containerEnvs: CONTAINER_ENVS,
        firstContainerEnvs: FIRST_CONTAINER_ENVS,
        containerVolumes: CONTAINER_VOLUMES,
        containerPorts: CONTAINER_PORTS,
        quiet: QUIET,
        showCommand: Boolean(modeState.isShowCommandMode),
        rmOnExit: RM_ON_EXIT,
        serverMode: Boolean(modeState.isServerMode),
        serverDetach: Boolean(modeState.isServerDetach),
        serverHost: SERVER_HOST,
        serverPort: SERVER_PORT,
        serverAuthUser: SERVER_AUTH_USER,
        serverAuthPass: SERVER_AUTH_PASS,
        serverAuthPassAuto: SERVER_AUTH_PASS_AUTO,
        logger: null
    };
}

function handleRemoveContainer(runtime) {
    try {
        if (containerExists(runtime.containerName)) {
            removeContainer(runtime.containerName);
        } else {
            console.log(`${RED}⚠️  错误: 未找到名为 ${runtime.containerName} 的容器。${NC}`);
        }
    } catch (e) {
        console.log(`${RED}⚠️  错误: 未找到名为 ${runtime.containerName} 的容器。${NC}`);
    }
}

function validateHostPath(runtime) {
    if (!fs.existsSync(runtime.hostPath)) {
        console.log(`${RED}⚠️  错误: 宿主机路径不存在: ${runtime.hostPath}${NC}`);
        process.exit(1);
    }
    const realHostPath = fs.realpathSync(runtime.hostPath);
    const homeDir = process.env.HOME || '/home';
    if (realHostPath === '/' || realHostPath === '/home' || realHostPath === homeDir) {
        console.log(`${RED}⚠️  错误: 不允许挂载根目录或home目录。${NC}`);
        process.exit(1);
    }
}

function validateHostPathOrThrow(hostPath) {
    if (!fs.existsSync(hostPath)) {
        throw new Error(`宿主机路径不存在: ${hostPath}`);
    }
    const realHostPath = fs.realpathSync(hostPath);
    const homeDir = process.env.HOME || '/home';
    if (realHostPath === '/' || realHostPath === '/home' || realHostPath === homeDir) {
        throw new Error('不允许挂载根目录或home目录。');
    }
}

function buildDetachedServeArgv(argv) {
    const result = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = String(argv[i] || '');
        if (arg === '-d' || arg === '--detach') {
            continue;
        }
        result.push(arg);
    }
    return result;
}

function buildDetachedServeEnv(runtime) {
    const env = { ...process.env };
    if (runtime.serverAuthUser) {
        env.MANYOYO_SERVER_USER = runtime.serverAuthUser;
    }
    if (runtime.serverAuthPass) {
        env.MANYOYO_SERVER_PASS = runtime.serverAuthPass;
    }
    return env;
}

function relaunchServeDetached(runtime) {
    const serveLog = buildManyoyoLogPath('serve');
    fs.mkdirSync(serveLog.dir, { recursive: true });

    const child = spawn(process.argv[0], buildDetachedServeArgv(process.argv.slice(1)), {
        detached: true,
        stdio: 'ignore',
        env: buildDetachedServeEnv(runtime)
    });
    child.unref();

    console.log(`${GREEN}✅ serve 已转入后台运行${NC}`);
    console.log(`PID: ${child.pid}`);
    console.log(`日志: ${serveLog.path}`);
    console.log(`登录用户名: ${runtime.serverAuthUser}`);
    if (runtime.serverAuthPassAuto) {
        console.log(`登录密码(本次随机): ${runtime.serverAuthPass}`);
    } else {
        console.log('登录密码: 使用你配置的 serve -P / serverPass / MANYOYO_SERVER_PASS');
    }
}

/**
 * 等待容器就绪（使用指数退避算法）
 * @param {string} containerName - 容器名称
 */
async function waitForContainerReady(containerName) {
    const MAX_RETRIES = CONFIG.CONTAINER_READY_MAX_RETRIES;
    let retryDelay = CONFIG.CONTAINER_READY_INITIAL_DELAY;

    for (let count = 0; count < MAX_RETRIES; count++) {
        try {
            const status = getContainerStatus(containerName);

            if (status === 'running') {
                return;
            }

            if (status === 'exited') {
                console.log(`${RED}⚠️  错误: 容器启动后立即退出。${NC}`);
                dockerExecArgs(['logs', containerName], { stdio: 'inherit' });
                process.exit(1);
            }

            await sleep(retryDelay);
            retryDelay = Math.min(retryDelay * 2, CONFIG.CONTAINER_READY_MAX_DELAY);
        } catch (e) {
            await sleep(retryDelay);
            retryDelay = Math.min(retryDelay * 2, CONFIG.CONTAINER_READY_MAX_DELAY);
        }
    }

    console.log(`${RED}⚠️  错误: 容器启动超时。${NC}`);
    process.exit(1);
}

function joinExecCommand(prefix, command, suffix) {
    return `${prefix || ''}${command || ''}${suffix || ''}`;
}

function executeFirstCommand(runtime) {
    if (!runtime.firstExecCommand || !String(runtime.firstExecCommand).trim()) {
        return;
    }

    const firstCommand = joinExecCommand(
        runtime.firstExecCommandPrefix,
        runtime.firstExecCommand,
        runtime.firstExecCommandSuffix
    );

    if (!(runtime.quiet.cmd || runtime.quiet.full)) {
        console.log(`${BLUE}----------------------------------------${NC}`);
        console.log(`⚙️  首次预执行命令: ${YELLOW}${firstCommand}${NC}`);
    }

    const firstExecArgs = [
        'exec',
        ...(runtime.firstContainerEnvs || []),
        runtime.containerName,
        '/bin/bash',
        '-c',
        firstCommand
    ];
    const firstExecResult = spawnSync(`${DOCKER_CMD}`, firstExecArgs, { stdio: 'inherit' });
    if (firstExecResult.error) {
        throw firstExecResult.error;
    }
    if (typeof firstExecResult.status === 'number' && firstExecResult.status !== 0) {
        throw new Error(`首次预执行命令失败，退出码: ${firstExecResult.status}`);
    }
    if (firstExecResult.signal) {
        throw new Error(`首次预执行命令被信号终止: ${firstExecResult.signal}`);
    }
}

/**
 * 创建新容器
 * @returns {Promise<string>} 默认命令
 */
async function createNewContainer(runtime) {
    if (!(runtime.quiet.cnew || runtime.quiet.full)) {
        console.log(`${CYAN}📦 manyoyo by xcanwin 正在创建新容器: ${YELLOW}${runtime.containerName}${NC}`);
    }

    runtime.execCommand = joinExecCommand(
        runtime.execCommandPrefix,
        runtime.execCommand,
        runtime.execCommandSuffix
    );
    const defaultCommand = runtime.execCommand;

    if (runtime.showCommand) {
        console.log(buildDockerRunCmd(runtime));
        process.exit(0);
    }

    // 使用数组参数执行命令（安全方式）
    try {
        const args = buildDockerRunArgs(runtime);
        dockerExecArgs(args, { stdio: 'pipe' });
    } catch (e) {
        showImagePullHint(e);
        throw e;
    }

    // Wait for container to be ready
    await waitForContainerReady(runtime.containerName);

    // Run one-time bootstrap command for newly created containers only.
    executeFirstCommand(runtime);

    return defaultCommand;
}

/**
 * 构建 Docker run 命令参数数组（安全方式，避免命令注入）
 * @returns {string[]} 命令参数数组
 */
function buildDockerRunArgs(runtime) {
    return buildContainerRunArgs({
        containerName: runtime.containerName,
        hostPath: runtime.hostPath,
        containerPath: runtime.containerPath,
        imageName: runtime.imageName,
        imageVersion: runtime.imageVersion,
        contModeArgs: runtime.contModeArgs,
        containerExtraArgs: runtime.containerExtraArgs,
        containerEnvs: runtime.containerEnvs,
        containerVolumes: runtime.containerVolumes,
        containerPorts: runtime.containerPorts,
        defaultCommand: runtime.execCommand
    });
}

/**
 * 构建 Docker run 命令字符串（用于显示）
 * @returns {string} 命令字符串
 */
function buildDockerRunCmd(runtime) {
    const args = buildDockerRunArgs(runtime);
    return buildContainerRunCommand(DOCKER_CMD, args);
}

async function connectExistingContainer(runtime) {
    if (!(runtime.quiet.cnew || runtime.quiet.full)) {
        console.log(`${CYAN}🔄 manyoyo by xcanwin 正在连接到现有容器: ${YELLOW}${runtime.containerName}${NC}`);
    }

    // Start container if stopped
    const status = getContainerStatus(runtime.containerName);
    if (status !== 'running') {
        dockerExecArgs(['start', runtime.containerName], { stdio: 'pipe' });
    }

    // Get default command from label
    const defaultCommand = dockerExecArgs(['inspect', '-f', '{{index .Config.Labels "manyoyo.default_cmd"}}', runtime.containerName]).trim();

    if (!runtime.execCommand) {
        runtime.execCommand = joinExecCommand(runtime.execCommandPrefix, defaultCommand, runtime.execCommandSuffix);
    } else {
        runtime.execCommand = joinExecCommand(runtime.execCommandPrefix, runtime.execCommand, runtime.execCommandSuffix);
    }

    return defaultCommand;
}

async function setupContainer(runtime) {
    if (runtime.showCommand) {
        if (containerExists(runtime.containerName)) {
            const defaultCommand = dockerExecArgs(['inspect', '-f', '{{index .Config.Labels "manyoyo.default_cmd"}}', runtime.containerName]).trim();
            const execCmd = runtime.execCommand
                ? joinExecCommand(runtime.execCommandPrefix, runtime.execCommand, runtime.execCommandSuffix)
                : joinExecCommand(runtime.execCommandPrefix, defaultCommand, runtime.execCommandSuffix);
            console.log(`${DOCKER_CMD} exec -it ${runtime.containerName} /bin/bash -c "${execCmd.replace(/"/g, '\\"')}"`);
            process.exit(0);
        }
        runtime.execCommand = joinExecCommand(runtime.execCommandPrefix, runtime.execCommand, runtime.execCommandSuffix);
        console.log(buildDockerRunCmd(runtime));
        process.exit(0);
    }
    if (!containerExists(runtime.containerName)) {
        return await createNewContainer(runtime);
    } else {
        return await connectExistingContainer(runtime);
    }
}

function executeInContainer(runtime, defaultCommand) {
    if (!containerExists(runtime.containerName)) {
        throw new Error(`未找到容器: ${runtime.containerName}`);
    }

    const status = getContainerStatus(runtime.containerName);
    if (status !== 'running') {
        dockerExecArgs(['start', runtime.containerName], { stdio: 'pipe' });
    }

    getHelloTip(runtime.containerName, defaultCommand, runtime.execCommand);
    if (!(runtime.quiet.cmd || runtime.quiet.full)) {
        console.log(`${BLUE}----------------------------------------${NC}`);
        console.log(`💻 执行命令: ${YELLOW}${runtime.execCommand || '交互式 Shell'}${NC}`);
    }

    // Execute command in container
    if (runtime.execCommand) {
        spawnSync(`${DOCKER_CMD}`, ['exec', '-it', runtime.containerName, '/bin/bash', '-c', runtime.execCommand], { stdio: 'inherit' });
    } else {
        spawnSync(`${DOCKER_CMD}`, ['exec', '-it', runtime.containerName, '/bin/bash'], { stdio: 'inherit' });
    }
}

/**
 * 处理会话退出后的交互
 * @param {string} defaultCommand - 默认命令
 */
async function handlePostExit(runtime, defaultCommand) {
    // --rm-on-exit 模式：自动删除容器
    if (runtime.rmOnExit) {
        removeContainer(runtime.containerName);
        return false;
    }

    getHelloTip(runtime.containerName, defaultCommand, runtime.execCommand);

    const resumeCommand = buildAgentResumeCommand(defaultCommand);
    const hasResumeAction = Boolean(resumeCommand);
    const menuResume = hasResumeAction ? ', r=恢复首次命令会话' : '';
    const quietResume = hasResumeAction ? ' r' : '';
    let tipAskKeep = `❔ 会话已结束。是否保留此后台容器 ${runtime.containerName}? [ y=默认保留, n=删除, 1=首次命令进入${menuResume}, x=执行命令, i=交互式SHELL ]: `;
    if (runtime.quiet.askkeep || runtime.quiet.full) tipAskKeep = `保留容器吗? [y n 1${quietResume} x i] `;
    const reply = await askQuestion(tipAskKeep);

    const firstChar = reply.trim().toLowerCase()[0];

    if (firstChar === 'n') {
        removeContainer(runtime.containerName);
        return false;
    } else if (firstChar === '1') {
        if (!(runtime.quiet.full)) console.log(`${GREEN}✅ 离开当前连接，用首次命令进入。${NC}`);
        runtime.execCommandPrefix = "";
        runtime.execCommandSuffix = "";
        runtime.execCommand = defaultCommand;
        return true;
    } else if (firstChar === 'r' && hasResumeAction) {
        if (!(runtime.quiet.full)) console.log(`${GREEN}✅ 离开当前连接，恢复首次命令会话。${NC}`);
        runtime.execCommandPrefix = "";
        runtime.execCommandSuffix = "";
        runtime.execCommand = resumeCommand;
        return true;
    } else if (firstChar === 'x') {
        const command = await askQuestion('❔ 输入要执行的命令: ');
        if (!(runtime.quiet.cmd || runtime.quiet.full)) console.log(`${GREEN}✅ 离开当前连接，执行命令。${NC}`);
        runtime.execCommandPrefix = "";
        runtime.execCommandSuffix = "";
        runtime.execCommand = command;
        return true;
    } else if (firstChar === 'i') {
        if (!(runtime.quiet.full)) console.log(`${GREEN}✅ 离开当前连接，进入容器交互式SHELL。${NC}`);
        runtime.execCommandPrefix = "";
        runtime.execCommandSuffix = "";
        runtime.execCommand = '/bin/bash';
        return true;
    } else {
        console.log(`${GREEN}✅ 已退出连接。容器 ${runtime.containerName} 仍在后台运行。${NC}`);
        return false;
    }
}

async function runWebServerMode(runtime) {
    if (!runtime.serverAuthUser || !runtime.serverAuthPass) {
        ensureWebServerAuthCredentials();
        runtime.serverAuthUser = SERVER_AUTH_USER;
        runtime.serverAuthPass = SERVER_AUTH_PASS;
        runtime.serverAuthPassAuto = SERVER_AUTH_PASS_AUTO;
    }

    await startWebServer({
        serverHost: runtime.serverHost,
        serverPort: runtime.serverPort,
        authUser: runtime.serverAuthUser,
        authPass: runtime.serverAuthPass,
        authPassAuto: runtime.serverAuthPassAuto,
        dockerCmd: DOCKER_CMD,
        hostPath: runtime.hostPath,
        containerPath: runtime.containerPath,
        imageName: runtime.imageName,
        imageVersion: runtime.imageVersion,
        execCommandPrefix: runtime.execCommandPrefix,
        execCommand: runtime.execCommand,
        execCommandSuffix: runtime.execCommandSuffix,
        contModeArgs: runtime.contModeArgs,
        containerExtraArgs: runtime.containerExtraArgs,
        containerEnvs: runtime.containerEnvs,
        containerVolumes: runtime.containerVolumes,
        containerPorts: runtime.containerPorts,
        validateHostPath: value => validateHostPathOrThrow(value),
        formatDate,
        isValidContainerName,
        containerExists,
        getContainerStatus,
        waitForContainerReady,
        dockerExecArgs,
        showImagePullHint,
        removeContainer,
        webHistoryDir: path.join(os.homedir(), '.manyoyo', 'web-history'),
        colors: {
            RED,
            GREEN,
            YELLOW,
            BLUE,
            CYAN,
            NC
        },
        logger: runtime.logger
    });
}

async function main() {
    try {
        // 1. Setup commander and parse arguments
        const modeState = await setupCommander();

        if (modeState.isPluginMode) {
            const exitCode = await runPluginCommand(modeState.pluginRequest, {
                globalConfig: modeState.pluginGlobalConfig,
                runConfig: modeState.pluginRunConfig,
                projectRoot: path.join(__dirname, '..'),
                stdout: process.stdout,
                stderr: process.stderr
            });
            process.exit(exitCode);
        }

        const runtime = createRuntimeContext(modeState);

        // 2. Start web server mode
        if (runtime.serverMode) {
            if (runtime.serverDetach) {
                relaunchServeDetached(runtime);
                return;
            }
            const serveLogger = createServeLogger();
            runtime.logger = serveLogger;
            installServeProcessDiagnostics(serveLogger);
            serveLogger.info('serve startup requested', {
                host: runtime.serverHost,
                port: runtime.serverPort,
                user: runtime.serverAuthUser || 'admin(auto/default)',
                process: getServeProcessSnapshot()
            });
            console.log(`${CYAN}📝 serve 日志文件: ${YELLOW}${serveLogger.path}${NC}`);
            await runWebServerMode(runtime);
            return;
        }

        // 3. Handle image build operation
        if (modeState.isBuildMode) {
            await buildImage({
                imageBuildArgs: IMAGE_BUILD_ARGS,
                imageName: runtime.imageName,
                imageVersionTag: runtime.imageVersion,
                imageVersionDefault: IMAGE_VERSION_DEFAULT,
                imageVersionBase: IMAGE_VERSION_BASE,
                parseImageVersionTag,
                manyoyoName: MANYOYO_NAME,
                yesMode: Boolean(modeState.yesMode),
                dockerCmd: DOCKER_CMD,
                rootDir: path.join(__dirname, '..'),
                loadConfig,
                runCmd,
                askQuestion,
                pruneDanglingImages,
                colors: { RED, GREEN, YELLOW, BLUE, CYAN, NC }
            });
            syncBuiltImageVersionToGlobalConfig(runtime.imageVersion);
            process.exit(0);
        }

        // 4. Handle remove container operation
        if (modeState.isRemoveMode) {
            handleRemoveContainer(runtime);
            return;
        }

        // 5. Validate host path safety
        validateHostPath(runtime);

        // 6. Setup container (create or connect)
        const defaultCommand = await setupContainer(runtime);

        // 7-8. Execute command and handle post-exit interactions
        let shouldContinue = true;
        while (shouldContinue) {
            executeInContainer(runtime, defaultCommand);
            shouldContinue = await handlePostExit(runtime, defaultCommand);
        }

    } catch (e) {
        console.error(`${RED}Error: ${e.message}${NC}`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
