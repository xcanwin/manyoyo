'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const http = require('http');
const net = require('net');
const { domainAllowed, PRIVATE_V4, PRIVATE_V6 } = require('./network-policy');
const { isValidId } = require('./container-state');

// 域名白名单的强制执行点：serve 进程内的 HTTP(S) 过滤代理。
// 开启 allowlist 的容器防火墙只放行到这个代理，直连被挡；这里按域名放行 CONNECT / 普通 HTTP，
// 并且解析出的 IP 属于私有 / 环回 / 链路本地段一律拒绝（防借代理打宿主机 loopback 与 DNS 重绑定），
// 除非该容器的 egress.rules 显式放行该 IP:端口。监听 0.0.0.0（容器只能经宿主机 LAN IP 访问宿主机），靠凭据挡局域网。
const REALM = 'manyoyo';
const CONNECT_TIMEOUT_MS = 15000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TUNNELS_PER_CONTAINER = 256;

const blocked = new net.BlockList();
[...PRIVATE_V4, '127.0.0.0/8', '224.0.0.0/4', '255.255.255.255/32'].forEach(cidr => {
    const [addr, prefix] = cidr.split('/');
    blocked.addSubnet(addr, Number(prefix), 'ipv4');
});
[...PRIVATE_V6, 'fe80::/10', 'ff00::/8', '::1/128', '::/128'].forEach(cidr => {
    const [addr, prefix] = cidr.split('/');
    blocked.addSubnet(addr, Number(prefix), 'ipv6');
});

// ::ffff:a.b.c.d 与 NAT64（64:ff9b::/96）里嵌的 IPv4 要按 IPv4 判断
function embeddedV4(ip) {
    const lower = ip.toLowerCase();
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return mapped[1];
    const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hex) {
        const a = parseInt(hex[1], 16);
        const b = parseInt(hex[2], 16);
        return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
    }
    return '';
}

function isRestrictedAddress(ip) {
    const v4 = embeddedV4(ip);
    if (v4) return blocked.check(v4, 'ipv4');
    const family = net.isIP(ip);
    if (!family) return true;
    return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

function ruleCovers(rule, ip, port) {
    if (rule.proto && rule.proto !== 'tcp') return false;
    if (rule.ports) {
        const ok = rule.ports.split(',').some(item => {
            const [a, b] = item.split('-').map(Number);
            return port >= a && port <= (b === undefined ? a : b);
        });
        if (!ok) return false;
    }
    const [addr, prefixText] = rule.cidr.split('/');
    const family = net.isIP(addr);
    if (!family || net.isIP(ip) !== family) return false;
    const list = new net.BlockList();
    list.addSubnet(addr, prefixText === undefined ? (family === 4 ? 32 : 128) : Number(prefixText), family === 4 ? 'ipv4' : 'ipv6');
    return list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

function parseBasicAuth(header) {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(String(header || '').trim());
    if (!m) return null;
    const decoded = Buffer.from(m[1], 'base64').toString('utf-8');
    const i = decoded.indexOf(':');
    if (i < 0) return null;
    return { id: decoded.slice(0, i), token: decoded.slice(i + 1) };
}

function tokenEquals(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseTarget(text) {
    const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:/\s]+)):(\d{1,5})$/.exec(text);
    if (!m) return null;
    const port = Number(m[3]);
    if (port < 1 || port > 65535) return null;
    return { host: (m[1] || m[2]).toLowerCase().replace(/\.$/, ''), port };
}

/**
 * @param {object} options
 * @param {(id: string) => string|null} options.getToken 容器的代理 token（没有返回 null）
 * @param {(id: string) => {preset: string, domains: string[], rules: object[]}|null} options.getPolicy
 * @param {string} [options.upstream] 上游 HTTP 代理 URL（串联）
 * @param {(host: string) => Promise<string[]>} [options.lookup] 测试替身
 */
