'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_HOST = '127.0.0.1';
const READY_TIMEOUT_MS = 30000;
const LOCK_STALE_MS = 60000;
const SERVE_MARKER_HEADER = 'x-manyoyo-serve';
const SPAWN_ATTEMPTS = 2;

function getAppStatePath(homeDir = os.homedir()) {
    return path.join(homeDir, '.manyoyo', 'serve', 'app.json');
}

function readAppState(filePath) {
    try {
        const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (state && state.host === APP_HOST && Number.isInteger(state.port) && Number.isInteger(state.pid)) {
            return state;
        }
    } catch (e) {
        // 不存在或损坏都按“没有实例”处理
    }
    return null;
}

function writeAppState(filePath, state) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function canConnect(host, port, timeoutMs = 500) {
    return new Promise(resolve => {
        const socket = net.connect({ host, port });
        const done = ok => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

// TCP 能连上不代表是 manyoyo：端口可能被别的程序（甚至别的用户）占了，一次性令牌只能发给 manyoyo serve。
// serve 的每个响应都带 X-Manyoyo-Serve 头（包括未登录的 401），请求本身不带任何凭据。
function probeManyoyoServe(host, port, timeoutMs = 1500) {
    return new Promise(resolve => {
        const req = http.get({ host, port, path: '/api/sessions', timeout: timeoutMs, headers: { Connection: 'close' } }, res => {
            res.resume();
            resolve(Boolean(res.headers[SERVE_MARKER_HEADER]));
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

function readLockPid(lockDir) {
    try {
        return Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf-8').trim());
    } catch (e) {
        return NaN;
    }
}

/**
 * 同一时刻只让一个 manyoyo 启动器去选端口/启动 serve（mkdir 是原子的）。
 * 锁的持有者已退出或锁太旧就当作残留清掉。拿不到锁说明另一个终端正在启动，等它结束再复用其结果。
 */
async function acquireStartLock(lockDir, deps) {
    const { isProcessRunning, sleep, now, timeoutMs } = deps;
    const deadline = now() + timeoutMs;
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
    for (;;) {
        try {
            fs.mkdirSync(lockDir);
            fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n`);
            return () => fs.rmSync(lockDir, { recursive: true, force: true });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
        const pid = readLockPid(lockDir);
        let age = 0;
        try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch (e) { continue; }
        const holderAlive = Number.isInteger(pid) && pid > 0 && isProcessRunning(pid);
        if (!holderAlive || age > LOCK_STALE_MS + timeoutMs) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
        }
        if (now() > deadline) {
            throw new Error('另一个 manyoyo 正在启动本机服务，请稍后重试');
        }
        await sleep(200);
    }
}

function pickFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, APP_HOST, () => {
            const { port } = server.address();
            server.close(err => (err ? reject(err) : resolve(port)));
        });
    });
}

// macOS 用 open，Linux 用 xdg-open；都没有返回 false（由调用方只打印地址）
function openBrowser(url, deps = {}) {
    const platform = deps.platform || process.platform;
    const run = deps.run || ((command, args) => spawnSync(command, args, { stdio: 'ignore' }));
    const command = platform === 'darwin' ? 'open' : (platform === 'linux' ? 'xdg-open' : '');
    if (!command) return false;
    const result = run(command, [url]);
    return Boolean(result) && !result.error && result.status === 0;
}

/**
 * 无参数 manyoyo：复用或后台启动本机 serve，签发一次性令牌并打开浏览器。
 * 所有副作用都从 deps 注入，便于测试。
 */
async function launchApp(deps) {
    const {
        statePath, isProcessRunning, spawnServe, issueToken, open, log
    } = deps;
    const connect = deps.canConnect || canConnect;
    const pickPort = deps.pickPort || pickFreePort;
    const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const now = deps.now || Date.now;
    const timeoutMs = deps.readyTimeoutMs || READY_TIMEOUT_MS;

    const probe = deps.probe || (async (host, port) => (await connect(host, port)) && probeManyoyoServe(host, port));
    const release = await acquireStartLock(path.join(path.dirname(statePath), 'app.lock'), {
        isProcessRunning, sleep, now, timeoutMs
    });
    let state;
    let reused = false;
    try {
        state = readAppState(statePath);
        if (state && isProcessRunning(state.pid) && await probe(APP_HOST, state.port)) {
            reused = true;
        } else {
            state = await startFresh();
        }
    } finally {
        release();
    }

    // 选端口与 serve 绑定之间有空档，端口可能被抢；serve 因此立即退出时换端口重试一次
    async function startFresh() {
        let lastError = null;
        for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt += 1) {
            const port = await pickPort();
            const child = spawnServe(port);
            let spawnError = null;
            let exited = false;
            if (child && typeof child.on === 'function') {
                child.on('error', error => { spawnError = error; });
                child.on('exit', () => { exited = true; });
            }
            if (child && !Number.isInteger(child.pid)) {
                await new Promise(resolve => setImmediate(resolve)); // 让异步的 spawn error（如 ENOENT）先到
            }
            if (!child || !Number.isInteger(child.pid)) {
                throw new Error(`无法启动本机服务${spawnError ? `: ${spawnError.message}` : ''}${deps.logPathHint ? `，请查看日志: ${deps.logPathHint}` : ''}`);
            }
            const next = { host: APP_HOST, port, pid: child.pid, startedAt: new Date(now()).toISOString() };
            writeAppState(statePath, next);

            const deadline = now() + timeoutMs;
            while (now() < deadline && !spawnError && !exited) {
                if (await probe(APP_HOST, port)) return next;
                await sleep(200);
            }
            if (spawnError) throw new Error(`无法启动本机服务: ${spawnError.message}`);
            lastError = exited
                ? new Error(`本机服务启动后立即退出（端口可能被占用）${deps.logPathHint ? `，请查看日志: ${deps.logPathHint}` : ''}`)
                : new Error(`本机服务在 ${Math.round(timeoutMs / 1000)} 秒内未就绪${deps.logPathHint ? `，请查看日志: ${deps.logPathHint}` : ''}`);
            if (!exited) break;
        }
        throw lastError;
    }

    const baseUrl = `http://${APP_HOST}:${state.port}`;
    const loginUrl = `${baseUrl}/auth/login?token=${issueToken()}`;
    log(`${reused ? '已复用运行中的服务' : '已启动本机服务'}: ${baseUrl}`);
    // 服务在后台一直运行，必须告诉用户怎么关
    log(`  关闭服务: ${deps.commandName || 'manyoyo'} serve ${APP_HOST}:${state.port} --stop`);
    const opened = open(loginUrl);
    if (!opened) {
        // 没有浏览器打开器：一次性地址只在这里打印（60 秒内、用一次即失效）
        log(`未能自动打开浏览器，请在 60 秒内访问: ${loginUrl}`);
    }
    return { reused, opened, baseUrl, loginUrl, pid: state.pid };
}

module.exports = {
    APP_HOST,
    getAppStatePath,
    readAppState,
    canConnect,
    probeManyoyoServe,
    SERVE_MARKER_HEADER,
    openBrowser,
    launchApp
};
