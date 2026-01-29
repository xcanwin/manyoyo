#!/usr/bin/env node

// ==============================================================================
// manyoyo - AI Agent CLI Sandbox - xcanwin
// ==============================================================================

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { Command } = require('commander');
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
let QUIET = {};

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
// Utility Functions
// ==============================================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==============================================================================
// Configuration File Functions
// ==============================================================================

function loadConfig() {
    const configPath = path.join(os.homedir(), '.manyoyo', 'config.json');
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return config;
        } catch (e) {
            console.error(`${YELLOW}⚠️ 配置文件格式错误: ${configPath}${NC}`);
            return {};
        }
    }
    return {};
}

// ==============================================================================
// UI Functions
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

function setQuiet(action) {
    action.split(',').forEach(ac => {
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
    // process.exit(0);
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

// ==============================================================================
// Configuration Functions
// ==============================================================================

function addEnv(env) {
    CONTAINER_ENVS.push("--env", env);
}

function addEnvFile(envFile) {
    ENV_FILE = envFile;
    if (ENV_FILE && fs.existsSync(ENV_FILE)) {
        const content = fs.readFileSync(ENV_FILE, 'utf-8');
        const lines = content.split('\n');

        for (let line of lines) {
            // Match pattern: (export )?(KEY)=(VALUE)
            const match = line.match(/^(?:export\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/);
            if (match) {
                let key = match[1];
                let value = match[2].trim();

                // Filter malicious characters
                if (/[\$\(\)\`\|\&\*\{\}]/.test(value)) continue;
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
    }
}

function addVolume(volume) {
    CONTAINER_VOLUMES.push("--volume", volume);
}

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
            EXEC_COMMAND = "codex";
            break;
        case 'opencode':
        case 'oc':
            EXEC_COMMAND = "opencode";
            break;
        default:
            console.log(`${RED}⚠️ 未知LLM CLI: ${cli}${NC}`);
            process.exit(0);
    }
}

function setContMode(mode) {
    switch (mode) {
        case 'common':
            CONT_MODE = "";
            break;
        case 'docker-in-docker':
        case 'dind':
        case 'd':
            CONT_MODE = "--privileged";
            console.log(`${GREEN}✅ 开启安全的容器嵌套容器模式, 手动在容器内启动服务: nohup dockerd &${NC}`);
            break;
        case 'mount-docker-socket':
        case 'sock':
        case 's':
            CONT_MODE = "--privileged --volume /var/run/docker.sock:/var/run/docker.sock --env DOCKER_HOST=unix:///var/run/docker.sock --env CONTAINER_HOST=unix:///var/run/docker.sock";
            console.log(`${RED}⚠️ 开启危险的容器嵌套容器模式, 危害: 容器可访问宿主机文件${NC}`);
            break;
        default:
            console.log(`${RED}⚠️ 未知模式: ${mode}${NC}`);
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

function containerExists(name) {
    const containers = dockerExec(`${DOCKER_CMD} ps -a --format '{{.Names}}'`);
    return containers.split('\n').some(n => n.trim() === name);
}

function getContainerStatus(name) {
    return dockerExec(`${DOCKER_CMD} inspect -f '{{.State.Status}}' "${name}"`).trim();
}

function removeContainer(name) {
    if ( !(QUIET.crm || QUIET.full) ) console.log(`${YELLOW}🗑️ 正在删除容器: ${name}...${NC}`);
    dockerExec(`${DOCKER_CMD} rm -f "${name}"`, { stdio: 'pipe' });
    if ( !(QUIET.crm || QUIET.full) ) console.log(`${GREEN}✅ 已彻底删除。${NC}`);
}

// ==============================================================================
// Docker Operations
// ==============================================================================

function ensureDocker() {
    const commands = ['docker', 'podman'];
    for (const cmd of commands) {
        try {
            execSync(`${cmd} --version`, { stdio: 'pipe' });
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
    execSync(`${DOCKER_CMD} image prune -f`, { stdio: 'inherit' });

    // Remove remaining <none> images
    try {
        const imagesOutput = execSync(`${DOCKER_CMD} images -a --format "{{.ID}} {{.Repository}}"`, { encoding: 'utf-8' });
        const noneImages = imagesOutput
            .split('\n')
            .filter(line => line.includes('<none>'))
            .map(line => line.split(' ')[0])
            .filter(id => id);

        if (noneImages.length > 0) {
            console.log(`${YELLOW}清理剩余的 <none> 镜像 (${noneImages.length} 个)...${NC}`);
            execSync(`${DOCKER_CMD} rmi -f ${noneImages.join(' ')}`, { stdio: 'inherit' });
        }
    } catch (e) {
        // Ignore errors if no <none> images found
    }

    console.log(`${GREEN}✅ 清理完成${NC}`);
}

async function prepareBuildCache(imageTool) {
    const cacheDir = path.join(__dirname, '../docker/cache');
    const timestampFile = path.join(cacheDir, '.timestamps.json');
    const cacheTTLDays = 2;

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
        const mirror = 'https://mirrors.tencent.com/nodejs-release';
        try {
            const shasum = execSync(`curl -sL ${mirror}/latest-v${nodeVersion}.x/SHASUMS256.txt | grep linux-${archNode}.tar.gz | awk '{print $2}'`, { encoding: 'utf-8' }).trim();
            const nodeUrl = `${mirror}/latest-v${nodeVersion}.x/${shasum}`;
            const nodeTargetPath = path.join(nodeCacheDir, shasum);
            execSync(`curl -fsSL "${nodeUrl}" -o "${nodeTargetPath}"`, { stdio: 'inherit' });
            timestamps[nodeKey] = now.toISOString();
            fs.writeFileSync(timestampFile, JSON.stringify(timestamps, null, 2));
            console.log(`${GREEN}✓ Node.js 下载完成${NC}`);
        } catch (e) {
            console.error(`${RED}错误: Node.js 下载失败${NC}`);
            throw e;
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
            const jdtUrl = 'https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz';
            try {
                execSync(`curl -fsSL "${jdtUrl}" -o "${jdtlsPath}"`, { stdio: 'inherit' });
                timestamps[jdtlsKey] = now.toISOString();
                fs.writeFileSync(timestampFile, JSON.stringify(timestamps, null, 2));
                console.log(`${GREEN}✓ JDT LSP 下载完成${NC}`);
            } catch (e) {
                console.error(`${RED}错误: JDT LSP 下载失败${NC}`);
                throw e;
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

                execSync(`GOPATH="${tmpGoPath}" GOOS=linux GOARCH=${arch} go install golang.org/x/tools/gopls@latest`, { stdio: 'inherit' });
                execSync(`cp "${tmpGoPath}/bin/linux_${arch}/gopls" "${goplsPath}" || cp "${tmpGoPath}/bin/gopls" "${goplsPath}"`, { stdio: 'inherit' });
                execSync(`chmod +x "${goplsPath}"`, { stdio: 'inherit' });

                // Save timestamp immediately after successful download
                timestamps[goplsKey] = now.toISOString();
                fs.writeFileSync(timestampFile, JSON.stringify(timestamps, null, 2));
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
    fs.writeFileSync(timestampFile, JSON.stringify(timestamps, null, 2));
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

    const reply = await askQuestion(`❔ 是否继续构建? [ 直接回车=继续, ctrl+c=取消 ]: `);
    console.log("");

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
// Main Function Helpers
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
  ~/.manyoyo/config.json    默认配置文件

示例:
  ${MANYOYO_NAME} --ib                                构建镜像
  ${MANYOYO_NAME} -n test --ef ./xxx.env -y c         设置环境变量并运行无需确认的AGENT
  ${MANYOYO_NAME} -n test -- -c                       恢复之前会话
  ${MANYOYO_NAME} -x echo 123                         指定命令执行
  ${MANYOYO_NAME} -n test --ef ./xxx.env -x claude    设置环境变量并运行
  ${MANYOYO_NAME} -n test -x claude -c                恢复之前会话
        `);

    // Options
    program
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
        .option('--ef, --env-file <file>', '设置环境变量通过文件')
        .option('-v, --volume <volume>', '绑定挂载卷 XXX:YYY (可多次使用)', (value, previous) => [...(previous || []), value], [])
        .option('--sp, --shell-prefix <command>', '临时环境变量 (作为-s前缀)')
        .option('-s, --shell <command>', '指定命令执行')
        .option('-x, --shell-full <command...>', '指定完整命令执行 (代替--sp和-s和--命令)')
        .option('-y, --yolo <cli>', '使AGENT无需确认 (claude/c, gemini/gm, codex/cx, opencode/oc)')
        .option('--install <name>', '安装manyoyo命令 (docker-cli-plugin)')
        .option('-q, --quiet <list>', '静默显示 (cnew,crm,tip,cmd,full)');

    // Docker CLI plugin metadata check
    if (process.argv[2] === 'docker-cli-plugin-metadata') {
        console.log(JSON.stringify({
            "SchemaVersion": "0.1.0",
            "Vendor": "xcanwin",
            "Version": "v1.0.0",
            "Description": "AI Agent CLI Sandbox"
        }, null, 2));
        process.exit(0);
    }

    // Docker CLI plugin mode - remove first arg if running as plugin
    const dockerPluginPath = path.join(process.env.HOME || '', '.docker/cli-plugins/docker-manyoyo');
    if (process.argv[1] === dockerPluginPath && process.argv[2] === 'manyoyo') {
        process.argv.splice(2, 1);
    }

    // Ensure docker/podman is available
    ensureDocker();

    // Parse arguments
    program.allowUnknownOption(false);
    program.parse(process.argv);

    const options = program.opts();

    // Apply config defaults, then override with command line options
    HOST_PATH = options.hostPath || config.hostPath || HOST_PATH;
    if (options.contName || config.containerName) CONTAINER_NAME = options.contName || config.containerName;
    if (options.contPath || config.containerPath) CONTAINER_PATH = options.contPath || config.containerPath;
    IMAGE_NAME = options.imageName || config.imageName || IMAGE_NAME;
    if (options.imageVer || config.imageVersion) IMAGE_VERSION = options.imageVer || config.imageVersion;
    if (options.envFile || config.envFile) addEnvFile(options.envFile || config.envFile);
    if (options.shellPrefix || config.shellPrefix) EXEC_COMMAND_PREFIX = (options.shellPrefix || config.shellPrefix) + " ";
    if (options.shell || config.shell) EXEC_COMMAND = options.shell || config.shell;

    // Handle arrays - merge config and command line
    const envList = [...(config.env || []), ...(options.env || [])];
    envList.forEach(e => addEnv(e));

    const volumeList = [...(config.volumes || []), ...(options.volume || [])];
    volumeList.forEach(v => addVolume(v));

    const buildArgList = [...(config.imageBuildArgs || []), ...(options.imageBuildArg || [])];
    buildArgList.forEach(arg => addImageBuildArg(arg));

    // Handle special options
    const quietValue = options.quiet || config.quiet;
    if (quietValue) setQuiet(quietValue);

    const yoloValue = options.yolo || config.yolo;
    if (yoloValue) setYolo(yoloValue);

    const contModeValue = options.contMode || config.containerMode;
    if (contModeValue) setContMode(contModeValue);

    if (options.contList) { getContList(); process.exit(0); }
    if (options.contRemove) SHOULD_REMOVE = true;
    if (options.imageBuild) IMAGE_BUILD_NEED = true;
    if (options.imageRemove) { pruneDanglingImages(); process.exit(0); }
    if (options.install) { installManyoyo(options.install); process.exit(0); }

    // Handle shell-full (variadic arguments)
    if (options.shellFull) {
        EXEC_COMMAND = options.shellFull.join(' ');
    }

    // Handle -- suffix arguments
    const doubleDashIndex = process.argv.indexOf('--');
    if (doubleDashIndex !== -1 && doubleDashIndex < process.argv.length - 1) {
        EXEC_COMMAND_SUFFIX = " " + process.argv.slice(doubleDashIndex + 1).join(' ');
    }

    return program;
}

function handleRemoveContainer() {
    if (SHOULD_REMOVE) {
        try {
            if (containerExists(CONTAINER_NAME)) {
                removeContainer(CONTAINER_NAME);
            } else {
                console.log(`${RED}⚠️ 错误: 未找到名为 ${CONTAINER_NAME} 的容器。${NC}`);
            }
        } catch (e) {
            console.log(`${RED}⚠️ 错误: 未找到名为 ${CONTAINER_NAME} 的容器。${NC}`);
        }
        process.exit(0);
    }
}

function validateHostPath() {
    const realHostPath = fs.realpathSync(HOST_PATH);
    const homeDir = process.env.HOME || '/home';
    if (realHostPath === '/' || realHostPath === '/home' || realHostPath === homeDir) {
        console.log(`${RED}⚠️ 错误: 不允许挂载根目录或home目录。${NC}`);
        process.exit(1);
    }
}

async function waitForContainerReady(containerName) {
    const MAX_RETRIES = 50;
    let count = 0;
    while (true) {
        try {
            const status = getContainerStatus(containerName);

            if (status === 'running') {
                break;
            }

            if (status === 'exited') {
                console.log(`${RED}⚠️ 错误: 容器启动后立即退出。${NC}`);
                dockerExec(`${DOCKER_CMD} logs "${containerName}"`, { stdio: 'inherit' });
                process.exit(1);
            }

            await sleep(100);
            count++;

            if (count >= MAX_RETRIES) {
                console.log(`${RED}⚠️ 错误: 容器启动超时（当前状态: ${status}）。${NC}`);
                dockerExec(`${DOCKER_CMD} logs "${containerName}"`, { stdio: 'inherit' });
                process.exit(1);
            }
        } catch (e) {
            await sleep(100);
            count++;
            if (count >= MAX_RETRIES) {
                console.log(`${RED}⚠️ 错误: 容器启动超时。${NC}`);
                process.exit(1);
            }
        }
    }
}

async function createNewContainer() {
    if ( !(QUIET.cnew || QUIET.full) ) console.log(`${CYAN}📦 manyoyo by xcanwin 正在创建新容器: ${YELLOW}${CONTAINER_NAME}${NC}`);

    EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}`;
    const defaultCommand = EXEC_COMMAND;

    // Build docker run command
    const fullImage = `${IMAGE_NAME}:${IMAGE_VERSION}`;
    const envArgs = CONTAINER_ENVS.join(' ');
    const volumeArgs = CONTAINER_VOLUMES.join(' ');
    const contModeArg = CONT_MODE || '';

    const dockerRunCmd = `${DOCKER_CMD} run -d --name "${CONTAINER_NAME}" --entrypoint "" ${contModeArg} ${envArgs} ${volumeArgs} --volume "${HOST_PATH}:${CONTAINER_PATH}" --workdir "${CONTAINER_PATH}" --label "manyoyo.default_cmd=${EXEC_COMMAND}" "${fullImage}" tail -f /dev/null`;

    dockerExec(dockerRunCmd, { stdio: 'pipe' });

    // Wait for container to be ready
    await waitForContainerReady(CONTAINER_NAME);

    return defaultCommand;
}

async function connectExistingContainer() {
    if ( !(QUIET.cnew || QUIET.full) ) console.log(`${CYAN}🔄 manyoyo by xcanwin 正在连接到现有容器: ${YELLOW}${CONTAINER_NAME}${NC}`);

    // Start container if stopped
    const status = getContainerStatus(CONTAINER_NAME);
    if (status !== 'running') {
        dockerExec(`${DOCKER_CMD} start "${CONTAINER_NAME}"`, { stdio: 'pipe' });
    }

    // Get default command from label
    const defaultCommand = dockerExec(`${DOCKER_CMD} inspect -f '{{index .Config.Labels "manyoyo.default_cmd"}}' "${CONTAINER_NAME}"`).trim();

    if (!EXEC_COMMAND) {
        EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${defaultCommand}${EXEC_COMMAND_SUFFIX}`;
    } else {
        EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}`;
    }

    return defaultCommand;
}

async function setupContainer() {
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

async function handlePostExit(defaultCommand) {
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
// Main Function
// ==============================================================================

async function main() {
    try {
        // 1. Setup commander and parse arguments
        setupCommander();

        // 2. Handle image build operation
        if (IMAGE_BUILD_NEED) {
            await buildImage(IMAGE_BUILD_ARGS, IMAGE_NAME, IMAGE_VERSION.split('-')[0]);
            process.exit(0);
        }

        // 3. Handle remove container operation
        handleRemoveContainer();

        // 4. Validate host path safety
        validateHostPath();

        // 5. Setup container (create or connect)
        const defaultCommand = await setupContainer();

        // 6. Execute command in container
        executeInContainer(defaultCommand);

        // 7. Handle post-exit interactions
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
