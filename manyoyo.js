#!/usr/bin/env node

// ==============================================================================
// MANYOYO - AI Agent CLI Sandbox
// ==============================================================================

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

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
const BIN_VERSION = "2.0.0";
let CONTAINER_NAME = `myy-${formatDate()}`;
let HOST_PATH = process.cwd();
let CONTAINER_PATH = HOST_PATH;
let IMAGE_NAME = "localhost/xcanwin/manyoyo";
let IMAGE_VERSION = "1.4.0-all";
let EXEC_COMMAND = "";
let EXEC_COMMAND_PREFIX = "";
let EXEC_COMMAND_SUFFIX = "";
let ENV_FILE = "";
let SHOULD_REMOVE = false;
let CONTAINER_ENVS = [];
let CONTAINER_VOLUMES = [];
let MANYOYO_NAME = "manyoyo";
let CONT_MODE = "";

// Color definitions using ANSI codes
const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const CYAN = '\x1b[0;36m';
const NC = '\x1b[0m'; // No Color

// Docker command (will be set by ensure_docker)
let DOCKER_CMD = 'docker';

function show_help() {
    console.log(`${BLUE}Usage:${NC}`);
    console.log(`  ${MANYOYO_NAME} [OPTIONS]`);
    console.log(`  ${MANYOYO_NAME} [--hp HOST_PATH] [-n CONTAINER_NAME] [--cp CONTAINER_PATH] [--ef ENV_FILE] [--sp COMMAND] [-s COMMAND] [-- COMMAND]`);
    console.log("");
    console.log(`${BLUE}Options:${NC}`);
    console.log("  -l|--ls|--list                 列举容器");
    console.log("  --hp|--host-path PATH          设置宿主机工作目录 (默认当前路径)");
    console.log("  -n|--cn|--cont-name NAME       设置容器名称");
    console.log("  --cp|--cont-path PATH          设置容器工作目录");
    console.log("  --in|--image-name NAME         指定镜像名称");
    console.log("  --iv|--image-ver VERSION       指定镜像版本");
    console.log("  -e|--env STRING                设置环境变量");
    console.log("  --ef|--env-file ENV_FILE       设置环境变量通过文件");
    console.log("  -v|--volume STRING             绑定挂载卷");
    console.log("  --rm|--remove-cont             删除-n容器");
    console.log("  --sp|--shell-prefix COMMAND    临时环境变量 (作为-s前缀)");
    console.log("  -s|--shell COMMAND             指定命令执行");
    console.log("  --|--shell-suffix COMMAND      指定命令参数, --后面全部直传 (作为-s后缀)");
    console.log("  -x|--shell-full COMMAND        指定完整命令执行, -x后面全部直传 (代替--sp和-s和--命令)");
    console.log("  -y|--yolo CLI                  使AGENT无需确认 (代替-s命令)");
    console.log("                                 例如 claude / c, gemini / gm, codex / cx, opencode / oc");
    console.log("  -m|--cm|--cont-mode STRING     设置容器嵌套容器模式");
    console.log("                                 例如 common, dind, mdsock");
    console.log("  --install NAME                 安装manyoyo命令");
    console.log("                                 例如 manyoyo, myy, docker-cli-plugin");
    console.log("  -V|--version                   显示版本");
    console.log("  -h|--help                      显示帮助");
    console.log("");
    console.log(`${BLUE}Example:${NC}`);
    console.log(`  ./${MANYOYO_NAME}.sh --install manyoyo              安装manyoyo命令`);
    console.log(`  ${MANYOYO_NAME} -n test --ef ./xxx.env -y c         设置环境变量并运行无需确认的AGENT`);
    console.log(`  ${MANYOYO_NAME} -n test -- -c                       恢复之前会话`);
    console.log(`  ${MANYOYO_NAME} -x echo 123                         指定命令执行`);
    console.log(`  ${MANYOYO_NAME} -n test --ef ./xxx.env -x claude    设置环境变量并运行`);
    console.log(`  ${MANYOYO_NAME} -n test -x claude -c                恢复之前会话`);
}

function ensure_docker() {
    try {
        execSync('docker --version', { stdio: 'pipe' });
        DOCKER_CMD = 'docker';
        return true;
    } catch (e) {
        try {
            execSync('podman --version', { stdio: 'pipe' });
            DOCKER_CMD = 'podman';
            return true;
        } catch (e2) {
            console.error("docker/podman not found");
            process.exit(1);
        }
    }
}

