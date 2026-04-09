'use strict';

const { spawnSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { startWebServer } = require('../web/server');
const { readManyoyoConfig } = require('../global-config');
const { resolveRuntimeConfig } = require('../runtime-resolver');
const { normalizeVolume, parseEnvEntry } = require('../runtime-normalizers');
const { imageVersion: IMAGE_VERSION_DEFAULT } = require('../../package.json');

const IMAGE_VERSION_BASE = String(IMAGE_VERSION_DEFAULT || '1.0.0').split('-')[0];
const DEFAULT_IMAGE_VERSION = IMAGE_VERSION_DEFAULT || `${IMAGE_VERSION_BASE}-common`;
const DEFAULT_IMAGE_NAME = 'localhost/xcanwin/manyoyo';
const DEFAULT_SERVER_HOST = '127.0.0.1';
const DEFAULT_SHELL_PATH = '/bin/bash';
const SAFE_CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CONTAINER_READY_MAX_RETRIES = 30;
const CONTAINER_READY_INITIAL_DELAY = 100;
const CONTAINER_READY_MAX_DELAY = 2000;

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

function formatDate() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    return `${month}${day}-${hour}${minute}`;
}

function pickConfigValue() {
    for (let i = 0; i < arguments.length; i += 1) {
        const value = arguments[i];
        if (value) {
            return value;
        }
    }
    return undefined;
}

function mergeArrayConfig(globalValue, runValue, cliValue) {
    return [...(globalValue || []), ...(runValue || []), ...(cliValue || [])];
}

function normalizeCommandSuffix(suffix) {
    if (typeof suffix !== 'string') return '';
    const trimmed = suffix.trim();
    return trimmed ? ` ${trimmed}` : '';
}

function resolveContainerNameTemplate(name) {
    if (typeof name !== 'string') {
        return name;
    }
    const nowValue = formatDate();
    return name.replace(/\{now\}|\$\{now\}/g, nowValue);
}

