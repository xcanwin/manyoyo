'use strict';

const http = require('http');
const net = require('net');
const { createEgressProxy, isRestrictedAddress, decide } = require('../lib/egress-proxy');
const { normalizePolicy, compileProxyPolicy } = require('../lib/network-policy');

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

const ENDPOINTS = { hostIps: ['172.16.99.1'], bridge: { subnet: '10.89.0.0/24', gateway: '10.89.0.1' }, containers: {} };
const rule = (action, target, extra = {}) => ({ action, target, ports: '', proto: 'all', enabled: true, ...extra });
const compile = (preset, outbound, endpoints = ENDPOINTS) => compileProxyPolicy(normalizePolicy({ preset, outbound }), endpoints);

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
            [A]: compile('allowlist', [
                rule('allow', 'ok.example.com'), rule('allow', '*.wild.example.com'),
                rule('allow', 'lan.example.com'), rule('allow', 'mixed.example.com'), rule('allow', '*.mixed.example.com'),
                rule('allow', '93.184.216.34', { ports: String(echoPort), proto: 'tcp' })
            ]),
            [B]: compile('allowlist', [rule('allow', 'other.example.com')])
        };
        // 虚构的公网地址 93.184.216.34 实际拨到本机回显服务（mapAddress）
        lookups = {
            'ok.example.com': ['93.184.216.34'], 'a.wild.example.com': ['93.184.216.34'], 'other.example.com': ['93.184.216.34'],
            'meta.wild.example.com': ['169.254.169.254'], 'priv.wild.example.com': ['10.1.2.3'], 'lan.example.com': ['10.1.2.3'],
            'mixed.example.com': ['10.1.2.3', '93.184.216.34'], 'a.mixed.example.com': ['10.1.2.3', '93.184.216.34'],
            'loop.example.com': ['127.0.0.1']
        };
        proxy = createEgressProxy({
            getClient: ip => clientOf(ip),
            onDenied: event => denied.push(event),
            mapAddress: () => '127.0.0.1',
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
        const address = await connect(proxyPort, 'priv.wild.example.com:80');
        expect(address.buf).toContain('Proxy-Status: proxy; error=destination_ip_prohibited');
        expect(`${domain.buf}${address.buf}`.toLowerCase()).not.toMatch(/manyoyo|via:|x-forwarded/);
    });

    test('被拒绝的访问通过 onDenied 记录（容器 id、域名、端口、原因）', async () => {
        await connect(proxyPort, `evil.example.org:${echoPort}`);
        await connect(proxyPort, 'priv.wild.example.com:80');
        expect(denied).toEqual([
            { id: A, host: 'evil.example.org', port: echoPort, reason: 'domain' },
            { id: A, host: 'priv.wild.example.com', port: 80, reason: 'address' }
        ]);
    });

    test('允许的域名（精确与通配）可通；其他域名 403；别的容器只按它自己的规则', async () => {
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, SRC.A)).status).toBe(200);
        expect((await connect(proxyPort, `a.wild.example.com:${echoPort}`, SRC.A)).status).toBe(200);
        expect((await connect(proxyPort, `evil.example.org:${echoPort}`, SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, `wild.example.com:${echoPort}`, SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, SRC.B)).status).toBe(403);
    });

    test('精确域名命中即放行（写了它就是信任它，哪怕解析到内网）；通配域名解析到内网 / 元数据要另有允许该地址的规则', async () => {
        expect((await connect(proxyPort, `lan.example.com:${echoPort}`, SRC.A)).status).toBe(200);
        expect((await connect(proxyPort, 'priv.wild.example.com:80', SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, 'meta.wild.example.com:80', SRC.A)).status).toBe(403);
        // 通配 + 混合记录：只拨可用的那条（公网），不拨内网
        expect((await connect(proxyPort, `a.mixed.example.com:${echoPort}`, SRC.A)).status).toBe(200);
        // 给内网地址加一行允许后，通配域名才放行
        policies[A] = compile('allowlist', [rule('allow', '*.wild.example.com'), rule('allow', '10.1.2.3', { ports: String(echoPort), proto: 'tcp' })]);
        expect((await connect(proxyPort, `priv.wild.example.com:${echoPort}`, SRC.A)).status).toBe(200);
        expect((await connect(proxyPort, `priv.wild.example.com:${echoPort + 1}`, SRC.A)).status).toBe(403);
    });

    test('环回地址永远拒绝（即使有允许 @any / 显式允许行）', async () => {
        policies[A] = compile('custom', [rule('allow', '@any'), rule('allow', '127.0.0.1')]);
        expect((await connect(proxyPort, `127.0.0.1:${echoPort}`, SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, `loop.example.com:${echoPort}`, SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, '[::1]:80', SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, '[::ffff:127.0.0.1]:80', SRC.A)).status).toBe(403);
    });

    test('规则从上往下第一条命中：上面的拒绝盖过下面的允许，反之亦然', async () => {
        policies[A] = compile('allowlist', [rule('deny', 'a.wild.example.com'), rule('allow', '*.wild.example.com')]);
        expect((await connect(proxyPort, `a.wild.example.com:${echoPort}`, SRC.A)).status).toBe(403);
        policies[A] = compile('allowlist', [rule('allow', 'a.wild.example.com'), rule('deny', '*.wild.example.com')]);
        expect((await connect(proxyPort, `a.wild.example.com:${echoPort}`, SRC.A)).status).toBe(200);
    });

    test('收紧：默认放行公网，域名拒绝行生效；内网解析 / 内网字面量被默认行拒绝，允许行排在上面才放行', async () => {
        policies[A] = compile('restricted', [rule('deny', 'ok.example.com'), rule('allow', '10.1.2.3', { ports: '8000', proto: 'tcp' })]);
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, `other.example.com:${echoPort}`, SRC.A)).status).toBe(200);
        expect((await connect(proxyPort, `93.184.216.34:${echoPort}`, SRC.A)).status).toBe(200);
        expect((await connect(proxyPort, `lan.example.com:${echoPort}`, SRC.A)).status).toBe(403); // 解析到内网，没有允许行
        expect((await connect(proxyPort, '10.1.2.4:8000', SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, '172.16.99.1:80', SRC.A)).status).toBe(403); // @host
        expect((await connect(proxyPort, '169.254.169.254:80', SRC.A)).status).toBe(403);
    });

    test('端口与协议：规则只在端口命中时生效；udp 行对代理无效', async () => {
        policies[A] = compile('allowlist', [rule('allow', 'ok.example.com', { ports: String(echoPort) })]);
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, SRC.A)).status).toBe(200);
        expect((await connect(proxyPort, `ok.example.com:${echoPort + 1}`, SRC.A)).status).toBe(403);
    });

    test('IP 字面量（allowlist）：只有允许行才可达', async () => {
        expect((await connect(proxyPort, `93.184.216.34:${echoPort}`, SRC.A)).status).toBe(200);
        expect((await connect(proxyPort, `93.184.216.34:${echoPort}`, SRC.B)).status).toBe(403);
        expect((await connect(proxyPort, '8.8.8.8:443', SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, '169.254.169.254:80', SRC.A)).status).toBe(403);
        expect((await connect(proxyPort, '[::ffff:10.0.0.1]:80', SRC.A)).status).toBe(403);
    });

    test('客户端项没有 rules（损坏 / 旧格式）：全部 403', async () => {
        policies[A] = { preset: 'allowlist' };
        expect((await connect(proxyPort, `ok.example.com:${echoPort}`, SRC.A)).status).toBe(403);
    });

    test('普通 HTTP 请求同样按来源识别与按域名放行；代理不加任何头', async () => {
        const target = http.createServer((req, res) => res.end(`got ${req.url} host=${req.headers.host} headers=${Object.keys(req.headers).sort().join(',')}`));
        const targetPort = await listen(target);
        policies[A] = compile('allowlist', [rule('allow', 'ok.example.com')]);
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
            expect(ok.body).toMatch(/^got \/x\?y=1 host=ok\.example\.com:\d+ headers=(connection,)?host$/);
            // 客户端发来的 Host 与 URL 里的主机不一致时，以 URL 为准（放行判断看的就是 URL）
            const spoofed = await new Promise(resolve => {
                http.get({ host: '127.0.0.1', port: proxyPort, path: `http://ok.example.com:${targetPort}/h`, headers: { Host: 'evil.example.org' } }, res => {
                    let body = '';
                    res.on('data', c => { body += c; });
                    res.on('end', () => resolve(body));
                });
            });
            expect(spoofed).toContain(`host=ok.example.com:${targetPort}`);
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
            // 宿主机解析不了 ok.example.com（交给上游）；priv.wild / meta.wild 能解析出私有地址
            lookup: async host => { if (!['meta.wild.example.com', 'priv.wild.example.com'].includes(host)) throw new Error('nx'); return lookups[host]; },
            upstream: `http://user:pw@127.0.0.1:${upstreamPort}`
        });
        const port = await chained.start({ host: '127.0.0.1', port: 0 });
        try {
            expect((await connect(port, 'ok.example.com:443', SRC.A)).status).toBe(200);
            expect(seen).toEqual([{ url: 'ok.example.com:443', auth: `Basic ${Buffer.from('user:pw').toString('base64')}` }]);
            expect((await connect(port, 'evil.example.org:443', SRC.A)).status).toBe(403);
            expect((await connect(port, '127.0.0.1:80', SRC.B)).status).toBe(403);
            // 通配域名本地能解析出来且是内网 / 元数据地址：即使经上游也拒绝；本地解析失败（宿主机解析不了）才交给上游
            expect((await connect(port, 'meta.wild.example.com:443', SRC.A)).status).toBe(403);
            expect((await connect(port, 'priv.wild.example.com:443', SRC.A)).status).toBe(403);
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

    test('decide：地址集合（any / inc / exc）、端口、默认行；规则没看地址时不触发解析', async () => {
        const policy = compile('restricted', [rule('allow', '@host', { ports: '11434', proto: 'tcp' }), rule('deny', '@public', { ports: '25' })]);
        expect((await decide(policy, '172.16.99.1', 11434, ['172.16.99.1'])).ok).toBe(true);
        expect((await decide(policy, '172.16.99.1', 80, ['172.16.99.1'])).ok).toBe(false); // 默认行拒绝 @host
        expect((await decide(policy, '8.8.8.8', 25, ['8.8.8.8'])).ok).toBe(false);
        expect((await decide(policy, '8.8.8.8', 443, ['8.8.8.8'])).ok).toBe(true);
        expect((await decide(policy, '10.89.0.5', 80, ['10.89.0.5'])).ok).toBe(false); // @containers
        expect((await decide(policy, '10.89.0.1', 80, ['10.89.0.1'])).ok).toBe(false); // 网关在 @host / @private 里
        expect((await decide(compile('custom', []), '10.89.0.5', 80, ['10.89.0.5'])).ok).toBe(true);
        expect((await decide(compile('custom', []), 'x.com', 80, [])).ok).toBe(true); // 本地解析不出来：自定义放行，交给上游
        expect((await decide(compile('allowlist', []), 'x.com', 80, [])).ok).toBe(false);
        const resolve = jest.fn(async () => ['93.184.216.34']);
        expect((await decide(compile('allowlist', [rule('allow', 'x.com')]), 'x.com', 80, resolve)).ok).toBe(true);
        expect((await decide(compile('allowlist', [rule('allow', 'x.com')]), 'y.com', 80, resolve)).ok).toBe(false);
        expect(resolve).not.toHaveBeenCalled(); // 域名规则就能判断：不等 DNS
        expect((await decide(compile('restricted', []), 'y.com', 80, resolve)).ok).toBe(true);
        expect(resolve).toHaveBeenCalledTimes(1);
    });
});
