'use strict';

const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const { buildExecArgs } = require('./container-exec');

// 运行中暴露容器端口：serve 在宿主机监听 bind:hostPort，每个连接起一个 `exec -i <容器> socat STDIO TCP:127.0.0.1:<端口>` 双向 pipe。
// 不需要重启容器、不依赖容器的网络模式（slirp4netns / bridge / pasta 都一样）。
const MAX_CONNECTIONS_PER_FORWARD = 64;

// 容器里优先 socat，没有就用 node 兜底；端口是校验过的整数
function containerCommand(port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`端口非法: ${port}`);
    const nodeScript = `const s=require('net').connect(${p},'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0))`;
    return ['/bin/sh', '-c', `if command -v socat >/dev/null 2>&1; then exec socat STDIO TCP:127.0.0.1:${p}; else exec node -e "${nodeScript}"; fi`];
}

function keyOf(id, bind, hostPort) {
    return `${id}|${bind}:${hostPort}`;
}

function createPortForwarder(options) {
    const command = options.command;
    const env = options.env ? { ...process.env, ...options.env } : process.env;
    const homeDir = options.homeDir || os.homedir();
    const resolveName = options.resolveName;
    const warn = options.warn || (() => {});
    const forwards = new Map(); // key → { id, bind, hostPort, port, server, sockets:Set, active }

    function handleConnection(forward, socket) {
        if (forward.active >= MAX_CONNECTIONS_PER_FORWARD) {
            socket.destroy();
            return;
        }
        const name = resolveName(forward.id);
        if (!name) {
            // 容器（状态目录）已被删：这个转发没有意义了，释放宿主机端口
            closeForward(keyOf(forward.id, forward.bind, forward.hostPort));
            socket.destroy();
            return;
        }
        forward.active += 1;
        forward.sockets.add(socket);
        const built = buildExecArgs({ homeDir, dockerExecArgs: () => '' }, name, {
            interactive: true,
            withEnv: false,
            command: containerCommand(forward.port)
        });
        const child = spawn(command, built.args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
        const finish = () => {
            if (forward.sockets.delete(socket)) forward.active -= 1;
            built.cleanup();
            socket.destroy();
            if (!child.killed) child.kill('SIGTERM');
        };
        socket.on('error', finish);
        socket.on('close', finish);
        child.on('error', finish);
        child.on('close', finish);
        child.stdin.on('error', () => {});
        child.stdout.on('error', () => {});
        socket.pipe(child.stdin);
        child.stdout.pipe(socket);
    }

    function open({ id, bind, hostPort, port }) {
        const key = keyOf(id, bind, hostPort);
        if (forwards.has(key)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const forward = { id, bind, hostPort, port, sockets: new Set(), active: 0, server: null };
            const server = net.createServer(socket => handleConnection(forward, socket));
            forward.server = server;
            server.once('error', error => {
                reject(error.code === 'EADDRINUSE'
                    ? new Error(`宿主机端口 ${bind}:${hostPort} 已被占用`)
                    : error);
            });
            server.listen(hostPort, bind, () => {
                server.removeAllListeners('error');
                server.on('error', error => warn(`端口转发 ${bind}:${hostPort} 出错: ${error.message}`));
                forwards.set(key, forward);
                resolve();
            });
        });
    }

    function closeForward(key) {
        const forward = forwards.get(key);
        if (!forward) return;
        forwards.delete(key);
        forward.server.close();
        forward.sockets.forEach(socket => socket.destroy());
    }

    function close(id, bind, hostPort) {
        closeForward(keyOf(id, bind, hostPort));
    }

    function closeFor(id) {
        [...forwards.keys()].filter(key => key.startsWith(`${id}|`)).forEach(closeForward);
    }

    function closeAll() {
        [...forwards.keys()].forEach(closeForward);
    }

    function list(id) {
        return [...forwards.values()].filter(f => f.id === id).map(f => ({ bind: f.bind, hostPort: f.hostPort, port: f.port }));
    }

    // 让转发列表与策略一致：多的关、少的开；单条失败只警告
    async function sync(id, expose) {
        const want = new Map(expose.map(e => [keyOf(id, e.bind, e.hostPort), e]));
        [...forwards.keys()].filter(key => key.startsWith(`${id}|`) && !want.has(key)).forEach(closeForward);
        const failures = [];
        for (const [key, entry] of want) {
            const existing = forwards.get(key);
            if (existing && existing.port === entry.port) continue;
            if (existing) closeForward(key);
            try {
                await open({ id, ...entry });
            } catch (e) {
                failures.push(e.message);
                warn(e.message);
            }
        }
        return failures;
    }

    return { open, close, closeFor, closeAll, list, sync };
}

module.exports = { createPortForwarder, containerCommand, MAX_CONNECTIONS_PER_FORWARD };
