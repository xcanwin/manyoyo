'use strict';

// 导出 / 导入用的容器运行时封装（docker / podman 命令行）。
// 导出导入的核心逻辑只依赖这里的接口，测试里用假实现替换。
// 全部异步 + 超时：docker 在 `cp` 进行期间会锁住容器，同一容器的 inspect / pause 会一直等；
// 同步调用会把 serve 的事件循环一起卡死，所以这里绝不能用 spawnSync。

const { spawn } = require('child_process');
const readline = require('readline');
const { mergeRuntimeEnv } = require('../container-runtime');

const SHORT_TIMEOUT_MS = 30 * 1000;

class RuntimeTimeoutError extends Error {
    constructor(what, ms) {
        super(`${what}超时（${Math.round(ms / 1000)} 秒），容器运行时没有响应`);
        this.name = 'RuntimeTimeoutError';
        this.code = 'ETIMEDOUT';
    }
}

class RuntimeAbortError extends Error {
    constructor() {
        super('已取消');
        this.name = 'RuntimeAbortError';
        this.code = 'ABORT_ERR';
    }
}

function createCliRuntime({ command, env: extraEnv, shortTimeoutMs = SHORT_TIMEOUT_MS }) {
    // extraEnv 只是运行时要额外带的变量（system podman / docker 常为 {}），必须叠加在本进程环境上；直接当 env 传会让子进程没有 PATH / HOME / XDG_RUNTIME_DIR
    const env = mergeRuntimeEnv(extraEnv) || process.env;

    // 跑一条命令，收集输出；超时 / 取消时强杀子进程
    function exec(args, { timeout = shortTimeoutMs, signal, what = '容器命令', encoding = 'utf8' } = {}) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) return reject(new RuntimeAbortError());
            const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
            const out = [];
            const err = [];
            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', onAbort);
                fn(value);
            };
            const timer = timeout > 0 ? setTimeout(() => {
                child.kill('SIGKILL');
                finish(reject, new RuntimeTimeoutError(what, timeout));
            }, timeout) : null;
            const onAbort = () => {
                child.kill('SIGKILL');
                finish(reject, new RuntimeAbortError());
            };
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            child.stdout.on('data', chunk => out.push(chunk));
            child.stderr.on('data', chunk => { if (err.length < 64) err.push(chunk); });
            child.on('error', error => finish(reject, error));
            child.on('close', code => {
                const stdout = Buffer.concat(out);
                finish(resolve, { status: code, stdout: encoding === 'buffer' ? stdout : stdout.toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
            });
        });
    }

    const must = async (args, what, options = {}) => {
        const result = await exec(args, { what, ...options });
        if (result.status !== 0) throw new Error(`${what}失败: ${String(result.stderr || '').trim().slice(0, 300)}`);
        return result.stdout;
    };

    return {
        // 容器信息；容器不存在返回 null；运行时没响应抛 RuntimeTimeoutError
        async inspect(name, options = {}) {
            const result = await exec(['inspect', '--format', '{{json .}}', name], { what: '读取容器信息', ...options });
            if (result.status !== 0) return null;
            let data;
            try {
                data = JSON.parse(result.stdout.split('\n')[0]);
            } catch (error) {
                return null;
            }
            const labels = (data.Config && data.Config.Labels) || {};
            return {
                id: labels['manyoyo.id'] || '',
                image: (data.Config && data.Config.Image) || '',
                status: data.State && data.State.Paused ? 'paused' : (data.State && data.State.Running ? 'running' : 'stopped'),
                mounts: (data.Mounts || []).map(item => item.Destination).filter(Boolean),
                defaultCmd: labels['manyoyo.default_cmd'] || ''
            };
        },
        async pause(name) {
            await must(['pause', name], '暂停容器');
        },
        async unpause(name) {
            await must(['unpause', name], '恢复容器');
        },
        // 暂停之后能不能读到容器文件：个别容器暂停后 `cp` 连 /etc/os-release 都报“找不到”（实测，运行中就正常）
        async canRead(name) {
            const result = await exec(['cp', `${name}:/etc/os-release`, '-'], { encoding: 'buffer', what: '探测容器文件' });
            return result.status === 0;
        },
        /**
         * 逐行读 `diff`（相对镜像的改动），每行回调 onEntry(kind, 路径)；不设固定超时（大容器要几十秒），可用 signal 取消。
         * 不攒成字符串：120 万行的输出会让内存翻倍。
         */
        diff(name, { onEntry, signal } = {}) {
            return new Promise((resolve, reject) => {
                if (signal && signal.aborted) return reject(new RuntimeAbortError());
                const child = spawn(command, ['diff', name], { env, stdio: ['ignore', 'pipe', 'pipe'] });
                let stderr = '';
                let settled = false;
                const finish = (fn, value) => {
                    if (settled) return;
                    settled = true;
                    if (signal) signal.removeEventListener('abort', onAbort);
                    fn(value);
                };
                const onAbort = () => {
                    child.kill('SIGKILL');
                    finish(reject, new RuntimeAbortError());
                };
                if (signal) signal.addEventListener('abort', onAbort, { once: true });
                child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
                const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
                lines.on('line', line => {
                    const match = /^([ACD])\s+(\/.*)$/.exec(line.trim());
                    if (match && onEntry) onEntry(match[1], match[2]);
                });
                child.on('error', error => finish(reject, error));
                child.on('close', code => {
                    if (code === 0) finish(resolve);
                    else finish(reject, new Error(`读取容器改动失败: ${stderr.trim().slice(0, 300)}`));
                });
            });
        },
        // 返回 { stream, done }：stream 是 tar 输出；done 在进程结束后给出 { code, stderr }
        cp(name, containerPath) {
            const child = spawn(command, ['cp', `${name}:${containerPath}`, '-'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
            const done = new Promise(resolve => child.on('close', code => resolve({ code, stderr })));
            child.on('error', error => child.stdout.destroy(error));
            return { stream: child.stdout, done, kill: () => child.kill('SIGKILL') };
        },
        // 把 tar 流写进容器：返回 { stdin, done }
        cpIn(name, containerPath) {
            const child = spawn(command, ['cp', '-', `${name}:${containerPath}`], { env, stdio: ['pipe', 'ignore', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
            const done = new Promise(resolve => child.on('close', code => resolve({ code, stderr })));
            return { stdin: child.stdin, done, kill: () => child.kill('SIGKILL') };
        }
    };
}

module.exports = { createCliRuntime, RuntimeTimeoutError, RuntimeAbortError };
