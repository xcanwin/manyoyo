'use strict';

const http = require('http');
const net = require('net');
const { createEgressProxy, isRestrictedAddress, ruleCovers } = require('../lib/egress-proxy');

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
// 容器按来源 IP 识别：A 来自 127.0.0.1，B 来自 127.0.0.2，127.0.0.3 不在映射里
const SRC = { A: '127.0.0.1', B: '127.0.0.2', X: '127.0.0.3' };

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// 发一个 CONNECT，返回状态行与（成功时）隧道里回显的内容
function connect(proxyPort, target, from = SRC.A) {
    return new Promise(resolve => {
        const socket = net.connect({ port: proxyPort, host: '127.0.0.1', localAddress: from });
        let buf = '';
        socket.on('connect', () => {
            socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
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
    let denied;
    const clientOf = ip => {
        const id = { [SRC.A]: A, [SRC.B]: B }[ip];
        return id && policies[id] ? { id, ...policies[id] } : null;
    };

    beforeAll(async () => {
        echo = net.createServer(socket => {
            socket.on('data', d => socket.write(`pong:${d}`));
            socket.on('error', () => {});
        });
        echoPort = await listen(echo);
    });
    afterAll(() => new Promise(resolve => echo.close(resolve)));

    beforeEach(async () => {
        denied = [];
        policies = {
            [A]: { preset: 'allowlist', domains: ['ok.example.com', '*.wild.example.com'], rules: [{ cidr: '127.0.0.1/32', ports: String(echoPort), proto: 'tcp' }] },
            [B]: { preset: 'allowlist', domains: ['other.example.com'], rules: [] }
        };
        lookups = { 'ok.example.com': ['127.0.0.1'], 'a.wild.example.com': ['127.0.0.1'], 'other.example.com': ['127.0.0.1'], 'meta.example.com': ['169.254.169.254'], 'lan.example.com': ['10.1.2.3'], 'mixed.example.com': ['10.1.2.3', '127.0.0.1'] };
        policies[A].domains.push('meta.example.com', 'lan.example.com', 'mixed.example.com');
        proxy = createEgressProxy({
            getClient: ip => clientOf(ip),
            onDenied: event => denied.push(event),
            lookup: async host => { if (!lookups[host]) throw new Error('nx'); return lookups[host]; }
        });
        proxyPort = await proxy.start({ host: '127.0.0.1', port: 0 });
    });
    afterEach(() => proxy.stop());

    test('来源 IP 不在映射里：403（带 Proxy-Status，无正文），不记录拒绝', async () => {
        const res = await connect(proxyPort, `ok.example.com:${echoPort}`, SRC.X);
        expect(res.status).toBe(403);
        expect(res.buf).toContain('Proxy-Status: proxy; error=http_request_denied');
        expect(denied).toEqual([]);
    });

    test('伪造的 Proxy-Authorization 头没有任何作用：身份只看来源地址', async () => {
        const socket = net.connect({ port: proxyPort, host: '127.0.0.1', localAddress: SRC.X });
        const buf = await new Promise(resolve => {
            let text = '';
            socket.on('connect', () => socket.write(`CONNECT ok.example.com:${echoPort} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic ${Buffer.from(`${A}:whatever`).toString('base64')}\r\n\r\n`));
            socket.on('data', c => { text += c; });
            socket.on('close', () => resolve(text));
        });
        expect(buf).toMatch(/^HTTP\/1.1 403/);
    });

    test('拒绝响应：403 + Proxy-Status，不带正文，不带 Via / X-Forwarded-For 等头，不出现 manyoyo', async () => {
        const domain = await connect(proxyPort, `evil.example.org:${echoPort}`);
        expect(domain.buf).toBe('HTTP/1.1 403 Forbidden\r\nProxy-Status: proxy; error=http_request_denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        const address = await connect(proxyPort, 'lan.example.com:80');
        expect(address.buf).toContain('Proxy-Status: proxy; error=destination_ip_prohibited');
        expect(`${domain.buf}${address.buf}`.toLowerCase()).not.toMatch(/manyoyo|via:|x-forwarded/);
    });

    test('被拒绝的访问通过 onDenied 记录（容器 id、域名、端口、原因）', async () => {
        await connect(proxyPort, `evil.example.org:${echoPort}`);
        await connect(proxyPort, 'lan.example.com:80');
        expect(denied).toEqual([
            { id: A, host: 'evil.example.org', port: echoPort, reason: 'domain' },
            { id: A, host: 'lan.example.com', port: 80, reason: 'address' }
        ]);
    });

    test('白名单域名（精确与通配）经显式放行的 IP 可通；其他域名 403；别的容器的凭据只按它自己的策略', async () => {
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, SRC.A)).status).toBe(200);
        expect((await connect(proxyPort, `a.wild.example.com:${echoPort}`, SRC.A)).status).toBe(200);
        expect((await connect(proxyPort, `evil.example.org:${echoPort}`, SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, `wild.example.com:${echoPort}`, SRC.A)).status).toBe(403);
        // B 访问只在 A 白名单里的域名：403
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, SRC.B)).status).toBe(403);
    });

    test('SSRF：域名解析到私有 / 元数据 / 环回地址一律拒绝（除非该容器显式放行 IP:端口）', async () => {
        // 169.254.169.254 与 10.x 没有显式放行
        expect((await connect(proxyPort, 'meta.example.com:80', SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, 'lan.example.com:80', SRC.A)).status).toBe(403);
        // B 没有任何显式放行：解析到 127.0.0.1 的白名单域名也被拒
        policies[B].domains.push('ok.example.com');
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, SRC.B)).status).toBe(403);
        // 混合记录：只用可用的那条（127.0.0.1 被 A 显式放行）
        expect((await connect(proxyPort, `mixed.example.com:${echoPort}`, SRC.A)).status).toBe(200);
        // A 的显式放行只对那个端口有效
        expect((await connect(proxyPort, `ok.example.com:${echoPort + 1}`, SRC.A)).status).toBe(403);
    });

    test('IP 字面量：只有显式放行才可达；私有 / 环回字面量默认 403', async () => {
        expect((await connect(proxyPort, `127.0.0.1:${echoPort}`, SRC.A)).status).toBe(200);
        expect((await connect(proxyPort, `127.0.0.1:${echoPort}`, SRC.B)).status).toBe(403);
        expect((await connect(proxyPort, '169.254.169.254:80', SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, '8.8.8.8:443', SRC.A)).status).toBe(403); // 公网 IP 字面量不在白名单规则里
        expect((await connect(proxyPort, '[::1]:80', SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, '[::ffff:10.0.0.1]:80', SRC.A)).status).toBe(403);
    });

    test('策略不是 allowlist（含已切回 restricted）：403', async () => {
        policies[A].preset = 'restricted';
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, SRC.A)).status).toBe(403);
    });

    test('普通 HTTP 请求同样按来源识别与按域名放行；代理不加任何头', async () => {
        const target = http.createServer((req, res) => res.end(`got ${req.url} host=${req.headers.host} headers=${Object.keys(req.headers).sort().join(',')}`));
        const targetPort = await listen(target);
        policies[A].rules = [{ cidr: '127.0.0.1/32', ports: String(targetPort), proto: 'tcp' }];
        const get = (urlPath, from) => new Promise(resolve => {
            http.get({ host: '127.0.0.1', port: proxyPort, localAddress: from, path: urlPath, headers: { Host: 'ok.example.com' } }, res => {
                let body = '';
                res.on('data', c => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
            });
        });
        try {
            expect((await get(`http://ok.example.com:${targetPort}/x?y=1`, SRC.X)).status).toBe(403);
            const ok = await get(`http://ok.example.com:${targetPort}/x?y=1`, SRC.A);
            expect(ok.status).toBe(200);
            // 目标收到的头与客户端发出的一致（只有 host / connection），没有 via / x-forwarded-for 等
            expect(ok.body).toMatch(/^got \/x\?y=1 host=ok\.example\.com headers=(connection,)?host$/);
            const bad = await get(`http://evil.example.org:${targetPort}/`, SRC.A);
            expect(bad.status).toBe(403);
            expect(bad.body).toBe('Forbidden');
            expect(bad.headers['proxy-status']).toBe('proxy; error=http_request_denied');
            expect(Object.keys(bad.headers).sort()).toEqual(['connection', 'content-length', 'content-type', 'date', 'proxy-status']);
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
            getClient: ip => clientOf(ip),
            // 宿主机解析不了 ok.example.com（交给上游）；meta / lan 能解析出私有地址
            lookup: async host => { if (!['meta.example.com', 'lan.example.com'].includes(host)) throw new Error('nx'); return lookups[host]; },
            upstream: `http://user:pw@127.0.0.1:${upstreamPort}`
        });
        const port = await chained.start({ host: '127.0.0.1', port: 0 });
        try {
            expect((await connect(port, 'ok.example.com:443', SRC.A)).status).toBe(200);
            expect(seen).toEqual([{ url: 'ok.example.com:443', auth: `Basic ${Buffer.from('user:pw').toString('base64')}` }]);
            expect((await connect(port, 'evil.example.org:443', SRC.A)).status).toBe(403);
            expect((await connect(port, '127.0.0.1:80', SRC.B)).status).toBe(403);
            // 本地能解析出来且全是私有 / 元数据地址：即使经上游也拒绝；本地解析失败（宿主机解析不了）才交给上游
            expect((await connect(port, 'meta.example.com:443', SRC.A)).status).toBe(403);
            expect((await connect(port, 'lan.example.com:443', SRC.A)).status).toBe(403);
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
