'use strict';

const p = require('../lib/network-policy');

const ID = '0123456789abcdef';

describe('normalizePolicy', () => {
    test('默认是 restricted，空结构齐全', () => {
        expect(p.normalizePolicy(undefined)).toEqual({
            version: 1, preset: 'restricted', egress: { domains: [], rules: [] }, host: [],
            peers: { inbound: [] }, deny: [], expose: [], autostartOnServe: false
        });
    });

    test('规范化：域名小写去重、端口排序前的空白去掉、协议默认 tcp、bind 默认 127.0.0.1', () => {
        const n = p.normalizePolicy({
            preset: 'allowlist',
            egress: { domains: ['GitHub.com', 'github.com', '*.Anthropic.com'], rules: [{ cidr: '140.82.112.0/20', ports: ' 22 , 443 ' }] },
            host: [{ ports: '18601' }],
            peers: { inbound: [{ from: ID, ports: '7000-7002' }] },
            expose: [{ hostPort: 18080, port: 8080 }]
        });
        expect(n.egress.domains).toEqual(['github.com', '*.anthropic.com']);
        expect(n.egress.rules).toEqual([{ cidr: '140.82.112.0/20', ports: '22,443', proto: 'tcp' }]);
        expect(n.host).toEqual([{ ports: '18601', proto: 'tcp' }]);
        expect(n.peers.inbound).toEqual([{ from: ID, ports: '7000-7002', proto: 'tcp' }]);
        expect(n.expose).toEqual([{ bind: '127.0.0.1', hostPort: 18080, port: 8080 }]);
    });

    const bad = [
        ['preset 未知', { preset: 'wide-open' }],
        ['域名带分号', { egress: { domains: ['a.com; flush ruleset'] } }],
        ['域名带换行', { egress: { domains: ['a.com\nb.com'] } }],
        ['域名无点', { egress: { domains: ['localhost'] } }],
        ['域名超长', { egress: { domains: [`${'a'.repeat(250)}.com`] } }],
        ['CIDR 带 }', { egress: { rules: [{ cidr: '1.2.3.4/32 } ; flush ruleset ; {' }] } }],
        ['CIDR 前缀越界', { deny: [{ cidr: '10.0.0.0/33' }] }],
        ['CIDR 是主机名', { deny: [{ cidr: 'example.com' }] }],
        ['端口 0', { host: [{ ports: '0' }] }],
        ['端口 65536', { host: [{ ports: '65536' }] }],
        ['端口倒序区间', { host: [{ ports: '90-80' }] }],
        ['端口带注入', { host: [{ ports: '80; drop' }] }],
        ['端口为空', { host: [{ ports: '' }] }],
        ['协议非法', { host: [{ ports: '80', proto: 'icmp' }] }],
        ['peer id 非法', { peers: { inbound: [{ from: '../x', ports: '80' }] } }],
        ['expose 绑定主机名', { expose: [{ bind: 'evil.com', hostPort: 18080, port: 80 }] }],
        ['expose 重复', { expose: [{ hostPort: 18080, port: 80 }, { hostPort: 18080, port: 81 }] }],
        ['数组过长', { host: Array.from({ length: 51 }, () => ({ ports: '80' })) }],
        ['类型错误', { host: 'x' }]
    ];
    test.each(bad)('拒绝：%s', (_name, input) => {
        expect(() => p.normalizePolicy(input)).toThrow();
    });
});

