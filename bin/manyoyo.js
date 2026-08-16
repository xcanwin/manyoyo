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
const { buildContainerRunCommand } = require('../lib/container-run');
const { compileContainerRun, compileContainerExec, createRuntimeDriver } = require('../lib/runtime/driver');
const { getManyoyoConfigPath, readManyoyoConfig, syncGlobalImageVersion } = require('../lib/global-config');
const { initAgentConfigs } = require('../lib/init-config');
const { bootstrapFirstRun } = require('../lib/first-run-setup');
const { buildImage } = require('../lib/image-build');
const { runDoctorChecks } = require('../lib/doctor');
const { DEFAULT_IMAGE_NAME } = require('../lib/default-image');
const { ensureDefaultImage } = require('../lib/image-pull');
const { resolveAgentResumeArg, buildAgentResumeCommand } = require('../lib/agent-resume');
const { runPluginCommand, createPlugin } = require('../lib/plugin');
const { registerPlaywrightAliasCommands } = require('../lib/cli/commands/playwright');
const { registerConfigCommands } = require('../lib/cli/commands/config');
const { registerCoreCommands } = require('../lib/cli/commands/core');
const { startConfiguredWebServer } = require('../lib/cli/web-server');
const { createServeProcessManager } = require('../lib/cli/serve-process');
const {
    connectExistingContainer: connectExistingContainerLifecycle,
    createNewContainer: createNewContainerLifecycle,
    executeFirstCommand: executeFirstCommandLifecycle,
    executeInContainer: executeInContainerLifecycle,
    handlePostExit: handlePostExitLifecycle,
    setupContainer: setupContainerLifecycle,
    waitForContainerReady: waitForContainerReadyLifecycle
} = require('../lib/cli/container-lifecycle');
const { buildManyoyoLogPath } = require('../lib/log-path');
const { resolveRuntimeConfig } = require('../lib/runtime-resolver');
const { resolveContainerMode } = require('../lib/runtime/container-modes');
const {
    assertProcessSucceeded
} = require('../lib/runtime/container-exec');
const { resolveWorktreeSupport } = require('../lib/worktrees');
const { resolveYoloCommand } = require('../lib/agent-adapters/metadata');
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
let IMAGE_NAME = DEFAULT_IMAGE_NAME;
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
let SERVER_TRUST_PROXY = false;
const SAFE_CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// Color definitions using ANSI codes
const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const CYAN = '\x1b[0;36m';
const NC = '\x1b[0m'; // No Color
const IMAGE_VERSION_TAG_PATTERN = /^(\d+\.\d+\.\d+)-([A-Za-z0-9][A-Za-z0-9_.-]*)$/;
const {
    writeServePidFile,
    stopServeProcess,
    relaunchServeDetached
} = createServeProcessManager({
    fs,
    path,
    os,
    processRef: process,
    globalRef: global,
    spawn,
    sleep,
    buildLogPath: buildManyoyoLogPath,
    log: message => console.log(message),
    colors: { GREEN, YELLOW, NC }
});

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
function loadConfig(result = readManyoyoConfig()) {
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
        throw error;
    }
}

/**
 * 设置容器嵌套模式
 * @param {string} mode - 模式名称 (common, dind, sock)
 */
