'use strict';

const net = require('net');
const { isValidId } = require('./container-id');

// 容器网络策略：校验（唯一入口）+ 生成 nft 规则文本。
// nft 文本只由校验过的结构化数据生成：IP/CIDR 经 net.isIP + 前缀整数、端口是 1-65535 的整数、域名不进规则
// （域名只在过滤代理里匹配），所以任何用户字符串都拼不进规则。
const PRESETS = ['restricted', 'allowlist', 'custom'];
const PROTOS = ['all', 'tcp', 'udp'];
const LIMITS = { outbound: 200, inbound: 50, expose: 20, portItems: 32, v1: 200 };
const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const OUTBOUND_VARS = ['@containers', '@host', '@private', '@public', '@metadata', '@any'];
const INBOUND_VARS = ['@containers', '@host', '@any'];
const ALWAYS_ALLOWED_VARS = ['@cont_local', '@manyoyo'];

// restricted / allowlist 默认禁止的私有与保留网段（公网放行）
const PRIVATE_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4'];
// 64:ff9b::/96（NAT64）里嵌的是 IPv4，可以映射到私有地址
const PRIVATE_V6 = ['fc00::/7', '64:ff9b::/96'];
// 云服务器元数据地址（AWS / GCP / Azure、阿里云、AWS IPv6）
const METADATA_V4 = ['169.254.169.254', '100.100.100.200'];
const METADATA_V6 = ['fd00:ec2::254'];

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
    const proto = String(input === undefined || input === null || input === '' ? 'all' : input).toLowerCase();
    if (!PROTOS.includes(proto)) fail(`协议只支持 all / tcp / udp: ${String(input).slice(0, 20)}`);
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
        version: 2,
        preset: 'restricted',
        outbound: [],
        inbound: [],
        expose: [],
        autostartOnServe: false
    };
}

// ---- 规则目标 ----

/** 目标 / 来源的类别：var（@ 变量）/ cidr / domain。 */
function targetKind(target) {
    if (String(target).startsWith('@')) return 'var';
    return net.isIP(String(target).split('/')[0]) ? 'cidr' : 'domain';
}

function normalizeTarget(input, direction) {
    const label = direction === 'inbound' ? '来源' : '目标';
    const text = String(input === undefined || input === null ? '' : input).trim();
    if (!text) fail(`${label}不能为空`);
    if (text.startsWith('@')) {
        const [head, ...rest] = text.split(':');
        const name = head.toLowerCase();
        if (ALWAYS_ALLOWED_VARS.includes(name)) fail(`${name} 始终允许，不用写规则`);
        if (name === '@container') {
            const ref = rest.join(':');
            if (!NAME_RE.test(ref) || ref.length > 128) fail(`@container: 后面要写容器名称: ${text.slice(0, 60)}`);
            return `@container:${ref}`;
        }
        if (rest.length || !(direction === 'inbound' ? INBOUND_VARS : OUTBOUND_VARS).includes(name)) fail(`${label}不支持: ${text.slice(0, 60)}`);
        return name;
    }
    if (net.isIP(text.split('/')[0])) return normalizeCidr(text, label).cidr;
    if (direction === 'inbound') fail(`来源只支持 IP / 网段 / @ 变量: ${text.slice(0, 60)}`);
    return normalizeDomain(text);
}

function normalizeRule(entry, direction, index) {
    const where = `${direction}[${index}]`;
    const r = asObject(entry, where);
    if (r.action !== 'allow' && r.action !== 'deny') fail(`${where}.action 只支持 allow / deny`);
    const field = direction === 'inbound' ? 'source' : 'target';
    const target = normalizeTarget(r[field], direction);
    const proto = normalizeProto(r.proto);
    if (targetKind(target) === 'domain' && proto === 'udp') fail(`域名规则只支持 tcp: ${target}`);
    return { action: r.action, [field]: target, ports: normalizePorts(r.ports, { required: false }), proto, enabled: r.enabled !== false };
}

// ---- v1 → v2（读取磁盘上的旧数据时一次性转换；不是兼容层，下次保存即写成 v2） ----

