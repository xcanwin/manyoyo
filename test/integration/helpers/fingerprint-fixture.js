'use strict';

// 本地夹具：页面暗号 + 指纹采集。不依赖外网，页面把浏览器里读到的指纹 POST 回来，同时记录请求头。
const http = require('http');
const crypto = require('crypto');

const COLLECT_SCRIPT = `
(async () => {
    const out = {};
    const safe = (fn) => { try { return fn(); } catch (e) { return 'error:' + e.message; } };
    out.webdriver = navigator.webdriver;
    out.userAgent = navigator.userAgent;
    out.platform = navigator.platform;
    out.languages = Array.from(navigator.languages || []);
    out.timezone = safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    out.locale = safe(() => Intl.DateTimeFormat().resolvedOptions().locale);
    out.hardwareConcurrency = navigator.hardwareConcurrency;
    out.pluginsLength = navigator.plugins.length;
    out.hasChromeObject = typeof window.chrome === 'object';
    out.screen = { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight };
    out.window = { innerWidth: innerWidth, innerHeight: innerHeight, outerWidth: outerWidth, outerHeight: outerHeight, dpr: devicePixelRatio };
    out.webgl = safe(() => {
        const gl = document.createElement('canvas').getContext('webgl');
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return { vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) };
    });
    if (navigator.userAgentData) {
        const data = navigator.userAgentData;
        out.userAgentData = { brands: data.brands, mobile: data.mobile, platform: data.platform };
        out.highEntropy = await data.getHighEntropyValues(['platformVersion', 'architecture', 'model', 'fullVersionList']).catch(e => 'error:' + e.message);
    } else {
        out.userAgentData = null;
    }
    await fetch('/report', { method: 'POST', body: JSON.stringify(out) });
    document.title = 'collected';
})();
`;

function startFixture({ host = '0.0.0.0', port = 0 } = {}) {
    const secret = `暗号-${crypto.randomBytes(4).toString('hex')}`;
    const state = { headers: null, report: null, reportWaiters: [] };
    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/report') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                state.report = JSON.parse(body);
                state.reportWaiters.splice(0).forEach(resolve => resolve(state.report));
                res.writeHead(204).end();
            });
            return;
        }
        if (req.url === '/state') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ headers: state.headers, report: state.report, secret }));
            return;
        }
        if (req.url === '/fingerprint') {
            state.headers = req.headers;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Accept-CH': 'Sec-CH-UA-Platform-Version' });
            res.end(`<!doctype html><meta charset="utf-8"><title>fp</title><body>${secret}<script>${COLLECT_SCRIPT}</script>`);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>fixture</title><body><h1 id="secret">${secret}</h1>`);
    });
    return new Promise(resolve => {
        server.listen(port, host, () => resolve({
            port: server.address().port,
            secret,
            state,
            waitForReport: (timeout = 15000) => new Promise((ok, fail) => {
                if (state.report) {
                    ok(state.report);
                    return;
                }
                state.reportWaiters.push(ok);
                setTimeout(() => fail(new Error('指纹夹具没有收到回报')), timeout);
            }),
            close: () => new Promise(done => server.close(done))
        }));
    });
}

if (require.main === module) {
    // 在容器内单独运行：localhost 是安全上下文，userAgentData 与 Sec-CH-UA 才会出现
    startFixture({ host: '127.0.0.1', port: Number(process.argv[2]) || 0 }).then(fixture => console.log(`fixture ${fixture.port}`));
}

module.exports = { startFixture };
