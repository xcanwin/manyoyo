'use strict';

const dns = require('dns').promises;
const http = require('http');
const net = require('net');
const { domainMatches, PRIVATE_V4, PRIVATE_V6 } = require('./network-policy');

// 域名规则的强制执行点：运行在 manyoyo 网络里专用 sidecar 容器中的 HTTP(S) 过滤代理（见 egress-sidecar.js）。
// 有启用域名规则的容器，HTTP(S) 都走这个代理，防火墙只放行到它；这里按连接的来源 IP 认出是哪个容器（getClient），
// 认不出的来源一律 403；然后按该容器编译好的有序规则（域名行 + 地址行 + 模式默认行）从上往下找第一条命中的。
// 地址行按“任一解析结果”匹配；通配域名命中后，解析结果若落在 @host / @private / @metadata，仍要有一条允许该地址的规则。
// 环回 / 未指定 / 组播地址永远拒绝（防借代理打 sidecar 自己）。
// 被拒绝时统一回 403（带 Proxy-Status，不带任何能暴露代理身份的内容），并通过 onDenied 记录。
const CONNECT_TIMEOUT_MS = 15000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TUNNELS_PER_CONTAINER = 256;
const LOOKUP_TIMEOUT_MS = 5000;

function withTimeout(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}

async function liveOnly(ips) {
    return ips.filter(ip => !checkList(floor, ip));
}

function blockListOf(cidrs) {
    const list = new net.BlockList();
    (cidrs || []).forEach(cidr => {
        const [addr, prefix] = String(cidr).split('/');
        const family = net.isIP(addr);
        if (!family) return;
        const type = family === 4 ? 'ipv4' : 'ipv6';
        if (prefix === undefined) list.addAddress(addr, type);
        else list.addSubnet(addr, Number(prefix), type);
    });
    return list;
}

const blocked = blockListOf([...PRIVATE_V4, ...PRIVATE_V6, 'fe80::/10', 'ff00::/8', '::1/128', '::/128', '127.0.0.0/8', '255.255.255.255/32']);
const floor = blockListOf(['127.0.0.0/8', '0.0.0.0/8', '224.0.0.0/4', '255.255.255.255/32', '::1/128', '::/128', 'ff00::/8']);

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

function checkList(list, ip) {
    const addr = embeddedV4(ip) || ip;
    const family = net.isIP(addr);
    return family ? list.check(addr, family === 4 ? 'ipv4' : 'ipv6') : null;
}

function isRestrictedAddress(ip) {
    const hit = checkList(blocked, ip);
    return hit === null ? true : hit;
}

const setCache = new WeakMap();
function compiledSet(set) {
    let compiled = setCache.get(set);
    if (!compiled) {
        compiled = { inc: blockListOf(set.inc), exc: blockListOf(set.exc) };
        setCache.set(set, compiled);
    }
    return compiled;
}

/** 地址集合 {any, inc, exc} 是否包含 ip。 */
function setCovers(set, ip) {
    if (!set) return false;
    const compiled = compiledSet(set);
    if (!set.any && !checkList(compiled.inc, ip)) return false;
    return !checkList(compiled.exc, ip);
}

const listCache = new WeakMap();
function listCovers(cidrs, ip) {
    let list = listCache.get(cidrs);
    if (!list) {
        list = blockListOf(cidrs);
        listCache.set(cidrs, list);
    }
    return Boolean(checkList(list, ip));
}

function portsCover(ports, port) {
    if (!ports) return true;
    return String(ports).split(',').some(item => {
        const [a, b] = item.split('-').map(Number);
        return port >= a && port <= (b === undefined ? a : b);
    });
}

/**
 * 按容器编译好的有序规则判断一次连接。解析是惰性的：只有规则需要看地址时才查 DNS（被域名规则直接拒绝 / 放行的不用等 DNS）。
 * @param {{rules: object[], default: string, sensitive?: string[]}} policy
 * @param {string} host 目标主机（域名或 IP 字面量）
 * @param {number} port
 * @param {string[]|(() => Promise<string[]>)} ipsOrResolve 目标的解析结果，或惰性解析函数（目标本身是 IP 时就是它自己；解析不出来为空）
 * @returns {Promise<{ok: boolean, reason?: string, usable?: string[]|null}>} usable 为 null 表示判断时没看地址，由调用方按解析结果挑
 */