function install_manyoyo(name) {
    const MANYOYO_FILE = fs.realpathSync(__filename);
    switch (name) {
        case 'manyoyo':
            execSync(`sudo ln -f -s "${MANYOYO_FILE}" /usr/local/bin/manyoyo`, { stdio: 'inherit' });
            break;
        case 'myy':
            execSync(`sudo ln -f -s "${MANYOYO_FILE}" /usr/local/bin/myy`, { stdio: 'inherit' });
            break;
        case 'docker-cli-plugin':
            execSync(`mkdir -p "$HOME/.docker/cli-plugins/"`, { stdio: 'inherit' });
            execSync(`sudo ln -f -s "${MANYOYO_FILE}" "$HOME/.docker/cli-plugins/docker-manyoyo"`, { stdio: 'inherit' });
            break;
        default:
            console.log("");
    }
    process.exit(0);
}

function show_version() {
    console.log(`manyoyo by xcanwin, ${BIN_VERSION}`);
}

function set_yolo(cli) {
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

function set_cont_mode(mode) {
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
        case 'mdsock':
        case 's':
            CONT_MODE = "--volume /var/run/docker.sock:/var/run/docker.sock";
            console.log(`${RED}⚠️ 开启危险的容器嵌套容器模式, 危害: 容器可访问宿主机文件${NC}`);
            break;
        default:
            console.log(`${RED}⚠️ 未知模式: ${mode}${NC}`);
            process.exit(0);
    }
}

function get_cont_list() {
    try {
        const result = execSync(`${DOCKER_CMD} ps -a --size --filter "ancestor=manyoyo" --filter "ancestor=$(${DOCKER_CMD} images -a --format '{{.Repository}}:{{.Tag}}' | grep manyoyo)" --format "table {{.Names}}\\t{{.Status}}\\t{{.Size}}\\t{{.ID}}\\t{{.Image}}\\t{{.Ports}}\\t{{.Networks}}\\t{{.Mounts}}"`,
            { encoding: 'utf-8' });
        console.log(result);
    } catch (e) {
        console.log(e.stdout || '');
    }
}

function add_volume(volume) {
    CONTAINER_VOLUMES.push("--volume", volume);
}

function add_env(env) {
    CONTAINER_ENVS.push("--env", env);
}

