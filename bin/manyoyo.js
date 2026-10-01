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
const { resolveUpdateImageVersion } = require('../lib/image-version-policy');
const { selectContainerRuntime, mergeRuntimeEnv } = require('../lib/container-runtime');
const { describeError } = require('../lib/error-hints');
const { ensureRuntimeReady, runCommandAsync } = require('../lib/runtime-heal');
const { ensureImagePresent, pullImageProcess } = require('../lib/image-pull');
const { readImportState, waitForImport } = require('../lib/offline-import');
const { pruneDanglingImages: pruneDanglingImagesSafely } = require('../lib/image-prune');
const { runUninstall, readPid, defaultIsManyoyoServe, defaultKill } = require('../lib/uninstall');
const appUpdate = require('../lib/app-update');
const { createUpdateChecker } = require('../lib/update-check');
const { getLoginTokenDir, issueLoginToken } = require('../lib/login-token');
const { launchApp, getAppStatePath, openBrowser } = require('../lib/app-launcher');
const { initAgentConfigs } = require('../lib/init-config');
const { buildImage } = require('../lib/image-build');
const { resolveAgentResumeArg, buildAgentResumeCommand } = require('../lib/agent-resume');
const { resolveYoloCommand } = require('../lib/agent-adapters');
const { runDoctorChecks, applyDoctorFixes } = require('../lib/doctor');
const { resolveContainerMode } = require('../lib/container-modes');
const { runPluginCommand, createPlugin } = require('../lib/plugin');
const { buildManyoyoLogPath } = require('../lib/log-path');
const { resolveRuntimeConfig } = require('../lib/runtime-resolver');
const { resolveWorktreeSupport } = require('../lib/worktrees');
const {
    parseEnvEntry: parseEnvEntryOrThrow,
    normalizeVolume
} = require('../lib/runtime-normalizers');
const {
    sanitizeSensitiveData,
    sanitizeServeLogText,
    formatServeLogValue,
    getServeProcessSnapshot
} = require('../lib/serve-log');
const { version: BIN_VERSION, imageVersion: IMAGE_VERSION_DEFAULT } = require('../package.json');
const IMAGE_VERSION_BASE = String(IMAGE_VERSION_DEFAULT || '1.0.0').split('-')[0];
const GLOBAL_CONFIG_IMAGE_VERSION = String(readManyoyoConfig().config.imageVersion || '').trim();
const IMAGE_VERSION_HELP_EXAMPLE = GLOBAL_CONFIG_IMAGE_VERSION || IMAGE_VERSION_DEFAULT || `${IMAGE_VERSION_BASE}-common`;

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
    // 离线安装器生成的 manyoyo / my 包装脚本都指向同一个 manyoyo.js，用环境变量区分显示的命令名
    const fromEnv = String(process.env.MANYOYO_COMMAND_NAME || '').trim();
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(fromEnv)) return fromEnv;

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
let IMAGE_NAME = "ghcr.io/xcanwin/manyoyo";
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
let SERVER_TITLE = null;
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
// 仅运行时子进程使用的完整 env（私有 Podman 才有值），不要写回 process.env
let DOCKER_ENV;
let CONTAINER_RUNTIME = null;
// 全局配置 updateCheck（默认 true）：serve 是否每天检查一次新版本
let UPDATE_CHECK_ENABLED = true;
// serve 的容器环境状态，供 GET /api/system/runtime 读取
const RUNTIME_STATE = { status: 'ready', message: '' };
const DOCKER_DAEMON_ERROR_CODES = new Set(['PODMAN_MACHINE_UNAVAILABLE', 'DOCKER_DAEMON_UNAVAILABLE', 'PORT_IN_USE']);
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
 * @property {{title?:string}} [serve] - serve 命令专属配置（如自定义网页标题，留空字符串则显示为空）
 * @property {Object.<string, Object>} [runs] - 运行配置映射（-r <name>）
 * @property {string} [yolo] - YOLO 模式
 * @property {string} [containerMode] - 容器模式
 * @property {string} [containerRuntime] - 容器运行时（auto/docker/podman，默认 auto；仅全局配置生效）
 * @property {boolean} [updateCheck] - serve 是否每天检查一次新版本（默认 true；仅全局配置生效，请求不附带任何本机信息）
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
    try {
        return parseEnvEntryOrThrow(env);
    } catch (e) {
        const message = e && e.message ? e.message : String(e);
        console.error(`${RED}⚠️  错误: ${message}${NC}`);
        process.exit(1);
    }
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

function setYolo(cli) {
    try {
        EXEC_COMMAND = resolveYoloCommand(cli);
    } catch (error) {
        console.log(`${RED}⚠️  未知LLM CLI: ${cli}${NC}`);
        process.exit(0);
    }
}

/**
 * 设置容器嵌套模式
 * @param {string} mode - 模式名称 (common, dind, sock)
 */
function setContMode(mode) {
    let resolved;
    try {
        resolved = resolveContainerMode(mode);
    } catch (error) {
        console.log(`${RED}⚠️  未知模式: ${mode}${NC}`);
        process.exit(0);
    }

    CONT_MODE_ARGS = resolved.args;

    if (resolved.mode === 'dind') {
        console.log(`${GREEN}✅ 开启安全的容器嵌套容器模式, 手动在容器内启动服务: nohup dockerd &${NC}`);
    } else if (resolved.mode === 'sock') {
        console.log(`${RED}⚠️  开启危险的容器嵌套容器模式, 危害: 容器可访问宿主机文件${NC}`);
    }
}

