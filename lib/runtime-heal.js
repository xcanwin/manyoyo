'use strict';

const path = require('path');

// 离线安装器给私有 Podman 建的 machine 名字；列表里有它就优先启动它
const PRIVATE_MACHINE_NAME = 'podman-machine-manyoyo';
const PROBE_TIMEOUT_MS = 3000;
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
 * @param {(command: string, args: string[], opts: {env?: Object, timeout?: number}) => string} options.run 执行器，失败抛错
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

    const isReady = () => {
        try {
            run(runtime.command, ['info'], { env, timeout: PROBE_TIMEOUT_MS });
            return true;
        } catch (e) {
            return false;
        }
    };

    if (isReady()) {
        return { status: 'ready', message: '' };
    }

    let startMessage;
    if (kind === 'podman') {
        let machines = [];
        try {
            machines = JSON.parse(run(runtime.command, ['machine', 'list', '--format', 'json'], { env, timeout: 10000 }));
        } catch (e) {
            machines = [];
        }
        if (!Array.isArray(machines) || machines.length === 0) {
            return { status: 'unavailable', message: '未找到 Podman machine，请先执行: podman machine init' };
        }
        if (machines.some(machine => machine && machine.Running)) {
            return { status: 'unavailable', message: 'Podman machine 已在运行但连接不可用，请执行: podman machine stop && podman machine start' };
        }
        const clean = machine => String(machine && machine.Name || '').replace(/\*$/, '');
        const target = machines.find(machine => clean(machine) === PRIVATE_MACHINE_NAME)
            || machines.find(machine => machine && machine.Default) || machines[0];
        const name = String(target.Name || '').replace(/\*$/, '');
        startMessage = '正在启动容器环境 (podman machine start)';
        onStatus({ status: 'starting', message: startMessage });
        try {
            run(runtime.command, name ? ['machine', 'start', name] : ['machine', 'start'], { env, timeout: timeoutMs });
        } catch (e) {
            const message = `podman machine start 失败: ${String(e && e.message || e).split('\n')[0]}`;
            onStatus({ status: 'failed', message });
            return { status: 'failed', message };
        }
    } else if (kind === 'docker' && platform === 'darwin') {
        startMessage = '正在启动容器环境 (Docker Desktop)';
        onStatus({ status: 'starting', message: startMessage });
        try {
            run('open', ['-a', 'Docker'], { timeout: 10000 });
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
        if (isReady()) {
            onStatus({ status: 'ready', message: '' });
            return { status: 'started', message: startMessage };
        }
        await sleep(pollMs);
    }
    const message = `等待容器环境就绪超时（${Math.round(timeoutMs / 1000)} 秒），请确认 ${kind === 'podman' ? 'Podman machine' : 'Docker Desktop'} 已启动后重试`;
    onStatus({ status: 'failed', message });
    return { status: 'timeout', message };
}

module.exports = {
    ensureRuntimeReady
};
