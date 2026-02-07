#!/usr/bin/env node

// ==============================================================================
// manyoyo - AI Agent CLI Sandbox - xcanwin
// ==============================================================================

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const http = require('http');
const { Command } = require('commander');
const JSON5 = require('json5');
const { version: BIN_VERSION, imageVersion: IMAGE_VERSION_BASE } = require('../package.json');

// Helper function to format date like bash $(date +%m%d-%H%M)
function formatDate() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    return `${month}${day}-${hour}${minute}`;
}

// ==============================================================================
// Configuration Constants
// ==============================================================================

const CONFIG = {
    CACHE_TTL_DAYS: 2,                    // 缓存过期天数
    CONTAINER_READY_MAX_RETRIES: 30,      // 容器就绪最大重试次数
    CONTAINER_READY_INITIAL_DELAY: 100,   // 容器就绪初始延迟(ms)
    CONTAINER_READY_MAX_DELAY: 2000,      // 容器就绪最大延迟(ms)
};

// Default configuration
let CONTAINER_NAME = `myy-${formatDate()}`;
let HOST_PATH = process.cwd();
let CONTAINER_PATH = HOST_PATH;
let IMAGE_NAME = "localhost/xcanwin/manyoyo";
let IMAGE_VERSION = `${IMAGE_VERSION_BASE}-full`;
let EXEC_COMMAND = "";
let EXEC_COMMAND_PREFIX = "";
let EXEC_COMMAND_SUFFIX = "";
let ENV_FILE = "";
let SHOULD_REMOVE = false;
let IMAGE_BUILD_NEED = false;
let IMAGE_BUILD_ARGS = [];
let CONTAINER_ENVS = [];
let CONTAINER_VOLUMES = [];
let MANYOYO_NAME = "manyoyo";
let CONT_MODE = "";
let CONT_MODE_ARGS = [];
let QUIET = {};
let SHOW_COMMAND = false;
let YES_MODE = false;
let RM_ON_EXIT = false;
let SERVER_MODE = false;
let SERVER_PORT = 3000;
const SAFE_CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// Color definitions using ANSI codes
const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const CYAN = '\x1b[0;36m';
const NC = '\x1b[0m'; // No Color

// Docker command (will be set by ensure_docker)
let DOCKER_CMD = 'docker';

// ==============================================================================
// SECTION: Utility Functions
// ==============================================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeCommandSuffix(suffix) {
    if (typeof suffix !== 'string') return "";
    const trimmed = suffix.trim();
    return trimmed ? ` ${trimmed}` : "";
}

function parseServerPort(rawPort) {
    if (rawPort === true || rawPort === undefined || rawPort === null || rawPort === '') {
        return 3000;
    }

    const value = String(rawPort).trim();
    if (!/^\d+$/.test(value)) {
        console.error(`${RED}⚠️  错误: --server 端口必须是 1-65535 的整数: ${rawPort}${NC}`);
        process.exit(1);
    }

    const port = Number(value);
    if (port < 1 || port > 65535) {
        console.error(`${RED}⚠️  错误: --server 端口超出范围 (1-65535): ${rawPort}${NC}`);
        process.exit(1);
    }

    return port;
}

/**
 * 计算文件的 SHA256 哈希值（跨平台）
 * @param {string} filePath - 文件路径
 * @returns {string} SHA256 哈希值（十六进制）
 */
function getFileSha256(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
}

/**
 * 敏感信息脱敏（用于 --show-config 输出）
 * @param {Object} obj - 配置对象
 * @returns {Object} 脱敏后的配置对象
 */
function sanitizeSensitiveData(obj) {
    const sensitiveKeys = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'AUTH', 'CREDENTIAL'];

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

// ==============================================================================
// SECTION: Configuration Management
// ==============================================================================

/**
 * @typedef {Object} Config
 * @property {string} [containerName] - 容器名称
 * @property {string} [hostPath] - 宿主机路径
 * @property {string} [containerPath] - 容器路径
 * @property {string} [imageName] - 镜像名称
 * @property {string} [imageVersion] - 镜像版本
 * @property {string[]} [env] - 环境变量数组
 * @property {string[]} [envFile] - 环境文件数组
 * @property {string[]} [volumes] - 挂载卷数组
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

function loadRunConfig(name) {
    // Check if name is a file path (contains path separator or extension)
    const isFilePath = name.includes('/') || name.includes('\\') || path.extname(name);

    if (isFilePath) {
        // If it's a file path, only check that exact path
        if (fs.existsSync(name)) {
            try {
                const config = JSON5.parse(fs.readFileSync(name, 'utf-8'));
                return config;
            } catch (e) {
                console.error(`${YELLOW}⚠️  运行配置文件格式错误: ${name}${NC}`);
                return {};
            }
        }
    } else {
        // If it's just a name, only check ~/.manyoyo/run/name.json
        const configPath = path.join(os.homedir(), '.manyoyo', 'run', `${name}.json`);
        if (fs.existsSync(configPath)) {
            try {
                const config = JSON5.parse(fs.readFileSync(configPath, 'utf-8'));
                return config;
            } catch (e) {
                console.error(`${YELLOW}⚠️  运行配置文件格式错误: ${configPath}${NC}`);
                return {};
            }
        }
    }

    console.error(`${RED}⚠️  未找到运行配置: ${name}${NC}`);
    return {};
}

// ==============================================================================
// SECTION: UI Functions
// ==============================================================================

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

function isValidContainerName(value) {
    return typeof value === 'string' && SAFE_CONTAINER_NAME_PATTERN.test(value);
}

// ==============================================================================
// SECTION: Environment Variables and Volume Handling
// ==============================================================================

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

// ==============================================================================
// Configuration Functions
// ==============================================================================

/**
 * 添加环境变量
 * @param {string} env - 环境变量字符串 (KEY=VALUE)
 */
