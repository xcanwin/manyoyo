'use strict';

const http = require('http');
const net = require('net');
const { createEgressProxy, isRestrictedAddress, ruleCovers } = require('../lib/egress-proxy');

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const TOKENS = { [A]: 'token-a', [B]: 'token-b' };
const basic = (id, token) => `Basic ${Buffer.from(`${id}:${token}`).toString('base64')}`;

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// 发一个 CONNECT，返回状态行与（成功时）隧道里回显的内容
function connect(proxyPort, target, auth) {
    return new Promise(resolve => {
        const socket = net.connect(proxyPort, '127.0.0.1');
        let buf = '';
        socket.on('connect', () => {
            socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`);
        });
        socket.on('data', chunk => {
            buf += chunk.toString();
            if (buf.includes('\r\n\r\n') && /^HTTP\/1.1 200/.test(buf)) socket.write('ping');
            if (/^HTTP\/1.1 200[\s\S]*pong:ping/.test(buf)) { socket.destroy(); resolve({ status: 200, buf }); }
        });
        socket.on('close', () => resolve({ status: Number((/^HTTP\/1.1 (\d+)/.exec(buf) || [])[1] || 0), buf }));
        socket.setTimeout(5000, () => { socket.destroy(); resolve({ status: -1, buf }); });
    });
}

describe('egress-proxy', () => {
    let echo;
    let echoPort;
    let proxy;
    let proxyPort;
    let policies;
    let lookups;

    beforeAll(async () => {
        echo = net.createServer(socket => {
            socket.on('data', d => socket.write(`pong:${d}`));
            socket.on('error', () => {});
        });
        echoPort = await listen(echo);
    });
    afterAll(() => new Promise(resolve => echo.close(resolve)));

    beforeEach(async () => {
        policies = {
            [A]: { preset: 'allowlist', domains: ['ok.example.com', '*.wild.example.com'], rules: [{ cidr: '127.0.0.1/32', ports: String(echoPort), proto: 'tcp' }] },
            [B]: { preset: 'allowlist', domains: ['other.example.com'], rules: [] }
        };
        lookups = { 'ok.example.com': ['127.0.0.1'], 'a.wild.example.com': ['127.0.0.1'], 'other.example.com': ['127.0.0.1'], 'meta.example.com': ['169.254.169.254'], 'lan.example.com': ['10.1.2.3'], 'mixed.example.com': ['10.1.2.3', '127.0.0.1'] };
        policies[A].domains.push('meta.example.com', 'lan.example.com', 'mixed.example.com');
        proxy = createEgressProxy({
            getToken: id => TOKENS[id] || null,
            getPolicy: id => policies[id] || null,
            lookup: async host => { if (!lookups[host]) throw new Error('nx'); return lookups[host]; }
        });
        proxyPort = await proxy.start({ host: '127.0.0.1', port: 0 });
    });
    afterEach(() => proxy.stop());

    test('无凭据 / 错凭据 / 不是 id 的用户名：407', async () => {
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`)).status).toBe(407);
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, basic(A, 'wrong'))).status).toBe(407);
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, basic('../etc', 'token-a'))).status).toBe(407);
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, basic(A, 'token-b'))).status).toBe(407);
    });

    test('白名单域名（精确与通配）经显式放行的 IP 可通；其他域名 403；别的容器的凭据只按它自己的策略', async () => {
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, basic(A, 'token-a'))).status).toBe(200);
        expect((await connect(proxyPort, `a.wild.example.com:${echoPort}`, basic(A, 'token-a'))).status).toBe(200);
        expect((await connect(proxyPort, `evil.example.org:${echoPort}`, basic(A, 'token-a'))).status).toBe(403);
        expect((await connect(proxyPort, `wild.example.com:${echoPort}`, basic(A, 'token-a'))).status).toBe(403);
        // B 带自己的凭据访问只在 A 白名单里的域名：403
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, basic(B, 'token-b'))).status).toBe(403);
    });

    test('SSRF：域名解析到私有 / 元数据 / 环回地址一律拒绝（除非该容器显式放行 IP:端口）', async () => {
        // 169.254.169.254 与 10.x 没有显式放行
        expect((await connect(proxyPort, 'meta.example.com:80', basic(A, 'token-a'))).status).toBe(403);
        expect((await connect(proxyPort, 'lan.example.com:80', basic(A, 'token-a'))).status).toBe(403);
        // B 没有任何显式放行：解析到 127.0.0.1 的白名单域名也被拒
        policies[B].domains.push('ok.example.com');
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, basic(B, 'token-b'))).status).toBe(403);
        // 混合记录：只用可用的那条（127.0.0.1 被 A 显式放行）
        expect((await connect(proxyPort, `mixed.example.com:${echoPort}`, basic(A, 'token-a'))).status).toBe(200);
        // A 的显式放行只对那个端口有效
        expect((await connect(proxyPort, `ok.example.com:${echoPort + 1}`, basic(A, 'token-a'))).status).toBe(403);
    });

    test('IP 字面量：只有显式放行才可达；私有 / 环回字面量默认 403', async () => {
        expect((await connect(proxyPort, `127.0.0.1:${echoPort}`, basic(A, 'token-a'))).status).toBe(200);
        expect((await connect(proxyPort, `127.0.0.1:${echoPort}`, basic(B, 'token-b'))).status).toBe(403);
        expect((await connect(proxyPort, '169.254.169.254:80', basic(A, 'token-a'))).status).toBe(403);
        expect((await connect(proxyPort, '8.8.8.8:443', basic(A, 'token-a'))).status).toBe(403); // 公网 IP 字面量不在白名单规则里
        expect((await connect(proxyPort, '[::1]:80', basic(A, 'token-a'))).status).toBe(403);
        expect((await connect(proxyPort, '[::ffff:10.0.0.1]:80', basic(A, 'token-a'))).status).toBe(403);
    });

    test('策略不是 allowlist（含已切回 restricted）：403', async () => {
        policies[A].preset = 'restricted';
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, basic(A, 'token-a'))).status).toBe(403);
    });

    test('普通 HTTP 请求同样鉴权与按域名放行', async () => {
        const target = http.createServer((req, res) => res.end(`got ${req.url} host=${req.headers.host} auth=${req.headers['proxy-authorization'] || 'none'}`));
        const targetPort = await listen(target);
        policies[A].rules = [{ cidr: '127.0.0.1/32', ports: String(targetPort), proto: 'tcp' }];
        const get = (urlPath, auth) => new Promise(resolve => {
            http.get({ host: '127.0.0.1', port: proxyPort, path: urlPath, headers: { ...(auth ? { 'Proxy-Authorization': auth } : {}), Host: 'ok.example.com' } }, res => {
                let body = '';
                res.on('data', c => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode, body }));
            });
        });
        try {
            expect((await get(`http://ok.example.com:${targetPort}/x?y=1`)).status).toBe(407);
            const ok = await get(`http://ok.example.com:${targetPort}/x?y=1`, basic(A, 'token-a'));
            expect(ok.status).toBe(200);
            expect(ok.body).toBe(`got /x?y=1 host=ok.example.com auth=none`);
            expect((await get(`http://evil.example.org:${targetPort}/`, basic(A, 'token-a'))).status).toBe(403);
        } finally {
            await new Promise(resolve => target.close(resolve));
        }
    });

    test('串联上游代理：CONNECT 目标原样交给上游（上游负责解析），仍先做域名与字面量检查', async () => {
        const seen = [];
        const upstream = http.createServer();
        const upstreamSockets = [];
        upstream.on('connect', (req, socket) => {
            upstreamSockets.push(socket);
            seen.push({ url: req.url, auth: req.headers['proxy-authorization'] });
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            socket.on('data', d => socket.write(`pong:${d}`));
            socket.on('error', () => {});
        });
        const upstreamPort = await listen(upstream);
        const chained = createEgressProxy({
            getToken: id => TOKENS[id] || null,
            getPolicy: id => policies[id] || null,
            upstream: `http://user:pw@127.0.0.1:${upstreamPort}`
        });
        const port = await chained.start({ host: '127.0.0.1', port: 0 });
        try {
            expect((await connect(port, 'ok.example.com:443', basic(A, 'token-a'))).status).toBe(200);
            expect(seen).toEqual([{ url: 'ok.example.com:443', auth: `Basic ${Buffer.from('user:pw').toString('base64')}` }]);
            expect((await connect(port, 'evil.example.org:443', basic(A, 'token-a'))).status).toBe(403);
            expect((await connect(port, '127.0.0.1:80', basic(B, 'token-b'))).status).toBe(403);
            expect(seen.length).toBe(1);
        } finally {
            await chained.stop();
            upstreamSockets.forEach(socket => socket.destroy());
            await new Promise(resolve => upstream.close(resolve));
        }
    });
});

