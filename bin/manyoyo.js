#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const readline = require('readline');
const { Command } = require('commander');
const JSON5 = require('json5');
const { startWebServer } = require('../lib/web/server');
const { buildContainerRunArgs, buildContainerRunCommand } = require('../lib/container-run');
const { initAgentConfigs } = require('../lib/init-config');
const { buildImage } = require('../lib/image-build');
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
let SHOULD_REMOVE = false;
let IMAGE_BUILD_NEED = false;
let IMAGE_BUILD_ARGS = [];
let CONTAINER_ENVS = [];
let CONTAINER_VOLUMES = [];
let MANYOYO_NAME = detectCommandName();
let CONT_MODE_ARGS = [];
let QUIET = {};
let SHOW_COMMAND = false;
let YES_MODE = false;
let RM_ON_EXIT = false;
let SERVER_MODE = false;
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
    const isHostName = /^[A-Za-z0-9.-]+$/.test(value);

    if (isIp || isHostName) {
        return value;
    }

    console.error(`${RED}⚠️  错误: --server 地址格式应为 端口 或 host:port (例如 3000 / 0.0.0.0:3000): ${rawServer}${NC}`);
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

    let host = '127.0.0.1';
    let portText = value;

    const ipv6Match = value.match(/^\[([^\]]+)\]:(\d+)$/);
    if (ipv6Match) {
        host = ipv6Match[1].trim();
        portText = ipv6Match[2].trim();
    } else {
        const lastColonIndex = value.lastIndexOf(':');
        if (lastColonIndex > 0) {
            const maybePort = value.slice(lastColonIndex + 1).trim();
            if (/^\d+$/.test(maybePort)) {
                host = value.slice(0, lastColonIndex).trim();
                portText = maybePort;
            }
        }
    }

    if (!/^\d+$/.test(portText)) {
        console.error(`${RED}⚠️  错误: --server 端口必须是 1-65535 的整数: ${rawServer}${NC}`);
        process.exit(1);
    }

    const port = Number(portText);
    if (port < 1 || port > 65535) {
        console.error(`${RED}⚠️  错误: --server 端口超出范围 (1-65535): ${rawServer}${NC}`);
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

/**
 * 敏感信息脱敏（用于 --show-config 输出）
 * @param {Object} obj - 配置对象
 * @returns {Object} 脱敏后的配置对象
 */
function sanitizeSensitiveData(obj) {
    const sensitiveKeys = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASS', 'AUTH', 'CREDENTIAL'];

    function sanitizeValue(key, value) {
        if (typeof value !== 'string') return value;
        const upperKey = key.toUpperCase();
        if (sensitiveKeys.some(k => upperKey.includes(k))) {
            if (value.length <= 8) return '****';
            return value.slice(0, 4) + '****' + value.slice(-4);
        }
        return value;
    }

    function sanitizeArray(arr) {
        return arr.map(item => {
            if (typeof item === 'string' && item.includes('=')) {
                const idx = item.indexOf('=');
                const key = item.slice(0, idx);
                const value = item.slice(idx + 1);
                return `${key}=${sanitizeValue(key, value)}`;
            }
            return item;
        });
    }

    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (Array.isArray(value)) {
            result[key] = sanitizeArray(value);
        } else if (typeof value === 'object' && value !== null) {
            result[key] = sanitizeSensitiveData(value);
        } else {
            result[key] = sanitizeValue(key, value);
        }
    }
    return result;
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
 * @property {string[]} [volumes] - 挂载卷数组
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
    const configPath = path.join(os.homedir(), '.manyoyo', 'manyoyo.json');
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON5.parse(fs.readFileSync(configPath, 'utf-8'));
            return config;
        } catch (e) {
            console.error(`${YELLOW}⚠️  配置文件格式错误: ${configPath}${NC}`);
            return {};
        }
    }
    return {};
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