function addEnv(env) {
    const idx = env.indexOf('=');
    if (idx <= 0) {
        console.error(`${RED}⚠️  错误: env 格式应为 KEY=VALUE: ${env}${NC}`);
        process.exit(1);
    }
    const key = env.slice(0, idx);
    const value = env.slice(idx + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        console.error(`${RED}⚠️  错误: env key 非法: ${key}${NC}`);
        process.exit(1);
    }
    if (/[\r\n\0]/.test(value) || /[;&|`$<>]/.test(value)) {
        console.error(`${RED}⚠️  错误: env value 含非法字符: ${key}${NC}`);
        process.exit(1);
    }
    CONTAINER_ENVS.push("--env", env);
}

function addEnvFile(envFile) {
    // Check if envFile is a file path (contains path separator)
    const isFilePath = envFile.includes('/') || envFile.includes('\\');

    let filePath;
    if (isFilePath) {
        // If it's a file path, only check that exact path
        filePath = envFile;
    } else {
        // If it's just a name, only check ~/.manyoyo/env/name.env
        filePath = path.join(os.homedir(), '.manyoyo', 'env', `${envFile}.env`);
    }

    ENV_FILE = filePath;
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

// ==============================================================================
// SECTION: YOLO Mode and Container Mode Configuration
// ==============================================================================

function setYolo(cli) {
    switch (cli) {
        case 'claude':
        case 'cc':
        case 'c':
            EXEC_COMMAND = "IS_SANDBOX=1 claude --dangerously-skip-permissions";
            break;
        case 'gemini':
        case 'gm':
        case 'g':
            EXEC_COMMAND = "gemini --yolo";
            break;
        case 'codex':
        case 'cx':
            EXEC_COMMAND = "codex --dangerously-bypass-approvals-and-sandbox";
            break;
        case 'opencode':
        case 'oc':
            EXEC_COMMAND = "OPENCODE_PERMISSION='{\"*\":\"allow\"}' opencode";
            break;
        default:
            console.log(`${RED}⚠️  未知LLM CLI: ${cli}${NC}`);
            process.exit(0);
    }
}

/**
 * 设置容器嵌套模式
 * @param {string} mode - 模式名称 (common, dind, sock)
 */
function setContMode(mode) {
    switch (mode) {
        case 'common':
            CONT_MODE = "";
            CONT_MODE_ARGS = [];
            break;
        case 'docker-in-docker':
        case 'dind':
        case 'd':
            CONT_MODE = "--privileged";
            CONT_MODE_ARGS = ['--privileged'];
            console.log(`${GREEN}✅ 开启安全的容器嵌套容器模式, 手动在容器内启动服务: nohup dockerd &${NC}`);
            break;
        case 'mount-docker-socket':
        case 'sock':
        case 's':
            CONT_MODE = "--privileged --volume /var/run/docker.sock:/var/run/docker.sock --env DOCKER_HOST=unix:///var/run/docker.sock --env CONTAINER_HOST=unix:///var/run/docker.sock";
            CONT_MODE_ARGS = [
                '--privileged',
                '--volume', '/var/run/docker.sock:/var/run/docker.sock',
                '--env', 'DOCKER_HOST=unix:///var/run/docker.sock',
                '--env', 'CONTAINER_HOST=unix:///var/run/docker.sock'
            ];
            console.log(`${RED}⚠️  开启危险的容器嵌套容器模式, 危害: 容器可访问宿主机文件${NC}`);
            break;
        default:
            console.log(`${RED}⚠️  未知模式: ${mode}${NC}`);
            process.exit(0);
    }
}

// ==============================================================================
// Docker Helper Functions
// ==============================================================================

function dockerExec(cmd, options = {}) {
    try {
        return execSync(cmd, { encoding: 'utf-8', ...options });
    } catch (e) {
        if (options.ignoreError) {
            return e.stdout || '';
        }
        throw e;
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
    console.log(`${YELLOW}   你可以: 1) 更新 ~/.manyoyo/manyoyo.json 的 imageVersion 2) 或先执行 manyoyo --ib --iv <version> 构建镜像。${NC}`);
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

// ==============================================================================
// SECTION: Docker Operations
// ==============================================================================

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

// ==============================================================================
// SECTION: Image Build System
// ==============================================================================

/**
 * 准备构建缓存（Node.js、JDT LSP、gopls）
 * @param {string} imageTool - 构建工具类型
 */
async function prepareBuildCache(imageTool) {
    const cacheDir = path.join(__dirname, '../docker/cache');
    const timestampFile = path.join(cacheDir, '.timestamps.json');

    // 从配置文件读取 TTL，默认 2 天
    const config = loadConfig();
    const cacheTTLDays = config.cacheTTL || CONFIG.CACHE_TTL_DAYS;

    // 镜像源优先级：用户配置 > 腾讯云 > 官方
    const nodeMirrors = [
        config.nodeMirror,
        'https://mirrors.tencent.com/nodejs-release',
        'https://nodejs.org/dist'
    ].filter(Boolean);

    console.log(`\n${CYAN}准备构建缓存...${NC}`);

    // Create cache directory
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Load timestamps
    let timestamps = {};
    if (fs.existsSync(timestampFile)) {
        try {
            timestamps = JSON.parse(fs.readFileSync(timestampFile, 'utf-8'));
        } catch (e) {
            timestamps = {};
        }
    }

    const now = new Date();
    const isExpired = (key) => {
        if (!timestamps[key]) return true;
        const cachedTime = new Date(timestamps[key]);
        const diffDays = (now - cachedTime) / (1000 * 60 * 60 * 24);
        return diffDays > cacheTTLDays;
    };

    // Determine architecture
    const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
    const archNode = arch === 'amd64' ? 'x64' : 'arm64';

    // Prepare Node.js cache
    const nodeCacheDir = path.join(cacheDir, 'node');
    const nodeVersion = 24;
    const nodeKey = 'node/';  // 使用目录级别的相对路径

    if (!fs.existsSync(nodeCacheDir)) {
        fs.mkdirSync(nodeCacheDir, { recursive: true });
    }

    const hasNodeCache = fs.existsSync(nodeCacheDir) && fs.readdirSync(nodeCacheDir).some(f => f.startsWith('node-') && f.includes(`linux-${archNode}`));
    if (!hasNodeCache || isExpired(nodeKey)) {
        console.log(`${YELLOW}下载 Node.js ${nodeVersion} (${archNode})...${NC}`);

        // 尝试多个镜像源
        let downloadSuccess = false;
        for (const mirror of nodeMirrors) {
            try {
                console.log(`${BLUE}尝试镜像源: ${mirror}${NC}`);
                const shasumUrl = `${mirror}/latest-v${nodeVersion}.x/SHASUMS256.txt`;
                const shasumContent = execSync(`curl -sL ${shasumUrl}`, { encoding: 'utf-8' });
                const shasumLine = shasumContent.split('\n').find(line => line.includes(`linux-${archNode}.tar.gz`));
                if (!shasumLine) continue;

                const [expectedHash, fileName] = shasumLine.trim().split(/\s+/);
                const nodeUrl = `${mirror}/latest-v${nodeVersion}.x/${fileName}`;
                const nodeTargetPath = path.join(nodeCacheDir, fileName);

                // 下载文件
                runCmd('curl', ['-fsSL', nodeUrl, '-o', nodeTargetPath], { stdio: 'inherit' });

                // SHA256 校验（使用 Node.js crypto 模块，跨平台）
                const actualHash = getFileSha256(nodeTargetPath);
                if (actualHash !== expectedHash) {
                    console.log(`${RED}SHA256 校验失败，删除文件${NC}`);
                    fs.unlinkSync(nodeTargetPath);
                    continue;
                }

                console.log(`${GREEN}✓ SHA256 校验通过${NC}`);
                timestamps[nodeKey] = now.toISOString();
                fs.writeFileSync(timestampFile, JSON.stringify(timestamps, null, 4));
                console.log(`${GREEN}✓ Node.js 下载完成${NC}`);
                downloadSuccess = true;
                break;
            } catch (e) {
                console.log(`${YELLOW}镜像源 ${mirror} 失败，尝试下一个...${NC}`);
            }
        }

        if (!downloadSuccess) {
            console.error(`${RED}错误: Node.js 下载失败（所有镜像源均不可用）${NC}`);
            throw new Error('Node.js download failed');
        }
    } else {
        console.log(`${GREEN}✓ Node.js 缓存已存在${NC}`);
    }

    // Prepare JDT LSP cache (for java variant)
    if (imageTool === 'full' || imageTool.includes('java')) {
        const jdtlsCacheDir = path.join(cacheDir, 'jdtls');
        const jdtlsKey = 'jdtls/jdt-language-server-latest.tar.gz';  // 使用相对路径
        const jdtlsPath = path.join(cacheDir, jdtlsKey);

        if (!fs.existsSync(jdtlsCacheDir)) {
            fs.mkdirSync(jdtlsCacheDir, { recursive: true });
        }

        if (!fs.existsSync(jdtlsPath) || isExpired(jdtlsKey)) {
            console.log(`${YELLOW}下载 JDT Language Server...${NC}`);
            const apkUrl = 'https://mirrors.tencent.com/alpine/latest-stable/community/x86_64/jdtls-1.53.0-r0.apk';
            const tmpDir = path.join(jdtlsCacheDir, '.tmp-apk');
            const apkPath = path.join(tmpDir, 'jdtls.apk');
            try {
                fs.mkdirSync(tmpDir, { recursive: true });
                runCmd('curl', ['-fsSL', apkUrl, '-o', apkPath], { stdio: 'inherit' });
                runCmd('tar', ['-xzf', apkPath, '-C', tmpDir], { stdio: 'inherit' });
                const srcDir = path.join(tmpDir, 'usr', 'share', 'jdtls');
                runCmd('tar', ['-czf', jdtlsPath, '-C', srcDir, '.'], { stdio: 'inherit' });
                timestamps[jdtlsKey] = now.toISOString();
                fs.writeFileSync(timestampFile, JSON.stringify(timestamps, null, 4));
                console.log(`${GREEN}✓ JDT LSP 下载完成${NC}`);
            } catch (e) {
                console.error(`${RED}错误: JDT LSP 下载失败${NC}`);
                throw e;
            } finally {
                try { runCmd('rm', ['-rf', tmpDir], { stdio: 'inherit', ignoreError: true }); } catch {}
            }
        } else {
            console.log(`${GREEN}✓ JDT LSP 缓存已存在${NC}`);
        }
    }

    // Prepare gopls cache (for go variant)
    if (imageTool === 'full' || imageTool.includes('go')) {
        const goplsCacheDir = path.join(cacheDir, 'gopls');
        const goplsKey = `gopls/gopls-linux-${arch}`;  // 使用相对路径
        const goplsPath = path.join(cacheDir, goplsKey);

        if (!fs.existsSync(goplsCacheDir)) {
            fs.mkdirSync(goplsCacheDir, { recursive: true });
        }

        if (!fs.existsSync(goplsPath) || isExpired(goplsKey)) {
            console.log(`${YELLOW}下载 gopls (${arch})...${NC}`);
            try {
                // Download using go install in temporary environment
                const tmpGoPath = path.join(cacheDir, '.tmp-go');

                // Clean up existing temp directory (with go clean for mod cache)
                if (fs.existsSync(tmpGoPath)) {
                    try {
                        execSync(`GOPATH="${tmpGoPath}" go clean -modcache 2>/dev/null || true`, { stdio: 'inherit' });
                        execSync(`chmod -R u+w "${tmpGoPath}" 2>/dev/null || true`, { stdio: 'inherit' });
                        execSync(`rm -rf "${tmpGoPath}"`, { stdio: 'inherit' });
                    } catch (e) {
                        // Ignore cleanup errors
                    }
                }
                fs.mkdirSync(tmpGoPath, { recursive: true });

                runCmd('go', ['install', 'golang.org/x/tools/gopls@latest'], {
                    stdio: 'inherit',
                    env: { ...process.env, GOPATH: tmpGoPath, GOOS: 'linux', GOARCH: arch }
                });
                execSync(`cp "${tmpGoPath}/bin/linux_${arch}/gopls" "${goplsPath}" || cp "${tmpGoPath}/bin/gopls" "${goplsPath}"`, { stdio: 'inherit' });
                runCmd('chmod', ['+x', goplsPath], { stdio: 'inherit' });

                // Save timestamp immediately after successful download
                timestamps[goplsKey] = now.toISOString();
                fs.writeFileSync(timestampFile, JSON.stringify(timestamps, null, 4));
                console.log(`${GREEN}✓ gopls 下载完成${NC}`);

                // Clean up temp directory (with go clean for mod cache)
                try {
                    execSync(`GOPATH="${tmpGoPath}" go clean -modcache 2>/dev/null || true`, { stdio: 'inherit' });
                    execSync(`chmod -R u+w "${tmpGoPath}" 2>/dev/null || true`, { stdio: 'inherit' });
                    execSync(`rm -rf "${tmpGoPath}"`, { stdio: 'inherit' });
                } catch (e) {
                    console.log(`${YELLOW}提示: 临时目录清理失败，可手动删除 ${tmpGoPath}${NC}`);
                }
            } catch (e) {
                console.error(`${RED}错误: gopls 下载失败${NC}`);
                throw e;
            }
        } else {
            console.log(`${GREEN}✓ gopls 缓存已存在${NC}`);
        }
    }

    // Save timestamps
    fs.writeFileSync(timestampFile, JSON.stringify(timestamps, null, 4));
    console.log(`${GREEN}✅ 构建缓存准备完成${NC}\n`);
}

function addImageBuildArg(string) {
    IMAGE_BUILD_ARGS.push("--build-arg", string);
}

async function buildImage(IMAGE_BUILD_ARGS, imageName, imageVersion) {
    let imageTool = "full";
    if (IMAGE_BUILD_ARGS.length === 0) {
        IMAGE_BUILD_ARGS = ["--build-arg", `TOOL=${imageTool}`];
    } else {
        imageTool = IMAGE_BUILD_ARGS.filter(v => v.startsWith("TOOL=")).at(-1)?.slice("TOOL=".length) ?? imageTool;
    }
    // Use package.json imageVersion if not specified
    const version = imageVersion || IMAGE_VERSION_BASE;
    const fullImageTag = `${imageName}:${version}-${imageTool}`;

    console.log(`${CYAN}🔨 正在构建镜像: ${YELLOW}${fullImageTag}${NC}`);
    console.log(`${BLUE}构建组件类型: ${imageTool}${NC}\n`);

    // Prepare cache (自动检测并下载缺失的文件)
    await prepareBuildCache(imageTool);

    // Find Dockerfile path
    const dockerfilePath = path.join(__dirname, '../docker/manyoyo.Dockerfile');
    if (!fs.existsSync(dockerfilePath)) {
        console.error(`${RED}错误: 找不到 Dockerfile: ${dockerfilePath}${NC}`);
        process.exit(1);
    }

    // Build command
    const imageBuildArgs = IMAGE_BUILD_ARGS.join(' ');
    const buildCmd = `${DOCKER_CMD} build -t "${fullImageTag}" -f "${dockerfilePath}" "${path.join(__dirname, '..')}" ${imageBuildArgs} --load --progress=plain --no-cache`;

    console.log(`${BLUE}准备执行命令:${NC}`);
    console.log(`${buildCmd}\n`);

    if (!YES_MODE) {
        await askQuestion(`❔ 是否继续构建? [ 直接回车=继续, ctrl+c=取消 ]: `);
        console.log("");
    }

    try {
        execSync(buildCmd, { stdio: 'inherit' });
        console.log(`\n${GREEN}✅ 镜像构建成功: ${fullImageTag}${NC}`);
        console.log(`${BLUE}使用镜像:${NC}`);
        console.log(`  manyoyo -n test --in ${imageName} --iv ${version}-${imageTool} -y c`);

        // Prune dangling images
        pruneDanglingImages();
    } catch (e) {
        console.error(`${RED}错误: 镜像构建失败${NC}`);
        process.exit(1);
    }
}

// ==============================================================================
// SECTION: Command Line Interface
// ==============================================================================

function setupCommander() {
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
  -r name       → ~/.manyoyo/run/name.json
  -r ./file.json → 当前目录的 file.json
  --ef name     → ~/.manyoyo/env/name.env
  --ef ./file.env → 当前目录的 file.env
  --ss "<args>" → 显式设置命令后缀
  -- <args...>  → 直接透传命令后缀（优先级最高）

示例:
  ${MANYOYO_NAME} --ib --iv ${IMAGE_VERSION_BASE || "1.0.0"}                     构建镜像
  ${MANYOYO_NAME} -r c                                使用 ~/.manyoyo/run/c.json 配置
  ${MANYOYO_NAME} -r codex --ss "resume --last"       使用命令后缀
  ${MANYOYO_NAME} -r ./myconfig.json                  使用当前目录 ./myconfig.json 配置
  ${MANYOYO_NAME} -n test --ef claude -y c            使用 ~/.manyoyo/env/claude.env 环境变量文件
  ${MANYOYO_NAME} -n test --ef ./myenv.env -y c       使用当前目录 ./myenv.env 环境变量文件
  ${MANYOYO_NAME} -n test -- -c                       恢复之前会话
  ${MANYOYO_NAME} -x echo 123                         指定命令执行
  ${MANYOYO_NAME} --server 3000                       启动网页交互服务
  ${MANYOYO_NAME} -n test -q tip -q cmd               多次使用静默选项
        `);

    // Options
    program
        .option('-r, --run <name>', '加载运行配置 (name → ~/.manyoyo/run/name.json, ./file.json → 当前目录文件)')
        .option('--hp, --host-path <path>', '设置宿主机工作目录 (默认当前路径)')
        .option('-n, --cont-name <name>', '设置容器名称')
        .option('--cp, --cont-path <path>', '设置容器工作目录')
        .option('-l, --cont-list', '列举容器')
        .option('--crm, --cont-remove', '删除-n指定容器')
        .option('-m, --cont-mode <mode>', '设置容器嵌套容器模式 (common, dind, sock)')
        .option('--in, --image-name <name>', '指定镜像名称')
        .option('--iv, --image-ver <version>', '指定镜像版本')
        .option('--ib, --image-build', '构建镜像')
        .option('--iba, --image-build-arg <arg>', '构建镜像时传参给dockerfile (可多次使用)', (value, previous) => [...(previous || []), value], [])
        .option('--irm, --image-remove', '清理悬空镜像和 <none> 镜像')
        .option('-e, --env <env>', '设置环境变量 XXX=YYY (可多次使用)', (value, previous) => [...(previous || []), value], [])
        .option('--ef, --env-file <file>', '设置环境变量通过文件 (name → ~/.manyoyo/env/name.env, ./file.env → 当前目录文件)', (value, previous) => [...(previous || []), value], [])
        .option('-v, --volume <volume>', '绑定挂载卷 XXX:YYY (可多次使用)', (value, previous) => [...(previous || []), value], [])
        .option('--sp, --shell-prefix <command>', '临时环境变量 (作为-s前缀)')
        .option('-s, --shell <command>', '指定命令执行')
        .option('--ss, --shell-suffix <command>', '指定命令后缀 (追加到-s之后，等价于 -- <args>)')
        .option('-x, --shell-full <command...>', '指定完整命令执行 (代替--sp和-s和--命令)')
        .option('-y, --yolo <cli>', '使AGENT无需确认 (claude/c, gemini/gm, codex/cx, opencode/oc)')
        .option('--install <name>', '安装manyoyo命令 (docker-cli-plugin)')
        .option('--show-config', '显示最终生效配置并退出')
        .option('--show-command', '显示将执行的 docker run 命令并退出')
        .option('--server [port]', '启动网页交互服务 (默认端口: 3000)')
        .option('--yes', '所有提示自动确认 (用于CI/脚本)')
        .option('--rm-on-exit', '退出后自动删除容器 (一次性模式)')
        .option('-q, --quiet <item>', '静默显示 (可多次使用: cnew,crm,tip,cmd,full)', (value, previous) => [...(previous || []), value], []);

    // Docker CLI plugin metadata check
    if (process.argv[2] === 'docker-cli-plugin-metadata') {
        console.log(JSON.stringify({
            "SchemaVersion": "0.1.0",
            "Vendor": "xcanwin",
            "Version": "v1.0.0",
            "Description": "AI Agent CLI Sandbox"
        }, null, 4));
        process.exit(0);
    }

    // Docker CLI plugin mode - remove first arg if running as plugin
    const dockerPluginPath = path.join(process.env.HOME || '', '.docker/cli-plugins/docker-manyoyo');
    if (process.argv[1] === dockerPluginPath && process.argv[2] === 'manyoyo') {
        process.argv.splice(2, 1);
    }

    // No args: show help instead of starting container
    if (process.argv.length <= 2) {
        program.help();
    }

    // Ensure docker/podman is available
    ensureDocker();

    // Pre-handle -x/--shell-full: treat all following args as a single command
    const shellFullIndex = process.argv.findIndex(arg => arg === '-x' || arg === '--shell-full');
    if (shellFullIndex !== -1 && shellFullIndex < process.argv.length - 1) {
        const shellFullArgs = process.argv.slice(shellFullIndex + 1).join(' ');
        process.argv.splice(shellFullIndex + 1, process.argv.length - (shellFullIndex + 1), shellFullArgs);
    }

    // Parse arguments
    program.allowUnknownOption(false);
    program.parse(process.argv);

    const options = program.opts();

    // Load run config if specified
    const runConfig = options.run ? loadRunConfig(options.run) : {};

    // Merge configs: command line > run config > global config > defaults
    // Override mode (scalar values): use first defined value
    HOST_PATH = options.hostPath || runConfig.hostPath || config.hostPath || HOST_PATH;
    if (options.contName || runConfig.containerName || config.containerName) {
        CONTAINER_NAME = options.contName || runConfig.containerName || config.containerName;
    }
    if (options.contPath || runConfig.containerPath || config.containerPath) {
        CONTAINER_PATH = options.contPath || runConfig.containerPath || config.containerPath;
    }
    IMAGE_NAME = options.imageName || runConfig.imageName || config.imageName || IMAGE_NAME;
    if (options.imageVer || runConfig.imageVersion || config.imageVersion) {
        IMAGE_VERSION = options.imageVer || runConfig.imageVersion || config.imageVersion;
    }
    if (options.shellPrefix || runConfig.shellPrefix || config.shellPrefix) {
        EXEC_COMMAND_PREFIX = (options.shellPrefix || runConfig.shellPrefix || config.shellPrefix) + " ";
    }
    if (options.shell || runConfig.shell || config.shell) {
        EXEC_COMMAND = options.shell || runConfig.shell || config.shell;
    }
    if (options.shellSuffix || runConfig.shellSuffix || config.shellSuffix) {
        EXEC_COMMAND_SUFFIX = normalizeCommandSuffix(options.shellSuffix || runConfig.shellSuffix || config.shellSuffix);
    }

    // Basic name validation to reduce injection risk
    validateName('containerName', CONTAINER_NAME, SAFE_CONTAINER_NAME_PATTERN);
    validateName('imageName', IMAGE_NAME, /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/);
    validateName('imageVersion', IMAGE_VERSION, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

    // Merge mode (array values): concatenate all sources
    const toArray = (val) => Array.isArray(val) ? val : (val ? [val] : []);
    const envFileList = [
        ...toArray(config.envFile),
        ...toArray(runConfig.envFile),
        ...(options.envFile || [])
    ].filter(Boolean);
    envFileList.forEach(ef => addEnvFile(ef));

    const envList = [...(config.env || []), ...(runConfig.env || []), ...(options.env || [])];
    envList.forEach(e => addEnv(e));

    const volumeList = [...(config.volumes || []), ...(runConfig.volumes || []), ...(options.volume || [])];
    volumeList.forEach(v => addVolume(v));

    const buildArgList = [...(config.imageBuildArgs || []), ...(runConfig.imageBuildArgs || []), ...(options.imageBuildArg || [])];
    buildArgList.forEach(arg => addImageBuildArg(arg));

    // Override mode for special options
    const yoloValue = options.yolo || runConfig.yolo || config.yolo;
    if (yoloValue) setYolo(yoloValue);

    const contModeValue = options.contMode || runConfig.containerMode || config.containerMode;
    if (contModeValue) setContMode(contModeValue);

    const quietValue = options.quiet || runConfig.quiet || config.quiet;
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

    if (options.yes) {
        YES_MODE = true;
    }

    if (options.rmOnExit) {
        RM_ON_EXIT = true;
    }

    if (options.server !== undefined) {
        SERVER_MODE = true;
        SERVER_PORT = parseServerPort(options.server);
    }

    if (options.showConfig) {
        const finalConfig = {
            hostPath: HOST_PATH,
            containerName: CONTAINER_NAME,
            containerPath: CONTAINER_PATH,
            imageName: IMAGE_NAME,
            imageVersion: IMAGE_VERSION,
            envFile: envFileList,
            env: envList,
            volumes: volumeList,
            imageBuildArgs: buildArgList,
            containerMode: contModeValue || "",
            shellPrefix: EXEC_COMMAND_PREFIX.trim(),
            shell: EXEC_COMMAND || "",
            shellSuffix: EXEC_COMMAND_SUFFIX || "",
            yolo: yoloValue || "",
            quiet: quietValue || [],
            server: SERVER_MODE,
            serverPort: SERVER_MODE ? SERVER_PORT : null,
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

function handleRemoveContainer() {
    if (SHOULD_REMOVE) {
        try {
            if (containerExists(CONTAINER_NAME)) {
                removeContainer(CONTAINER_NAME);
            } else {
                console.log(`${RED}⚠️  错误: 未找到名为 ${CONTAINER_NAME} 的容器。${NC}`);
            }
        } catch (e) {
            console.log(`${RED}⚠️  错误: 未找到名为 ${CONTAINER_NAME} 的容器。${NC}`);
        }
        process.exit(0);
    }
}

function validateHostPath() {
    if (!fs.existsSync(HOST_PATH)) {
        console.log(`${RED}⚠️  错误: 宿主机路径不存在: ${HOST_PATH}${NC}`);
        process.exit(1);
    }
    const realHostPath = fs.realpathSync(HOST_PATH);
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

// ==============================================================================
// SECTION: Container Lifecycle Management
// ==============================================================================

/**
 * 创建新容器
 * @returns {Promise<string>} 默认命令
 */
async function createNewContainer() {
    if ( !(QUIET.cnew || QUIET.full) ) console.log(`${CYAN}📦 manyoyo by xcanwin 正在创建新容器: ${YELLOW}${CONTAINER_NAME}${NC}`);

    EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}`;
    const defaultCommand = EXEC_COMMAND;

    if (SHOW_COMMAND) {
        console.log(buildDockerRunCmd());
        process.exit(0);
    }

    // 使用数组参数执行命令（安全方式）
    try {
        const args = buildDockerRunArgs();
        dockerExecArgs(args, { stdio: 'pipe' });
    } catch (e) {
        showImagePullHint(e);
        throw e;
    }

    // Wait for container to be ready
    await waitForContainerReady(CONTAINER_NAME);

    return defaultCommand;
}

/**
 * 构建 Docker run 命令参数数组（安全方式，避免命令注入）
 * @returns {string[]} 命令参数数组
 */
function buildDockerRunArgs() {
    const fullImage = `${IMAGE_NAME}:${IMAGE_VERSION}`;
    const safeLabelCmd = EXEC_COMMAND.replace(/[\r\n]/g, ' ');

    const args = [
        'run', '-d',
        '--name', CONTAINER_NAME,
        '--entrypoint', '',
        ...CONT_MODE_ARGS,
        ...CONTAINER_ENVS,
        ...CONTAINER_VOLUMES,
        '--volume', `${HOST_PATH}:${CONTAINER_PATH}`,
        '--workdir', CONTAINER_PATH,
        '--label', `manyoyo.default_cmd=${safeLabelCmd}`,
        fullImage,
        'tail', '-f', '/dev/null'
    ];

    return args;
}

/**
 * 构建 Docker run 命令字符串（用于显示）
 * @returns {string} 命令字符串
 */
function buildDockerRunCmd() {
    const args = buildDockerRunArgs();
    // 对包含空格或特殊字符的参数加引号
    const quotedArgs = args.map(arg => {
        if (arg.includes(' ') || arg.includes('"') || arg.includes('=')) {
            return `"${arg.replace(/"/g, '\\"')}"`;
        }
        return arg;
    });
    return `${DOCKER_CMD} ${quotedArgs.join(' ')}`;
}

