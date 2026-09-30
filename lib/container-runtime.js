'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const INFO_TIMEOUT_MS = 3000;
const VERSION_TIMEOUT_MS = 5000;
const SUPPORTED_RUNTIMES = ['docker', 'podman'];

function getPrivatePodmanPaths(homeDir = os.homedir()) {
    const root = path.join(homeDir, '.manyoyo', 'runtime', 'podman');
    return {
        root,
        bin: path.join(root, 'bin', 'podman'),
        configHome: path.join(root, 'config'),
        dataHome: path.join(root, 'data'),
        containersConf: path.join(root, 'containers.conf')
    };
}

function ensurePrivatePodmanConfig(paths) {
    fs.mkdirSync(paths.configHome, { recursive: true });
    fs.mkdirSync(paths.dataHome, { recursive: true });
    if (!fs.existsSync(paths.containersConf)) {
        const helperDir = JSON.stringify(path.dirname(paths.bin));
        fs.writeFileSync(paths.containersConf, `[engine]\nhelper_binaries_dir = [${helperDir}]\n`);
    }
}

function normalizeConfigured(configured) {
    const value = String(configured || '').trim().toLowerCase();
    if (!value || value === 'auto') return '';
    if (!SUPPORTED_RUNTIMES.includes(value)) {
        throw new Error(`containerRuntime 无效: ${configured}（可选 auto / docker / podman）`);
    }
    return value;
}

// 不启动任何子进程：用户显式配置 > 私有 Podman；都没有返回 null。
function resolveForcedRuntime(options = {}) {
    const configured = normalizeConfigured(options.configured);
    if (configured) {
        return { command: configured, env: {}, source: 'config' };
    }
    const paths = getPrivatePodmanPaths(options.homeDir);
    if (fs.existsSync(paths.bin)) {
        ensurePrivatePodmanConfig(paths);
        return {
            command: paths.bin,
            env: {
                XDG_CONFIG_HOME: paths.configHome,
                XDG_DATA_HOME: paths.dataHome,
                CONTAINERS_CONF: paths.containersConf
            },
            source: 'private-podman'
        };
    }
    return null;
}

function defaultRun(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: options.timeout,
        env: options.env
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`);
    }
    return result.stdout || '';
}

function succeeds(run, command, args, timeout) {
    try {
        run(command, args, { timeout });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * 选择容器运行时。
 * 优先级：containerRuntime 配置 > 私有 Podman > daemon 可用的 docker > daemon 可用的 podman
 *        > 仅 --version 可用的第一个 > 抛错。
 * @returns {{command: string, env: Object<string,string>, source: string}}
 */
function selectContainerRuntime(options = {}) {
    const forced = resolveForcedRuntime(options);
    if (forced) return forced;

    const run = typeof options.run === 'function' ? options.run : defaultRun;
    for (const name of SUPPORTED_RUNTIMES) {
        if (succeeds(run, name, ['info'], INFO_TIMEOUT_MS)) {
            return { command: name, env: {}, source: `${name}-daemon` };
        }
    }
    for (const name of SUPPORTED_RUNTIMES) {
        if (succeeds(run, name, ['--version'], VERSION_TIMEOUT_MS)) {
            return { command: name, env: {}, source: 'version-only' };
        }
    }
    throw new Error('未找到可用的容器运行时 (docker/podman not found)：请安装并启动 Docker Desktop 或 Podman。');
}

// 只给运行时子进程用：env 为空时返回 undefined（子进程照常继承 process.env）。
function mergeRuntimeEnv(env, base = process.env) {
    if (!env || Object.keys(env).length === 0) return undefined;
    return { ...base, ...env };
}

module.exports = {
    selectContainerRuntime,
    resolveForcedRuntime,
    getPrivatePodmanPaths,
    mergeRuntimeEnv
};