function getHelloTip(containerName, defaultCommand) {
    if ( !(QUIET.tip || QUIET.full) ) {
        console.log("");
        console.log(`${BLUE}----------------------------------------${NC}`);
        console.log(`📦 首次命令        : ${defaultCommand}`);
        console.log(`⚫ 恢复首次命令会话: ${CYAN}${MANYOYO_NAME} -n ${containerName} -- -c${NC}`);
        console.log(`⚫ 执行首次命令    : ${GREEN}${MANYOYO_NAME} -n ${containerName}${NC}`);
        console.log(`⚫ 执行指定命令    : ${GREEN}${MANYOYO_NAME} -n ${containerName} -x /bin/bash${NC}`);
        console.log(`⚫ 执行指定命令    : ${GREEN}docker exec -it ${containerName} /bin/bash${NC}`);
        console.log(`⚫ 删除容器        : ${MANYOYO_NAME} -n ${containerName} --crm`);
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

function addEnv(env) {
    const parsed = parseEnvEntry(env);
    CONTAINER_ENVS.push("--env", `${parsed.key}=${parsed.value}`);
}

function addEnvFile(envFile) {
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
                    CONTAINER_ENVS.push("--env", `${key}=${value}`);
                }
            }
        }
        return {};
    }
    console.error(`${RED}⚠️  未找到环境文件: ${envFile}${NC}`);
    return {};
}