describe('buildNftRuleset', () => {
    const endpoints = {
        dns: ['172.16.99.2'],
        allow: [{ ip: '172.16.99.1', ports: '10808' }, { ip: '172.16.99.129', ports: '8935,18601', proto: 'tcp' }],
        peerIn: [{ ip: '10.89.0.2', ports: '7000' }],
        bridge: { subnet: '10.89.0.0/24', gateway: '10.89.0.1' }
    };

    test('open 只删表（无规则），不留任何 chain', () => {
        const text = p.buildNftRuleset(p.normalizePolicy({ preset: 'open' }), endpoints);
        expect(text).toBe('add table inet manyoyo\ndelete table inet manyoyo\n');
    });

    test('restricted：先放行必需端点再封私有网段，公网不拦；先删后建保证原子替换', () => {
        const text = p.buildNftRuleset(p.normalizePolicy({}), endpoints);
        expect(text.startsWith('add table inet manyoyo\ndelete table inet manyoyo\ntable inet manyoyo {')).toBe(true);
        const lines = text.split('\n');
        const idx = s => lines.findIndex(l => l.includes(s));
        expect(idx('udp dport 53 accept')).toBeGreaterThan(-1);
        expect(idx('ip daddr 172.16.99.1 tcp dport 10808 accept')).toBeLessThan(idx('ip daddr { 0.0.0.0/8'));
        expect(idx('ip daddr 172.16.99.129 tcp dport { 8935, 18601 } accept')).toBeLessThan(idx('ip daddr { 0.0.0.0/8'));
        expect(text).toContain('169.254.0.0/16');
        expect(text).toContain('ip6 daddr { fc00::/7 } reject');
        expect(text).toContain('ip saddr 10.89.0.2 tcp dport 7000 accept');
        expect(text).toContain('ip saddr 10.89.0.0/24 ip saddr != 10.89.0.1 ct state new reject');
        expect(text).not.toMatch(/^\s+reject$/m);
    });

    test('allowlist：只放行必需端点与 egress.rules，末尾无条件 reject，不含私有网段列表', () => {
        const policy = p.normalizePolicy({ preset: 'allowlist', egress: { domains: ['github.com'], rules: [{ cidr: '140.82.112.0/20', ports: '22' }] } });
        const text = p.buildNftRuleset(policy, endpoints);
        expect(text).toContain('ip daddr 140.82.112.0/20 tcp dport 22 accept');
        expect(text).toMatch(/\n {4}reject\n {2}\}/);
        expect(text).not.toContain('100.64.0.0/10');
        expect(text).not.toContain('github.com'); // 域名不进 nft，只在过滤代理里匹配
    });

    test('注入：端点里的恶意字符串在生成时仍被拒', () => {
        const policy = p.normalizePolicy({});
        expect(() => p.buildNftRuleset(policy, { allow: [{ ip: '1.2.3.4; flush ruleset', ports: '80' }] })).toThrow();
        expect(() => p.buildNftRuleset(policy, { allow: [{ ip: '1.2.3.4', ports: '80 }\nflush ruleset' }] })).toThrow();
        expect(() => p.buildNftRuleset(policy, { dns: ['x\nflush ruleset'] })).toThrow();
        expect(() => p.buildNftRuleset(policy, { peerIn: [{ ip: '10.0.0.1', ports: '1', proto: 'tcp; drop' }] })).toThrow();
    });

    test('IPv6 端点使用 ip6 前缀；不限端口用 l4proto', () => {
        const text = p.buildNftRuleset(p.normalizePolicy({}), { allow: [{ ip: 'fd00::1', ports: '443' }, { ip: '8.8.8.0/24', ports: '', proto: 'udp' }] });
        expect(text).toContain('ip6 daddr fd00::1 tcp dport 443 accept');
        expect(text).toContain('ip daddr 8.8.8.0/24 meta l4proto udp accept');
    });
});

describe('域名匹配', () => {
    test('精确与通配（通配不含自身、不误匹配后缀拼接）', () => {
        expect(p.domainMatches('github.com', 'GitHub.com')).toBe(true);
        expect(p.domainMatches('github.com', 'api.github.com')).toBe(false);
        expect(p.domainMatches('*.example.com', 'a.b.example.com')).toBe(true);
        expect(p.domainMatches('*.example.com', 'example.com')).toBe(false);
        expect(p.domainMatches('*.example.com', 'evilexample.com')).toBe(false);
        expect(p.domainAllowed(['a.com', '*.b.com'], 'x.b.com.')).toBe(true);
    });
});
