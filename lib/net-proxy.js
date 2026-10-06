'use strict';

// 访问 GitHub 的请求读取代理：环境变量（https_proxy 等）或 macOS 系统代理。
// Node 内置 fetch 不读代理变量，所以这里按请求构造带代理的 fetch，绝不修改全局（serve 进程里还有访问本机/容器的请求）。

const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const { spawnSync } = require('child_process');

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 60000;

function pick(env, names) {
    for (const name of names) {
        const value = String(env[name] || env[name.toUpperCase()] || '').trim();
        if (value) return value;
    }
    return '';
}

// 去掉账号密码，只留 scheme://host:port，用于打印
function displayProxy(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}`;
    } catch (error) {
        return '';
    }
}

function normalizeProxyUrl(value) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}

/**
 * 解析 macOS `scutil --proxy` 的输出。返回 { url, noProxy } 或 { unsupported } 或 null。
 * 只认 HTTPS 代理（没有就退到 HTTP 代理）；PAC / 自动代理不解析。
 */
function parseScutilProxy(text) {
    const values = {};
    const exceptions = [];
    let inExceptions = false;
    for (const rawLine of String(text || '').split('\n')) {
        const line = rawLine.trim();
        if (/^ExceptionsList\s*:/.test(line)) { inExceptions = true; continue; }
        if (inExceptions) {
            const item = line.match(/^\d+\s*:\s*(.+)$/);
            if (item) { exceptions.push(item[1].trim()); continue; }
            inExceptions = false;
        }
        const pair = line.match(/^(\w+)\s*:\s*(.+)$/);
        if (pair) values[pair[1]] = pair[2].trim();
    }
    const noProxy = exceptions.map(item => item.replace(/^\*\./, '.')).join(',');
    for (const prefix of ['HTTPS', 'HTTP']) {
        if (values[`${prefix}Enable`] === '1' && values[`${prefix}Proxy`] && /^\d+$/.test(values[`${prefix}Port`] || '')) {
            return { url: `http://${values[`${prefix}Proxy`]}:${values[`${prefix}Port`]}`, noProxy };
        }
    }
    if (values.ProxyAutoConfigEnable === '1' || values.SOCKSEnable === '1') return { unsupported: true };
    return null;
}

function readScutilProxy() {
    const result = spawnSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf-8', timeout: 3000 });
    return result.status === 0 ? result.stdout : '';
}

/**
 * 找出当前该用的代理。优先级：环境变量 > macOS 系统代理 > 无。
 * 返回 { proxyEnv, source: 'env'|'system'|null, display, notice }；notice 是需要告诉用户的一句话（如暂不支持 socks）。
 */