function isV1(src) {
    return src.version === 1 || ['egress', 'host', 'peers', 'deny'].some(key => src[key] !== undefined);
}

function migrateV1(src) {
    const out = { ...src, version: 2, outbound: [], inbound: [] };
    const allowAny = { action: 'allow', ports: '', proto: 'all', enabled: true };
    if (src.preset === 'open') {
        out.preset = 'custom';
        out.outbound = [{ ...allowAny, target: '@any' }];
        out.inbound = [{ ...allowAny, source: '@any' }];
    } else {
        const egress = asObject(src.egress, 'egress');
        asArray(src.deny, LIMITS.v1, 'deny').forEach(entry => {
            out.outbound.push({ action: 'deny', target: asObject(entry, 'deny[]').cidr, ports: '', proto: 'all', enabled: true });
        });
        asArray(src.host, LIMITS.v1, 'host').forEach(entry => {
            const e = asObject(entry, 'host[]');
            out.outbound.push({ action: 'allow', target: '@host', ports: e.ports, proto: e.proto || 'tcp', enabled: true });
        });
        asArray(egress.rules, LIMITS.v1, 'egress.rules').forEach(entry => {
            const e = asObject(entry, 'egress.rules[]');
            out.outbound.push({ action: 'allow', target: e.cidr, ports: e.ports, proto: e.proto || 'tcp', enabled: true });
        });
        // 非白名单预设下旧的域名列表本来不生效，迁移成暂停行，免得老容器突然改走过滤代理
        asArray(egress.domains, LIMITS.v1, 'egress.domains').forEach(domain => {
            out.outbound.push({ action: 'allow', target: domain, ports: '', proto: 'all', enabled: src.preset === 'allowlist' });
        });
    }
    if (src.preset !== 'open') {
        asArray(asObject(src.peers, 'peers').inbound, LIMITS.v1, 'peers.inbound').forEach(entry => {
            const e = asObject(entry, 'peers.inbound[]');
            if (!isValidId(e.from)) fail('peers.inbound.from 必须是容器 id');
            out.inbound.push({ action: 'allow', source: `@container:${e.from}`, ports: e.ports, proto: e.proto || 'tcp', enabled: true });
        });
    }
    delete out.egress;
    delete out.host;
    delete out.peers;
    delete out.deny;
    return out;
}

/**
 * 校验并规范化策略；任何非法输入抛错（调用方返回 400）。旧 v1 数据先转成 v2。
 */