// 本地没有镜像时自动拉取（终端显示拉取进度），失败给出原因与下一步
async function ensureRunImage(runtime) {
    const imageRef = `${runtime.imageName}:${runtime.imageVersion}`;
    // 离线安装器还在后台导入镜像时先等它，避免重复去仓库拉
    await waitForImport({ onWait: state => console.log(`${YELLOW}⏳ ${state.message}，等待完成...${NC}`) });
    await ensureImagePresent({
        imageRef,
        command: DOCKER_CMD,
        isPresent: () => {
            try {
                dockerExecArgs(['image', 'inspect', imageRef], { stdio: 'pipe' });
                return true;
            } catch (e) {
                return false;
            }
        },
        pull: () => pullImageProcess({
            command: DOCKER_CMD,
            env: DOCKER_ENV,
            imageRef,
            onOutput: (text, stream) => (stream === 'stderr' ? process.stderr : process.stdout).write(text)
        }),
        onStart: () => console.log(`${YELLOW}⏬ 本地没有镜像 ${imageRef}，正在拉取...${NC}`)
    });
}

function showImagePullHint(err) {
    const info = describeError(getCommandFailureText(err), { imageRef: `${IMAGE_NAME}:${IMAGE_VERSION}` });
    if (!info || !['IMAGE_PULL_FAILED', 'IMAGE_NOT_FOUND'].includes(info.code)) {
        return;
    }
    console.log(`${YELLOW}💡 提示: ${info.reason}${NC}`);
    console.log(`${YELLOW}   ${info.action}${NC}`);
}

function getCommandFailureText(err) {
    const stderr = err && err.stderr ? err.stderr.toString() : '';
    const stdout = err && err.stdout ? err.stdout.toString() : '';
    const message = err && err.message ? err.message : '';
    return `${message}\n${stderr}\n${stdout}`;
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

function checkPortAvailability(port) {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve('occupied'));
        server.listen(port, '127.0.0.1', () => server.close(() => resolve('available')));
    });
}