async function decide(policy, host, port, ipsOrResolve) {
    const isIp = net.isIP(host) !== 0;
    const deny = reason => ({ ok: false, reason });
    let live = null;
    const liveIps = async () => {
        if (live === null) {
            const ips = Array.isArray(ipsOrResolve) ? ipsOrResolve : (isIp ? [host] : await ipsOrResolve());
            live = { all: ips, ok: ips.filter(ip => !checkList(floor, ip)) };
        }
        return live;
    };
    const applies = rule => rule.proto !== 'udp' && portsCover(rule.ports, port);
    const addressAllowed = ip => {
        for (const rule of policy.rules) {
            if (rule.domain || !applies(rule) || !setCovers(rule.addr, ip)) continue;
            return rule.action === 'allow';
        }
        return policy.default === 'allow';
    };
    for (const rule of policy.rules) {
        if (!applies(rule)) continue;
        if (rule.domain) {
            if (isIp || !domainMatches(rule.domain, host)) continue;
            if (rule.action === 'deny') return deny('domain');
            if (rule.domain.startsWith('*.')) {
                const { all, ok } = await liveIps();
                if (all.length && !ok.length) return deny('address');
                const sensitive = policy.sensitive || [];
                const usable = ok.filter(ip => !listCovers(sensitive, ip) || addressAllowed(ip));
                if (ok.length && !usable.length) return deny('address');
                return { ok: true, usable };
            }
            return { ok: true, usable: null };
        }
        const { all, ok } = await liveIps();
        if (all.length && !ok.length) return deny('address');
        const hit = ok.filter(ip => setCovers(rule.addr, ip));
        if (!hit.length) continue;
        return rule.action === 'allow' ? { ok: true, usable: isIp ? ok : hit } : deny('address');
    }
    return policy.default === 'allow' ? { ok: true, usable: null } : deny('domain');
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
 * @param {(ip: string) => {id: string, default: string, sensitive?: string[], rules: object[]}|null} options.getClient 按来源 IP 认容器（认不出返回 null）
 * @param {(event: {id: string, host: string, port: number, reason: string}) => void} [options.onDenied] 拒绝记录
 * @param {string} [options.upstream] 上游 HTTP 代理 URL（串联）
 * @param {(host: string) => Promise<string[]>} [options.lookup] 测试替身
 * @param {(ip: string) => string} [options.mapAddress] 测试替身：实际拨号的地址（单测里把虚构的公网 IP 映射到本机夹具）
 */
function createEgressProxy(options) {
    const getClient = options.getClient;
    const onDenied = options.onDenied || (() => {});
    const mapAddress = options.mapAddress || (ip => ip);
    const lookup = options.lookup || (async host => (await dns.lookup(host, { all: true })).map(r => r.address));
    // upstream 可以是字符串或返回字符串的函数（sidecar 里按文件改动热更新）；解析结果按字符串缓存
    let parsedFor = null;
    let parsedUpstream = null;
    function currentUpstream() {
        const text = typeof options.upstream === 'function' ? options.upstream() : options.upstream;
        if (text !== parsedFor) {
            parsedFor = text;
            parsedUpstream = null;
            if (text) {
                try {
                    const url = new URL(text);
                    if (url.protocol === 'http:') {
                        parsedUpstream = { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || 80, auth: url.username ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}` : '' };
                    }
                } catch (e) { /* 无效上游当作没有 */ }
            }
        }
        return parsedUpstream;
    }
    const tunnels = new Map();
    const sockets = new Set(); // CONNECT 劫持出来的 socket 不在 http.Server 的跟踪里，stop 时要自己关
    let server = null;

    function normalizeSource(address) {
        const text = String(address || '');
        return /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(text) ? text.slice(7) : text;
    }

    // 按来源 IP 认容器：返回 {id, policy}，认不出返回 null
    function identify(socket) {
        let client = null;
        try { client = getClient(normalizeSource(socket.remoteAddress)); } catch (e) { client = null; }
        return client && client.id ? { id: client.id, policy: client } : null;
    }

    // 返回 {ok:true, ip?} 或 {ok:false, status, message}
    async function authorize(policy, host, port, upstream) {
        if (!policy || !Array.isArray(policy.rules)) return { ok: false, status: 403, message: 'domain' };
        const isIp = net.isIP(host) !== 0;
        let addresses = null;
        const resolveIps = async () => {
            if (addresses === null) {
                addresses = [];
                try {
                    addresses = await withTimeout(lookup(host), LOOKUP_TIMEOUT_MS);
                } catch (e) { /* 解析不出来：规则里的域名行仍然判断；经上游代理时交给上游解析 */ }
            }
            return addresses;
        };
        const verdict = await decide(policy, host, port, isIp ? [host] : resolveIps);
        if (!verdict.ok) return { ok: false, status: 403, message: verdict.reason };
        if (upstream) return { ok: true, ip: '' };
        // 直接拨号：需要地址。规则没看过地址时，从解析结果里挑非环回的
        const usable = verdict.usable || (await liveOnly(isIp ? [host] : await resolveIps()));
        if (!usable.length) return isIp || (addresses && addresses.length) ? { ok: false, status: 403, message: 'address' } : { ok: false, status: 502, message: 'dns' };
        return { ok: true, ip: usable[0] };
    }

    // Proxy-Status（RFC 9209）只带通用错误类型；拒绝一律 403，正文只有 Forbidden
    function statusHeader(message) {
        return message === 'address' ? 'proxy; error=destination_ip_prohibited' : 'proxy; error=http_request_denied';
    }

    function reject(res, status, message) {
        const body = { 400: 'Bad Request', 403: 'Forbidden', 429: 'Too Many Requests' }[status] || 'Bad Gateway';
        const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), Connection: 'close' };
        if (status === 403) headers['Proxy-Status'] = statusHeader(message);
        res.writeHead(status, headers);
        res.end(body);
    }

    function deny(client, host, port, reason) {
        try { onDenied({ id: client ? client.id : '', host, port, reason }); } catch (e) { /* 记录失败不影响拒绝 */ }
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

    function rawReject(socket, status, text, message) {
        const extra = status === 403 ? `Proxy-Status: ${statusHeader(message)}\r\n` : '';
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
        const client = identify(clientSocket);
        const target = parseTarget(String(req.url || ''));
        if (!client) return rawReject(clientSocket, 403, 'Forbidden', 'domain');
        if (!target) return rawReject(clientSocket, 400, 'Bad Request');
        const id = client.id;
        const upstream = currentUpstream();
        const verdict = await authorize(client.policy, target.host, target.port, upstream);
        if (!verdict.ok) {
            if (verdict.status === 403) deny(client, target.host, target.port, verdict.message);
            return rawReject(clientSocket, verdict.status, verdict.status === 403 ? 'Forbidden' : 'Bad Gateway', verdict.message);
        }
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
            upstreamSocket = track(net.connect({ host: mapAddress(verdict.ip), port: target.port }));
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
        const client = identify(req.socket);
        if (!client) return reject(res, 403, 'domain');
        const id = client.id;
        let url;
        try { url = new URL(req.url); } catch (e) { return reject(res, 400, 'bad request'); }
        if (url.protocol !== 'http:') return reject(res, 400, 'bad request');
        const port = Number(url.port) || 80;
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
        const upstream = currentUpstream();
        const verdict = await authorize(client.policy, host, port, upstream);
        if (!verdict.ok) {
            if (verdict.status === 403) deny(client, host, port, verdict.message);
            return reject(res, verdict.status, verdict.message);
        }
        if (!acquire(id)) return reject(res, 429, 'limit');
        const headers = { ...req.headers, host: url.host }; // 放行判断看的是 URL 里的主机，Host 头必须与它一致（RFC 9112）
        delete headers['proxy-authorization'];
        delete headers['proxy-connection'];
        const outbound = upstream
            ? { host: upstream.host, port: upstream.port, path: req.url, headers: { ...headers, ...(upstream.auth ? { 'proxy-authorization': upstream.auth } : {}) } }
            : { host: mapAddress(verdict.ip), port, path: `${url.pathname}${url.search}`, headers };
        const proxyReq = http.request({ ...outbound, method: req.method, timeout: CONNECT_TIMEOUT_MS });
        let released = false;
        const done = () => { if (!released) { released = true; release(id); } };
        proxyReq.on('response', proxyRes => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });
        proxyReq.on('timeout', () => proxyReq.destroy());
        proxyReq.on('error', () => { if (!res.headersSent) reject(res, 502, 'upstream'); else res.destroy(); });
        res.on('close', () => { done(); proxyReq.destroy(); });
        req.pipe(proxyReq);
    }

    function start(listen) {
        return new Promise((resolve, fail) => {
            server = http.createServer((req, res) => { onRequest(req, res).catch(() => { try { reject(res, 500, 'upstream'); } catch (e) { /* 连接已断 */ } }); });
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

module.exports = { createEgressProxy, isRestrictedAddress, decide, setCovers, parseTarget };
