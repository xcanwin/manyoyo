'use strict';

const dns = require('dns').promises;
const net = require('net');
const { normalizePolicy, normalizeDomain, isUnrestricted } = require('./network-policy');
const { isRestrictedAddress } = require('./egress-proxy');
const { AGENT_ENV_SCHEMA } = require('./init-config');

// 新建容器时从用户在创建时填写的 env 里推断“Agent 要访问的端点”（如 ANTHROPIC_BASE_URL、OPENAI_BASE_URL 指向宿主机上的
// Ollama 或局域网网关），把落在私有网段的写进网络策略，否则默认收紧会让 Agent 一上来就连不上自己配置的模型服务。
// 只在创建时、只读宿主机侧给定的 env（不读容器可写的 /run/manyoyo/env：容器不能靠改自己的 env 来放开自己的防火墙）；
// 结果写进 network.json，在「设置容器」页的规则里看得到，也可以删。
// 代理变量的主机不算“Agent 要访问的服务”
const PROXY_KEYS = new Set(['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);
const HOST_ALIASES = new Set(['host.containers.internal', 'host.docker.internal']);

function urlOf(value) {
    if (!/^https?:\/\//i.test(value)) return null;
    try {
        const url = new URL(value);
        const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
        return { host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port };
    } catch (e) {
        return null;
    }
}

/**
 * env 里 URL 的域名（排除 IP、宿主机别名、代理变量）：Agent 的模型服务（ANTHROPIC_BASE_URL、OPENAI_BASE_URL…）。
 * 仅白名单模式下它们必须放行，否则 Agent 一发请求就被过滤代理拒绝（客户端只会看到 ERR_PROXY_TUNNEL）。
 */
function envUrlDomains(envLines) {
    const out = [];
    for (const line of envLines || []) {
        const text = String(line);
        const i = text.indexOf('=');
        if (i <= 0 || PROXY_KEYS.has(text.slice(0, i))) continue;
        const target = urlOf(text.slice(i + 1));
        if (!target || net.isIP(target.host) || HOST_ALIASES.has(target.host)) continue;
        let domain;
        try { domain = normalizeDomain(target.host); } catch (e) { continue; }
        if (!out.includes(domain)) out.push(domain);
    }
    return out;
}

/**
 * Agent 的模型域名：env 里的 URL 域名，再加官方默认域名（取自 AGENT_ENV_SCHEMA 的 baseUrlPresets）。
 * 官方域名只在该 Agent 没配 BASE_URL 时才算；给了 agentId 就只看这个 Agent，没给则只看配了 Key 的 Agent。
 */
function modelDomains(envLines, agentId) {
    const out = envUrlDomains(envLines);
    const env = {};
    for (const line of envLines || []) {
        const text = String(line);
        const i = text.indexOf('=');
        if (i > 0) env[text.slice(0, i)] = text.slice(i + 1);
    }
    const agents = agentId ? [agentId] : Object.keys(AGENT_ENV_SCHEMA);
    for (const id of agents) {
        const spec = AGENT_ENV_SCHEMA[id];
        if (!spec || env[spec.baseUrlKey]) continue;
        if (!agentId && !spec.requiredAnyOf.some(key => env[key])) continue;
        for (const preset of spec.baseUrlPresets) {
            const target = urlOf(preset.value);
            if (!target) continue;
            let domain;
            try { domain = normalizeDomain(target.host); } catch (e) { continue; }
            if (!out.includes(domain)) out.push(domain);
        }
    }
    return out;
}

/**
 * 判断“被拦的是不是这个 Agent 自己的模型地址”用的：只认该 Agent 的 BASE_URL 变量（配了）或官方默认域名（没配）。
 * 比 modelDomains 窄：env 里别的 URL（npm 源、pip 源……）被拦不能当成模型地址去中止一轮。
 */
function agentModelDomains(envLines, agentId) {
    const spec = AGENT_ENV_SCHEMA[agentId];
    if (!spec) return [];
    const out = [];
    let configured = '';
    for (const line of envLines || []) {
        const text = String(line);
        const i = text.indexOf('=');
        if (i > 0 && text.slice(0, i) === spec.baseUrlKey) configured = text.slice(i + 1);
    }
    const urls = configured ? [configured] : spec.baseUrlPresets.map(item => item.value);
    for (const value of urls) {
        const target = urlOf(value);
        if (!target || net.isIP(target.host) || HOST_ALIASES.has(target.host)) continue;
        try {
            const domain = normalizeDomain(target.host);
            if (!out.includes(domain)) out.push(domain);
        } catch (e) { /* 非法域名忽略 */ }
    }
    return out;
}

/**
 * @param {string[]} envLines KEY=VALUE（创建时的用户 env）
 * @param {(host: string) => Promise<string[]>} [lookup]
 * @returns {Promise<{host: {ports: string, proto: 'tcp'}[], rules: {cidr: string, ports: string, proto: 'tcp'}[]}>}
 */
async function inferEnvEndpoints(envLines, lookup = async host => (await dns.lookup(host, { all: true })).map(r => r.address)) {
    const host = [];
    const rules = [];
    const seen = new Set();
    for (const line of envLines || []) {
        const value = String(line).slice(String(line).indexOf('=') + 1);
        const target = urlOf(value);
        if (!target) continue;
        const key = `${target.host}:${target.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (HOST_ALIASES.has(target.host)) {
            host.push({ ports: String(target.port), proto: 'tcp' });
            continue;
        }
        let addresses = [];
        try {
            addresses = net.isIP(target.host) ? [target.host] : await lookup(target.host);
        } catch (e) {
            addresses = [];
        }
        addresses.filter(ip => isRestrictedAddress(ip) && !/^127\./.test(ip) && ip !== '::1').forEach(ip => {
            rules.push({ cidr: ip, ports: String(target.port), proto: 'tcp' });
        });
    }
    return { host, rules, domains: envUrlDomains(envLines) };
}

/**
 * 把推断出的端点并进（已校验的）策略，写成出站规则行：宿主机端口 → 允许 @host，私有地址 → 允许该 IP，
 * 模型服务域名只在「仅白名单」下加（其他模式本来就能访问公网域名）。不限制的自定义策略不需要。
 */
async function withEnvEndpoints(policy, envLines, lookup) {
    if (isUnrestricted(policy)) return policy;
    const inferred = await inferEnvEndpoints(envLines, lookup);
    const wanted = [
        ...inferred.host.map(r => ({ target: '@host', ports: r.ports, proto: r.proto })),
        ...inferred.rules.map(r => ({ target: r.cidr, ports: r.ports, proto: r.proto })),
        ...(policy.preset === 'allowlist' ? inferred.domains.map(domain => ({ target: domain, ports: '', proto: 'all' })) : [])
    ];
    const key = r => `${r.target}|${r.ports}|${r.proto}`;
    const have = new Set(policy.outbound.filter(r => r.action === 'allow').map(key));
    const added = wanted.filter(r => !have.has(key(r))).map(r => ({ action: 'allow', ...r, enabled: true }));
    if (!added.length) return policy;
    return normalizePolicy({ ...policy, outbound: [...policy.outbound, ...added] });
}

module.exports = { inferEnvEndpoints, withEnvEndpoints, envUrlDomains, modelDomains, agentModelDomains };