async function connectExistingContainer() {
    if ( !(QUIET.cnew || QUIET.full) ) console.log(`${CYAN}🔄 manyoyo by xcanwin 正在连接到现有容器: ${YELLOW}${CONTAINER_NAME}${NC}`);

    // Start container if stopped
    const status = getContainerStatus(CONTAINER_NAME);
    if (status !== 'running') {
        dockerExecArgs(['start', CONTAINER_NAME], { stdio: 'pipe' });
    }

    // Get default command from label
    const defaultCommand = dockerExecArgs(['inspect', '-f', '{{index .Config.Labels "manyoyo.default_cmd"}}', CONTAINER_NAME]).trim();

    if (!EXEC_COMMAND) {
        EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${defaultCommand}${EXEC_COMMAND_SUFFIX}`;
    } else {
        EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}`;
    }

    return defaultCommand;
}

async function setupContainer() {
    if (SHOW_COMMAND) {
        if (containerExists(CONTAINER_NAME)) {
            const defaultCommand = dockerExecArgs(['inspect', '-f', '{{index .Config.Labels "manyoyo.default_cmd"}}', CONTAINER_NAME]).trim();
            const execCmd = EXEC_COMMAND
                ? `${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}`
                : `${EXEC_COMMAND_PREFIX}${defaultCommand}${EXEC_COMMAND_SUFFIX}`;
            console.log(`${DOCKER_CMD} exec -it ${CONTAINER_NAME} /bin/bash -c "${execCmd.replace(/"/g, '\\"')}"`);
            process.exit(0);
        }
        EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}`;
        console.log(buildDockerRunCmd());
        process.exit(0);
    }
    if (!containerExists(CONTAINER_NAME)) {
        return await createNewContainer();
    } else {
        return await connectExistingContainer();
    }
}

function executeInContainer(defaultCommand) {
    getHelloTip(CONTAINER_NAME, defaultCommand);
    if ( !(QUIET.cmd || QUIET.full) ) {
        console.log(`${BLUE}----------------------------------------${NC}`);
        console.log(`💻 执行命令: ${YELLOW}${EXEC_COMMAND || '交互式 Shell'}${NC}`);
    }

    // Execute command in container
    if (EXEC_COMMAND) {
        spawnSync(`${DOCKER_CMD}`, ['exec', '-it', CONTAINER_NAME, '/bin/bash', '-c', EXEC_COMMAND], { stdio: 'inherit' });
    } else {
        spawnSync(`${DOCKER_CMD}`, ['exec', '-it', CONTAINER_NAME, '/bin/bash'], { stdio: 'inherit' });
    }
}

/**
 * 处理会话退出后的交互
 * @param {string} defaultCommand - 默认命令
 */
async function handlePostExit(defaultCommand) {
    // --rm-on-exit 模式：自动删除容器
    if (RM_ON_EXIT) {
        removeContainer(CONTAINER_NAME);
        return;
    }

    getHelloTip(CONTAINER_NAME, defaultCommand);

    let tipAskKeep = `❔ 会话已结束。是否保留此后台容器 ${CONTAINER_NAME}? [ y=默认保留, n=删除, 1=首次命令进入, x=执行命令, i=交互式SHELL ]: `;
    if ( QUIET.askkeep || QUIET.full ) tipAskKeep = `保留容器吗? [y n 1 x i] `;
    const reply = await askQuestion(tipAskKeep);

    const firstChar = reply.trim().toLowerCase()[0];

    if (firstChar === 'n') {
        removeContainer(CONTAINER_NAME);
    } else if (firstChar === '1') {
        if ( !(QUIET.full) ) console.log(`${GREEN}✅ 离开当前连接，用首次命令进入。${NC}`);
        // Reset command variables to use default command
        EXEC_COMMAND = "";
        EXEC_COMMAND_PREFIX = "";
        EXEC_COMMAND_SUFFIX = "";
        const newArgs = ['-n', CONTAINER_NAME];
        process.argv = [process.argv[0], process.argv[1], ...newArgs];
        await main();
    } else if (firstChar === 'x') {
        const command = await askQuestion('❔ 输入要执行的命令: ');
        if ( !(QUIET.cmd || QUIET.full) ) console.log(`${GREEN}✅ 离开当前连接，执行命令。${NC}`);
        const newArgs = ['-n', CONTAINER_NAME, '-x', command];
        process.argv = [process.argv[0], process.argv[1], ...newArgs];
        await main();
    } else if (firstChar === 'i') {
        if ( !(QUIET.full) ) console.log(`${GREEN}✅ 离开当前连接，进入容器交互式SHELL。${NC}`);
        const newArgs = ['-n', CONTAINER_NAME, '-x', '/bin/bash'];
        process.argv = [process.argv[0], process.argv[1], ...newArgs];
        await main();
    } else {
        console.log(`${GREEN}✅ 已退出连接。容器 ${CONTAINER_NAME} 仍在后台运行。${NC}`);
    }
}

// ==============================================================================
// SECTION: Web Server
// ==============================================================================

const WEB_HISTORY_DIR = path.join(os.homedir(), '.manyoyo', 'web-history');
const WEB_HISTORY_MAX_MESSAGES = 500;
const WEB_OUTPUT_MAX_CHARS = 16000;

function ensureWebHistoryDir() {
    fs.mkdirSync(WEB_HISTORY_DIR, { recursive: true });
}

function getWebHistoryFile(containerName) {
    return path.join(WEB_HISTORY_DIR, `${containerName}.json`);
}

function loadWebSessionHistory(containerName) {
    ensureWebHistoryDir();
    const filePath = getWebHistoryFile(containerName);
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

function saveWebSessionHistory(containerName, history) {
    ensureWebHistoryDir();
    const filePath = getWebHistoryFile(containerName);
    fs.writeFileSync(filePath, JSON.stringify(history, null, 4));
}

function removeWebSessionHistory(containerName) {
    ensureWebHistoryDir();
    const filePath = getWebHistoryFile(containerName);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

function listWebHistorySessionNames() {
    ensureWebHistoryDir();
    return fs.readdirSync(WEB_HISTORY_DIR)
        .filter(file => file.endsWith('.json'))
        .map(file => path.basename(file, '.json'))
        .filter(name => isValidContainerName(name));
}

function appendWebSessionMessage(containerName, role, content, extra = {}) {
    const history = loadWebSessionHistory(containerName);
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
    saveWebSessionHistory(containerName, history);
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

function listWebManyoyoContainers() {
    const output = dockerExecArgs(
        ['ps', '-a', '--filter', 'label=manyoyo.default_cmd', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}'],
        { ignoreError: true }
    );

    const map = {};
    if (!output.trim()) {
        return map;
    }

    output.trim().split('\n').forEach(line => {
        const [name, status, image] = line.split('\t');
        if (!isValidContainerName(name)) {
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

async function ensureWebContainer(containerName) {
    if (!containerExists(containerName)) {
        const webDefaultCommand = `${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}`.trim() || '/bin/bash';
        const safeLabelCmd = webDefaultCommand.replace(/[\r\n]/g, ' ');
        const args = [
            'run', '-d',
            '--name', containerName,
            '--entrypoint', '',
            ...CONT_MODE_ARGS,
            ...CONTAINER_ENVS,
            ...CONTAINER_VOLUMES,
            '--volume', `${HOST_PATH}:${CONTAINER_PATH}`,
            '--workdir', CONTAINER_PATH,
            '--label', `manyoyo.default_cmd=${safeLabelCmd}`,
            `${IMAGE_NAME}:${IMAGE_VERSION}`,
            'tail', '-f', '/dev/null'
        ];

        try {
            dockerExecArgs(args, { stdio: 'pipe' });
        } catch (e) {
            showImagePullHint(e);
            throw e;
        }

        await waitForContainerReady(containerName);
        appendWebSessionMessage(containerName, 'system', `容器 ${containerName} 已创建并启动。`);
        return;
    }

    const status = getContainerStatus(containerName);
    if (status !== 'running') {
        dockerExecArgs(['start', containerName], { stdio: 'pipe' });
        appendWebSessionMessage(containerName, 'system', `容器 ${containerName} 已启动。`);
    }
}

function execCommandInWebContainer(containerName, command) {
    const result = spawnSync(DOCKER_CMD, ['exec', containerName, '/bin/bash', '-lc', command], {
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024
    });

    if (result.error) {
        throw result.error;
    }

    const exitCode = typeof result.status === 'number' ? result.status : 1;
    const rawOutput = `${result.stdout || ''}${result.stderr || ''}`;
    const output = clipText(stripAnsi(rawOutput).trim() || '(无输出)');

    return { exitCode, output };
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

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
    res.writeHead(statusCode, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
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

function buildSessionSummary(containerMap, name) {
    const history = loadWebSessionHistory(name);
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

function getWebServerHtml() {
    return `<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MANYOYO Web</title>
    <style>
        :root {
            --bg: #f4f7f5;
            --panel: #ffffff;
            --panel-soft: #f0f5f2;
            --line: #dbe4de;
            --text: #0f2f20;
            --muted: #4a6256;
            --accent: #0f9d58;
            --accent-strong: #087f45;
            --user-bubble: #e4f5eb;
            --assistant-bubble: #f7faf8;
            --system-bubble: #eef4ff;
            --sidebar-width: 280px;
            --header-height: 70px;
            --composer-height: 176px;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            height: 100vh;
            overflow: hidden;
            font-family: "IBM Plex Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
            color: var(--text);
            background: radial-gradient(circle at 0 0, #d8efe2 0%, var(--bg) 45%, #f5f8f6 100%);
        }

        .app {
            height: 100vh;
        }

        .sidebar {
            position: fixed;
            left: 0;
            top: 0;
            bottom: 0;
            width: var(--sidebar-width);
            z-index: 30;
            border-right: 1px solid var(--line);
            background: linear-gradient(180deg, #f9fcfa 0%, #eef6f1 100%);
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .brand {
            font-weight: 700;
            letter-spacing: 0.5px;
            font-size: 16px;
        }

        .new-session {
            display: flex;
            gap: 8px;
        }

        .new-session input {
            flex: 1;
            border: 1px solid var(--line);
            border-radius: 10px;
            padding: 9px 10px;
            background: var(--panel);
        }

        button {
            border: none;
            border-radius: 10px;
            padding: 9px 12px;
            font-weight: 600;
            cursor: pointer;
            background: var(--accent);
            color: #fff;
        }

        button:hover {
            background: var(--accent-strong);
        }

        button.secondary {
            background: var(--panel-soft);
            color: var(--text);
            border: 1px solid var(--line);
        }

        button.secondary:hover {
            background: #e6efe9;
        }

        #sessionList {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding-right: 4px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .session-item {
            text-align: left;
            width: 100%;
            background: var(--panel);
            color: var(--text);
            border: 1px solid var(--line);
            padding: 10px;
            border-radius: 12px;
            transition: 120ms ease;
        }

        .session-item.active {
            border-color: var(--accent);
            box-shadow: 0 0 0 2px rgba(15, 157, 88, 0.15);
        }

        .session-name {
            font-size: 13px;
            font-weight: 700;
            margin-bottom: 3px;
            word-break: break-all;
        }

        .session-meta {
            font-size: 12px;
            color: var(--muted);
        }

        .empty {
            color: var(--muted);
            font-size: 13px;
            padding: 8px 4px;
        }

        .main {
            margin-left: var(--sidebar-width);
            height: 100vh;
        }

        .header {
            position: fixed;
            top: 0;
            left: var(--sidebar-width);
            right: 0;
            height: var(--header-height);
            z-index: 20;
            border-bottom: 1px solid var(--line);
            background: rgba(255, 255, 255, 0.75);
            backdrop-filter: blur(6px);
            padding: 14px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
        }

        #activeTitle {
            margin: 0;
            font-size: 17px;
            font-weight: 700;
        }

        .header-actions {
            display: flex;
            gap: 8px;
        }

        #messages {
            position: fixed;
            left: var(--sidebar-width);
            right: 0;
            top: var(--header-height);
            bottom: var(--composer-height);
            overflow-y: auto;
            scroll-behavior: smooth;
            padding: 18px 20px;
            display: flex;
            flex-direction: column;
            gap: 14px;
        }

        #messages::-webkit-scrollbar {
            width: 10px;
        }

        #messages::-webkit-scrollbar-thumb {
            background: #bdd8c8;
            border-radius: 8px;
        }

        .msg {
            display: flex;
            flex-direction: column;
            max-width: 920px;
            width: fit-content;
        }

        .msg.user {
            align-self: flex-end;
        }

        .msg.assistant, .msg.system {
            align-self: flex-start;
        }

        .role {
            font-size: 12px;
            color: var(--muted);
            margin-bottom: 4px;
            font-weight: 600;
        }

        .bubble {
            border: 1px solid var(--line);
            background: var(--assistant-bubble);
            border-radius: 12px;
            padding: 10px 12px;
        }

        .msg.user .bubble {
            background: var(--user-bubble);
        }

        .msg.system .bubble {
            background: var(--system-bubble);
        }

        .bubble pre {
            margin: 0;
            white-space: pre-wrap;
            word-break: break-word;
            font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
            font-size: 13px;
            line-height: 1.5;
        }

        .composer {
            position: fixed;
            left: var(--sidebar-width);
            right: 0;
            bottom: 0;
            min-height: var(--composer-height);
            z-index: 20;
            border-top: 1px solid var(--line);
            padding: 12px 20px 16px;
            background: rgba(255, 255, 255, 0.86);
        }

        .composer-inner {
            display: flex;
            gap: 10px;
            align-items: flex-end;
        }

        #commandInput {
            width: 100%;
            min-height: 120px;
            height: 120px;
            max-height: 300px;
            border: 1px solid var(--line);
            border-radius: 12px;
            padding: 11px 12px;
            resize: none;
            font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
            font-size: 13px;
            background: #fff;
        }

        #sendBtn[disabled] {
            opacity: 0.6;
            cursor: not-allowed;
        }

        @media (max-width: 900px) {
            body {
                height: auto;
                overflow: auto;
            }

            .sidebar {
                position: static;
                width: auto;
                z-index: auto;
                border-right: none;
                border-bottom: 1px solid var(--line);
                max-height: 42vh;
            }

            .main {
                margin-left: 0;
                min-height: 58vh;
                height: auto;
                display: grid;
                grid-template-rows: auto 1fr auto;
            }

            .header {
                position: static;
                height: auto;
            }

            #messages {
                position: static;
                min-height: 42vh;
                max-height: 42vh;
            }

            .composer {
                position: static;
                min-height: auto;
            }
        }
    </style>