function add_env_file(envFile) {
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

function get_hello_tip(containerName, defaultCommand) {
    console.log(`${BLUE}----------------------------------------${NC}`);
    console.log(`📦 首次命令        : ${defaultCommand}`);
    console.log(`⚫ 恢复首次命令会话: ${CYAN}${MANYOYO_NAME} -n ${containerName} -- -c${NC}`);
    console.log(`⚫ 执行首次命令    : ${GREEN}${MANYOYO_NAME} -n ${containerName}${NC}`);
    console.log(`⚫ 执行指定命令    : ${GREEN}${MANYOYO_NAME} -n ${containerName} -x /bin/bash${NC}`);
    console.log(`⚫ 执行指定命令    : ${GREEN}docker exec -it ${containerName} /bin/bash${NC}`);
    console.log(`⚫ 删除容器        : ${MANYOYO_NAME} -n ${containerName} --rm`);
    console.log("");
}

function docker_exec(cmd, options = {}) {
    try {
        return execSync(cmd, { encoding: 'utf-8', ...options });
    } catch (e) {
        if (options.ignoreError) {
            return e.stdout || '';
        }
        throw e;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

async function main() {
    // Check if no arguments provided
    if (process.argv.length <= 2) {
        show_help();
        process.exit(1);
    }

    // Ensure docker/podman is available
    ensure_docker();

    // Docker CLI plugin metadata
    if (process.argv[2] === 'docker-cli-plugin-metadata') {
        const metadata = {
            "SchemaVersion": "0.1.0",
            "Vendor": "xcanwin",
            "Version": "v1.0.0",
            "Description": "AI Agent CLI Sandbox"
        };
        console.log(JSON.stringify(metadata, null, 2));
        process.exit(0);
    }

    // Parse arguments
    let args = process.argv.slice(2);

    // Docker CLI plugin mode - remove first arg if running as plugin
    const dockerPluginPath = path.join(process.env.HOME || '', '.docker/cli-plugins/docker-manyoyo');
    if (process.argv[1] === dockerPluginPath && args[0] === 'manyoyo') {
        args.shift();
    }

    // Parse command-line arguments
    let i = 0;
    while (i < args.length) {
        const arg = args[i];

        switch (arg) {
            case '-l':
            case '--ls':
            case '--list':
                get_cont_list();
                process.exit(0);

            case '--hp':
            case '--host-path':
                HOST_PATH = args[i + 1];
                i += 2;
                break;

            case '-n':
            case '--cn':
            case '--cont-name':
                CONTAINER_NAME = args[i + 1];
                i += 2;
                break;

            case '--cp':
            case '--cont-path':
                CONTAINER_PATH = args[i + 1];
                i += 2;
                break;

            case '--in':
            case '--image-name':
                IMAGE_NAME = args[i + 1];
                i += 2;
                break;

            case '--iv':
            case '--image-ver':
                IMAGE_VERSION = args[i + 1];
                i += 2;
                break;

            case '-e':
            case '--env':
                add_env(args[i + 1]);
                i += 2;
                break;

            case '--ef':
            case '--env-file':
                add_env_file(args[i + 1]);
                i += 2;
                break;

            case '-v':
            case '--volume':
                add_volume(args[i + 1]);
                i += 2;
                break;

            case '--rm':
            case '--rmc':
            case '--remove-cont':
                SHOULD_REMOVE = true;
                i += 1;
                break;

            case '--sp':
            case '--shell-prefix':
                EXEC_COMMAND_PREFIX = args[i + 1] + " ";
                i += 2;
                break;

            case '-s':
            case '--shell':
                EXEC_COMMAND = args[i + 1];
                i += 2;
                break;

            case '--':
            case '--ss':
            case '--shell-suffix':
                EXEC_COMMAND_SUFFIX = " " + args.slice(i + 1).join(' ');
                i = args.length;
                break;

            case '-x':
            case '--sf':
            case '--shell-full':
                EXEC_COMMAND = args.slice(i + 1).join(' ');
                i = args.length;
                break;

            case '-y':
            case '--yolo':
                set_yolo(args[i + 1]);
                i += 2;
                break;

            case '-m':
            case '--cm':
            case '--cont-mode':
                set_cont_mode(args[i + 1]);
                i += 2;
                break;

            case '--install':
                install_manyoyo(args[i + 1]);
                process.exit(0);

            case '-V':
            case '--version':
                show_version();
                process.exit(0);

            case '-h':
            case '--help':
                show_help();
                process.exit(0);

            default:
                console.log(`${RED}⚠️ 未知参数: ${arg}${NC}`);
                show_help();
                process.exit(1);
        }
    }

    // Handle remove logic
    if (SHOULD_REMOVE) {
        try {
            const containers = docker_exec(`${DOCKER_CMD} ps -a --format '{{.Names}}'`);
            if (containers.split('\n').some(name => name.trim() === CONTAINER_NAME)) {
                console.log(`${YELLOW}🗑️ 正在删除容器: ${CONTAINER_NAME}...${NC}`);
                docker_exec(`${DOCKER_CMD} rm -f "${CONTAINER_NAME}"`, { stdio: 'pipe' });
                console.log(`${GREEN}✅ 已彻底删除。${NC}`);
            } else {
                console.log(`${RED}⚠️ 错误: 未找到名为 ${CONTAINER_NAME} 的容器。${NC}`);
            }
        } catch (e) {
            console.log(`${RED}⚠️ 错误: 未找到名为 ${CONTAINER_NAME} 的容器。${NC}`);
        }
        process.exit(0);
    }

    // Safety check
    const realHostPath = fs.realpathSync(HOST_PATH);
    const homeDir = process.env.HOME || '/home';
    if (realHostPath === '/' || realHostPath === '/home' || realHostPath === homeDir) {
        console.log(`${RED}⚠️ 错误: 不允许挂载根目录或home目录。${NC}`);
        process.exit(1);
    }

    const FULL_IMAGE = `${IMAGE_NAME}:${IMAGE_VERSION}`;
    let DEFAULT_COMMAND = "";

    // Check if container exists
    try {
        const containers = docker_exec(`${DOCKER_CMD} ps -a --format '{{.Names}}'`);
        const containerExists = containers.split('\n').some(name => name.trim() === CONTAINER_NAME);

        if (!containerExists) {
            // Create new container
            console.log(`${CYAN}📦 manyoyo by xcanwin 正在创建新容器: ${YELLOW}${CONTAINER_NAME}${NC}\n`);
            EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}`;
            DEFAULT_COMMAND = EXEC_COMMAND;

            // Build docker run command
            const envArgs = CONTAINER_ENVS.join(' ');
            const volumeArgs = CONTAINER_VOLUMES.join(' ');
            const contModeArg = CONT_MODE ? CONT_MODE : '';

            const dockerRunCmd = `${DOCKER_CMD} run -d --name "${CONTAINER_NAME}" --entrypoint "" ${contModeArg} ${envArgs} ${volumeArgs} --volume "${HOST_PATH}:${CONTAINER_PATH}" --workdir "${CONTAINER_PATH}" --label "manyoyo.default_cmd=${EXEC_COMMAND}" "${FULL_IMAGE}" tail -f /dev/null`;

            docker_exec(dockerRunCmd, { stdio: 'pipe' });

            // Wait for container to be ready
            const MAX_RETRIES = 50;
            let count = 0;
            while (true) {
                try {
                    const status = docker_exec(`${DOCKER_CMD} inspect -f '{{.State.Status}}' "${CONTAINER_NAME}"`).trim();

                    if (status === 'running') {
                        break;
                    }

                    if (status === 'exited') {
                        console.log(`${RED}⚠️ 错误: 容器启动后立即退出。${NC}`);
                        docker_exec(`${DOCKER_CMD} logs "${CONTAINER_NAME}"`, { stdio: 'inherit' });
                        process.exit(1);
                    }

                    await sleep(100);
                    count++;

                    if (count >= MAX_RETRIES) {
                        console.log(`${RED}⚠️ 错误: 容器启动超时（当前状态: ${status}）。${NC}`);
                        docker_exec(`${DOCKER_CMD} logs "${CONTAINER_NAME}"`, { stdio: 'inherit' });
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
        } else {
            // Container exists
            console.log(`${CYAN}🔄 manyoyo by xcanwin 正在连接到现有容器: ${YELLOW}${CONTAINER_NAME}${NC}`);

            // Start container if stopped
            const status = docker_exec(`${DOCKER_CMD} inspect -f '{{.State.Status}}' "${CONTAINER_NAME}"`).trim();
            if (status !== 'running') {
                docker_exec(`${DOCKER_CMD} start "${CONTAINER_NAME}"`, { stdio: 'pipe' });
            }

            // Get default command from label
            DEFAULT_COMMAND = docker_exec(`${DOCKER_CMD} inspect -f '{{index .Config.Labels "manyoyo.default_cmd"}}' "${CONTAINER_NAME}"`).trim();

            if (!EXEC_COMMAND) {
                EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${DEFAULT_COMMAND}${EXEC_COMMAND_SUFFIX}`;
            } else {
                EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}`;
            }
        }

        get_hello_tip(CONTAINER_NAME, DEFAULT_COMMAND);
        console.log(`${BLUE}----------------------------------------${NC}`);
        console.log(`💻 执行命令: ${YELLOW}${EXEC_COMMAND || '交互式 Shell'}${NC}`);

        // Execute command in container
        if (EXEC_COMMAND) {
            spawnSync(`${DOCKER_CMD}`, ['exec', '-it', CONTAINER_NAME, '/bin/bash', '-c', EXEC_COMMAND], { stdio: 'inherit' });
        } else {
            spawnSync(`${DOCKER_CMD}`, ['exec', '-it', CONTAINER_NAME, '/bin/bash'], { stdio: 'inherit' });
        }

        // Post-exit prompt
        console.log("");
        get_hello_tip(CONTAINER_NAME, DEFAULT_COMMAND);

        const reply = await askQuestion(`❔ 会话已结束。是否保留此后台容器 ${CONTAINER_NAME}? [ y=默认保留, n=删除, 1=首次命令进入, s=执行命令, i=交互式SHELL ]: `);
        console.log("");

        const firstChar = reply.trim().toLowerCase()[0];

        if (firstChar === 'n') {
            console.log(`${YELLOW}🗑️ 正在删除容器...${NC}`);
            docker_exec(`${DOCKER_CMD} rm -f "${CONTAINER_NAME}"`, { stdio: 'pipe' });
            console.log(`${GREEN}✅ 已彻底删除。${NC}`);
        } else if (firstChar === '1') {
            console.log(`${GREEN}✅ 离开当前连接，用首次命令进入。${NC}`);
            // Reconstruct the command and execute recursively
            const newArgs = ['-n', CONTAINER_NAME];
            process.argv = [process.argv[0], process.argv[1], ...newArgs];
            await main();
        } else if (firstChar === 's') {
            const command = await askQuestion('❔ 输入要执行的命令: ');
            console.log(`${GREEN}✅ 离开当前连接，执行命令。${NC}`);
            const newArgs = ['-n', CONTAINER_NAME, '-x', command];
            process.argv = [process.argv[0], process.argv[1], ...newArgs];
            await main();
        } else if (firstChar === 'i') {
            console.log(`${GREEN}✅ 离开当前连接，进入容器交互式SHELL。${NC}`);
            const newArgs = ['-n', CONTAINER_NAME, '-x', '/bin/bash'];
            process.argv = [process.argv[0], process.argv[1], ...newArgs];
            await main();
        } else {
            console.log(`${GREEN}✅ 已退出连接。容器 ${CONTAINER_NAME} 仍在后台运行。${NC}`);
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