function createEgressProxy(options) {
    const getToken = options.getToken;
    const getPolicy = options.getPolicy;
    const lookup = options.lookup || (async host => (await dns.lookup(host, { all: true })).map(r => r.address));
    let upstream = null;
    if (options.upstream) {
        try {
            const url = new URL(options.upstream);
            if (url.protocol === 'http:') {
                upstream = { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || 80, auth: url.username ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}` : '' };
            }
        } catch (e) { /* 无效上游当作没有 */ }
    }
    const tunnels = new Map();
    const sockets = new Set(); // CONNECT 劫持出来的 socket 不在 http.Server 的跟踪里，stop 时要自己关
    let server = null;

    function authenticate(req) {
        const cred = parseBasicAuth(req.headers['proxy-authorization']);
        if (!cred || !isValidId(cred.id)) return null;
        const token = getToken(cred.id);
        if (!token || !tokenEquals(token, cred.token)) return null;
        return cred.id;
    }

    // 返回 {ok:true, ip?} 或 {ok:false, status, message}
    async function authorize(id, host, port) {
        const policy = getPolicy(id);
        if (!policy || policy.preset !== 'allowlist') return { ok: false, status: 403, message: 'policy' };
        const isIp = net.isIP(host) !== 0;
        const explicit = (ip, p) => (policy.rules || []).some(rule => ruleCovers(rule, ip, p));
        if (isIp) {
            if (isRestrictedAddress(host) && !explicit(host, port)) return { ok: false, status: 403, message: 'address' };
            if (!explicit(host, port)) return { ok: false, status: 403, message: 'domain' };
            return { ok: true, ip: host };
        }
        if (!domainAllowed(policy.domains, host)) return { ok: false, status: 403, message: 'domain' };
        if (upstream) {
            // 经上游代理时真正的连接由上游解析；这里仍做一次本地解析，解析得到私有 / 环回地址（且没有被显式放行）就拒绝。
            // 本地解析不出来（宿主机不一定能解析）则放行给上游。残余风险：白名单里的通配域名若被控制了 DNS，
            // 本地与上游可能得到不同答案——不要在白名单里放你不信任的通配域名。
            try {
                const local = await lookup(host);
                if (local.length && local.every(ip => isRestrictedAddress(ip) && !explicit(ip, port))) return { ok: false, status: 403, message: 'address' };
            } catch (e) { /* 本地解析失败：交给上游 */ }
            return { ok: true, ip: '' };
        }
        let addresses;
        try {
            addresses = await lookup(host);
        } catch (e) {
            return { ok: false, status: 502, message: 'dns' };
        }
        const usable = addresses.filter(ip => !isRestrictedAddress(ip) || explicit(ip, port));
        if (!usable.length) return { ok: false, status: 403, message: 'address' };
        return { ok: true, ip: usable[0] };
    }

    function reject(res, status, message) {
        const headers = { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' };
        if (status === 407) headers['Proxy-Authenticate'] = `Basic realm="${REALM}"`;
        res.writeHead(status, headers);
        res.end(`manyoyo egress proxy: ${message}\n`);
    }

    function acquire(id) {
        const n = tunnels.get(id) || 0;
        if (n >= MAX_TUNNELS_PER_CONTAINER) return false;
        tunnels.set(id, n + 1);
        return true;
    }

    function release(id) {
        const n = (tunnels.get(id) || 1) - 1;
        if (n <= 0) tunnels.delete(id); else tunnels.set(id, n);
    }

    function rawReject(socket, status, text) {
        const extra = status === 407 ? `Proxy-Authenticate: Basic realm="${REALM}"\r\n` : '';
        socket.end(`HTTP/1.1 ${status} ${text}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
    }

    function track(socket) {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        return socket;
    }

    async function onConnect(req, clientSocket, head) {
        track(clientSocket);
        clientSocket.on('error', () => {});
        const id = authenticate(req);
        if (!id) return rawReject(clientSocket, 407, 'Proxy Authentication Required');
        const target = parseTarget(String(req.url || ''));
        if (!target) return rawReject(clientSocket, 400, 'Bad Request');
        const verdict = await authorize(id, target.host, target.port);
        if (!verdict.ok) return rawReject(clientSocket, verdict.status, verdict.status === 403 ? 'Forbidden' : 'Bad Gateway');
        if (!acquire(id)) return rawReject(clientSocket, 429, 'Too Many Requests');
        let released = false;
        const done = () => { if (!released) { released = true; release(id); } };
        let upstreamSocket;
        if (upstream) {
            upstreamSocket = track(net.connect({ host: upstream.host, port: upstream.port }));
            upstreamSocket.setTimeout(CONNECT_TIMEOUT_MS, () => upstreamSocket.destroy());
            upstreamSocket.once('connect', () => {
                upstreamSocket.setTimeout(IDLE_TIMEOUT_MS, () => upstreamSocket.destroy());
                const authLine = upstream.auth ? `Proxy-Authorization: ${upstream.auth}\r\n` : '';
                const hostPort = net.isIPv6(target.host) ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`;
                upstreamSocket.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n${authLine}\r\n`);
                let buf = Buffer.alloc(0);
                const onData = chunk => {
                    buf = Buffer.concat([buf, chunk]);
                    const end = buf.indexOf('\r\n\r\n');
                    if (end < 0) { if (buf.length > 16384) upstreamSocket.destroy(); return; }
                    upstreamSocket.removeListener('data', onData);
                    const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(buf.toString('latin1', 0, end)) || [])[1]);
                    if (status !== 200) { rawReject(clientSocket, 502, 'Bad Gateway'); upstreamSocket.destroy(); return; }
                    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    const rest = buf.subarray(end + 4);
                    if (rest.length) clientSocket.write(rest);
                    if (head && head.length) upstreamSocket.write(head);
                    upstreamSocket.pipe(clientSocket);
                    clientSocket.pipe(upstreamSocket);
                };
                upstreamSocket.on('data', onData);
            });
        } else {
            upstreamSocket = track(net.connect({ host: verdict.ip, port: target.port }));
            upstreamSocket.setTimeout(CONNECT_TIMEOUT_MS, () => upstreamSocket.destroy());
            upstreamSocket.once('connect', () => {
                upstreamSocket.setTimeout(IDLE_TIMEOUT_MS, () => upstreamSocket.destroy());
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head && head.length) upstreamSocket.write(head);
                upstreamSocket.pipe(clientSocket);
                clientSocket.pipe(upstreamSocket);
            });
        }
        upstreamSocket.on('error', () => { if (!clientSocket.destroyed) rawReject(clientSocket, 502, 'Bad Gateway'); });
        upstreamSocket.on('close', () => { done(); clientSocket.destroy(); });
        clientSocket.on('close', () => { done(); upstreamSocket.destroy(); });
    }

    // 普通 HTTP 代理（绝对 URI 请求）
    async function onRequest(req, res) {
        const id = authenticate(req);
        if (!id) return reject(res, 407, 'proxy authentication required');
        let url;
        try { url = new URL(req.url); } catch (e) { return reject(res, 400, 'absolute URI required'); }
        if (url.protocol !== 'http:') return reject(res, 400, 'only http: URIs');
        const port = Number(url.port) || 80;
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
        const verdict = await authorize(id, host, port);
        if (!verdict.ok) return reject(res, verdict.status, verdict.status === 403 ? 'forbidden by policy' : 'bad gateway');
        if (!acquire(id)) return reject(res, 429, 'too many connections');
        const headers = { ...req.headers };
        delete headers['proxy-authorization'];
        delete headers['proxy-connection'];
        const outbound = upstream
            ? { host: upstream.host, port: upstream.port, path: req.url, headers: { ...headers, ...(upstream.auth ? { 'proxy-authorization': upstream.auth } : {}) } }
            : { host: verdict.ip, port, path: `${url.pathname}${url.search}`, headers };
        const proxyReq = http.request({ ...outbound, method: req.method, timeout: CONNECT_TIMEOUT_MS });
        let released = false;
        const done = () => { if (!released) { released = true; release(id); } };
        proxyReq.on('response', proxyRes => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });
        proxyReq.on('timeout', () => proxyReq.destroy());
        proxyReq.on('error', () => { if (!res.headersSent) reject(res, 502, 'bad gateway'); else res.destroy(); });
        res.on('close', () => { done(); proxyReq.destroy(); });
        req.pipe(proxyReq);
    }

    function start(listen) {
        return new Promise((resolve, fail) => {
            server = http.createServer((req, res) => { onRequest(req, res).catch(() => { try { reject(res, 500, 'error'); } catch (e) { /* 连接已断 */ } }); });
            server.on('connect', (req, socket, head) => { onConnect(req, socket, head).catch(() => socket.destroy()); });
            server.headersTimeout = 20000;
            server.on('clientError', (err, socket) => socket.destroy());
            server.once('error', fail);
            server.listen(listen.port, listen.host, () => {
                server.removeListener('error', fail);
                resolve(server.address().port);
            });
        });
    }

    function stop() {
        return new Promise(resolve => {
            if (!server) return resolve();
            server.close(() => resolve());
            server.closeAllConnections && server.closeAllConnections();
            sockets.forEach(socket => socket.destroy());
            server = null;
        });
    }

    return { start, stop, authorize, isListening: () => Boolean(server && server.listening) };
}

module.exports = { createEgressProxy, isRestrictedAddress, ruleCovers, parseBasicAuth, parseTarget, REALM };