function dockerExecArgs(args, options = {}) {
    try {
        return runCmd(DOCKER_CMD, args, { env: DOCKER_ENV, ...options });
    } catch (e) {
        const info = describeError(getCommandFailureText(e), { command: DOCKER_CMD });
        if (info && DOCKER_DAEMON_ERROR_CODES.has(info.code) && e && e.message) {
            const hint = `\n提示: ${info.reason}\n${info.action}`;
            if (!e.message.includes(hint)) e.message = `${e.message}${hint}`;
        }
        throw e;
    }
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

// 运行时子进程执行器：env 只是增量，合并后仅传给这个子进程
function runRuntimeCommand(command, args, options = {}) {
    return runCmd(command, args, {
        stdio: 'pipe',
        timeout: options.timeout,
        env: mergeRuntimeEnv(options.env)
    });
}

// serve 里的自愈用异步执行器：machine start 最长 120s，同步执行会冻住整个事件循环（向导进度、登录页都没响应）
function runRuntimeCommandAsync(command, args, options = {}) {
    return runCommandAsync(command, args, { timeout: options.timeout, env: mergeRuntimeEnv(options.env) });
}

function healContainerRuntime(onStatus, options = {}) {
    return ensureRuntimeReady({ runtime: CONTAINER_RUNTIME, run: options.async ? runRuntimeCommandAsync : runRuntimeCommand, onStatus });
}

// 选择阶段已确认 daemon 可用（info 通过）时无需再自愈
function isRuntimeProven() {
    return /-daemon$/.test(CONTAINER_RUNTIME.source);
}

async function ensureDocker(configuredRuntime, options = {}) {
    try {
        CONTAINER_RUNTIME = selectContainerRuntime({ configured: configuredRuntime });
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
    DOCKER_CMD = CONTAINER_RUNTIME.command;
    DOCKER_ENV = mergeRuntimeEnv(CONTAINER_RUNTIME.env);
    if (options.deferHeal || isRuntimeProven()) {
        return true;
    }

    const result = await healContainerRuntime(state => {
        if (state.status === 'starting') console.log(`${YELLOW}⏳ ${state.message}...${NC}`);
    });
    if (result.status === 'started') {
        console.log(`${GREEN}✅ 容器环境已就绪${NC}`);
    } else if (result.status !== 'ready') {
        console.log(`${YELLOW}⚠️  ${result.message}${NC}`);
    }
    return true;
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

// 升级后让旧版本的后台服务退出（pid 必须确实是 manyoyo serve），下次执行 manyoyo 就会启动新版本
function stopBackgroundApp() {
    const pid = readPid(path.join(os.homedir(), '.manyoyo', 'serve', 'app.json'));
    if (pid && pid !== process.pid && defaultIsManyoyoServe(pid) && defaultKill(pid)) {
        console.log(`${GREEN}✅ 已停止旧版本的后台服务 (pid ${pid})，下次执行 ${MANYOYO_NAME} 会启动新版本。${NC}`);
    }
}

// 升级流程里准备容器运行时：和 ensureDocker 一样选择并（必要时）自愈，但没有运行时也不退出进程
async function prepareRuntimeForUpdate(configuredRuntime) {
    try {
        CONTAINER_RUNTIME = selectContainerRuntime({ configured: configuredRuntime });
    } catch (error) {
        return false;
    }
    DOCKER_CMD = CONTAINER_RUNTIME.command;
    DOCKER_ENV = mergeRuntimeEnv(CONTAINER_RUNTIME.env);
    if (!isRuntimeProven()) {
        const result = await healContainerRuntime(state => {
            if (state.status === 'starting') console.log(`${YELLOW}⏳ ${state.message}...${NC}`);
        });
        if (result.status !== 'ready' && result.status !== 'started') {
            console.log(`${YELLOW}⚠️  ${result.message}${NC}`);
            return false;
        }
    }
    return true;
}

async function updateOfflineInstall(mode, options, globalConfig) {
    const { appRoot } = mode;
    if (options.rollback) {
        const result = appUpdate.rollbackApp({ appRoot });
        console.log(`${GREEN}✅ 已回滚: ${result.from || '未知'} → ${result.to}${NC}`);
        stopBackgroundApp();
        return;
    }

    const installed = appUpdate.currentVersion(appRoot) || mode.version;
    console.log(`${CYAN}🔄 当前版本: ${installed}${NC}`);
    console.log(`${CYAN}🔄 正在查询最新版本...${NC}`);
    const release = await appUpdate.fetchLatestRelease();
    if (appUpdate.compareVersions(release.version, installed) <= 0) {
        console.log(`${GREEN}✅ 已是最新版本 ${installed}${NC}`);
        return;
    }
    console.log(`${CYAN}⬇️  发现新版本 ${release.version}，只下载 manyoyo 本体（数十 MB）${NC}`);
    const result = await appUpdate.installAppUpdate({ appRoot, release, log: line => console.log(`   ${line}`) });
    console.log(`${GREEN}✅ 更新完成: ${installed} → ${result.version}（上一版本 ${result.previous || '无'} 已保留，可用 ${MANYOYO_NAME} update --rollback 回滚）${NC}`);

    // Podman / VM 磁盘有变化只提示（需要新的完整包）
    try {
        const names = appUpdate.releaseAssetNames(release.version, appUpdate.arch());
        if (release.assets[names.manifest]) {
            const remote = JSON.parse(await appUpdate.fetchText(fetch, release.assets[names.manifest]));
            const hint = appUpdate.describeRuntimeChange(appUpdate.readInstalledRecord(os.homedir()), remote);
            if (hint) console.log(`${YELLOW}ℹ️  ${hint}${NC}`);
        }
    } catch (error) {
        // 提示信息拿不到不影响升级
    }

    // 新版本要求的镜像不存在就拉取；仍用旧镜像的容器只列出来，不动
    const imageName = String(globalConfig.imageName || 'ghcr.io/xcanwin/manyoyo');
    const versionPolicy = resolveUpdateImageVersion({
        configured: globalConfig.imageVersion,
        previousDefault: require('../package.json').imageVersion,
        nextDefault: result.manifest.imageVersion
    });
    const imageVersion = versionPolicy.imageVersion;
    if (versionPolicy.advance) {
        const synced = syncGlobalImageVersion(imageVersion);
        console.log(`${CYAN}ℹ️  配置里的 imageVersion（${globalConfig.imageVersion}）是旧版本默认值，已随新版本更新为 ${imageVersion}${synced.updated ? '' : '（写入配置失败，请手动修改）'}${NC}`);
    } else if (versionPolicy.pinned) {
        console.log(`${YELLOW}ℹ️  你在配置里固定了 imageVersion=${imageVersion}，新版本默认是 ${result.manifest.imageVersion}；如需使用新镜像请修改 ~/.manyoyo/manyoyo.json${NC}`);
    }
    if (imageVersion && await prepareRuntimeForUpdate(globalConfig.containerRuntime)) {
        const imageRef = `${imageName}:${imageVersion}`;
        try {
            await ensureImagePresent({
                imageRef,
                command: DOCKER_CMD,
                isPresent: () => {
                    try {
                        dockerExecArgs(['image', 'inspect', imageRef], { stdio: 'pipe' });
                        return true;
                    } catch (e) {
                        return false;
                    }
                },
                pull: () => pullImageProcess({ command: DOCKER_CMD, env: DOCKER_ENV, imageRef, onOutput: (text, stream) => (stream === 'stderr' ? process.stderr : process.stdout).write(text) }),
                onStart: () => console.log(`${YELLOW}⏬ 新版本需要镜像 ${imageRef}，正在拉取...${NC}`)
            });
        } catch (error) {
            console.log(`${YELLOW}⚠️  镜像还没准备好：${error.message}${NC}`);
        }
        const outdated = appUpdate.findOutdatedContainers({ run: runCmd, runtime: { command: DOCKER_CMD, env: DOCKER_ENV }, imageRef });
        if (outdated.length > 0) {
            console.log(`${YELLOW}ℹ️  有 ${outdated.length} 个容器还在用旧镜像：${outdated.map(item => `${item.name}(${item.image})`).join('、')}${NC}`);
            console.log(`${YELLOW}   它们可以继续使用；想换成新镜像，请新建容器（会话历史与凭据都在宿主机上，不会丢）。${NC}`);
        }
    }
    stopBackgroundApp();
}

async function updateManyoyo(options = {}, globalConfig = {}) {
    const mode = appUpdate.detectInstallMode({ scriptPath: __filename });
    if (mode.mode === 'offline') {
        try {
            await updateOfflineInstall(mode, options, globalConfig);
        } catch (error) {
            if (error instanceof appUpdate.UpdateError) {
                console.error(`${RED}❌ ${error.message}${NC}`);
                process.exit(1);
            }
            throw error;
        }
        return;
    }
    if (options.rollback) {
        console.error(`${RED}❌ --rollback 只适用于离线包安装；npm 安装的版本请用 npm install -g @xcanwin/manyoyo@<版本> 回退。${NC}`);
        process.exit(1);
    }

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
    runCmd('npm', ['update', '-g', '@xcanwin/manyoyo', '--prefer-online'], { stdio: 'inherit' });

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
    pruneDanglingImagesSafely({
        dockerExecArgs,
        log: line => console.log(line),
        colors: { YELLOW, GREEN, NC }
    });
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

function normalizeWorktreeArgv(argv) {
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--wt') {
            argv[i] = '--worktrees';
            continue;
        }
        if (argv[i] === '--wtr') {
            argv[i] = '--worktrees-root';
            continue;
        }
        if (typeof argv[i] === 'string' && argv[i].startsWith('--wtr=')) {
            argv[i] = `--worktrees-root=${argv[i].slice('--wtr='.length)}`;
        }
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

function enableShellSuffixPassThrough(command) {
    return command.allowExcessArguments(true);
}

function validateShellSuffixPassThroughArgs(command) {
    const extraArgs = Array.isArray(command && command.args) ? command.args : [];
    if (!extraArgs.length) {
        return;
    }

    if (!process.argv.includes('--')) {
        console.error(`${RED}⚠️  错误: 存在多余位置参数: ${extraArgs.join(' ')}。如需透传命令后缀，请使用 -- <args...>${NC}`);
        process.exit(1);
    }
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
        .option('--worktrees', '启用 Git worktrees 根目录自动挂载 (别名: --wt)')
        .option('--worktrees-root <path>', '指定项目级 Git worktrees 根目录 (仅支持绝对路径; 隐式启用 --worktrees; 别名: --wtr)')
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
  ${MANYOYO_NAME} build --update-agents --yes         仅更新已有镜像内已存在的 Agent CLI
  ${MANYOYO_NAME} init all                            从本机 Agent 配置初始化 ~/.manyoyo
  ${MANYOYO_NAME} run -r claude                       使用 manyoyo.json 的 runs.claude 快速启动
  ${MANYOYO_NAME} run -r codex --ss "resume --last"   使用命令后缀
  ${MANYOYO_NAME} run -n test --ef /path/ab.env -y c  使用绝对路径环境变量文件
  ${MANYOYO_NAME} run -n test -- -c                   恢复之前会话
  ${MANYOYO_NAME} run -x "echo 123"                   使用完整命令
  ${MANYOYO_NAME} serve 127.0.0.1:3000                启动本机网页服务
  ${MANYOYO_NAME} serve 127.0.0.1:3000 -d             后台启动；未设密码时会打印本次随机密码
  ${MANYOYO_NAME} serve 0.0.0.0:3000 -U admin -P 123 -d  后台启动并监听全部网卡
  ${MANYOYO_NAME} serve 0.0.0.0:3000 -U admin -P 123 -d --restart  重启指定后台网页服务
  ${MANYOYO_NAME} playwright up mcp-host-headless     启动 playwright MCP 宿主场景（默认/推荐）
  ${MANYOYO_NAME} playwright up cli-host-headless     启动 playwright CLI 宿主场景（供容器内 playwright-cli 附着）
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
    enableShellSuffixPassThrough(runCommand);
    runCommand.action((options, command) => {
        validateShellSuffixPassThroughArgs(command);
        selectAction('run', options);
    });

    const buildCommand = program.command('build').description('构建 manyoyo 沙箱镜像');
    buildCommand
        .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
        .option('--in, --image-name <name>', '指定镜像名称')
        .option('--iv, --image-ver <version>', '指定镜像版本 (格式: x.y.z-后缀，如 1.7.4-common)')
        .option('--update-agents', '仅更新已有镜像内 Agent CLI 到 latest (Claude/Codex/Gemini/OpenCode)')
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
    serveCommand.option('--stop', '停止后台网页服务；必须显式传入 listen');
    serveCommand.option('--restart', '重启后台网页服务；必须显式传入 listen');
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
    enableShellSuffixPassThrough(configShowCommand);
    configShowCommand.action((options, command) => {
        validateShellSuffixPassThroughArgs(command);
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
    enableShellSuffixPassThrough(configRunCommand);
    configRunCommand.action((options, command) => {
        validateShellSuffixPassThroughArgs(command);
        selectAction('config-command', options);
    });

    program.command('uninstall')
        .description('卸载离线包安装的 MANYOYO：停止服务，删除程序与 PATH 配置，用户数据逐项询问（--yes 不会删用户数据）')
        .option('--yes', '确认卸载程序本身，不再询问（不会删除配置、历史、日志、工作目录和外部运行时里的容器镜像）')
        .action(options => selectAction('uninstall', options));

    const initCommand = program.command('init [agents]').description('初始化 Agent 配置到 ~/.manyoyo');
    initCommand
        .option('--yes', '所有提示自动确认 (用于CI/脚本)')
        .action((agents, options) => selectAction('init', { ...options, initConfig: agents === undefined ? 'all' : agents }));

    program.command('doctor')
        .description('诊断容器运行时、镜像、配置、Agent、模式、插件和端口')
        .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
        .option('--port <port>', '检查指定监听端口')
        .option('--json', '以 JSON 输出稳定诊断结果')
        .option('--fix', '自动修复可修复项（启动容器环境、拉取镜像、生成默认配置，端口占用时给出建议端口）')
        .action(options => selectAction('doctor', { ...options, doctor: true }));

    program.command('update')
        .description('更新 MANYOYO（离线包安装只下载变化部分并保留上一版本；若检测为本地 file 安装则跳过）')
        .option('--rollback', '离线包安装：切回上一版本')
        .action(options => selectAction('update', { update: true, rollback: Boolean(options.rollback) }));

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

    // No args: start (or reuse) the local web app and open the browser, already logged in
    if (process.argv.length <= 2) {
        await runAppLauncher();
    }

    // Pre-handle -x/--shell-full: treat all following args as a single command
    normalizeShellFullArgv(process.argv);
    normalizeWorktreeArgv(process.argv);

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
    const isDoctorMode = selectedAction === 'doctor';
    const isServerMode = options.server !== undefined;
    const isServerStopMode = Boolean(selectedAction === 'serve' && options.stop);
    const isServerRestartMode = Boolean(selectedAction === 'serve' && options.restart);

    if (isServerStopMode && isServerRestartMode) {
        throw new Error('serve --stop 与 --restart 不能同时使用');
    }

    UPDATE_CHECK_ENABLED = config.updateCheck !== false;
    const noDockerActions = new Set(['init', 'update', 'install', 'config-show', 'plugin', 'doctor', 'uninstall']);
    if (isServerStopMode) {
        noDockerActions.add('serve');
    }
    if (!noDockerActions.has(selectedAction)) {
        await ensureDocker(config.containerRuntime, { deferHeal: selectedAction === 'serve' });
    }

    if (options.update) {
        await updateManyoyo(options, config);
        process.exit(0);
    }

    if (selectedAction === 'uninstall') {
        await runUninstall({
            yes: yesMode,
            ask: askQuestion,
            log: line => console.log(line),
            selectExternalRuntime: () => {
                try {
                    const selected = selectContainerRuntime({ configured: config.containerRuntime });
                    return selected.source === 'private-podman' ? null : selected;
                } catch (error) {
                    return null;
                }
            }
        });
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

    const resolvedRuntime = resolveRuntimeConfig({
        cliOptions: options,
        globalConfig: config,
        runConfig,
        globalFirstConfig,
        runFirstConfig,
        defaults: {
            hostPath: HOST_PATH,
            containerName: CONTAINER_NAME,
            containerPath: CONTAINER_PATH,
            imageName: IMAGE_NAME,
            imageVersion: IMAGE_VERSION
        },
        envVars: process.env,
        argv: process.argv,
        isServerMode,
        isServerStopMode,
        pickConfigValue,
        resolveContainerNameTemplate,
        normalizeCommandSuffix,
        normalizeJsonEnvMap,
        normalizeCliEnvMap,
        mergeArrayConfig,
        normalizeVolume,
        parseServerListen,
        resolveWorktreeSupport
    });

    HOST_PATH = resolvedRuntime.hostPath;
    CONTAINER_NAME = resolvedRuntime.containerName;
    CONTAINER_PATH = resolvedRuntime.containerPath;
    IMAGE_NAME = resolvedRuntime.imageName;
    IMAGE_VERSION = resolvedRuntime.imageVersion;
    EXEC_COMMAND_PREFIX = resolvedRuntime.exec.prefix;
    EXEC_COMMAND = resolvedRuntime.exec.shell;
    EXEC_COMMAND_SUFFIX = resolvedRuntime.exec.suffix;
    FIRST_EXEC_COMMAND_PREFIX = resolvedRuntime.first.exec.prefix;
    FIRST_EXEC_COMMAND = resolvedRuntime.first.exec.shell;
    FIRST_EXEC_COMMAND_SUFFIX = resolvedRuntime.first.exec.suffix;

    // Basic name validation to reduce injection risk
    validateName('containerName', CONTAINER_NAME, SAFE_CONTAINER_NAME_PATTERN);
    validateName('imageName', IMAGE_NAME, /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/);
    validateImageVersion(IMAGE_VERSION);

    // Merge mode (array values): concatenate all sources
    const envFileList = resolvedRuntime.envFile;
    envFileList.forEach(ef => addEnvFile(ef));

    const envMap = resolvedRuntime.env;
    Object.entries(envMap).forEach(([key, value]) => addEnv(`${key}=${value}`));

    const firstEnvFileList = resolvedRuntime.first.envFile;
    firstEnvFileList.forEach(ef => addEnvFileTo(FIRST_CONTAINER_ENVS, ef));

    const firstEnvMap = resolvedRuntime.first.env;
    Object.entries(firstEnvMap).forEach(([key, value]) => addEnvTo(FIRST_CONTAINER_ENVS, `${key}=${value}`));

    applyPlaywrightCliSessionIntegration(config, runConfig);

    const volumeList = resolvedRuntime.volumes;
    volumeList.forEach(v => addVolume(v));

    const portList = resolvedRuntime.ports;
    portList.forEach(p => addPort(p));

    const buildArgList = resolvedRuntime.imageBuildArgs;
    buildArgList.forEach(arg => addImageBuildArg(arg));

    const yoloValue = resolvedRuntime.yolo;
    if (yoloValue) setYolo(yoloValue);

    const contModeValue = resolvedRuntime.containerMode;
    if (contModeValue) setContMode(contModeValue);

    const quietValue = resolvedRuntime.quiet;
    if (quietValue) setQuiet(quietValue);

    if (options.rmOnExit) {
        RM_ON_EXIT = true;
    }

    SERVER_HOST = resolvedRuntime.serverHost || SERVER_HOST;
    SERVER_PORT = resolvedRuntime.serverPort || SERVER_PORT;
    SERVER_AUTH_USER = resolvedRuntime.serverUser || '';
    SERVER_AUTH_PASS = resolvedRuntime.serverPass || '';
    SERVER_AUTH_PASS_AUTO = Boolean(resolvedRuntime.serverPassAuto);
    SERVER_TITLE = resolvedRuntime.serveTitle;

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
            worktrees: resolvedRuntime.worktrees,
            worktreesRoot: resolvedRuntime.worktreesRoot,
            worktreeRepoRoot: resolvedRuntime.worktreeRepoRoot,
            worktreeMainRepoRoot: resolvedRuntime.worktreeMainRepoRoot,
            containerMode: contModeValue || "",
            containerRuntime: config.containerRuntime || "auto",
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
            serve: {
                title: SERVER_TITLE
            },
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

    if (isDoctorMode) {
        const parsedPort = options.port === undefined ? null : Number(options.port);
        const portStatus = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
            ? await checkPortAvailability(parsedPort)
            : undefined;
        let doctorRuntime = null;
        let report = await runDoctorChecks({
            selectRuntime: () => {
                doctorRuntime = selectContainerRuntime({ configured: config.containerRuntime });
                return doctorRuntime;
            },
            runCommand: runRuntimeCommand,
            configExists: fs.existsSync(getManyoyoConfigPath()),
            imageName: IMAGE_NAME,
            imageVersion: IMAGE_VERSION,
            agentCommand: EXEC_COMMAND,
            containerMode: contModeValue || 'common',
            pluginConfig: config.plugins,
            portStatus
        });
        if (options.fix) {
            report = await applyDoctorFixes(report, {
                startRuntime: async () => {
                    const result = await ensureRuntimeReady({ runtime: doctorRuntime, run: runRuntimeCommand });
                    return { fixed: result.status === 'started' || result.status === 'ready', message: result.message };
                },
                pullImage: async () => {
                    const image = `${IMAGE_NAME}:${IMAGE_VERSION}`;
                    try {
                        console.error(`正在拉取 ${image} ...`);
                        await pullImageProcess({
                            command: doctorRuntime.command,
                            env: mergeRuntimeEnv(doctorRuntime.env),
                            imageRef: image,
                            onOutput: text => process.stderr.write(text)
                        });
                    } catch (e) {
                        throw new Error(`拉取 ${image} 失败；可执行 ${MANYOYO_NAME} build --iv ${IMAGE_VERSION} 本地构建`);
                    }
                    return { fixed: true, message: `已拉取 ${image}` };
                },
                createConfig: () => {
                    const result = syncGlobalImageVersion(IMAGE_VERSION);
                    return { fixed: result.reason === 'created', message: result.reason === 'created' ? `已生成 ${result.path}` : `未生成配置: ${result.reason}` };
                },
                suggestPort: async () => {
                    for (let candidate = parsedPort + 1; candidate <= Math.min(parsedPort + 50, 65535); candidate += 1) {
                        if (await checkPortAvailability(candidate) === 'available') {
                            return { fixed: false, message: `建议使用空闲端口 ${candidate}` };
                        }
                    }
                    return { fixed: false, message: '附近没有空闲端口，请手动指定' };
                }
            });
        }
        if (options.json) {
            console.log(JSON.stringify(report, null, 4));
        } else {
            report.checks.forEach(check => {
                console.log(`[${check.status.toUpperCase()}] ${check.code}: ${check.summary}${check.action ? ` (${check.action})` : ''}`);
                if (check.fix && check.fix.attempted) {
                    console.log(`    ${check.fix.fixed ? '已修复' : '未修复'}: ${check.fix.message}`);
                }
            });
        }
        process.exit(report.ok ? 0 : 1);
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
        isServerStop: isServerStopMode,
        isServerRestart: isServerRestartMode,
        isServerDetach: Boolean(selectedAction === 'serve' && options.detach),
        isServerListenSpecified: Boolean(isServerMode && options.server !== true),
        updateAgents: Boolean(options.updateAgents),
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
        serverStop: Boolean(modeState.isServerStop),
        serverRestart: Boolean(modeState.isServerRestart),
        serverDetach: Boolean(modeState.isServerDetach),
        serverListenSpecified: Boolean(modeState.isServerListenSpecified),
        serverHost: SERVER_HOST,
        serverPort: SERVER_PORT,
        serverAuthUser: SERVER_AUTH_USER,
        serverAuthPass: SERVER_AUTH_PASS,
        serverAuthPassAuto: SERVER_AUTH_PASS_AUTO,
        serveTitle: SERVER_TITLE,
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
        if (arg === '-d' || arg === '--detach' || arg === '--restart') {
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

function formatServeListenHost(host) {
    const text = String(host || '').trim() || '127.0.0.1';
    if (text.includes(':') && !text.startsWith('[')) {
        return `[${text}]`;
    }
    return text;
}

function buildServeListenLabel(host, port) {
    return `${formatServeListenHost(host)}:${port}`;
}

function buildServePidFile(host, port, homeDir = os.homedir()) {
    const dir = path.join(homeDir, '.manyoyo', 'run', 'serve');
    const listen = buildServeListenLabel(host, port);
    const safeName = listen.replace(/[^A-Za-z0-9_.-]+/g, '_');
    return {
        dir,
        listen,
        path: path.join(dir, `${safeName}.pid`)
    };
}

function removeServePidFile(filePath) {
    if (!filePath) return;
    try {
        fs.rmSync(filePath, { force: true });
    } catch (e) {
        // ignore cleanup failures
    }
}

function isProcessRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e && e.code !== 'ESRCH';
    }
}

function readServePidFile(filePath) {
    try {
        const text = fs.readFileSync(filePath, 'utf-8').trim();
        if (!/^\d+$/.test(text)) {
            return 0;
        }
        return Number(text);
    } catch (e) {
        return 0;
    }
}

function getServePidTarget(host, port, homeDir = os.homedir()) {
    const pidFile = buildServePidFile(host, port, homeDir);
    const pid = readServePidFile(pidFile.path);
    if (!Number.isInteger(pid) || pid <= 0 || !isProcessRunning(pid)) {
        removeServePidFile(pidFile.path);
        return null;
    }
    return {
        pid,
        listen: pidFile.listen,
        path: pidFile.path
    };
}

function installServePidCleanup(pidFilePath, logger) {
    if (!pidFilePath || global.__manyoyoServePidCleanupInstalled) {
        return;
    }
    global.__manyoyoServePidCleanupInstalled = true;
    process.on('exit', () => {
        removeServePidFile(pidFilePath);
        if (logger && typeof logger.info === 'function') {
            logger.info('serve pid file removed', { pidFilePath });
        }
    });
}

function writeServePidFile(runtime, serverHandle) {
    const pidFile = buildServePidFile(serverHandle.host, serverHandle.port);
    fs.mkdirSync(pidFile.dir, { recursive: true });
    fs.writeFileSync(pidFile.path, `${process.pid}\n`);
    installServePidCleanup(pidFile.path, runtime && runtime.logger);
    return pidFile.path;
}

async function stopServeProcess(runtime, options = {}) {
    const commandName = options.commandName || '--stop';
    if (!runtime || !runtime.serverListenSpecified) {
        throw new Error(`serve ${commandName} 必须显式传入 listen，例如 manyoyo serve 127.0.0.1:3000 ${commandName}`);
    }
    const target = getServePidTarget(runtime.serverHost, runtime.serverPort);
    if (!target) {
        const label = buildServeListenLabel(runtime.serverHost, runtime.serverPort);
        console.log(`${YELLOW}⚠️  未发现运行中的 serve 实例: ${label}${NC}`);
        return false;
    }
    try {
        process.kill(target.pid, 'SIGTERM');
    } catch (e) {
        if (!e || e.code !== 'ESRCH') {
            throw e;
        }
    }
    await sleep(200);
    if (isProcessRunning(target.pid)) {
        try {
            process.kill(target.pid, 'SIGKILL');
        } catch (e) {
            if (!e || e.code !== 'ESRCH') {
                throw e;
            }
        }
    }
    removeServePidFile(target.path);
    console.log(`${GREEN}✅ 已停止 serve: ${target.listen} (pid: ${target.pid})${NC}`);
    return true;
}

function relaunchServeDetached(runtime) {
    const serveLog = buildManyoyoLogPath('serve');
    fs.mkdirSync(serveLog.dir, { recursive: true });

    const existing = getServePidTarget(runtime.serverHost, runtime.serverPort);
    if (existing) {
        console.log(`${YELLOW}⚠️  serve 已在后台运行: ${existing.listen} (pid: ${existing.pid})${NC}`);
        return;
    }

    const child = spawn(process.argv[0], buildDetachedServeArgv(process.argv.slice(1)), {
        detached: true,
        stdio: 'ignore',
        env: buildDetachedServeEnv(runtime)
    });
    child.unref();

    console.log(`${GREEN}✅ MANYOYO Web 服务已在后台启动: http://${buildServeListenLabel(runtime.serverHost, runtime.serverPort)}${NC}`);
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
 * @param {{throwOnFailure?: boolean}} [options] serve 路径传 true：失败抛错而不是 process.exit，调用方才能清理容器
 */
async function waitForContainerReady(containerName, options = {}) {
    const MAX_RETRIES = CONFIG.CONTAINER_READY_MAX_RETRIES;
    let retryDelay = CONFIG.CONTAINER_READY_INITIAL_DELAY;

    for (let count = 0; count < MAX_RETRIES; count++) {
        try {
            const status = getContainerStatus(containerName);

            if (status === 'running') {
                return;
            }

            if (status === 'exited') {
                if (options.throwOnFailure) {
                    throw Object.assign(new Error('容器启动后立即退出'), { containerExited: true });
                }
                console.log(`${RED}⚠️  错误: 容器启动后立即退出。${NC}`);
                dockerExecArgs(['logs', containerName], { stdio: 'inherit' });
                process.exit(1);
            }

            await sleep(retryDelay);
            retryDelay = Math.min(retryDelay * 2, CONFIG.CONTAINER_READY_MAX_DELAY);
        } catch (e) {
            if (e && e.containerExited) throw e;
            await sleep(retryDelay);
            retryDelay = Math.min(retryDelay * 2, CONFIG.CONTAINER_READY_MAX_DELAY);
        }
    }

    if (options.throwOnFailure) {
        throw new Error('容器启动超时');
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
    const firstExecResult = spawnSync(`${DOCKER_CMD}`, firstExecArgs, { stdio: 'inherit', env: DOCKER_ENV });
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

    await ensureRunImage(runtime);

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
        spawnSync(`${DOCKER_CMD}`, ['exec', '-it', runtime.containerName, '/bin/bash', '-c', runtime.execCommand], { stdio: 'inherit', env: DOCKER_ENV });
    } else {
        spawnSync(`${DOCKER_CMD}`, ['exec', '-it', runtime.containerName, '/bin/bash'], { stdio: 'inherit', env: DOCKER_ENV });
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

async function runAppLauncher() {
    try {
        await launchApp({
            statePath: getAppStatePath(),
            isProcessRunning,
            spawnServe: port => {
                // 登录走一次性令牌；未配置密码时 serve 自己生成随机密码（标记为自动生成，向导据此让用户设置）
                const child = spawn(process.argv[0], [process.argv[1], 'serve', `127.0.0.1:${port}`], {
                    detached: true,
                    stdio: 'ignore'
                });
                child.unref();
                return child;
            },
            issueToken: () => issueLoginToken(getLoginTokenDir()),
            open: url => openBrowser(url),
            log: line => console.log(line),
            logPathHint: buildManyoyoLogPath('serve').path,
            commandName: MANYOYO_NAME
        });
    } catch (e) {
        console.error(`${RED}${e.message}${NC}`);
        process.exit(1);
    }
    process.exit(0);
}

async function runWebServerMode(runtime) {
    if (!runtime.serverAuthUser || !runtime.serverAuthPass) {
        ensureWebServerAuthCredentials();
        runtime.serverAuthUser = SERVER_AUTH_USER;
        runtime.serverAuthPass = SERVER_AUTH_PASS;
        runtime.serverAuthPassAuto = SERVER_AUTH_PASS_AUTO;
    }

    const updateChecker = createUpdateChecker({
        currentVersion: require('../package.json').version,
        installMode: appUpdate.detectInstallMode({ scriptPath: __filename }).mode,
        enabled: UPDATE_CHECK_ENABLED,
        fetchLatest: () => appUpdate.fetchLatestRelease()
    });

    const needRuntimeHeal = !isRuntimeProven();
    if (needRuntimeHeal) {
        RUNTIME_STATE.status = 'starting';
        RUNTIME_STATE.message = '正在检查容器环境';
    }

    // 自愈失败/超时不是终态：用户手动修好（或点向导里的“重试”）后可以再来一次
    let runtimeHealing = false;
    function startServeRuntimeHeal() {
        if (runtimeHealing) return false;
        runtimeHealing = true;
        RUNTIME_STATE.status = 'starting';
        RUNTIME_STATE.message = '正在检查容器环境';
        healContainerRuntime(state => {
            RUNTIME_STATE.status = state.status;
            RUNTIME_STATE.message = state.message;
            if (state.status === 'starting') console.log(`${YELLOW}⏳ ${state.message}...${NC}`);
        }, { async: true }).then(result => {
            if (result.status === 'ready' || result.status === 'started') {
                RUNTIME_STATE.status = 'ready';
                RUNTIME_STATE.message = '';
            } else {
                RUNTIME_STATE.status = 'failed';
                RUNTIME_STATE.message = result.message;
                console.log(`${YELLOW}⚠️  ${result.message}${NC}`);
            }
        }).catch(error => {
            RUNTIME_STATE.status = 'failed';
            RUNTIME_STATE.message = String(error && error.message || error);
        }).finally(() => {
            runtimeHealing = false;
        });
        return true;
    }

    const serverHandle = await startWebServer({
        serverHost: runtime.serverHost,
        serverPort: runtime.serverPort,
        authUser: runtime.serverAuthUser,
        authPass: runtime.serverAuthPass,
        authPassAuto: runtime.serverAuthPassAuto,
        serveTitle: runtime.serveTitle,
        dockerCmd: DOCKER_CMD,
        dockerEnv: DOCKER_ENV,
        runtimeState: RUNTIME_STATE,
        retryRuntimeHeal: () => (needRuntimeHeal ? startServeRuntimeHeal() : false),
        autoPullImage: true,
        importState: () => readImportState(),
        updateInfo: () => updateChecker.getInfo(),
        loginTokenDir: getLoginTokenDir(),
        doctorCheck: async () => runDoctorChecks({
            selectRuntime: () => CONTAINER_RUNTIME,
            runCommand: runRuntimeCommandAsync,
            configExists: fs.existsSync(getManyoyoConfigPath()),
            imageName: runtime.imageName,
            imageVersion: runtime.imageVersion,
            containerMode: 'common',
            pluginConfig: {}
        }),
        doctorStartRuntime: async () => {
            const result = await ensureRuntimeReady({ runtime: CONTAINER_RUNTIME, run: runRuntimeCommandAsync });
            const fixed = result.status === 'started' || result.status === 'ready';
            if (fixed) {
                RUNTIME_STATE.status = 'ready';
                RUNTIME_STATE.message = '';
            }
            return { fixed, message: result.message };
        },
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
        dockerExecAsync: (args, options = {}) => runCommandAsync(DOCKER_CMD, args, { env: DOCKER_ENV, timeout: options.timeout }),
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
    writeServePidFile(runtime, serverHandle);
    if (needRuntimeHeal) {
        startServeRuntimeHeal();
    }
    return serverHandle;
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
            if (runtime.serverStop) {
                await stopServeProcess(runtime);
                return;
            }
            if (runtime.serverRestart) {
                await stopServeProcess(runtime, { commandName: '--restart' });
            }
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
                updateAgents: Boolean(modeState.updateAgents),
                dockerCmd: DOCKER_CMD,
                dockerEnv: DOCKER_ENV,
                rootDir: path.join(__dirname, '..'),
                loadConfig,
                runCmd,
                askQuestion,
                pruneDanglingImages,
                colors: { RED, GREEN, YELLOW, BLUE, CYAN, NC }
            });
            if (!modeState.updateAgents) {
                syncBuiltImageVersionToGlobalConfig(runtime.imageVersion);
            }
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