function setContMode(mode) {
    let resolvedMode;
    try {
        resolvedMode = resolveContainerMode(mode);
    } catch (error) {
        console.log(`${RED}⚠️  未知模式: ${mode}${NC}`);
        throw error;
    }
    const normalizedMode = resolvedMode.mode;

    if (normalizedMode === 'common') {
        CONT_MODE_ARGS = resolvedMode.args;
        return;
    }

    if (normalizedMode === 'dind') {
        CONT_MODE_ARGS = resolvedMode.args;
        console.log(`${GREEN}✅ 开启安全的容器嵌套容器模式, 手动在容器内启动服务: nohup dockerd &${NC}`);
        return;
    }

    if (normalizedMode === 'sock') {
        CONT_MODE_ARGS = resolvedMode.args;
        console.log(`${RED}⚠️  开启危险的容器嵌套容器模式, 危害: 容器可访问宿主机文件${NC}`);
        return;
    }
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

function getCommandFailureText(err) {
    const stderr = err && err.stderr ? err.stderr.toString() : '';
    const stdout = err && err.stdout ? err.stdout.toString() : '';
    const message = err && err.message ? err.message : '';
    return `${message}\n${stderr}\n${stdout}`;
}

function getContainerRuntimeUnavailableHint(command, err) {
    const text = getCommandFailureText(err);
    if (/Cannot connect to Podman|unable to connect to Podman socket|podman machine start|podman system connection/i.test(text)) {
        return [
            '',
            `提示: 当前 ${command} 命令正在连接 Podman machine，但连接不可用。`,
            '请先在宿主机执行: podman machine start'
        ].join('\n');
    }
    if (/Cannot connect to the Docker daemon|docker daemon is not running|Is the docker daemon running/i.test(text)) {
        return [
            '',
            `提示: 当前 ${command} 命令无法连接容器运行时。`,
            '请先启动 Docker Desktop / Docker daemon，或确认 Podman machine 已启动。'
        ].join('\n');
    }
    return '';
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
    try {
        return runCmd(DOCKER_CMD, args, options);
    } catch (e) {
        const hint = getContainerRuntimeUnavailableHint(DOCKER_CMD, e);
        if (hint && e && e.message && !e.message.includes(hint)) {
            e.message = `${e.message}${hint}`;
        }
        throw e;
    }
}

function getRuntimeDriver() {
    return createRuntimeDriver(dockerExecArgs);
}

function containerExists(name) {
    return getRuntimeDriver().containerExists(name);
}

function getContainerStatus(name) {
    return getRuntimeDriver().getContainerStatus(name);
}

function removeContainer(name) {
    if ( !(QUIET.crm || QUIET.full) ) console.log(`${YELLOW}🗑️ 正在删除容器: ${name}...${NC}`);
    getRuntimeDriver().removeContainer(name);
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

function checkPortAvailability(port) {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve('occupied'));
        server.listen(port, '127.0.0.1', () => {
            server.close(() => resolve('available'));
        });
    });
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
            .option('-P, --pass <password>', '网页服务登录密码 (默认自动生成随机密码)')
            .option('--trust-proxy', '信任 TLS 反向代理的 X-Forwarded-Proto，并设置 Secure Cookie');
    }

    if (includeWebAuthOptions) {
        command
            .option('-U, --user <username>', '网页服务登录用户名 (默认 admin)')
            .option('-P, --pass <password>', '网页服务登录密码 (默认自动生成随机密码)')
            .option('--trust-proxy', '信任 TLS 反向代理的 X-Forwarded-Proto，并设置 Secure Cookie');
    }

    return command;
}

