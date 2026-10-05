'use strict';

const net = require('net');
const { isValidId } = require('./container-state');

// 容器网络策略：校验（唯一入口）+ 生成 nft 规则文本。
// nft 文本只由校验过的结构化数据生成：IP/CIDR 经 net.isIP + 前缀整数、端口是 1-65535 的整数、域名不进规则
// （域名只在过滤代理里匹配），所以任何用户字符串都拼不进规则。
const PRESETS = ['restricted', 'open', 'allowlist'];
const PROTOS = ['tcp', 'udp'];
const LIMITS = { domains: 200, rules: 100, host: 50, inbound: 50, deny: 100, expose: 20, portItems: 32 };
const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// restricted / allowlist 默认禁止的私有与保留网段（公网放行）
const PRIVATE_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '240.0.0.0/4'];
const PRIVATE_V6 = ['fc00::/7'];

function fail(message) {
    throw new Error(message);
}

function isPort(value) {
    return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * 端口表达式 "80" / "80-90" / "80,443,8000-8100" → 规范化字符串；空串表示不限端口（仅部分规则允许）。
 */
function normalizePorts(input, { required = true, label = '端口' } = {}) {
    const text = String(input === undefined || input === null ? '' : input).replace(/\s+/g, '');
    if (!text) {
        if (required) fail(`${label}不能为空`);
        return '';
    }
    const items = text.split(',');
    if (items.length > LIMITS.portItems) fail(`${label}条目过多`);
    const out = items.map(item => {
        const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(item);
        if (!m) fail(`${label}格式非法: ${String(input).slice(0, 40)}`);
        const a = Number(m[1]);
        const b = m[2] === undefined ? a : Number(m[2]);
        if (!isPort(a) || !isPort(b) || b < a) fail(`${label}超出范围: ${item}`);
        return a === b ? String(a) : `${a}-${b}`;
    });
    return out.join(',');
}

function normalizeProto(input) {
    const proto = String(input === undefined || input === null || input === '' ? 'tcp' : input).toLowerCase();
    if (!PROTOS.includes(proto)) fail(`协议只支持 tcp / udp: ${String(input).slice(0, 20)}`);
    return proto;
}

/** IP 或 CIDR，返回 {cidr, family}；不接受主机名。 */
function normalizeCidr(input, label = 'CIDR') {
    const text = String(input === undefined || input === null ? '' : input).trim();
    const m = /^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/.exec(text);
    if (!m) fail(`${label}格式非法: ${text.slice(0, 60)}`);
    const family = net.isIP(m[1]);
    if (!family) fail(`${label}不是合法 IP: ${text.slice(0, 60)}`);
    const max = family === 4 ? 32 : 128;
    let prefix = m[2] === undefined ? max : Number(m[2]);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) fail(`${label}前缀超出范围: ${text.slice(0, 60)}`);
    return { cidr: `${m[1].toLowerCase()}${m[2] === undefined ? '' : `/${prefix}`}`, family };
}

function normalizeDomain(input) {
    const text = String(input === undefined || input === null ? '' : input).trim().toLowerCase();
    if (text.length > 253 || !DOMAIN_RE.test(text)) fail(`域名非法: ${text.slice(0, 80)}`);
    return text;
}

function normalizeBind(input) {
    const text = String(input === undefined || input === null || input === '' ? '127.0.0.1' : input).trim();
    if (!net.isIP(text)) fail(`监听地址必须是 IP: ${text.slice(0, 60)}`);
    return text.toLowerCase();
}

function asArray(value, max, label) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) fail(`${label}必须是数组`);
    if (value.length > max) fail(`${label}最多 ${max} 条`);
    return value;
}

