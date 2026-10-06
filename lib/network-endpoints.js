'use strict';

const dns = require('dns').promises;
const net = require('net');
const { normalizePolicy, normalizeDomain } = require('./network-policy');
const { isRestrictedAddress } = require('./egress-proxy');

// 新建容器时从用户在创建时填写的 env 里推断“Agent 要访问的端点”（如 ANTHROPIC_BASE_URL、OPENAI_BASE_URL 指向宿主机上的
// Ollama 或局域网网关），把落在私有网段的写进网络策略，否则默认收紧会让 Agent 一上来就连不上自己配置的模型服务。
// 只在创建时、只读宿主机侧给定的 env（不读容器可写的 /run/manyoyo/env：容器不能靠改自己的 env 来放开自己的防火墙）；
// 结果写进 network.json，在「容器」页的规则里看得到，也可以删。
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
 * 域名白名单模式下它们必须放行，否则 Agent 一发请求就被过滤代理拒绝（客户端只会看到 ERR_PROXY_TUNNEL）。
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

/** 把推断出的端点并进（已校验的）策略；open 预设不需要。 */
async function withEnvEndpoints(policy, envLines, lookup) {
    if (policy.preset === 'open') return policy;
    const inferred = await inferEnvEndpoints(envLines, lookup);
    if (!inferred.host.length && !inferred.rules.length && !inferred.domains.length) return policy;
    const hostKey = r => `${r.ports}/${r.proto}`;
    const ruleKey = r => `${r.cidr}|${r.ports}|${r.proto}`;
    const haveHost = new Set(policy.host.map(hostKey));
    const haveRules = new Set(policy.egress.rules.map(ruleKey));
    return normalizePolicy({
        ...policy,
        host: [...policy.host, ...inferred.host.filter(r => !haveHost.has(hostKey(r)))],
        egress: {
            // 域名同样在任何预设下都登记：以后切到白名单时，模型服务的域名已经在列表里
            domains: [...policy.egress.domains, ...inferred.domains.filter(d => !policy.egress.domains.includes(d))],
            rules: [...policy.egress.rules, ...inferred.rules.filter(r => !haveRules.has(ruleKey(r)))]
        }
    });
}

module.exports = { inferEnvEndpoints, withEnvEndpoints, envUrlDomains };
