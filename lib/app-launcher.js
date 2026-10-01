'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_HOST = '127.0.0.1';
const READY_TIMEOUT_MS = 30000;

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

    let state = readAppState(statePath);
    let reused = false;
    if (state && isProcessRunning(state.pid) && await connect(APP_HOST, state.port)) {
        reused = true;
    } else {
        const port = await pickPort();
        const child = spawnServe(port);
        state = { host: APP_HOST, port, pid: child.pid, startedAt: new Date(now()).toISOString() };
        writeAppState(statePath, state);

        const deadline = now() + timeoutMs;
        let ready = false;
        while (now() < deadline) {
            if (await connect(APP_HOST, port)) {
                ready = true;
                break;
            }
            await sleep(200);
        }
        if (!ready) {
            throw new Error(`本机服务在 ${Math.round(timeoutMs / 1000)} 秒内未就绪${deps.logPathHint ? `，请查看日志: ${deps.logPathHint}` : ''}`);
        }
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
    openBrowser,
    launchApp
};