</head>
<body>
    <div class="app">
        <aside class="sidebar">
            <div class="brand">MANYOYO Web</div>
            <form class="new-session" id="newSessionForm">
                <input id="newSessionName" placeholder="容器名 (例如 myy-dev)" />
                <button type="submit">新建</button>
            </form>
            <div id="sessionList"></div>
        </aside>
        <main class="main">
            <header class="header">
                <h1 id="activeTitle">未选择会话</h1>
                <div class="header-actions">
                    <button type="button" id="refreshBtn" class="secondary">刷新</button>
                    <button type="button" id="removeBtn" class="secondary">删除容器</button>
                    <button type="button" id="removeAllBtn" class="secondary">删除容器与聊天记录</button>
                </div>
            </header>
            <section id="messages"></section>
            <form class="composer" id="composer">
                <div class="composer-inner">
                    <textarea id="commandInput" placeholder="输入容器命令，例如: ls -la"></textarea>
                    <button type="submit" id="sendBtn">发送</button>
                </div>
            </form>
        </main>
    </div>

    <script>
        (function () {
            const state = {
                sessions: [],
                active: '',
                messages: [],
                sending: false
            };

            const sessionList = document.getElementById('sessionList');
            const activeTitle = document.getElementById('activeTitle');
            const messagesNode = document.getElementById('messages');
            const newSessionForm = document.getElementById('newSessionForm');
            const newSessionName = document.getElementById('newSessionName');
            const composer = document.getElementById('composer');
            const commandInput = document.getElementById('commandInput');
            const sendBtn = document.getElementById('sendBtn');
            const refreshBtn = document.getElementById('refreshBtn');
            const removeBtn = document.getElementById('removeBtn');
            const removeAllBtn = document.getElementById('removeAllBtn');

            function roleName(role) {
                if (role === 'user') return '你';
                if (role === 'assistant') return '容器输出';
                return '系统';
            }

            function formatStatus(status) {
                if (!status) return 'history';
                return status;
            }

            async function api(url, options) {
                const requestOptions = Object.assign(
                    { headers: { 'Content-Type': 'application/json' } },
                    options || {}
                );
                const response = await fetch(url, requestOptions);
                let data = {};
                try {
                    data = await response.json();
                } catch (e) {
                    data = {};
                }
                if (!response.ok) {
                    throw new Error(data.error || '请求失败');
                }
                return data;
            }

            function setSending(value) {
                state.sending = value;
                sendBtn.disabled = value || !state.active;
                commandInput.disabled = !state.active;
            }

            function updateHeader() {
                if (!state.active) {
                    activeTitle.textContent = '未选择会话';
                    removeBtn.disabled = true;
                    removeAllBtn.disabled = true;
                    setSending(false);
                    commandInput.value = '';
                    return;
                }
                activeTitle.textContent = state.active;
                removeBtn.disabled = false;
                removeAllBtn.disabled = false;
                setSending(state.sending);
            }

            function renderSessions() {
                sessionList.innerHTML = '';
                if (!state.sessions.length) {
                    const empty = document.createElement('div');
                    empty.className = 'empty';
                    empty.textContent = '暂无 manyoyo 会话';
                    sessionList.appendChild(empty);
                    return;
                }

                state.sessions.forEach(function (session) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'session-item' + (state.active === session.name ? ' active' : '');
                    btn.innerHTML =
                        '<div class="session-name">' + session.name + '</div>' +
                        '<div class="session-meta">' + formatStatus(session.status) + '</div>';
                    btn.addEventListener('click', function () {
                        state.active = session.name;
                        updateHeader();
                        renderSessions();
                        loadMessages();
                    });
                    sessionList.appendChild(btn);
                });
            }

            function renderMessages(messages) {
                messagesNode.innerHTML = '';
                if (!messages.length) {
                    const empty = document.createElement('div');
                    empty.className = 'empty';
                    empty.textContent = '输入命令后，容器输出会显示在这里。';
                    messagesNode.appendChild(empty);
                    return;
                }

                messages.forEach(function (msg) {
                    const row = document.createElement('article');
                    row.className = 'msg ' + (msg.role || 'system');

                    const role = document.createElement('div');
                    role.className = 'role';
                    role.textContent = roleName(msg.role);

                    const bubble = document.createElement('div');
                    bubble.className = 'bubble';

                    const pre = document.createElement('pre');
                    pre.textContent = msg.content || '';
                    bubble.appendChild(pre);

                    row.appendChild(role);
                    row.appendChild(bubble);
                    messagesNode.appendChild(row);
                });

                messagesNode.scrollTop = messagesNode.scrollHeight;
            }

            async function loadSessions(preferredName) {
                const data = await api('/api/sessions');
                state.sessions = Array.isArray(data.sessions) ? data.sessions : [];

                if (preferredName) {
                    state.active = preferredName;
                }

                if (state.active && !state.sessions.some(function (s) { return s.name === state.active; })) {
                    state.active = '';
                }

                if (!state.active && state.sessions.length) {
                    state.active = state.sessions[0].name;
                }

                updateHeader();
                renderSessions();
                await loadMessages();
            }

            async function loadMessages() {
                if (!state.active) {
                    state.messages = [];
                    renderMessages(state.messages);
                    return;
                }
                const data = await api('/api/sessions/' + encodeURIComponent(state.active) + '/messages');
                state.messages = Array.isArray(data.messages) ? data.messages : [];
                renderMessages(state.messages);
            }

            newSessionForm.addEventListener('submit', async function (event) {
                event.preventDefault();
                try {
                    const name = (newSessionName.value || '').trim();
                    const data = await api('/api/sessions', {
                        method: 'POST',
                        body: JSON.stringify({ name: name })
                    });
                    newSessionName.value = '';
                    await loadSessions(data.name);
                } catch (e) {
                    alert(e.message);
                }
            });

            composer.addEventListener('submit', async function (event) {
                event.preventDefault();
                if (!state.active) return;
                if (state.sending) return;
                const command = (commandInput.value || '').trim();
                if (!command) return;

                const submitSession = state.active;
                const previousMessages = state.messages.slice();
                state.messages = state.messages.concat([{
                    role: 'user',
                    content: command,
                    timestamp: new Date().toISOString(),
                    pending: true
                }]);
                renderMessages(state.messages);

                setSending(true);
                try {
                    commandInput.value = '';
                    commandInput.focus();
                    await api('/api/sessions/' + encodeURIComponent(submitSession) + '/run', {
                        method: 'POST',
                        body: JSON.stringify({ command: command })
                    });
                    await loadSessions(submitSession);
                } catch (e) {
                    if (state.active === submitSession) {
                        state.messages = previousMessages;
                        renderMessages(state.messages);
                    }
                    alert(e.message);
                } finally {
                    setSending(false);
                    commandInput.focus();
                }
            });

            commandInput.addEventListener('keydown', function (event) {
                if (event.key !== 'Enter' || event.isComposing) {
                    return;
                }

                // Shift+Enter / Option(Alt)+Enter: 换行
                if (event.shiftKey || event.altKey) {
                    return;
                }

                // Enter / Ctrl+Enter: 发送
                event.preventDefault();
                if (!state.active || state.sending) {
                    return;
                }
                composer.requestSubmit();
            });

            refreshBtn.addEventListener('click', function () {
                loadSessions(state.active).catch(function (e) { alert(e.message); });
            });

            removeBtn.addEventListener('click', async function () {
                if (!state.active) return;
                const yes = confirm('确认删除容器 ' + state.active + ' ? 仅删除容器，历史消息仍保留。');
                if (!yes) return;
                try {
                    const current = state.active;
                    await api('/api/sessions/' + encodeURIComponent(current) + '/remove', {
                        method: 'POST'
                    });
                    await loadSessions('');
                } catch (e) {
                    alert(e.message);
                }
            });

            removeAllBtn.addEventListener('click', async function () {
                if (!state.active) return;
                const yes = confirm('确认删除容器和聊天记录 ' + state.active + ' ? 删除后无法恢复。');
                if (!yes) return;
                try {
                    const current = state.active;
                    await api('/api/sessions/' + encodeURIComponent(current) + '/remove-with-history', {
                        method: 'POST'
                    });
                    await loadSessions('');
                } catch (e) {
                    alert(e.message);
                }
            });

            setSending(false);
            loadSessions().catch(function (e) {
                alert(e.message);
            });
        })();
    </script>