function normalizePolicy(input) {
    let src = asObject(input, '网络策略');
    if (isV1(src)) src = migrateV1(src);
    const policy = defaultPolicy();
    if (src.preset !== undefined) {
        if (!PRESETS.includes(src.preset)) fail(`preset 只支持 ${PRESETS.join(' / ')}`);
        policy.preset = src.preset;
    }
    policy.outbound = asArray(src.outbound, LIMITS.outbound, 'outbound').map((rule, i) => normalizeRule(rule, 'outbound', i));
    policy.inbound = asArray(src.inbound, LIMITS.inbound, 'inbound').map((rule, i) => normalizeRule(rule, 'inbound', i));
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

const CONTAINER_REF = '@container:';

/** `@container:<名称>` → `@container:<id>`；lookup(名称) 返回 id 或空。已经是 id 的原样保留（容器删了规则也在）。 */
function resolveContainerRefs(policy, lookup) {
    const fix = (rule, field) => {
        const value = rule[field];
        if (!value.startsWith(CONTAINER_REF)) return rule;
        const ref = value.slice(CONTAINER_REF.length);
        if (isValidId(ref)) return rule;
        const id = lookup(ref);
        if (!id) fail(`找不到容器: ${ref}`);
        return { ...rule, [field]: `${CONTAINER_REF}${id}` };
    };
    return { ...policy, outbound: policy.outbound.map(r => fix(r, 'target')), inbound: policy.inbound.map(r => fix(r, 'source')) };
}

/** 有没有按名称写的 @container:<名称>（需要查运行时换成 id）。 */
function hasNameRefs(policy) {
    return [...policy.outbound.map(r => r.target), ...policy.inbound.map(r => r.source)].some(v => v.startsWith(CONTAINER_REF) && !isValidId(v.slice(CONTAINER_REF.length)));
}

function containerRefOf(value) {
    return String(value).startsWith(CONTAINER_REF) ? String(value).slice(CONTAINER_REF.length) : '';
}

const targetOf = rule => (rule.target !== undefined ? rule.target : rule.source);

/** 只有“允许 @any”（或没有规则）的自定义策略 = 不限制：不建规则表。 */
function isUnrestricted(policy) {
    if (policy.preset !== 'custom') return false;
    const plain = rule => !rule.enabled || (rule.action === 'allow' && targetOf(rule) === '@any' && !rule.ports && rule.proto === 'all');
    return policy.outbound.every(plain) && policy.inbound.every(plain);
}

/** 出站有启用的域名规则（tcp / all）→ 容器的 HTTP(S) 走过滤代理。 */
function usesProxy(policy) {
    return policy.outbound.some(rule => rule.enabled && targetKind(rule.target) === 'domain' && rule.proto !== 'udp');
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

/** 出站域名规则从上往下第一条命中：返回规则，没有则 null（只看域名行，用于被拦截列表与一键放行）。 */
function firstDomainRule(policy, host) {
    return policy.outbound.find(rule => rule.enabled && targetKind(rule.target) === 'domain' && domainMatches(rule.target, host)) || null;
}

function domainRuleAllows(policy, host) {
    const rule = firstDomainRule(policy, host);
    return Boolean(rule && rule.action === 'allow');
}

// ---- 变量 → 地址集合（下发时现算；全部由宿主机侧数据得出） ----
// 地址集合 { any, inc, exc }：any 表示“所有地址”；inc 为包含的 CIDR；exc 为排除的 CIDR；空集合返回 null（该行不生成）

const withMask = ip => (ip.includes(':') ? `${ip}/128` : `${ip}/32`);

/**
 * @param {string} target 规范化后的目标 / 来源
 * @param {object} endpoints 见 buildNftRuleset
 */
function addressSetOf(target, endpoints = {}) {
    const kind = targetKind(target);
    if (kind === 'cidr') return { any: false, inc: [normalizeCidr(target).cidr], exc: [] };
    if (kind === 'domain') return null;
    const ips = list => list.map(ip => normalizeCidr(ip, 'ip').cidr);
    switch (target) {
        case '@any': return { any: true, inc: [], exc: [] };
        case '@public': return { any: true, inc: [], exc: [...PRIVATE_V4, ...PRIVATE_V6, 'fe80::/10', '::1/128'] };
        case '@private': return { any: false, inc: [...PRIVATE_V4, ...PRIVATE_V6, 'fe80::/10'], exc: [] };
        case '@metadata': return { any: false, inc: [...METADATA_V4, ...METADATA_V6], exc: [] };
        case '@host': return endpoints.hostIps && endpoints.hostIps.length ? { any: false, inc: ips(endpoints.hostIps), exc: [] } : null;
        case '@containers': {
            if (!endpoints.bridge) return null;
            const subnet = normalizeCidr(endpoints.bridge.subnet, 'bridge.subnet');
            const gateway = normalizeCidr(endpoints.bridge.gateway, 'bridge.gateway');
            return subnet.family === 4 && gateway.family === 4 ? { any: false, inc: [subnet.cidr], exc: [withMask(gateway.cidr)] } : null;
        }
        default: {
            const id = containerRefOf(target);
            const ip = id && endpoints.containers ? endpoints.containers[id] : '';
            return ip ? { any: false, inc: ips([ip]), exc: [] } : null;
        }
    }
}

// ---- nft 生成 ----

function portSet(ports) {
    const normalized = normalizePorts(ports);
    return normalized.includes(',') ? `{ ${normalized.split(',').join(', ')} }` : normalized;
}

// proto=all 且无端口 → 不限协议；有端口 → 只能 tcp / udp
function portClause(proto, ports) {
    if (proto === 'all') return ports ? ` meta l4proto { tcp, udp } th dport ${portSet(ports)}` : '';
    const p = normalizeProto(proto);
    return ports ? ` ${p} dport ${portSet(ports)}` : ` meta l4proto ${p}`;
}

function cidrsOfFamily(cidrs, family) {
    return cidrs.map(c => normalizeCidr(c)).filter(c => c.family === family).map(c => c.cidr);
}

/** 地址集合 → nft 地址条件列表（每个元素是一行规则里的地址部分；[''] 表示不限地址）。 */
function addrClauses(direction, set) {
    if (!set) return [];
    if (set.any && !set.exc.length) return [''];
    const clauses = [];
    for (const family of [4, 6]) {
        const prefix = family === 4 ? 'ip' : 'ip6';
        const inc = cidrsOfFamily(set.inc, family);
        const exc = cidrsOfFamily(set.exc, family);
        if (!set.any && !inc.length) continue;
        const parts = [];
        if (inc.length) parts.push(`${prefix} ${direction} { ${inc.join(', ')} }`);
        if (exc.length) parts.push(`${prefix} ${direction} != { ${exc.join(', ')} }`);
        clauses.push(parts.join(' '));
    }
    return clauses;
}

function pushRule(lines, direction, set, tail) {
    addrClauses(direction, set).forEach(addr => lines.push(`    ${addr}${tail}`.replace(/^ {4} /, '    ')));
}

// 模式默认行：restricted 拒绝其他容器 / 宿主机 / 内网 / 元数据后放行公网；allowlist 拒绝一切；custom 没有
const DEFAULT_ROWS = {
    restricted: { outbound: ['@containers', '@host', '@private', '@metadata'], inbound: ['@containers'] },
    allowlist: { outbound: ['@any'], inbound: ['@containers'] },
    custom: { outbound: [], inbound: [] }
};

/**
 * @param {object} policy normalizePolicy 的结果
 * @param {object} endpoints 运行时解析出的地址（下发时现算，全部重新校验）
 * @param {string[]} [endpoints.dns]
 * @param {{ip:string, ports:string, proto?:string}[]} [endpoints.allow] manyoyo 必需端点（上游代理、过滤代理、Playwright、镜像）与派生的容器间放行
 * @param {{daddr:string, saddr:string}[]} [endpoints.antiSpoof] 发往 daddr 的包来源必须是 saddr（过滤代理按来源 IP 认容器）
 * @param {{subnet:string, gateway:string}|null} [endpoints.bridge]
 * @param {string[]} [endpoints.hostIps] 容器看到的宿主机 IP（@host）
 * @param {Object<string,string>} [endpoints.containers] 运行中容器 id → IP（@container:<id>）
 * @returns {string} 整份 nft 脚本（先删后建，一次 nft -f 原子替换）；不限制的策略只删表
 */
function buildNftRuleset(policy, endpoints = {}) {
    const lines = ['add table inet manyoyo', 'delete table inet manyoyo'];
    if (isUnrestricted(policy)) return `${lines.join('\n')}\n`;

    const out = ['    oif lo accept', '    ct state established,related accept'];
    (endpoints.antiSpoof || []).forEach(item => {
        const daddr = normalizeCidr(item.daddr, 'antiSpoof');
        const saddr = normalizeCidr(item.saddr, 'antiSpoof');
        out.push(`    ${daddr.family === 4 ? 'ip' : 'ip6'} daddr ${daddr.cidr} ${saddr.family === 4 ? 'ip' : 'ip6'} saddr != ${saddr.cidr} drop`);
    });
    (endpoints.dns || []).forEach(ip => {
        const { cidr, family } = normalizeCidr(ip, 'dns');
        const prefix = family === 4 ? 'ip' : 'ip6';
        out.push(`    ${prefix} daddr ${cidr} udp dport 53 accept`);
        out.push(`    ${prefix} daddr ${cidr} tcp dport 53 accept`);
    });
    (endpoints.allow || []).forEach(item => {
        const { cidr, family } = normalizeCidr(item.ip, 'allow');
        out.push(`    ${family === 4 ? 'ip' : 'ip6'} daddr ${cidr}${portClause(item.proto || 'tcp', item.ports)} accept`);
    });
    // 用户规则：从上往下，第一条命中的生效（域名规则由过滤代理执行，不进 nft）
    policy.outbound.filter(rule => rule.enabled && targetKind(rule.target) !== 'domain').forEach(rule => {
        pushRule(out, 'daddr', addressSetOf(rule.target, endpoints), `${portClause(rule.proto, rule.ports)} ${rule.action === 'allow' ? 'accept' : 'reject'}`);
    });
    DEFAULT_ROWS[policy.preset].outbound.forEach(target => {
        pushRule(out, 'daddr', addressSetOf(target, endpoints), ' reject');
    });

    const inn = ['    iif lo accept', '    ct state established,related accept'];
    policy.inbound.filter(rule => rule.enabled && targetKind(rule.source) !== 'domain').forEach(rule => {
        pushRule(inn, 'saddr', addressSetOf(rule.source, endpoints), `${portClause(rule.proto, rule.ports)}${rule.action === 'allow' ? ' accept' : ' ct state new reject'}`);
    });
    DEFAULT_ROWS[policy.preset].inbound.forEach(target => {
        pushRule(inn, 'saddr', addressSetOf(target, endpoints), ' ct state new reject');
    });

    lines.push('table inet manyoyo {');
    lines.push('  chain output {', '    type filter hook output priority 0; policy accept;', ...out, '  }');
    lines.push('  chain input {', '    type filter hook input priority 0; policy accept;', ...inn, '  }');
    lines.push('}');
    return `${lines.join('\n')}\n`;
}

/**
 * 过滤代理按容器编译好的有序规则（clients.json 里的一项）：域名行原样，其余展开成 CIDR 集合，然后是模式默认行。
 * 过滤代理只做 tcp；udp 行不进来。
 * @param {object} endpoints 同 buildNftRuleset，另有 derived: {ip, ports, proto}[]（其他容器入站放行本容器的派生行）
 */
function compileProxyPolicy(policy, endpoints = {}) {
    const rules = [];
    const addAddr = (action, target, ports, proto) => {
        if (proto === 'udp') return;
        const set = addressSetOf(target, endpoints);
        if (set) rules.push({ action, addr: set, ports: ports || '', proto });
    };
    (endpoints.derived || []).forEach(item => addAddr('allow', item.ip, item.ports, item.proto || 'tcp'));
    policy.outbound.filter(rule => rule.enabled).forEach(rule => {
        if (targetKind(rule.target) === 'domain') {
            if (rule.proto !== 'udp') rules.push({ action: rule.action, domain: rule.target, ports: rule.ports, proto: rule.proto });
        } else {
            addAddr(rule.action, rule.target, rule.ports, rule.proto);
        }
    });
    DEFAULT_ROWS[policy.preset].outbound.filter(target => target !== '@any').forEach(target => addAddr('deny', target, '', 'all'));
    const sensitive = ['@host', '@private', '@metadata'].flatMap(target => (addressSetOf(target, endpoints) || { inc: [] }).inc);
    return { preset: policy.preset, default: policy.preset === 'allowlist' ? 'deny' : 'allow', sensitive, rules };
}

module.exports = {
    PRESETS,
    PROTOS,
    LIMITS,
    PRIVATE_V4,
    PRIVATE_V6,
    METADATA_V4,
    METADATA_V6,
    DEFAULT_ROWS,
    normalizePorts,
    normalizeProto,
    normalizeCidr,
    normalizeDomain,
    normalizeTarget,
    normalizePolicy,
    defaultPolicy,
    targetKind,
    resolveContainerRefs,
    hasNameRefs,
    containerRefOf,
    isUnrestricted,
    usesProxy,
    domainMatches,
    domainAllowed,
    firstDomainRule,
    domainRuleAllows,
    addressSetOf,
    buildNftRuleset,
    compileProxyPolicy
};