function addVolume(volume) {
    CONTAINER_VOLUMES.push("--volume", volume);
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
    console.log(`${YELLOW}   你可以: (1) 更新 ~/.manyoyo/manyoyo.json 的 imageVersion。 (2) 或先执行 ${MANYOYO_NAME} --ib --iv <x.y.z-后缀> 构建镜像。${NC}`);
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

function getContList() {
    try {
        const result = execSync(`${DOCKER_CMD} ps -a --size --filter "ancestor=manyoyo" --filter "ancestor=$(${DOCKER_CMD} images -a --format '{{.Repository}}:{{.Tag}}' | grep manyoyo)" --format "table {{.Names}}\\t{{.Status}}\\t{{.Size}}\\t{{.ID}}\\t{{.Image}}\\t{{.Ports}}\\t{{.Networks}}\\t{{.Mounts}}"`,
            { encoding: 'utf-8' });
        console.log(result);
    } catch (e) {
        console.log(e.stdout || '');
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

async function setupCommander() {
    // Load config file
    const config = loadConfig();

    const program = new Command();

    program
        .name(MANYOYO_NAME)
        .version(BIN_VERSION, '-V, --version', '显示版本')
        .description('MANYOYO - AI Agent CLI Sandbox\nhttps://github.com/xcanwin/manyoyo')
        .addHelpText('after', `
配置文件:
  ~/.manyoyo/manyoyo.json    全局配置文件 (JSON5格式，支持注释)
  ~/.manyoyo/run/c.json      运行配置示例

路径规则:
  -r name       → ~/.manyoyo/manyoyo.json 的 runs.name
  --ef /abs/path.env → 绝对路径环境文件
  --ss "<args>" → 显式设置命令后缀
  -- <args...>  → 直接透传命令后缀（优先级最高）

示例:
  ${MANYOYO_NAME} --ib --iv ${IMAGE_VERSION_HELP_EXAMPLE}              构建镜像
  ${MANYOYO_NAME} --init-config all                   从本机 Agent 配置初始化 ~/.manyoyo
  ${MANYOYO_NAME} -r claude                           使用 manyoyo.json 的 runs.claude 快速启动
  ${MANYOYO_NAME} -r codex --ss "resume --last"       使用命令后缀
  ${MANYOYO_NAME} -n test --ef /abs/path/myenv.env -y c  使用绝对路径环境变量文件
  ${MANYOYO_NAME} -n test -- -c                       恢复之前会话
  ${MANYOYO_NAME} -x echo 123                         指定命令执行
  ${MANYOYO_NAME} --server --server-user admin --server-pass 123456   启动带登录认证的网页服务
  ${MANYOYO_NAME} --server 3000                       启动网页交互服务
  ${MANYOYO_NAME} --server 0.0.0.0:3000               监听全部网卡，便于局域网访问
  ${MANYOYO_NAME} -n test -q tip -q cmd               多次使用静默选项
        `);

    // Options
    program
        .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
        .option('--hp, --host-path <path>', '设置宿主机工作目录 (默认当前路径)')
        .option('-n, --cont-name <name>', '设置容器名称')
        .option('--cp, --cont-path <path>', '设置容器工作目录')
        .option('-l, --cont-list', '列举容器')
        .option('--crm, --cont-remove', '删除-n指定容器')
        .option('-m, --cont-mode <mode>', '设置容器嵌套容器模式 (common, dind, sock)')
        .option('--in, --image-name <name>', '指定镜像名称')
        .option('--iv, --image-ver <version>', '指定镜像版本 (格式: x.y.z-后缀，如 1.7.4-common)')
        .option('--ib, --image-build', '构建镜像')
        .option('--iba, --image-build-arg <arg>', '构建镜像时传参给dockerfile (可多次使用)', (value, previous) => [...(previous || []), value], [])
        .option('--init-config [agents]', '初始化 Agent 配置到 ~/.manyoyo (all 或逗号分隔: claude,codex,gemini,opencode)')
        .option('--irm, --image-remove', '清理悬空镜像和 <none> 镜像')
        .option('-e, --env <env>', '设置环境变量 XXX=YYY (可多次使用)', (value, previous) => [...(previous || []), value], [])
        .option('--ef, --env-file <file>', '设置环境变量通过文件 (仅支持绝对路径，如 /abs/path.env)', (value, previous) => [...(previous || []), value], [])
        .option('-v, --volume <volume>', '绑定挂载卷 XXX:YYY (可多次使用)', (value, previous) => [...(previous || []), value], [])
        .option('--sp, --shell-prefix <command>', '临时环境变量 (作为-s前缀)')
        .option('-s, --shell <command>', '指定命令执行')
        .option('--ss, --shell-suffix <command>', '指定命令后缀 (追加到-s之后，等价于 -- <args>)')
        .option('-x, --shell-full <command...>', '指定完整命令执行 (代替--sp和-s和--命令)')
        .option('-y, --yolo <cli>', '使AGENT无需确认 (claude/c, gemini/gm, codex/cx, opencode/oc)')
        .option('--install <name>', `安装${MANYOYO_NAME}命令 (docker-cli-plugin)`)
        .option('--show-config', '显示最终生效配置并退出')
        .option('--show-command', '显示将执行的 docker run 命令并退出')
        .option('--server [port]', '启动网页交互服务 (默认 127.0.0.1:3000，支持 host:port)')
        .option('--server-user <username>', '网页服务登录用户名 (默认 admin)')
        .option('--server-pass <password>', '网页服务登录密码 (默认自动生成随机密码)')
        .option('--yes', '所有提示自动确认 (用于CI/脚本)')
        .option('--rm-on-exit', '退出后自动删除容器 (一次性模式)')
        .option('-q, --quiet <item>', '静默显示 (可多次使用: cnew,crm,tip,cmd,full)', (value, previous) => [...(previous || []), value], []);

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

    const isInitConfigMode = process.argv.some(arg => arg === '--init-config' || arg.startsWith('--init-config='));
    // init-config 只处理本地文件，不依赖 docker/podman
    if (!isInitConfigMode) {
        // Ensure docker/podman is available
        ensureDocker();
    }

    // Pre-handle -x/--shell-full: treat all following args as a single command
    normalizeShellFullArgv(process.argv);

    // Parse arguments
    program.allowUnknownOption(false);
    program.parse(process.argv);

    const options = program.opts();

    if (options.yes) {
        YES_MODE = true;
    }

    if (options.initConfig !== undefined) {
        await initAgentConfigs(options.initConfig, {
            yesMode: YES_MODE,
            askQuestion,
            loadConfig,
            supportedAgents: SUPPORTED_INIT_AGENTS,
            colors: { RED, GREEN, YELLOW, CYAN, NC }
        });
        process.exit(0);
    }

    // Load run config if specified
    const runConfig = options.run ? loadRunConfig(options.run, config) : {};

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

    const volumeList = mergeArrayConfig(config.volumes, runConfig.volumes, options.volume);
    volumeList.forEach(v => addVolume(v));

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

    if (options.server !== undefined) {
        SERVER_MODE = true;
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

    if (SERVER_MODE) {
        ensureWebServerAuthCredentials();
    }

    if (options.showConfig) {
        const finalConfig = {
            hostPath: HOST_PATH,
            containerName: CONTAINER_NAME,
            containerPath: CONTAINER_PATH,
            imageName: IMAGE_NAME,
            imageVersion: IMAGE_VERSION,
            envFile: envFileList,
            env: envMap,
            volumes: volumeList,
            imageBuildArgs: buildArgList,
            containerMode: contModeValue || "",
            shellPrefix: EXEC_COMMAND_PREFIX.trim(),
            shell: EXEC_COMMAND || "",
            shellSuffix: EXEC_COMMAND_SUFFIX || "",
            yolo: yoloValue || "",
            quiet: quietValue || [],
            server: SERVER_MODE,
            serverHost: SERVER_MODE ? SERVER_HOST : null,
            serverPort: SERVER_MODE ? SERVER_PORT : null,
            serverUser: SERVER_AUTH_USER || "",
            serverPass: SERVER_AUTH_PASS || "",
            exec: {
                prefix: EXEC_COMMAND_PREFIX,
                shell: EXEC_COMMAND,
                suffix: EXEC_COMMAND_SUFFIX
            }
        };
        // 敏感信息脱敏
        const sanitizedConfig = sanitizeSensitiveData(finalConfig);
        console.log(JSON.stringify(sanitizedConfig, null, 4));
        process.exit(0);
    }

    if (options.showCommand) {
        SHOW_COMMAND = true;
    }

    if (options.contList) { getContList(); process.exit(0); }
    if (options.contRemove) SHOULD_REMOVE = true;
    if (options.imageBuild) IMAGE_BUILD_NEED = true;
    if (options.imageRemove) { pruneDanglingImages(); process.exit(0); }
    if (options.install) { installManyoyo(options.install); process.exit(0); }

    return program;
}

function createRuntimeContext() {
    return {
        containerName: CONTAINER_NAME,
        hostPath: HOST_PATH,
        containerPath: CONTAINER_PATH,
        imageName: IMAGE_NAME,
        imageVersion: IMAGE_VERSION,
        execCommand: EXEC_COMMAND,
        execCommandPrefix: EXEC_COMMAND_PREFIX,
        execCommandSuffix: EXEC_COMMAND_SUFFIX,
        contModeArgs: CONT_MODE_ARGS,
        containerEnvs: CONTAINER_ENVS,
        containerVolumes: CONTAINER_VOLUMES,
        quiet: QUIET,
        showCommand: SHOW_COMMAND,
        rmOnExit: RM_ON_EXIT,
        serverMode: SERVER_MODE,
        serverHost: SERVER_HOST,
        serverPort: SERVER_PORT,
        serverAuthUser: SERVER_AUTH_USER,
        serverAuthPass: SERVER_AUTH_PASS,
        serverAuthPassAuto: SERVER_AUTH_PASS_AUTO
    };
}

function handleRemoveContainer(runtime) {
    if (!SHOULD_REMOVE) {
        return false;
    }

    try {
        if (containerExists(runtime.containerName)) {
            removeContainer(runtime.containerName);
        } else {
            console.log(`${RED}⚠️  错误: 未找到名为 ${runtime.containerName} 的容器。${NC}`);
        }
    } catch (e) {
        console.log(`${RED}⚠️  错误: 未找到名为 ${runtime.containerName} 的容器。${NC}`);
    }
    return true;
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
        containerEnvs: runtime.containerEnvs,
        containerVolumes: runtime.containerVolumes,
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

    getHelloTip(runtime.containerName, defaultCommand);
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

    getHelloTip(runtime.containerName, defaultCommand);

    let tipAskKeep = `❔ 会话已结束。是否保留此后台容器 ${runtime.containerName}? [ y=默认保留, n=删除, 1=首次命令进入, x=执行命令, i=交互式SHELL ]: `;
    if (runtime.quiet.askkeep || runtime.quiet.full) tipAskKeep = `保留容器吗? [y n 1 x i] `;
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
        containerEnvs: runtime.containerEnvs,
        containerVolumes: runtime.containerVolumes,
        validateHostPath: () => validateHostPath(runtime),
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
        }
    });
}

async function main() {
    try {
        // 1. Setup commander and parse arguments
        await setupCommander();
        const runtime = createRuntimeContext();

        // 2. Start web server mode
        if (runtime.serverMode) {
            await runWebServerMode(runtime);
            return;
        }

        // 3. Handle image build operation
        if (IMAGE_BUILD_NEED) {
            await buildImage({
                imageBuildArgs: IMAGE_BUILD_ARGS,
                imageName: runtime.imageName,
                imageVersionTag: runtime.imageVersion,
                imageVersionDefault: IMAGE_VERSION_DEFAULT,
                imageVersionBase: IMAGE_VERSION_BASE,
                parseImageVersionTag,
                manyoyoName: MANYOYO_NAME,
                yesMode: YES_MODE,
                dockerCmd: DOCKER_CMD,
                rootDir: path.join(__dirname, '..'),
                loadConfig,
                runCmd,
                askQuestion,
                pruneDanglingImages,
                colors: { RED, GREEN, YELLOW, BLUE, CYAN, NC }
            });
            process.exit(0);
        }

        // 4. Handle remove container operation
        if (handleRemoveContainer(runtime)) {
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