describe('地址判断', () => {
    test('isRestrictedAddress', () => {
        ['127.0.0.1', '10.1.1.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1']
            .forEach(ip => expect(isRestrictedAddress(ip)).toBe(true));
        ['8.8.8.8', '1.1.1.1', '172.32.0.1', '140.82.112.3', '2606:4700::1111', '::ffff:8.8.8.8'].forEach(ip => expect(isRestrictedAddress(ip)).toBe(false));
        expect(isRestrictedAddress('not-an-ip')).toBe(true);
    });

    test('ruleCovers：CIDR、端口区间、协议', () => {
        expect(ruleCovers({ cidr: '140.82.112.0/20', ports: '22,443', proto: 'tcp' }, '140.82.113.4', 443)).toBe(true);
        expect(ruleCovers({ cidr: '140.82.112.0/20', ports: '22', proto: 'tcp' }, '140.82.113.4', 443)).toBe(false);
        expect(ruleCovers({ cidr: '10.0.0.0/8', ports: '8000-8100', proto: 'tcp' }, '10.9.9.9', 8050)).toBe(true);
        expect(ruleCovers({ cidr: '10.0.0.0/8', ports: '', proto: 'udp' }, '10.9.9.9', 53)).toBe(false);
        expect(ruleCovers({ cidr: '10.0.0.1', ports: '', proto: 'tcp' }, '10.0.0.1', 1)).toBe(true);
    });
});
