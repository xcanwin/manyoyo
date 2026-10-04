'use strict';

// Chrome 中继：把容器里的 CDP 连接转发给用户正在使用的 Chrome。
// 只放行带 token 路径的 WebSocket upgrade；每次新连接都重新读取 DevToolsActivePort，
// 所以 Chrome 重启（端口与路径变化）后不用重建容器；转发时改写 Host 头以通过 Chrome 的 Host 检查。

const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { WebSocket, WebSocketServer } = require('ws');

function parseDevToolsActivePort(content) {
    const lines = String(content || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const port = Number(lines[0]);
    const wsPath = lines[1] || '';
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || !wsPath.startsWith('/devtools/browser/')) {
        return null;
    }
    return { port, wsPath };
}

function findDevToolsActivePort(candidates) {
    for (const filePath of candidates) {
        try {
            const parsed = parseDevToolsActivePort(fs.readFileSync(filePath, 'utf8'));
            if (parsed) {
                return { ...parsed, filePath };
            }
        } catch {
            // 候选路径不存在，继续找下一个
        }
    }
    return null;
}

function tokenMatches(actual, expected) {
    const a = Buffer.from(String(actual));
    const b = Buffer.from(String(expected));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createRelay({ token, candidates }) {
    const wss = new WebSocketServer({ noServer: true });
    const server = http.createServer((req, res) => {
        res.writeHead(404);
        res.end();
    });

    server.on('upgrade', (req, socket, head) => {
        const pathname = String(req.url || '').split('?')[0];
        if (!tokenMatches(pathname, `/${token}`)) {
            socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            return;
        }
        const target = findDevToolsActivePort(candidates);
        if (!target) {
            socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
            return;
        }
        const upstream = new WebSocket(`ws://127.0.0.1:${target.port}${target.wsPath}`, {
            headers: { Host: `127.0.0.1:${target.port}` },
            perMessageDeflate: false
        });
        upstream.once('error', () => socket.destroy());
        upstream.once('open', () => {
            wss.handleUpgrade(req, socket, head, client => {
                client.on('message', (data, isBinary) => upstream.send(data, { binary: isBinary }));
                upstream.on('message', (data, isBinary) => client.send(data, { binary: isBinary }));
                client.on('close', () => upstream.close());
                upstream.on('close', () => client.close());
                client.on('error', () => upstream.terminate());
                upstream.on('error', () => client.terminate());
            });
        });
    });

    return server;
}

if (require.main === module) {
    // 配置只经文件传入（含 token），不进命令行与环境变量
    const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const server = createRelay(config);
    server.listen(config.port, config.host);
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

module.exports = { createRelay, findDevToolsActivePort, parseDevToolsActivePort };