function asObject(value, label) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象`);
    return value;
}

function defaultPolicy() {
    return {
        version: 1,
        preset: 'restricted',
        egress: { domains: [], rules: [] },
        host: [],
        peers: { inbound: [] },
        deny: [],
        expose: [],
        autostartOnServe: false
    };
}

/**
 * 校验并规范化策略；任何非法输入抛错（调用方返回 400）。
 */
function normalizePolicy(input) {
    const src = asObject(input, '网络策略');
    const policy = defaultPolicy();
    if (src.preset !== undefined) {
        if (!PRESETS.includes(src.preset)) fail(`preset 只支持 ${PRESETS.join(' / ')}`);
        policy.preset = src.preset;
    }
    const egress = asObject(src.egress, 'egress');
    const seenDomains = new Set();
    asArray(egress.domains, LIMITS.domains, 'egress.domains').forEach(d => {
        const domain = normalizeDomain(d);
        if (!seenDomains.has(domain)) {
            seenDomains.add(domain);
            policy.egress.domains.push(domain);
        }
    });
    asArray(egress.rules, LIMITS.rules, 'egress.rules').forEach(rule => {
        const r = asObject(rule, 'egress.rules[]');
        const { cidr } = normalizeCidr(r.cidr, 'egress.rules.cidr');
        policy.egress.rules.push({ cidr, ports: normalizePorts(r.ports, { required: false }), proto: normalizeProto(r.proto) });
    });
    asArray(src.host, LIMITS.host, 'host').forEach(entry => {
        const e = asObject(entry, 'host[]');
        policy.host.push({ ports: normalizePorts(e.ports, { label: '宿主机端口' }), proto: normalizeProto(e.proto) });
    });
    const peers = asObject(src.peers, 'peers');
    asArray(peers.inbound, LIMITS.inbound, 'peers.inbound').forEach(entry => {
        const e = asObject(entry, 'peers.inbound[]');
        if (!isValidId(e.from)) fail('peers.inbound.from 必须是容器 id');
        policy.peers.inbound.push({ from: e.from, ports: normalizePorts(e.ports, { label: '入站端口' }), proto: normalizeProto(e.proto) });
    });
    asArray(src.deny, LIMITS.deny, 'deny').forEach(entry => {
        policy.deny.push({ cidr: normalizeCidr(asObject(entry, 'deny[]').cidr, 'deny.cidr').cidr });
    });
    const hostPorts = new Set();
    asArray(src.expose, LIMITS.expose, 'expose').forEach(entry => {
        const e = asObject(entry, 'expose[]');
        const hostPort = Number(e.hostPort);
        const port = Number(e.port);
        if (!isPort(hostPort)) fail(`宿主机端口非法: ${String(e.hostPort).slice(0, 10)}`);
        if (!isPort(port)) fail(`容器端口非法: ${String(e.port).slice(0, 10)}`);
        const bind = normalizeBind(e.bind);
        const key = `${bind}:${hostPort}`;
        if (hostPorts.has(key)) fail(`重复的暴露端口: ${key}`);
        hostPorts.add(key);
        policy.expose.push({ bind, hostPort, port });
    });
    policy.autostartOnServe = src.autostartOnServe === true;
    return policy;
}

// ---- 域名匹配（过滤代理用） ----

/** pattern 为 `example.com`（只匹配自身）或 `*.example.com`（匹配任意子域，不含自身）。 */
function domainMatches(pattern, host) {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    if (pattern.startsWith('*.')) return h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1;
    return h === pattern;
}

function domainAllowed(domains, host) {
    return (domains || []).some(pattern => domainMatches(pattern, host));
}

// ---- nft 生成 ----

function portSet(ports) {
    const normalized = normalizePorts(ports);
    return normalized.includes(',') ? `{ ${normalized.split(',').join(', ')} }` : normalized;
}

function addrExpr(direction, cidr, label) {
    const { cidr: c, family } = normalizeCidr(cidr, label);
    return `${family === 4 ? 'ip' : 'ip6'} ${direction} ${c}`;
}

function portClause(proto, ports) {
    return ports ? ` ${normalizeProto(proto)} dport ${portSet(ports)}` : ` meta l4proto ${normalizeProto(proto)}`;
}

function cidrList(cidrs, family) {
    return cidrs.map(c => normalizeCidr(c)).filter(c => c.family === family).map(c => c.cidr);
}

/**
 * @param {object} policy normalizePolicy 的结果
 * @param {object} endpoints 运行时解析出的地址（下发时现算，全部重新校验）
 * @param {string[]} [endpoints.dns]
 * @param {{ip:string, ports:string, proto?:string}[]} [endpoints.allow] manyoyo 必需端点、上游代理、过滤代理、Playwright、镜像、host 端口、出站 peer
 * @param {{ip:string, ports:string, proto?:string}[]} [endpoints.peerIn] 允许进来的 peer
 * @param {{subnet:string, gateway:string}|null} [endpoints.bridge]
 * @returns {string} 整份 nft 脚本（先删后建，一次 nft -f 原子替换）；open 预设只删表
 */
function buildNftRuleset(policy, endpoints = {}) {
    const lines = ['add table inet manyoyo', 'delete table inet manyoyo'];
    if (policy.preset === 'open') return `${lines.join('\n')}\n`;

    const out = ['    oif lo accept', '    ct state established,related accept'];
    (endpoints.dns || []).forEach(ip => {
        const { cidr, family } = normalizeCidr(ip, 'dns');
        const prefix = family === 4 ? 'ip' : 'ip6';
        out.push(`    ${prefix} daddr ${cidr} udp dport 53 accept`);
        out.push(`    ${prefix} daddr ${cidr} tcp dport 53 accept`);
    });
    (endpoints.allow || []).forEach(item => {
        out.push(`    ${addrExpr('daddr', item.ip, 'allow')}${portClause(item.proto, item.ports)} accept`);
    });
    if (policy.preset === 'allowlist') {
        policy.egress.rules.forEach(rule => {
            out.push(`    ${addrExpr('daddr', rule.cidr, 'egress')}${portClause(rule.proto, rule.ports)} accept`);
        });
        out.push('    reject');
    } else {
        // restricted：先放行用户 deny 之外的公网，再封私有网段
        policy.deny.forEach(rule => out.push(`    ${addrExpr('daddr', rule.cidr, 'deny')} reject`));
        const v4 = cidrList(PRIVATE_V4, 4);
        const v6 = cidrList(PRIVATE_V6, 6);
        out.push(`    ip daddr { ${v4.join(', ')} } reject`);
        out.push(`    ip6 daddr { ${v6.join(', ')} } reject`);
        out.push('    meta l4proto { tcp, udp } ip6 daddr fe80::/10 reject');
    }

    const inn = ['    iif lo accept', '    ct state established,related accept'];
    (endpoints.peerIn || []).forEach(item => {
        inn.push(`    ${addrExpr('saddr', item.ip, 'peer')}${portClause(item.proto, item.ports)} accept`);
    });
    if (endpoints.bridge) {
        const subnet = normalizeCidr(endpoints.bridge.subnet, 'bridge.subnet');
        const gateway = normalizeCidr(endpoints.bridge.gateway, 'bridge.gateway');
        if (subnet.family === 4 && gateway.family === 4) {
            inn.push(`    ip saddr ${subnet.cidr} ip saddr != ${gateway.cidr} ct state new reject`);
        }
    }

    lines.push('table inet manyoyo {');
    lines.push('  chain output {', '    type filter hook output priority 0; policy accept;', ...out, '  }');
    lines.push('  chain input {', '    type filter hook input priority 0; policy accept;', ...inn, '  }');
    lines.push('}');
    return `${lines.join('\n')}\n`;
}

module.exports = {
    PRESETS,
    PRIVATE_V4,
    PRIVATE_V6,
    normalizePorts,
    normalizeProto,
    normalizeCidr,
    normalizeDomain,
    normalizePolicy,
    defaultPolicy,
    domainMatches,
    domainAllowed,
    buildNftRuleset
};
