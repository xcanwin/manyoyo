'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { start, envUpstream, CLIENTS_FILE } = require('../lib/egress-sidecar-main');
const { normalizePolicy, compileProxyPolicy } = require('../lib/network-policy');
const denied = require('../lib/egress-denied');

const A = 'aaaaaaaaaaaaaaaa';
const allowDomain = domain => ({ id: A, ...compileProxyPolicy(normalizePolicy({ preset: 'allowlist', outbound: [{ action: 'allow', target: domain }] }), {}) });

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
    // 运行时注入的代理变量会成为上游：开发机上常有，每个用例先清掉
    const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
    const savedProxy = Object.fromEntries(PROXY_KEYS.map(key => [key, process.env[key]]));
    beforeEach(() => {
        PROXY_KEYS.forEach(key => delete process.env[key]);
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-sidecar-'));
        fs.mkdirSync(path.join(dir, 'data'));
        fs.mkdirSync(path.join(dir, 'denied'));
    });
    afterEach(async () => {
        PROXY_KEYS.forEach(key => { if (savedProxy[key] === undefined) delete process.env[key]; else process.env[key] = savedProxy[key]; });
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
        server = await start({ dataDir: path.join(dir, 'data'), deniedDir: path.join(dir, 'denied'), port: 0, host: '127.0.0.1', lookup: async host => (host === 'ok.example.com' ? ['127.0.0.1'] : ['8.8.8.8']) });
        // 没有映射文件：谁都不认识
        expect(await connectVia(server.port, 'ok.example.com:80', '127.0.0.1')).toMatch(/^HTTP\/1.1 403/);
        writeClients({ '127.0.0.1': allowDomain('ok.example.com') });
        await new Promise(resolve => setTimeout(resolve, 600));
        // 允许的域名解析到 127.0.0.1（环回永远拒绝，防借代理打 sidecar 自己）
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
        writeClients({ '127.0.0.1': allowDomain('ok.example.com') });
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

    test('运行时注入 sidecar 的代理：upstream.txt 没有时才用；环回地址改写成宿主机别名；非 http 代理忽略', () => {
        expect(envUpstream({ https_proxy: 'http://host.containers.internal:10808' })).toBe('http://host.containers.internal:10808');
        expect(envUpstream({ HTTP_PROXY: 'http://127.0.0.1:7890', EGRESS_HOST_ALIAS: 'host.docker.internal' })).toBe('http://host.docker.internal:7890');
        expect(envUpstream({ http_proxy: 'http://user:pw@localhost:7890' })).toBe('http://user:pw@host.containers.internal:7890');
        expect(envUpstream({ https_proxy: 'socks5://127.0.0.1:1080' })).toBe('');
        expect(envUpstream({})).toBe('');
    });

    test('没有 upstream.txt 时走运行时注入的代理（P2）', async () => {
        const http = require('http');
        const seen = [];
        const up = http.createServer();
        const sockets = [];
        up.on('connect', (r, socket) => { sockets.push(socket); seen.push(r.url); socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.on('error', () => {}); });
        await new Promise(resolve => up.listen(0, '127.0.0.1', resolve));
        process.env.https_proxy = `http://127.0.0.1:${up.address().port}`;
        process.env.EGRESS_HOST_ALIAS = '127.0.0.1';
        writeClients({ '127.0.0.1': allowDomain('ok.example.com') });
        server = await start({ dataDir: path.join(dir, 'data'), deniedDir: path.join(dir, 'denied'), port: 0, host: '127.0.0.1', lookup: async () => ['8.8.8.8'] });
        try {
            const res = await new Promise(resolve => {
                const socket = net.connect({ port: server.port, host: '127.0.0.1' });
                let buf = '';
                socket.on('connect', () => socket.write('CONNECT ok.example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n'));
                socket.on('data', c => { buf += c; if (buf.includes('\r\n\r\n')) { socket.destroy(); resolve(buf); } });
            });
            expect(res).toMatch(/^HTTP\/1.1 200/);
            expect(seen).toEqual(['ok.example.com:443']);
        } finally {
            delete process.env.EGRESS_HOST_ALIAS;
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
