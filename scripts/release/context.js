'use strict';

// 真实环境的 ctx：同步读用 spawnSync，执行用 spawn 并把输出逐行写进日志（脱敏），支持取消与 dry-run。

const { spawn, spawnSync } = require('child_process');
const { createStateStore } = require('./state');

const SECRET_PATTERNS = [
    [/\b(github_pat_[A-Za-z0-9_]{10,}|gh[pousr]_[A-Za-z0-9]{10,})\b/g, '***'],
    [/(Authorization:\s*Bearer\s+)\S+/gi, '$1***'],
    [/(GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN)=\S+/g, '$1=***']
];

function redact(text) {
    return SECRET_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), String(text));
}

function createBaseContext({ repoRoot, dryRun = false, fetchImpl = fetch }) {
    const state = createStateStore(repoRoot);
    const read = (cmd, args) => {
        const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
        return { status: result.error ? 127 : result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
    };
    // 异步读：网络类探测并行执行，不阻塞控制台的事件循环
    const readAsync = (cmd, args) => new Promise(resolve => {
        const child = spawn(cmd, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', () => { clearTimeout(timer); resolve({ status: 127, stdout, stderr }); });
        child.on('close', status => { clearTimeout(timer); resolve({ status: status === null ? 143 : status, stdout, stderr }); });
    });
    return {
        repoRoot,
        dryRun,
        read,
        readAsync,
        state,
        now: () => Date.now(),
        fetchJson: async url => (await fetchImpl(url, { headers: { 'User-Agent': 'manyoyo-release' } })).json(),
        fetchStatus: async (url, headers) => (await fetchImpl(url, { method: 'HEAD', headers: { 'User-Agent': 'manyoyo-release', ...headers } })).status
    };
}

/** 每个任务一个 ctx：日志回调与取消信号绑定到这次任务 */
function createJobContext(base, log, signal) {
    const emit = line => log(redact(line));
    return {
        ...base,
        log: emit,
        signal,
        sleep: ms => new Promise(resolve => {
            if (signal && signal.aborted) return resolve();
            const onAbort = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => {
                if (signal) signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        }),
        run: (cmd, args, options = {}) => new Promise(resolve => {
            const shown = `$ ${cmd} ${args.join(' ')}`;
            if (base.dryRun && !options.safe) {
                emit(`[dry-run] ${shown}`);
                resolve({ status: 0, stdout: '' });
                return;
            }
            emit(shown);
            // 独立进程组：取消时连 npm 启动的 jest / vitepress 等孙进程一起结束
            const child = spawn(cmd, args, { cwd: base.repoRoot, detached: process.platform !== 'win32', stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } });
            let stdout = '';
            const pump = stream => {
                let rest = '';
                stream.on('data', chunk => {
                    stdout += chunk;
                    const lines = (rest + chunk).split('\n');
                    rest = lines.pop();
                    lines.forEach(line => emit(line));
                });
                stream.on('end', () => { if (rest) emit(rest); });
            };
            pump(child.stdout);
            pump(child.stderr);
            if (options.input !== undefined) child.stdin.end(options.input);
            const onAbort = () => {
                try {
                    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
                    else child.kill('SIGTERM');
                } catch (error) {
                    child.kill('SIGTERM');
                }
            };
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            child.on('error', error => { emit(`无法执行 ${cmd}: ${error.message}`); resolve({ status: 127, stdout }); });
            child.on('close', status => {
                if (signal) signal.removeEventListener('abort', onAbort);
                resolve({ status: status === null ? 143 : status, stdout });
            });
        })
    };
}

module.exports = { createBaseContext, createJobContext, redact };