function resolveProxy({ env = process.env, platform = process.platform, readSystemProxy = readScutilProxy } = {}) {
    const noProxy = pick(env, ['no_proxy']);
    const candidates = [pick(env, ['https_proxy']), pick(env, ['http_proxy']), pick(env, ['all_proxy'])].filter(Boolean);
    let notice = '';
    for (const candidate of candidates) {
        const url = normalizeProxyUrl(candidate);
        if (/^socks/i.test(url)) {
            notice = '暂不支持 socks 代理，请改用 http 代理端口。';
            continue;
        }
        if (!/^https?:\/\//i.test(url) || !displayProxy(url)) continue;
        return { proxyEnv: { HTTPS_PROXY: url, HTTP_PROXY: url, ...(noProxy ? { NO_PROXY: noProxy } : {}) }, source: 'env', display: displayProxy(url), notice };
    }
    if (platform === 'darwin') {
        let parsed = null;
        try {
            parsed = parseScutilProxy(readSystemProxy());
        } catch (error) {
            parsed = null;
        }
        if (parsed && parsed.url) {
            const merged = [noProxy, parsed.noProxy].filter(Boolean).join(',');
            return { proxyEnv: { HTTPS_PROXY: parsed.url, HTTP_PROXY: parsed.url, ...(merged ? { NO_PROXY: merged } : {}) }, source: 'system', display: displayProxy(parsed.url), notice };
        }
        if (parsed && parsed.unsupported) notice = '系统代理用了自动配置或 socks，暂不支持，请在终端设置 https_proxy 指向 http 代理端口。';
    }
    return { proxyEnv: null, source: null, display: '', notice };
}

// Agent 的 proxyEnv 选项：Node 22.21+ / 24.5+ 才有
function supportsProxyEnv(version = process.versions.node) {
    const [major, minor] = String(version).split('.').map(Number);
    if (major >= 25) return true;
    if (major === 24) return minor >= 5;
    if (major === 22) return minor >= 21;
    return false;
}

function requestOnce(url, options, agents) {
    const target = new URL(url);
    const client = target.protocol === 'http:' ? http : https;
    const agent = target.protocol === 'http:' ? agents.http : agents.https;
    return new Promise((resolve, reject) => {
        const req = client.request(target, { method: options.method || 'GET', headers: options.headers || {}, agent, signal: options.signal }, resolve);
        // 连接或下载中途卡住（代理停止转发等）时不能永远挂着：空闲超过 60 秒按超时处理
        req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('空闲超时'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
        req.end();
    });
}

/**
 * 带代理的最小 fetch 兼容实现（status / ok / headers.get / json / text / body）。
 * 手动跟随最多 5 次重定向，每一跳都由 Agent 按 NO_PROXY 重新判断是否走代理；HTTPS 目标走 CONNECT 隧道，证书照常校验。
 */
function createProxyFetch(proxyEnv, agentOptions = {}) {
    const agents = {
        http: new http.Agent({ proxyEnv, keepAlive: false }),
        https: new https.Agent({ proxyEnv, keepAlive: false, ...agentOptions })
    };
    return async function proxyFetch(url, options = {}) {
        let current = String(url);
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
            const res = await requestOnce(current, options, agents);
            const location = res.headers.location;
            if (res.statusCode >= 300 && res.statusCode < 400 && location && options.redirect !== 'manual') {
                res.resume();
                const next = new URL(location, current);
                // 跨站跳转不带凭据类请求头
                if (next.host !== new URL(current).host && options.headers) {
                    options = { ...options, headers: Object.fromEntries(Object.entries(options.headers).filter(([key]) => !/^(authorization|cookie)$/i.test(key))) };
                }
                current = next.toString();
                continue;
            }
            const headers = { get: name => { const value = res.headers[String(name).toLowerCase()]; return Array.isArray(value) ? value.join(', ') : value === undefined ? null : value; } };
            const readText = async () => {
                const chunks = [];
                for await (const chunk of res) chunks.push(chunk);
                return Buffer.concat(chunks).toString('utf-8');
            };
            return {
                status: res.statusCode,
                ok: res.statusCode >= 200 && res.statusCode < 300,
                headers,
                url: current,
                body: Readable.toWeb(res),
                text: readText,
                json: async () => JSON.parse(await readText())
            };
        }
        throw Object.assign(new Error('重定向次数过多'), { cause: { code: 'TOO_MANY_REDIRECTS' } });
    };
}

/**
 * 访问 GitHub 用的 fetch：有可用代理时返回带代理的版本，否则返回内置 fetch。
 * 返回 { fetch, proxy, notice }；notice 是要打印给用户的提示（使用了哪个代理 / 为什么没用）。
 */
function getGithubFetch({ env = process.env, platform = process.platform, readSystemProxy, nodeVersion = process.versions.node, baseFetch = globalThis.fetch } = {}) {
    const proxy = resolveProxy({ env, platform, readSystemProxy });
    if (!proxy.proxyEnv) return { fetch: baseFetch, proxy, notice: proxy.notice };
    if (!supportsProxyEnv(nodeVersion)) {
        return { fetch: baseFetch, proxy, notice: '当前 Node 版本不支持代理，请升级到 Node 22.21+ 或 24+。' };
    }
    const label = proxy.source === 'system' ? '使用系统代理' : '使用代理';
    return { fetch: createProxyFetch(proxy.proxyEnv), proxy, notice: `${label}: ${proxy.display}` };
}

module.exports = { resolveProxy, parseScutilProxy, displayProxy, supportsProxyEnv, createProxyFetch, getGithubFetch };
