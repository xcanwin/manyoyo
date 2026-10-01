'use strict';

const path = require('path');
const { spawn } = require('child_process');

// 离线安装器给私有 Podman 建的 machine 名字；列表里有它就优先启动它
const PRIVATE_MACHINE_NAME = 'podman-machine-manyoyo';
// 冷启动或磁盘忙时 info 可能超过 3 秒但 daemon 是好的
const PROBE_TIMEOUT_MS = 10000;
const DEFAULT_READY_TIMEOUT_MS = 120000;
const DEFAULT_POLL_MS = 2000;

function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 运行时 daemon 不可用时尝试自愈：
 * - Podman：machine 已存在但未运行 → podman machine start
 * - macOS 上的 Docker：open -a Docker 并等待就绪
 * 其余情况只报告，不猜。
 *
 * @param {Object} options
 * @param {{command: string, env?: Object}} options.runtime selectContainerRuntime 的结果
 * @param {(command: string, args: string[], opts: {env?: Object, timeout?: number}) => string|Promise<string>} options.run 执行器（同步或异步均可），失败抛错；serve 里必须传异步实现，避免阻塞事件循环
 * @param {(state: {status: string, message: string}) => void} [options.onStatus]
 * @returns {Promise<{status: 'ready'|'started'|'unavailable'|'failed'|'timeout', message: string}>}
 */
async function ensureRuntimeReady(options) {
    const { runtime, run } = options;
    const platform = options.platform || process.platform;
    const sleep = options.sleep || defaultSleep;
    const now = options.now || Date.now;
    const onStatus = options.onStatus || (() => {});
    const timeoutMs = options.timeoutMs || DEFAULT_READY_TIMEOUT_MS;
    const pollMs = options.pollMs || DEFAULT_POLL_MS;
    const env = runtime.env || {};
    const kind = path.basename(runtime.command);

    let lastProbeTimedOut = false;
    const isReady = async () => {
        try {
            await run(runtime.command, ['info'], { env, timeout: PROBE_TIMEOUT_MS });
            lastProbeTimedOut = false;
            return true;
        } catch (e) {
            lastProbeTimedOut = Boolean(e && (e.code === 'ETIMEDOUT' || e.timedOut || e.killed));
            return false;
        }
    };

    if (await isReady()) {
        return { status: 'ready', message: '' };
    }

    let startMessage;
    if (kind === 'podman') {
        let machines = [];
        try {
            machines = JSON.parse(await run(runtime.command, ['machine', 'list', '--format', 'json'], { env, timeout: 10000 }));
        } catch (e) {
            machines = [];
        }
        if (!Array.isArray(machines) || machines.length === 0) {
            return { status: 'unavailable', message: '未找到 Podman machine，请先执行: podman machine init' };
        }
        const starting = machines.some(machine => machine && machine.Starting);
        if (!starting && machines.some(machine => machine && machine.Running)) {
            return {
                status: 'unavailable',
                message: lastProbeTimedOut
                    ? 'Podman machine 已在运行但响应超时，请稍后重试；持续超时再执行: podman machine stop && podman machine start'
                    : 'Podman machine 已在运行但连接不可用，请执行: podman machine stop && podman machine start'
            };
        }
        const clean = machine => String(machine && machine.Name || '').replace(/\*$/, '');
        const target = machines.find(machine => clean(machine) === PRIVATE_MACHINE_NAME)
            || machines.find(machine => machine && machine.Default) || machines[0];
        const name = String(target.Name || '').replace(/\*$/, '');
        startMessage = '正在启动容器环境 (podman machine start)';
        onStatus({ status: 'starting', message: startMessage });
        // 别处（另一个 CLI/serve）已经在启动同一台 machine：不再重复 start，直接轮询等待
        if (!starting) {
            try {
                await run(runtime.command, name ? ['machine', 'start', name] : ['machine', 'start'], { env, timeout: timeoutMs });
            } catch (e) {
                // 并发启动时 start 会报 already starting/running 之类：先重探一次再判失败
                if (await isReady()) {
                    onStatus({ status: 'ready', message: '' });
                    return { status: 'started', message: startMessage };
                }
                const message = `podman machine start 失败: ${String(e && e.message || e).split('\n')[0]}`;
                onStatus({ status: 'failed', message });
                return { status: 'failed', message };
            }
        }
    } else if (kind === 'docker' && platform === 'darwin') {
        startMessage = '正在启动容器环境 (Docker Desktop)';
        onStatus({ status: 'starting', message: startMessage });
        try {
            await run('open', ['-a', 'Docker'], { timeout: 10000 });
        } catch (e) {
            const message = '无法启动 Docker Desktop，请手动打开后重试';
            onStatus({ status: 'failed', message });
            return { status: 'failed', message };
        }
    } else {
        return { status: 'unavailable', message: `${kind} daemon 不可用，请先启动后重试` };
    }

    const deadline = now() + timeoutMs;
    while (now() < deadline) {
        if (await isReady()) {
            onStatus({ status: 'ready', message: '' });
            return { status: 'started', message: startMessage };
        }
        await sleep(pollMs);
    }
    const message = `等待容器环境就绪超时（${Math.round(timeoutMs / 1000)} 秒），请确认 ${kind === 'podman' ? 'Podman machine' : 'Docker Desktop'} 已启动后重试`;
    onStatus({ status: 'failed', message });
    return { status: 'timeout', message };
}

/**
 * 异步执行命令（不阻塞事件循环）。语义与同步执行器一致：非 0 退出或超时都抛错，
 * 超时的错误带 code=ETIMEDOUT。serve 里的自愈必须用它，不能用 spawnSync。
 * @returns {Promise<string>} stdout
 */
function runCommandAsync(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(command, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            reject(e);
            return;
        }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = options.timeout ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, options.timeout) : null;
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => {
            if (timer) clearTimeout(timer);
            reject(error);
        });
        child.on('close', code => {
            if (timer) clearTimeout(timer);
            if (timedOut) {
                const error = new Error(`Command timed out: ${command} ${args.join(' ')}`);
                error.code = 'ETIMEDOUT';
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            } else if (code !== 0) {
                const error = new Error(`Command failed: ${command} ${args.join(' ')}`);
                error.status = code;
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

module.exports = {
    ensureRuntimeReady,
    runCommandAsync
};