async function setupCommander() {
    // Load config file
    const configResult = readManyoyoConfig();
    let config = loadConfig(configResult);

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

    registerCoreCommands(program, {
        manyoyoName: MANYOYO_NAME,
        imageVersionHelpExample: IMAGE_VERSION_HELP_EXAMPLE,
        applyRunStyleOptions,
        appendArrayOption,
        enableShellSuffixPassThrough,
        validateShellSuffixPassThroughArgs,
        selectAction
    });

    const playwrightCommand = program.command('playwright').description('管理 playwright 插件服务（推荐）');
    registerPlaywrightAliasCommands(playwrightCommand, { appendArrayOption, selectPluginAction });

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
    registerPlaywrightAliasCommands(pluginPlaywrightCommand, { appendArrayOption, selectPluginAction });

    registerConfigCommands(program, {
        applyRunStyleOptions,
        enableShellSuffixPassThrough,
        validateShellSuffixPassThroughArgs,
        selectAction
    });

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

    const noDockerActions = new Set(['init', 'update', 'install', 'config-show', 'plugin', 'doctor']);
    if (isServerStopMode) {
        noDockerActions.add('serve');
    }

    const bootstrappedFirstRun = await bootstrapFirstRun({
        action: selectedAction,
        configExists: configResult.exists,
        initialize: () => initAgentConfigs('all', {
            yesMode: true,
            askQuestion,
            loadConfig,
            supportedAgents: SUPPORTED_INIT_AGENTS,
            colors: { RED, GREEN, YELLOW, CYAN, NC }
        }),
        log: message => console.log(message)
    });
    if (bootstrappedFirstRun) {
        config = loadConfig();
    }

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
    SERVER_TRUST_PROXY = Boolean(resolvedRuntime.serverTrustProxy);
    SERVER_AUTH_PASS_AUTO = Boolean(resolvedRuntime.serverPassAuto);

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
            serverTrustProxy: SERVER_TRUST_PROXY,
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
        if (options.explain) {
            finalConfig.provenance = resolvedRuntime.provenance;
        }
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
        const report = runDoctorChecks({
            runCommand: runCmd,
            configExists: fs.existsSync(getManyoyoConfigPath()),
            imageName: IMAGE_NAME,
            imageVersion: IMAGE_VERSION,
            agentCommand: EXEC_COMMAND,
            containerMode: contModeValue || 'common',
            pluginConfig: config.plugins,
            portStatus
        });
        if (options.json) {
            console.log(JSON.stringify(report, null, 4));
        } else {
            report.checks.forEach(check => {
                console.log(`[${check.status.toUpperCase()}] ${check.code}: ${check.summary}${check.action ? ` (${check.action})` : ''}`);
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
        isDoctorMode,
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
        serverTrustProxy: SERVER_TRUST_PROXY,
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

/**
 * 等待容器就绪（使用指数退避算法）
 * @param {string} containerName - 容器名称
 */
async function waitForContainerReady(containerName) {
    return waitForContainerReadyLifecycle(containerName, {
        getContainerStatus,
        sleep,
        maxRetries: CONFIG.CONTAINER_READY_MAX_RETRIES,
        initialDelay: CONFIG.CONTAINER_READY_INITIAL_DELAY,
        maxDelay: CONFIG.CONTAINER_READY_MAX_DELAY,
        onExited: name => {
            console.log(`${RED}⚠️  错误: 容器启动后立即退出。${NC}`);
            dockerExecArgs(['logs', name], { stdio: 'inherit' });
            process.exit(1);
        },
        onTimeout: () => {
            console.log(`${RED}⚠️  错误: 容器启动超时。${NC}`);
            process.exit(1);
        }
    });
}

function joinExecCommand(prefix, command, suffix) {
    return `${prefix || ''}${command || ''}${suffix || ''}`;
}

function executeFirstCommand(runtime) {
    return executeFirstCommandLifecycle(runtime, {
        joinExecCommand,
        logCommand: command => {
            console.log(`${BLUE}----------------------------------------${NC}`);
            console.log(`⚙️  首次预执行命令: ${YELLOW}${command}${NC}`);
        },
        spawnSync,
        dockerCmd: DOCKER_CMD,
        compileContainerExec,
        stdinIsTTY: Boolean(process.stdin.isTTY),
        stdoutIsTTY: Boolean(process.stdout.isTTY),
        assertProcessSucceeded
    });
}

/**
 * 创建新容器
 * @returns {Promise<string>} 默认命令
 */
async function createNewContainer(runtime) {
    return createNewContainerLifecycle(runtime, {
        joinExecCommand,
        logCreating: name => console.log(`${CYAN}📦 manyoyo by xcanwin 正在创建新容器: ${YELLOW}${name}${NC}`),
        logCommandPreview: value => console.log(buildDockerRunCmd(value)),
        exit: process.exit,
        dockerExecArgs,
        buildDockerRunArgs,
        showImagePullHint,
        waitForContainerReady,
        executeFirstCommand
    });
}

/**
 * 构建 Docker run 命令参数数组（安全方式，避免命令注入）
 * @returns {string[]} 命令参数数组
 */
function buildDockerRunArgs(runtime) {
    return compileContainerRun({
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
    return connectExistingContainerLifecycle(runtime, {
        getContainerStatus,
        getRuntimeDriver,
        joinExecCommand,
        log: containerName => console.log(`${CYAN}🔄 manyoyo by xcanwin 正在连接到现有容器: ${YELLOW}${containerName}${NC}`)
    });
}

async function setupContainer(runtime) {
    return setupContainerLifecycle(runtime, {
        containerExists,
        getRuntimeDriver,
        joinExecCommand,
        logExistingCommandPreview: (name, command) => console.log(`${DOCKER_CMD} exec -it ${name} /bin/bash -c "${command.replace(/"/g, '\\"')}"`),
        logNewCommandPreview: value => console.log(buildDockerRunCmd(value)),
        exit: process.exit,
        createNewContainer,
        connectExistingContainer
    });
}

function executeInContainer(runtime, defaultCommand) {
    return executeInContainerLifecycle(runtime, defaultCommand, {
        containerExists,
        getContainerStatus,
        getRuntimeDriver,
        showHelloTip: getHelloTip,
        logCommand: command => {
            console.log(`${BLUE}----------------------------------------${NC}`);
            console.log(`💻 执行命令: ${YELLOW}${command || '交互式 Shell'}${NC}`);
        },
        spawnSync,
        dockerCmd: DOCKER_CMD,
        compileContainerExec,
        stdinIsTTY: Boolean(process.stdin.isTTY),
        stdoutIsTTY: Boolean(process.stdout.isTTY),
        assertProcessSucceeded
    });
}

/**
 * 处理会话退出后的交互
 * @param {string} defaultCommand - 默认命令
 */
async function handlePostExit(runtime, defaultCommand) {
    return handlePostExitLifecycle(runtime, defaultCommand, {
        removeContainer,
        showHelloTip: getHelloTip,
        buildAgentResumeCommand,
        askQuestion,
        log: (action, containerName) => {
            if (action === 'first' && !runtime.quiet.full) console.log(`${GREEN}✅ 离开当前连接，用首次命令进入。${NC}`);
            if (action === 'resume' && !runtime.quiet.full) console.log(`${GREEN}✅ 离开当前连接，恢复首次命令会话。${NC}`);
            if (action === 'command' && !(runtime.quiet.cmd || runtime.quiet.full)) console.log(`${GREEN}✅ 离开当前连接，执行命令。${NC}`);
            if (action === 'shell' && !runtime.quiet.full) console.log(`${GREEN}✅ 离开当前连接，进入容器交互式SHELL。${NC}`);
            if (action === 'keep') console.log(`${GREEN}✅ 已退出连接。容器 ${containerName} 仍在后台运行。${NC}`);
        }
    });
}

async function runWebServerMode(runtime) {
    if (!runtime.serverAuthUser || !runtime.serverAuthPass) {
        ensureWebServerAuthCredentials();
        runtime.serverAuthUser = SERVER_AUTH_USER;
        runtime.serverAuthPass = SERVER_AUTH_PASS;
        runtime.serverAuthPassAuto = SERVER_AUTH_PASS_AUTO;
    }

    return startConfiguredWebServer(runtime, {
        startWebServer,
        dockerCmd: DOCKER_CMD,
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
        colors: { RED, GREEN, YELLOW, BLUE, CYAN, NC },
        writeServePidFile
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

        ensureDefaultImage({
            imageName: runtime.imageName,
            imageVersion: runtime.imageVersion,
            execute: dockerExecArgs,
            commandName: MANYOYO_NAME,
            log: message => console.log(`${CYAN}${message}${NC}`)
        });

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
