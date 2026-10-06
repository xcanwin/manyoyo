'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { start, CLIENTS_FILE } = require('../lib/egress-sidecar-main');
const denied = require('../lib/egress-denied');

const A = 'aaaaaaaaaaaaaaaa';

function connectVia(port, target, from) {
    return new Promise(resolve => {
        const socket = net.connect({ port, host: '127.0.0.1', localAddress: from });
        let buf = '';
        socket.on('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        socket.on('data', c => { buf += c; });
        socket.on('close', () => resolve(buf));
    });
}

describe('egress-sidecar-main', () => {
    let dir;
    let server;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-sidecar-'));
        fs.mkdirSync(path.join(dir, 'data'));
        fs.mkdirSync(path.join(dir, 'denied'));
    });
    afterEach(async () => {
        if (server) await server.stop();
        server = null;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const writeClients = clients => {
        const file = path.join(dir, 'data', CLIENTS_FILE);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ clients }));
        fs.renameSync(`${file}.tmp`, file);
    };

    test('映射文件热更新：未知来源 403，写入后按策略放行，拒绝写进 denied 目录', async () => {
        server = await start({ dataDir: path.join(dir, 'data'), deniedDir: path.join(dir, 'denied'), port: 0, host: '127.0.0.1', lookup: async () => ['127.0.0.1'] });
        // 没有映射文件：谁都不认识
        expect(await connectVia(server.port, 'ok.example.com:80', '127.0.0.1')).toMatch(/^HTTP\/1.1 403/);
        writeClients({ '127.0.0.1': { id: A, preset: 'allowlist', domains: ['ok.example.com'], rules: [] } });
        await new Promise(resolve => setTimeout(resolve, 600));
        // 白名单域名解析到 127.0.0.1（私有）且没有显式放行：仍被拒（SSRF 防护）
        expect(await connectVia(server.port, 'ok.example.com:80', '127.0.0.1')).toContain('destination_ip_prohibited');
        expect(await connectVia(server.port, 'evil.example.org:80', '127.0.0.1')).toContain('http_request_denied');
        await server.stop();
        server = null;
        const list = denied.read(path.join(dir, 'denied'), A);
        expect(list.map(r => r.host).sort()).toEqual(['evil.example.org', 'ok.example.com']);
    });

    test('upstream.txt 热更新：改了就用新的上游，不需要重启', async () => {
        const http = require('http');
        const seen = [];
        const up = http.createServer();
        const sockets = [];
        up.on('connect', (r, socket) => { sockets.push(socket); seen.push(r.url); socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.on('error', () => {}); });
        await new Promise(resolve => up.listen(0, '127.0.0.1', resolve));
        writeClients({ '127.0.0.1': { id: A, preset: 'allowlist', domains: ['ok.example.com'], rules: [] } });
        server = await start({ dataDir: path.join(dir, 'data'), deniedDir: path.join(dir, 'denied'), port: 0, host: '127.0.0.1', lookup: async () => ['8.8.8.8'] });
        try {
            fs.writeFileSync(path.join(dir, 'data', 'upstream.txt'), `http://127.0.0.1:${up.address().port}\n`);
            await new Promise(resolve => setTimeout(resolve, 700));
            const res = await new Promise(resolve => {
                const socket = net.connect({ port: server.port, host: '127.0.0.1' });
                let buf = '';
                socket.on('connect', () => socket.write('CONNECT ok.example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n'));
                socket.on('data', c => { buf += c; if (buf.includes('\r\n\r\n')) { socket.destroy(); resolve(buf); } });
            });
            expect(res).toMatch(/^HTTP\/1.1 200/);
            expect(seen).toEqual(['ok.example.com:443']);
        } finally {
            sockets.forEach(s => s.destroy());
            await new Promise(resolve => up.close(resolve));
        }
    });

    test('映射文件损坏：全部 403（失败即关闭）', async () => {
        fs.writeFileSync(path.join(dir, 'data', CLIENTS_FILE), '{not json');
        server = await start({ dataDir: path.join(dir, 'data'), deniedDir: path.join(dir, 'denied'), port: 0, host: '127.0.0.1' });
        expect(await connectVia(server.port, 'ok.example.com:80', '127.0.0.1')).toMatch(/^HTTP\/1.1 403/);
    });
});
