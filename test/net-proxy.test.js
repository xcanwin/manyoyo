'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveProxy, parseScutilProxy, displayProxy, supportsProxyEnv, createProxyFetch, getGithubFetch } = require('../lib/net-proxy');

const SCUTIL_ON = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  HTTPEnable : 1
  HTTPPort : 8888
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
}`;

describe('resolveProxy', () => {
    test('环境变量：小写优先，打印地址去掉账号密码，NO_PROXY 透传', () => {
        const result = resolveProxy({ env: { https_proxy: 'http://u:p@10.0.0.1:7890', HTTPS_PROXY: 'http://other:1', NO_PROXY: 'a.com' }, platform: 'linux' });
        expect(result.source).toBe('env');
        expect(result.display).toBe('http://10.0.0.1:7890');
        expect(result.display).not.toMatch(/u:p/);
        expect(result.proxyEnv.HTTPS_PROXY).toBe('http://u:p@10.0.0.1:7890');
        expect(result.proxyEnv.NO_PROXY).toBe('a.com');
    });

    test('优先级 HTTPS_PROXY > HTTP_PROXY > ALL_PROXY，无 scheme 补 http://', () => {
        expect(resolveProxy({ env: { HTTP_PROXY: 'h:1', ALL_PROXY: 'a:2' }, platform: 'linux' }).display).toBe('http://h:1');
        expect(resolveProxy({ env: { ALL_PROXY: 'a:2' }, platform: 'linux' }).display).toBe('http://a:2');
    });

    test('socks 代理不支持并给出提示', () => {
        const result = resolveProxy({ env: { ALL_PROXY: 'socks5://127.0.0.1:1080' }, platform: 'linux' });
        expect(result.proxyEnv).toBeNull();
        expect(result.notice).toMatch(/socks/);
    });

    test('非 macOS 不读系统代理', () => {
        const read = jest.fn(() => SCUTIL_ON);
        expect(resolveProxy({ env: {}, platform: 'linux', readSystemProxy: read }).source).toBeNull();
        expect(read).not.toHaveBeenCalled();
    });

    test('macOS 无环境变量时读系统代理，环境变量存在时不读', () => {
        const read = jest.fn(() => SCUTIL_ON);
        const system = resolveProxy({ env: {}, platform: 'darwin', readSystemProxy: read });
        expect(system.source).toBe('system');
        expect(system.display).toBe('http://127.0.0.1:7890');
        expect(system.proxyEnv.NO_PROXY).toBe('.local,169.254/16');
        const env = resolveProxy({ env: { https_proxy: 'http://e:1' }, platform: 'darwin', readSystemProxy: read });
        expect(env.source).toBe('env');
        expect(read).toHaveBeenCalledTimes(1);
    });
});

describe('parseScutilProxy', () => {
    test('只有 HTTP 时退到 HTTP 项', () => {
        expect(parseScutilProxy('HTTPEnable : 1\nHTTPPort : 8888\nHTTPProxy : 1.2.3.4\nHTTPSEnable : 0').url).toBe('http://1.2.3.4:8888');
    });

    test('全部关闭返回 null', () => {
        expect(parseScutilProxy('HTTPEnable : 0\nHTTPSEnable : 0\nProxyAutoConfigEnable : 0')).toBeNull();
        expect(parseScutilProxy('')).toBeNull();
    });

    test('PAC / socks 标为不支持', () => {
        expect(parseScutilProxy('ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : http://x/pac')).toEqual({ unsupported: true });
        expect(parseScutilProxy('SOCKSEnable : 1\nSOCKSPort : 1\nSOCKSProxy : 1.1.1.1')).toEqual({ unsupported: true });
    });
});

test('displayProxy 去掉凭据', () => {
    expect(displayProxy('http://user:pass@h:8080')).toBe('http://h:8080');
    expect(displayProxy('不是地址')).toBe('');
});

test('supportsProxyEnv 按 Node 版本判断', () => {
    expect(supportsProxyEnv('22.20.0')).toBe(false);
    expect(supportsProxyEnv('22.21.0')).toBe(true);
    expect(supportsProxyEnv('24.4.0')).toBe(false);
    expect(supportsProxyEnv('24.21.0')).toBe(true);
    expect(supportsProxyEnv('20.0.0')).toBe(false);
});

describe('getGithubFetch', () => {
    test('没有代理返回基础 fetch', () => {
        const baseFetch = jest.fn();
        expect(getGithubFetch({ env: {}, platform: 'linux', baseFetch }).fetch).toBe(baseFetch);
    });

    test('Node 太老时提示并直连', () => {
        const baseFetch = jest.fn();
        const result = getGithubFetch({ env: { https_proxy: 'http://h:1' }, platform: 'linux', nodeVersion: '22.1.0', baseFetch });
        expect(result.fetch).toBe(baseFetch);
        expect(result.notice).toMatch(/Node/);
    });

    test('有代理时打印去凭据的地址', () => {
        const result = getGithubFetch({ env: { https_proxy: 'http://u:p@h:1' }, platform: 'linux', nodeVersion: '24.21.0' });
        expect(result.notice).toBe('使用代理: http://h:1');
    });
});

// ---- 真实代理替身：只处理 CONNECT（HTTPS 目标）和绝对地址转发（HTTP 目标），并记录经过的请求 ----
const itProxy = supportsProxyEnv() ? test : test.skip;

function startProxy() {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push(`HTTP ${req.url}`);
        const target = new URL(req.url);
        const upstream = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers }, upstreamRes => {
            res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
            upstreamRes.pipe(res);
        });
        req.pipe(upstream);
    });
    server.on('connect', (req, clientSocket, head) => {
        seen.push(`CONNECT ${req.url}`);
        const [host, port] = req.url.split(':');
        const upstream = net.connect(Number(port), host, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

describe('createProxyFetch（真实代理替身）', () => {
    let proxy;
    beforeEach(async () => { proxy = await startProxy(); });
    afterEach(() => { proxy.server.close(); });

    itProxy('HTTP 目标经代理转发，并跟随重定向', async () => {
        const target = http.createServer((req, res) => {
            if (req.url === '/a') { res.writeHead(302, { Location: '/b' }); res.end(); return; }
            res.writeHead(200, { 'x-test': 'yes' });
            res.end('{"ok":true}');
        });
        const port = await listen(target);
        try {
            const proxyFetch = createProxyFetch({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` });
            const response = await proxyFetch(`http://127.0.0.1:${port}/a`);
            expect(response.ok).toBe(true);
            expect(response.headers.get('x-test')).toBe('yes');
            expect(await response.json()).toEqual({ ok: true });
            expect(proxy.seen.length).toBe(2);
        } finally {
            target.close();
        }
    });

    itProxy('NO_PROXY 命中时不经过代理', async () => {
        const target = http.createServer((req, res) => res.end('direct'));
        const port = await listen(target);
        try {
            const proxyFetch = createProxyFetch({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: '127.0.0.1' });
            expect(await (await proxyFetch(`http://127.0.0.1:${port}/`)).text()).toBe('direct');
            expect(proxy.seen).toEqual([]);
        } finally {
            target.close();
        }
    });

    const opensslOk = spawnSync('openssl', ['version']).status === 0;
    (opensslOk && supportsProxyEnv() ? test : test.skip)('HTTPS 目标走 CONNECT 隧道，流式下载完整，证书照常校验', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-proxy-test-'));
        try {
            const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { encoding: 'utf-8' });
            expect(gen.status).toBe(0);
            const cert = fs.readFileSync(path.join(dir, 'c.pem'));
            const body = Buffer.alloc(3 * 1024 * 1024, 7);
            const target = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert }, (req, res) => res.end(body));
            const port = await listen(target);
            try {
                const env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, HTTP_PROXY: `http://127.0.0.1:${proxy.port}` };
                const trusted = createProxyFetch(env, { ca: cert });
                const response = await trusted(`https://localhost:${port}/`);
                const chunks = [];
                for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
                expect(Buffer.concat(chunks).length).toBe(body.length);
                expect(proxy.seen).toEqual([`CONNECT localhost:${port}`]);
                // 不信任这张证书时必须失败（校验没有被关掉）
                await expect(createProxyFetch(env)(`https://localhost:${port}/`)).rejects.toBeTruthy();
            } finally {
                target.close();
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

test('不修改全局：http.globalAgent / https.globalAgent / 全局 fetch 保持原样（serve 里还有访问本机的请求）', () => {
    const before = [http.globalAgent, https.globalAgent, globalThis.fetch, process.env.NODE_USE_ENV_PROXY];
    getGithubFetch({ env: { https_proxy: 'http://h:1' }, platform: 'linux', nodeVersion: '24.21.0' });
    expect([http.globalAgent, https.globalAgent, globalThis.fetch, process.env.NODE_USE_ENV_PROXY]).toEqual(before);
});

describe('createProxyFetch 的健壮性', () => {
    test('跨站重定向不带 Authorization / Cookie', async () => {
        const seen = [];
        const server = http.createServer((req, res) => {
            seen.push({ url: req.url, host: req.headers.host, auth: req.headers.authorization || '' });
            if (req.url === '/r') { res.writeHead(302, { Location: `http://localhost:${server.address().port}/b` }); return res.end(); }
            return res.end('ok');
        });
        const port = await listen(server);
        try {
            const proxyFetch = createProxyFetch({ HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost' });
            await (await proxyFetch(`http://127.0.0.1:${port}/r`, { headers: { Authorization: 'secret' } })).text();
            expect(seen.map(item => item.auth)).toEqual(['secret', '']);
        } finally {
            server.close();
        }
    });
});