function normalizeJsonEnvMap(envConfig, sourceLabel) {
    if (envConfig === undefined || envConfig === null) {
        return {};
    }
    if (typeof envConfig !== 'object' || Array.isArray(envConfig)) {
        throw new Error(`${sourceLabel} 的 env 必须是对象(map)`);
    }

    const envMap = {};
    for (const [key, rawValue] of Object.entries(envConfig)) {
        if (rawValue !== null && !['string', 'number', 'boolean'].includes(typeof rawValue)) {
            throw new Error(`${sourceLabel} 的 env.${key} 必须是 string/number/boolean/null`);
        }
        const parsed = parseEnvEntry(`${key}=${rawValue === null ? '' : String(rawValue)}`);
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

function parseServerListenForElectron() {
    return {
        host: DEFAULT_SERVER_HOST,
        port: 0
    };
}

function resolveContainerModeArgs(mode) {
    const normalized = String(mode || '').trim().toLowerCase();
    if (!normalized || normalized === 'common') {
        return [];
    }
    if (normalized === 'dind' || normalized === 'docker-in-docker' || normalized === 'd') {
        return ['--privileged'];
    }
    if (normalized === 'sock' || normalized === 'mount-docker-socket' || normalized === 's') {
        return [
            '--privileged',
            '--volume', '/var/run/docker.sock:/var/run/docker.sock',
            '--env', 'DOCKER_HOST=unix:///var/run/docker.sock',
            '--env', 'CONTAINER_HOST=unix:///var/run/docker.sock'
        ];
    }
    throw new Error(`未知 containerMode: ${mode}`);
}

function resolveYoloCommand(yolo) {
    const key = String(yolo || '').trim().toLowerCase();
    if (!key) {
        return '';
    }
    const command = YOLO_COMMAND_MAP[key];
    if (!command) {
        throw new Error(`未知 yolo 值: ${yolo}`);
    }
    return command;
}

function buildEnvArgs(envMap, envFiles) {
    const args = [];
    Object.entries(envMap || {}).forEach(([key, value]) => {
        args.push('--env', `${key}=${value}`);
    });

    for (const envFile of (envFiles || [])) {
        const filePath = String(envFile || '').trim();
        if (!filePath) continue;
        if (!path.isAbsolute(filePath)) {
            throw new Error(`envFile 仅支持绝对路径: ${filePath}`);
        }
        if (!fs.existsSync(filePath)) {
            throw new Error(`未找到环境文件: ${filePath}`);
        }

        const content = fs.readFileSync(filePath, 'utf-8');
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
    }
    return args;
}

function buildVolumeArgs(volumes) {
    const args = [];
    for (const volume of (volumes || [])) {
        args.push('--volume', String(volume));
    }
    return args;
}

function buildPortArgs(ports) {
    const args = [];
    for (const port of (ports || [])) {
        args.push('--publish', String(port));
    }
    return args;
}

function isValidContainerName(value) {
    return typeof value === 'string' && SAFE_CONTAINER_NAME_PATTERN.test(value);
}

function validateHostPathOrThrow(hostPath) {
    if (!hostPath || !fs.existsSync(hostPath)) {
        throw new Error(`宿主机路径不存在: ${hostPath}`);
    }
    const realHostPath = fs.realpathSync(hostPath);
    const homeDir = process.env.HOME || os.homedir() || '/home';
    if (realHostPath === '/' || realHostPath === '/home' || realHostPath === homeDir) {
        throw new Error('不允许挂载根目录或home目录。');
    }
}

function runCmd(cmd, args, options = {}) {
    const result = spawnSync(cmd, args, { encoding: 'utf-8', ...options });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        const err = new Error(`Command failed: ${cmd} ${args.join(' ')}`);
        err.stdout = result.stdout;
        err.stderr = result.stderr;
        err.status = result.status;
        throw err;
    }
    return result.stdout || '';
}

function detectContainerRuntime() {
    const commands = ['docker', 'podman'];
    for (const cmd of commands) {
        try {
            runCmd(cmd, ['--version'], { stdio: 'pipe' });
            return cmd;
        } catch (e) {
            // try next runtime
        }
    }
    throw new Error('未找到 docker/podman，请先安装容器运行时并确保 PATH 可用。');
}

function dockerExecArgs(dockerCmd, args, options = {}) {
    return runCmd(dockerCmd, args, options);
}

function containerExists(dockerCmd, name) {
    const containers = dockerExecArgs(dockerCmd, ['ps', '-a', '--format', '{{.Names}}']);
    return containers.split('\n').some(item => item.trim() === name);
}

function getContainerStatus(dockerCmd, name) {
    return dockerExecArgs(dockerCmd, ['inspect', '-f', '{{.State.Status}}', name]).trim();
}

function removeContainer(dockerCmd, name) {
    dockerExecArgs(dockerCmd, ['rm', '-f', name], { stdio: 'pipe' });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForContainerReady(dockerCmd, containerName) {
    let retryDelay = CONTAINER_READY_INITIAL_DELAY;

    for (let count = 0; count < CONTAINER_READY_MAX_RETRIES; count += 1) {
        try {
            const status = getContainerStatus(dockerCmd, containerName);
            if (status === 'running') {
                return;
            }
            if (status === 'exited') {
                const logs = dockerExecArgs(dockerCmd, ['logs', containerName], { stdio: 'pipe' });
                throw new Error(`容器启动后立即退出。\n${logs}`);
            }
        } catch (e) {
            if (count === CONTAINER_READY_MAX_RETRIES - 1) {
                throw e;
            }
        }
        await sleep(retryDelay);
        retryDelay = Math.min(retryDelay * 2, CONTAINER_READY_MAX_DELAY);
    }

    throw new Error('容器启动超时。');
}

function showImagePullHint(err) {
    const stderr = err && err.stderr ? String(err.stderr) : '';
    const stdout = err && err.stdout ? String(err.stdout) : '';
    const message = err && err.message ? String(err.message) : '';
    const combined = `${message}\n${stderr}\n${stdout}`;
    if (/localhost\/v2|pinging container registry localhost|connection refused|dial tcp .*:443/i.test(combined)) {
        console.log(`[manyoyo-electron] 提示: 本地镜像缺失或 localhost 注册表不可用，请先确认 imageVersion 或执行 manyoyo build。`);
    }
}

function createLogger() {
    return {
        info(message, extra) {
            if (extra !== undefined) {
                console.log(`[manyoyo-electron] ${message}`, extra);
                return;
            }
            console.log(`[manyoyo-electron] ${message}`);
        },
        warn(message, extra) {
            if (extra !== undefined) {
                console.warn(`[manyoyo-electron] ${message}`, extra);
                return;
            }
            console.warn(`[manyoyo-electron] ${message}`);
        },
        error(message, extra) {
            if (extra !== undefined) {
                console.error(`[manyoyo-electron] ${message}`, extra);
                return;
            }
            console.error(`[manyoyo-electron] ${message}`);
        }
    };
}

function buildDefaultOptions() {
    const candidates = [
        process.cwd(),
        path.join(os.homedir(), 'Desktop'),
        path.join(os.homedir(), 'Documents')
    ];
    let hostPath = process.cwd();
    for (const candidate of candidates) {
        const text = String(candidate || '').trim();
        if (!text) {
            continue;
        }
        try {
            if (fs.existsSync(text) && fs.realpathSync(text) !== os.homedir()) {
                hostPath = text;
                break;
            }
        } catch (e) {
            // try next candidate
        }
    }
    return {
        hostPath,
        containerName: `my-${formatDate()}`,
        containerPath: hostPath,
        imageName: DEFAULT_IMAGE_NAME,
        imageVersion: DEFAULT_IMAGE_VERSION
    };
}

function buildRuntimeConfig() {
    const configResult = readManyoyoConfig();
    if (configResult.parseError) {
        throw new Error(`~/.manyoyo/manyoyo.json 解析失败: ${configResult.parseError.message || String(configResult.parseError)}`);
    }
    const globalConfig = configResult && configResult.config && typeof configResult.config === 'object'
        ? configResult.config
        : {};

    return resolveRuntimeConfig({
        cliOptions: { server: true },
        globalConfig,
        runConfig: {},
        globalFirstConfig: {},
        runFirstConfig: {},
        defaults: buildDefaultOptions(),
        envVars: process.env,
        pickConfigValue,
        resolveContainerNameTemplate,
        normalizeCommandSuffix,
        normalizeJsonEnvMap,
        normalizeCliEnvMap,
        mergeArrayConfig,
        normalizeVolume,
        parseServerListen: parseServerListenForElectron,
        argv: [],
        isServerMode: true,
        isServerStopMode: false
    });
}

function resolveExecCommand(runtimeConfig) {
    const exec = runtimeConfig && runtimeConfig.exec ? runtimeConfig.exec : {};
    const shell = String(exec.shell || '').trim();
    if (shell) {
        return {
            prefix: exec.prefix || '',
            command: shell,
            suffix: exec.suffix || ''
        };
    }
    const yoloCommand = resolveYoloCommand(runtimeConfig && runtimeConfig.yolo);
    return {
        prefix: '',
        command: yoloCommand,
        suffix: ''
    };
}

async function getMacShellPathValue() {
    if (process.platform !== 'darwin') {
        return '';
    }
    return new Promise(resolve => {
        execFile(DEFAULT_SHELL_PATH, ['-lc', 'printf %s "$PATH"'], { encoding: 'utf-8' }, (error, stdout) => {
            if (error) {
                resolve('');
                return;
            }
            resolve(String(stdout || '').trim());
        });
    });
}

async function prepareDesktopEnvironment() {
    const shellPath = await getMacShellPathValue();
    const fallbackPaths = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/opt/podman/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin'
    ];
    const currentPath = String(process.env.PATH || '').split(':').filter(Boolean);
    const merged = [
        ...String(shellPath || '').split(':').filter(Boolean),
        ...currentPath,
        ...fallbackPaths
    ];
    process.env.PATH = Array.from(new Set(merged)).join(':');
}

async function startElectronWebServer(options = {}) {
    await prepareDesktopEnvironment();

    const runtimeConfig = buildRuntimeConfig();
    const execCommand = resolveExecCommand(runtimeConfig);
    const dockerCmd = detectContainerRuntime();
    const authUser = options.authUser || `manyoyo_${crypto.randomBytes(4).toString('hex')}`;
    const authPass = options.authPass || crypto.randomBytes(18).toString('hex');
    const logger = createLogger();

    const containerEnvs = buildEnvArgs(runtimeConfig.env, runtimeConfig.envFile);
    const containerVolumes = buildVolumeArgs(runtimeConfig.volumes);
    const containerPorts = buildPortArgs(runtimeConfig.ports);
    const contModeArgs = resolveContainerModeArgs(runtimeConfig.containerMode);

    const handle = await startWebServer({
        serverHost: DEFAULT_SERVER_HOST,
        serverPort: 0,
        authUser,
        authPass,
        authPassAuto: false,
        dockerCmd,
        hostPath: runtimeConfig.hostPath,
        containerPath: runtimeConfig.containerPath,
        imageName: runtimeConfig.imageName,
        imageVersion: runtimeConfig.imageVersion,
        execCommandPrefix: execCommand.prefix,
        execCommand: execCommand.command,
        execCommandSuffix: execCommand.suffix,
        contModeArgs,
        containerExtraArgs: [],
        containerEnvs,
        containerVolumes,
        containerPorts,
        validateHostPath: validateHostPathOrThrow,
        formatDate,
        isValidContainerName,
        containerExists: name => containerExists(dockerCmd, name),
        getContainerStatus: name => getContainerStatus(dockerCmd, name),
        waitForContainerReady: name => waitForContainerReady(dockerCmd, name),
        dockerExecArgs: (args, runtimeOptions) => dockerExecArgs(dockerCmd, args, runtimeOptions),
        showImagePullHint,
        removeContainer: name => removeContainer(dockerCmd, name),
        webHistoryDir: path.join(os.homedir(), '.manyoyo', 'web-history'),
        colors: {
            RED: '',
            GREEN: '',
            YELLOW: '',
            BLUE: '',
            CYAN: '',
            NC: ''
        },
        logger
    });

    return {
        ...handle,
        authUser,
        authPass,
        url: `http://${handle.host}:${handle.port}`
    };
}

module.exports = {
    startElectronWebServer,
    prepareDesktopEnvironment
};