</body>
</html>`;
}

async function handleWebApi(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/sessions') {
        const containerMap = listWebManyoyoContainers();
        const names = new Set([...Object.keys(containerMap), ...listWebHistorySessionNames()]);
        const sessions = Array.from(names)
            .map(name => buildSessionSummary(containerMap, name))
            .sort((a, b) => {
                const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                return timeB - timeA;
            });
        sendJson(res, 200, { sessions });
        return true;
    }

    if (req.method === 'POST' && pathname === '/api/sessions') {
        const payload = await readJsonBody(req);
        let containerName = (payload.name || '').trim();
        if (!containerName) {
            containerName = `myy-${formatDate()}`;
        }
        if (!isValidContainerName(containerName)) {
            sendJson(res, 400, { error: `containerName 非法: ${containerName}` });
            return true;
        }

        await ensureWebContainer(containerName);
        sendJson(res, 200, { name: containerName });
        return true;
    }

    const messagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (req.method === 'GET' && messagesMatch) {
        const containerName = decodeSessionName(messagesMatch[1]);
        if (!isValidContainerName(containerName)) {
            sendJson(res, 400, { error: `containerName 非法: ${containerName}` });
            return true;
        }
        const history = loadWebSessionHistory(containerName);
        sendJson(res, 200, { name: containerName, messages: history.messages });
        return true;
    }

    const runMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/run$/);
    if (req.method === 'POST' && runMatch) {
        const containerName = decodeSessionName(runMatch[1]);
        if (!isValidContainerName(containerName)) {
            sendJson(res, 400, { error: `containerName 非法: ${containerName}` });
            return true;
        }

        const payload = await readJsonBody(req);
        const command = (payload.command || '').trim();
        if (!command) {
            sendJson(res, 400, { error: 'command 不能为空' });
            return true;
        }

        await ensureWebContainer(containerName);
        appendWebSessionMessage(containerName, 'user', command);
        const result = execCommandInWebContainer(containerName, command);
        appendWebSessionMessage(containerName, 'assistant', `${result.output}\n\n[exit ${result.exitCode}]`, { exitCode: result.exitCode });
        sendJson(res, 200, { exitCode: result.exitCode, output: result.output });
        return true;
    }

    const removeMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/remove$/);
    if (req.method === 'POST' && removeMatch) {
        const containerName = decodeSessionName(removeMatch[1]);
        if (!isValidContainerName(containerName)) {
            sendJson(res, 400, { error: `containerName 非法: ${containerName}` });
            return true;
        }

        if (containerExists(containerName)) {
            removeContainer(containerName);
            appendWebSessionMessage(containerName, 'system', `容器 ${containerName} 已删除。`);
        }

        sendJson(res, 200, { removed: true, name: containerName });
        return true;
    }

    const removeAllMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/remove-with-history$/);
    if (req.method === 'POST' && removeAllMatch) {
        const containerName = decodeSessionName(removeAllMatch[1]);
        if (!isValidContainerName(containerName)) {
            sendJson(res, 400, { error: `containerName 非法: ${containerName}` });
            return true;
        }

        if (containerExists(containerName)) {
            removeContainer(containerName);
        }
        removeWebSessionHistory(containerName);

        sendJson(res, 200, { removed: true, removedHistory: true, name: containerName });
        return true;
    }

    return false;
}

async function startWebServer() {
    validateHostPath();
    ensureWebHistoryDir();

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${SERVER_PORT}`}`);
            const pathname = url.pathname;

            if (req.method === 'GET' && pathname === '/') {
                sendHtml(res, 200, getWebServerHtml());
                return;
            }

            if (pathname === '/healthz') {
                sendJson(res, 200, { ok: true });
                return;
            }

            if (pathname.startsWith('/api/')) {
                const handled = await handleWebApi(req, res, pathname);
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

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(SERVER_PORT, '127.0.0.1', () => {
            console.log(`${GREEN}✅ MANYOYO Web 服务已启动: http://127.0.0.1:${SERVER_PORT}${NC}`);
            console.log(`${CYAN}提示: 左侧是 manyoyo 容器会话列表，右侧可发送命令并查看输出。${NC}`);
            resolve();
        });
    });
}

// ==============================================================================
// Main Function
// ==============================================================================

async function main() {
    try {
        // 1. Setup commander and parse arguments
        setupCommander();

        // 2. Start web server mode
        if (SERVER_MODE) {
            await startWebServer();
            return;
        }

        // 3. Handle image build operation
        if (IMAGE_BUILD_NEED) {
            await buildImage(IMAGE_BUILD_ARGS, IMAGE_NAME, IMAGE_VERSION.split('-')[0]);
            process.exit(0);
        }

        // 4. Handle remove container operation
        handleRemoveContainer();

        // 5. Validate host path safety
        validateHostPath();

        // 6. Setup container (create or connect)
        const defaultCommand = await setupContainer();

        // 7. Execute command in container
        executeInContainer(defaultCommand);

        // 8. Handle post-exit interactions
        await handlePostExit(defaultCommand);

    } catch (e) {
        console.error(`${RED}Error: ${e.message}${NC}`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
