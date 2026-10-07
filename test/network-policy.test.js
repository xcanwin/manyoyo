'use strict';

const p = require('../lib/network-policy');

const ID = '0123456789abcdef';
const ID2 = 'fedcba9876543210';
const rule = (action, target, extra = {}) => ({ action, target, ports: '', proto: 'all', enabled: true, ...extra });
const inRule = (action, source, extra = {}) => ({ action, source, ports: '', proto: 'all', enabled: true, ...extra });

describe('normalizePolicy（v2）', () => {
    test('默认是 restricted，空结构齐全', () => {
        expect(p.normalizePolicy(undefined)).toEqual({
            version: 2, preset: 'restricted', outbound: [], inbound: [], expose: [], autostartOnServe: false
        });
    });

    test('规范化：域名小写、端口去空白、协议默认 all、enabled 默认 true、bind 默认 127.0.0.1', () => {
        const n = p.normalizePolicy({
            preset: 'allowlist',
            outbound: [
                { action: 'allow', target: '*.Anthropic.com' },
                { action: 'allow', target: '140.82.112.0/20', ports: ' 22 , 443 ', proto: 'TCP' },
                { action: 'deny', target: '@Host', enabled: false }
            ],
            inbound: [{ action: 'allow', source: `@container:${ID}`, ports: '7000-7002' }],
            expose: [{ hostPort: 18080, port: 8080 }]
        });
        expect(n.outbound).toEqual([
            rule('allow', '*.anthropic.com'),
            rule('allow', '140.82.112.0/20', { ports: '22,443', proto: 'tcp' }),
            rule('deny', '@host', { enabled: false })
        ]);
        expect(n.inbound).toEqual([inRule('allow', `@container:${ID}`, { ports: '7000-7002' })]);
        expect(n.expose).toEqual([{ bind: '127.0.0.1', hostPort: 18080, port: 8080 }]);
    });

    test('每种目标都收：变量 / 容器 / IP / CIDR / 域名；来源不收域名与出站专用变量', () => {
        ['@containers', '@host', '@private', '@public', '@metadata', '@any', `@container:${ID}`, '@container:my-box', '10.0.0.1', '10.0.0.0/8', 'fd00::/8', 'a.example.com', '*.example.com']
            .forEach(target => expect(() => p.normalizePolicy({ outbound: [rule('allow', target)] })).not.toThrow());
        ['@containers', '@host', '@any', `@container:${ID}`, '10.0.0.0/8', '::1']
            .forEach(source => expect(() => p.normalizePolicy({ inbound: [inRule('allow', source)] })).not.toThrow());
        ['@private', '@public', '@metadata', 'example.com'].forEach(source => expect(() => p.normalizePolicy({ inbound: [inRule('allow', source)] })).toThrow());
    });

    test('@cont_local / @manyoyo 不能写进用户规则（始终允许）', () => {
        expect(() => p.normalizePolicy({ outbound: [rule('allow', '@cont_local')] })).toThrow(/始终允许/);
        expect(() => p.normalizePolicy({ outbound: [rule('deny', '@manyoyo')] })).toThrow(/始终允许/);
        expect(() => p.normalizePolicy({ inbound: [inRule('deny', '@cont_local')] })).toThrow(/始终允许/);
    });

    const bad = [
        ['preset 未知', { preset: 'open' }],
        ['动作非法', { outbound: [{ action: 'drop', target: '@host' }] }],
        ['域名带分号', { outbound: [rule('allow', 'a.com; flush ruleset')] }],
        ['域名带换行', { outbound: [rule('allow', 'a.com\nb.com')] }],
        ['域名无点', { outbound: [rule('allow', 'localhost')] }],
        ['域名超长', { outbound: [rule('allow', `${'a'.repeat(250)}.com`)] }],
        ['CIDR 带 }', { outbound: [rule('allow', '1.2.3.4/32 } ; flush ruleset ; {')] }],
        ['CIDR 前缀越界', { outbound: [rule('deny', '10.0.0.0/33')] }],
        ['变量未知', { outbound: [rule('allow', '@everything')] }],
        ['变量带冒号', { outbound: [rule('allow', '@host:80')] }],
        ['@container: 后面不是名称', { outbound: [rule('allow', '@container:a b')] }],
        ['端口 0', { outbound: [rule('allow', '@host', { ports: '0' })] }],
        ['端口 65536', { outbound: [rule('allow', '@host', { ports: '65536' })] }],
        ['端口倒序区间', { outbound: [rule('allow', '@host', { ports: '90-80' })] }],
        ['端口带注入', { outbound: [rule('allow', '@host', { ports: '80; drop' })] }],
        ['协议非法', { outbound: [rule('allow', '@host', { proto: 'icmp' })] }],
        ['域名规则用 udp', { outbound: [rule('allow', 'a.com', { proto: 'udp' })] }],
        ['expose 绑定主机名', { expose: [{ bind: 'evil.com', hostPort: 18080, port: 80 }] }],
        ['expose 重复', { expose: [{ hostPort: 18080, port: 80 }, { hostPort: 18080, port: 81 }] }],
        ['出站过多', { outbound: Array.from({ length: 201 }, () => rule('allow', '@host')) }],
        ['入站过多', { inbound: Array.from({ length: 51 }, () => inRule('allow', '@any')) }],
        ['类型错误', { outbound: 'x' }]
    ];
    test.each(bad)('拒绝：%s', (_name, input) => {
        expect(() => p.normalizePolicy(input)).toThrow();
    });
});

describe('v1 → v2 迁移', () => {
    test('逐字段：deny / host / egress.rules / domains / peers.inbound', () => {
        const n = p.normalizePolicy({
            version: 1,
            preset: 'allowlist',
            deny: [{ cidr: '10.1.0.0/16' }],
            host: [{ ports: '11434', proto: 'tcp' }],
            egress: { domains: ['github.com'], rules: [{ cidr: '192.168.1.5', ports: '8080', proto: 'udp' }] },
            peers: { inbound: [{ from: ID, ports: '7000', proto: 'tcp' }] },
            expose: [{ bind: '0.0.0.0', hostPort: 18080, port: 80 }],
            autostartOnServe: true
        });
        expect(n).toEqual({
            version: 2,
            preset: 'allowlist',
            outbound: [
                rule('deny', '10.1.0.0/16'),
                rule('allow', '@host', { ports: '11434', proto: 'tcp' }),
                rule('allow', '192.168.1.5', { ports: '8080', proto: 'udp' }),
                rule('allow', 'github.com')
            ],
            inbound: [inRule('allow', `@container:${ID}`, { ports: '7000', proto: 'tcp' })],
            expose: [{ bind: '0.0.0.0', hostPort: 18080, port: 80 }],
            autostartOnServe: true
        });
    });

    test('v1 没写 version 也识别；非白名单预设下的旧域名迁移为暂停行', () => {
        const n = p.normalizePolicy({ egress: { domains: ['github.com'] } });
        expect(n.preset).toBe('restricted');
        expect(n.outbound).toEqual([rule('allow', 'github.com', { enabled: false })]);
        expect(p.usesProxy(n)).toBe(false);
    });

    test('open → custom + 出入站各一行允许 @any，并且视为不限制', () => {
        const n = p.normalizePolicy({ version: 1, preset: 'open', deny: [{ cidr: '10.0.0.0/8' }], host: [{ ports: '80' }] });
        expect(n.preset).toBe('custom');
        expect(n.outbound).toEqual([rule('allow', '@any')]);
        expect(n.inbound).toEqual([inRule('allow', '@any')]);
        expect(p.isUnrestricted(n)).toBe(true);
    });

    test('旧版四个列表合起来超过 200 条也能迁移（不因新上限读不出来）', () => {
        const n = p.normalizePolicy({
            host: Array.from({ length: 50 }, (_v, i) => ({ ports: String(1000 + i) })),
            egress: { domains: Array.from({ length: 200 }, (_v, i) => `a${i}.example.com`), rules: Array.from({ length: 100 }, (_v, i) => ({ cidr: `10.0.${i}.1`, ports: '80' })) }
        });
        expect(n.outbound).toHaveLength(350);
        expect(() => p.normalizePolicy({ outbound: Array.from({ length: 201 }, () => rule('allow', '@host')) })).toThrow();
    });

    test('迁移结果再规范化是幂等的', () => {
        const once = p.normalizePolicy({ host: [{ ports: '80' }], peers: { inbound: [{ from: ID, ports: '1' }] } });
        expect(p.normalizePolicy(once)).toEqual(once);
    });

    test('旧数据里的非法值仍被拒', () => {
        expect(() => p.normalizePolicy({ host: [{ ports: '80; flush ruleset' }] })).toThrow();
        expect(() => p.normalizePolicy({ peers: { inbound: [{ from: '../x', ports: '80' }] } })).toThrow();
    });
});

describe('isUnrestricted / usesProxy / 容器引用', () => {
    test('只有自定义且只有“允许 @any”（暂停行不算）才是不限制', () => {
        expect(p.isUnrestricted(p.normalizePolicy({ preset: 'custom' }))).toBe(true);
        expect(p.isUnrestricted(p.normalizePolicy({ preset: 'custom', outbound: [rule('allow', '@any'), rule('deny', 'a.com', { enabled: false })] }))).toBe(true);
        expect(p.isUnrestricted(p.normalizePolicy({ preset: 'custom', outbound: [rule('allow', '@any'), rule('deny', 'a.com')] }))).toBe(false);
        expect(p.isUnrestricted(p.normalizePolicy({ preset: 'custom', outbound: [rule('allow', '@any', { ports: '80' })] }))).toBe(false);
        expect(p.isUnrestricted(p.normalizePolicy({ preset: 'restricted' }))).toBe(false);
    });

    test('有启用的域名行才走过滤代理', () => {
        expect(p.usesProxy(p.normalizePolicy({ outbound: [rule('deny', 'ads.example.com')] }))).toBe(true);
        expect(p.usesProxy(p.normalizePolicy({ outbound: [rule('allow', 'a.com', { enabled: false })] }))).toBe(false);
        expect(p.usesProxy(p.normalizePolicy({ outbound: [rule('allow', '192.168.1.1')] }))).toBe(false);
    });

    test('@container:<名称> 换成 id；找不到报错；已经是 id 的原样保留（容器已删也不报错）', () => {
        const policy = p.normalizePolicy({ outbound: [rule('allow', '@container:box-a')], inbound: [inRule('allow', `@container:${ID2}`)] });
        expect(p.hasNameRefs(policy)).toBe(true);
        const fixed = p.resolveContainerRefs(policy, name => ({ 'box-a': ID })[name] || '');
        expect(fixed.outbound[0].target).toBe(`@container:${ID}`);
        expect(fixed.inbound[0].source).toBe(`@container:${ID2}`);
        expect(p.hasNameRefs(fixed)).toBe(false);
        expect(() => p.resolveContainerRefs(policy, () => '')).toThrow(/找不到容器: box-a/);
    });

    test('域名规则从上往下第一条命中：拒绝在上方时不算放行', () => {
        const policy = p.normalizePolicy({ outbound: [rule('deny', 'a.example.com'), rule('allow', '*.example.com')] });
        expect(p.domainRuleAllows(policy, 'a.example.com')).toBe(false);
        expect(p.domainRuleAllows(policy, 'b.example.com')).toBe(true);
        expect(p.domainRuleAllows(policy, 'other.com')).toBe(false);
    });
});

describe('buildNftRuleset', () => {
    const endpoints = {
        dns: ['172.16.99.2'],
        allow: [{ ip: '172.16.99.1', ports: '10808' }, { ip: '172.16.99.129', ports: '8935,18601', proto: 'tcp' }],
        hostIps: ['172.16.99.1'],
        containers: { [ID]: '10.89.0.2' },
        bridge: { subnet: '10.89.0.0/24', gateway: '10.89.0.1' }
    };
    const lineIndex = (text, s) => text.split('\n').findIndex(l => l.includes(s));

    test('不限制的自定义只删表（无规则），不留任何 chain', () => {
        const text = p.buildNftRuleset(p.normalizePolicy({ preset: 'custom', outbound: [rule('allow', '@any')], inbound: [inRule('allow', '@any')] }), endpoints);
        expect(text).toBe('add table inet manyoyo\ndelete table inet manyoyo\n');
    });

    test('restricted：必需端点 → 用户规则 → 模式默认行；先删后建保证原子替换', () => {
        const policy = p.normalizePolicy({ outbound: [rule('allow', '@host', { ports: '11434', proto: 'tcp' })] });
        const text = p.buildNftRuleset(policy, endpoints);
        expect(text.startsWith('add table inet manyoyo\ndelete table inet manyoyo\ntable inet manyoyo {')).toBe(true);
        const user = lineIndex(text, 'ip daddr { 172.16.99.1 } tcp dport 11434 accept');
        expect(lineIndex(text, 'ip daddr 172.16.99.1 tcp dport 10808 accept')).toBeLessThan(user);
        expect(user).toBeGreaterThan(-1);
        // 默认行：其他容器（不含网关）→ 宿主机 → 内网 → 元数据
        const containers = lineIndex(text, 'ip daddr { 10.89.0.0/24 } ip daddr != { 10.89.0.1/32 } reject');
        expect(user).toBeLessThan(containers);
        expect(containers).toBeLessThan(lineIndex(text, 'ip daddr { 172.16.99.1 } reject'));
        expect(lineIndex(text, 'ip daddr { 172.16.99.1 } reject')).toBeLessThan(lineIndex(text, 'ip daddr { 0.0.0.0/8'));
        expect(text).toContain('ip6 daddr { fc00::/7, 64:ff9b::/96 } reject');
        expect(text).toContain('meta l4proto { tcp, udp } ip6 daddr fe80::/10 reject'); // 邻居发现（ICMPv6）不拒绝
        expect(text).toContain('ip daddr { 169.254.169.254, 100.100.100.200 } reject');
        expect(text).toContain('ip6 daddr { fd00:ec2::254 } reject');
        expect(text).toContain('ip saddr { 10.89.0.0/24 } ip saddr != { 10.89.0.1/32 } ct state new reject');
        expect(text).not.toMatch(/^\s+reject$/m);
    });

    test('用户规则的顺序决定结果：拒绝在允许上方先编译', () => {
        const policy = p.normalizePolicy({ outbound: [rule('deny', '@host', { ports: '8080', proto: 'tcp' }), rule('allow', '@host')] });
        const text = p.buildNftRuleset(policy, endpoints);
        expect(lineIndex(text, 'tcp dport 8080 reject')).toBeLessThan(lineIndex(text, 'ip daddr { 172.16.99.1 } accept'));
        expect(lineIndex(text, 'ip daddr { 172.16.99.1 } accept')).toBeGreaterThan(-1);
    });

    test('暂停的行和域名行不进 nft', () => {
        const policy = p.normalizePolicy({ outbound: [rule('allow', '192.168.1.5', { enabled: false }), rule('deny', 'ads.example.com')] });
        const text = p.buildNftRuleset(policy, endpoints);
        expect(text).not.toContain('192.168.1.5');
        expect(text).not.toContain('ads.example.com');
    });

    test('allowlist：用户规则后无条件 reject，不含私有网段列表', () => {
        const policy = p.normalizePolicy({ preset: 'allowlist', outbound: [rule('allow', 'github.com'), rule('allow', '140.82.112.0/20', { ports: '22', proto: 'tcp' })] });
        const text = p.buildNftRuleset(policy, endpoints);
        expect(text).toContain('ip daddr { 140.82.112.0/20 } tcp dport 22 accept');
        expect(text).toMatch(/\n {4}reject\n {2}\}\n {2}chain input/);
        expect(text).not.toContain('100.64.0.0/10');
    });

    test('custom 有规则时没有模式默认行（链默认放行）', () => {
        const policy = p.normalizePolicy({ preset: 'custom', outbound: [rule('deny', '@private'), rule('allow', '@any')] });
        const text = p.buildNftRuleset(policy, endpoints);
        expect(text).toContain('ip daddr { 0.0.0.0/8');
        expect(text).toMatch(/\n {4}accept\n {2}\}\n {2}chain input/);
    });

    test('@public 展开成“不在内网”；@any 不带地址条件；协议 + 端口的各种写法', () => {
        const policy = p.normalizePolicy({
            outbound: [
                rule('deny', '@public', { ports: '25', proto: 'tcp' }),
                rule('allow', '192.168.1.5', { ports: '53,5353' }),
                rule('allow', 'fd00::/8', { proto: 'udp' }),
                rule('deny', '@any', { ports: '9' })
            ]
        });
        const text = p.buildNftRuleset(policy, endpoints);
        expect(text).toMatch(/ip daddr != \{ 0\.0\.0\.0\/8.*\} tcp dport 25 reject/);
        expect(text).toMatch(/ip6 daddr != \{ fc00::\/7.*::1\/128 \} tcp dport 25 reject/);
        expect(text).toContain('ip daddr { 192.168.1.5 } meta l4proto { tcp, udp } th dport { 53, 5353 } accept');
        expect(text).toContain('ip6 daddr { fd00::/8 } meta l4proto udp accept');
        expect(text).toMatch(/\n {4}meta l4proto \{ tcp, udp \} th dport 9 reject/);
    });

    test('拒绝 @private 时发往 fe80::/10 的 ICMPv6（邻居发现）不被拒绝，只拒 tcp / udp；有端口 / 协议条件的规则本来就只管 tcp / udp', () => {
        const text = p.buildNftRuleset(p.normalizePolicy({ outbound: [rule('deny', '@private')] }), endpoints);
        const allProto = text.split('\n').filter(l => /ip6 daddr \{.*\} reject$/.test(l) && !l.includes('l4proto'));
        expect(allProto.every(l => !l.includes('fe80::/10'))).toBe(true);
        expect(text.match(/meta l4proto \{ tcp, udp \} ip6 daddr fe80::\/10 reject/g)).toHaveLength(2); // 用户规则一条 + 收紧默认行一条
        const withPort = p.buildNftRuleset(p.normalizePolicy({ outbound: [rule('deny', '@private', { ports: '80' })] }), endpoints);
        expect(withPort).toContain('ip6 daddr { fc00::/7, 64:ff9b::/96, fe80::/10 } meta l4proto { tcp, udp } th dport 80 reject');
    });

    test('@container:<id> 展开成对方当前 IP；对方没在运行则该行不生成', () => {
        const policy = p.normalizePolicy({
            outbound: [rule('allow', `@container:${ID}`, { ports: '7000', proto: 'tcp' }), rule('allow', `@container:${ID2}`)],
            inbound: [inRule('allow', `@container:${ID}`, { ports: '7000', proto: 'tcp' })]
        });
        const text = p.buildNftRuleset(policy, endpoints);
        expect(text).toContain('ip daddr { 10.89.0.2 } tcp dport 7000 accept');
        expect(text).toContain('ip saddr { 10.89.0.2 } tcp dport 7000 accept');
        expect(text).not.toContain(ID2);
    });

    test('入站：拒绝只拦新连接；用户规则在默认“拒绝 @containers”之前', () => {
        const policy = p.normalizePolicy({ inbound: [inRule('deny', '192.168.1.5'), inRule('allow', '@containers', { ports: '3000', proto: 'tcp' })] });
        const text = p.buildNftRuleset(policy, endpoints);
        expect(text).toContain('ip saddr { 192.168.1.5 } ct state new reject');
        const input = text.slice(text.indexOf('chain input'));
        expect(input.indexOf('tcp dport 3000 accept')).toBeGreaterThan(-1);
        expect(input.indexOf('tcp dport 3000 accept')).toBeLessThan(input.lastIndexOf('ip saddr { 10.89.0.0/24 }'));
    });

    test('antiSpoof：发往过滤代理的包来源必须是本容器 IP，排在放行规则之前；注入被拒', () => {
        const policy = p.normalizePolicy({ outbound: [rule('allow', 'github.com')] });
        const text = p.buildNftRuleset(policy, { allow: [{ ip: '10.89.0.250', ports: '3128' }], antiSpoof: [{ daddr: '10.89.0.250', saddr: '10.89.0.7' }] });
        const drop = lineIndex(text, 'ip daddr 10.89.0.250 ip saddr != 10.89.0.7 drop');
        expect(drop).toBeGreaterThan(-1);
        expect(drop).toBeLessThan(lineIndex(text, 'ip daddr 10.89.0.250 tcp dport 3128 accept'));
        expect(() => p.buildNftRuleset(policy, { antiSpoof: [{ daddr: '10.89.0.250', saddr: '1.1.1.1; flush ruleset' }] })).toThrow();
    });

    test('注入：端点里的恶意字符串在生成时仍被拒', () => {
        const policy = p.normalizePolicy({});
        expect(() => p.buildNftRuleset(policy, { allow: [{ ip: '1.2.3.4; flush ruleset', ports: '80' }] })).toThrow();
        expect(() => p.buildNftRuleset(policy, { allow: [{ ip: '1.2.3.4', ports: '80 }\nflush ruleset' }] })).toThrow();
        expect(() => p.buildNftRuleset(policy, { dns: ['x\nflush ruleset'] })).toThrow();
        expect(() => p.buildNftRuleset(policy, { allow: [{ ip: '10.0.0.1', ports: '1', proto: 'tcp; drop' }] })).toThrow();
        expect(() => p.buildNftRuleset(p.normalizePolicy({ outbound: [rule('allow', '@host')] }), { hostIps: ['1.2.3.4; flush ruleset'] })).toThrow();
    });

    test('IPv6 端点使用 ip6 前缀；不限端口用 l4proto', () => {
        const text = p.buildNftRuleset(p.normalizePolicy({}), { allow: [{ ip: 'fd00::1', ports: '443' }, { ip: '8.8.8.0/24', ports: '', proto: 'udp' }] });
        expect(text).toContain('ip6 daddr fd00::1 tcp dport 443 accept');
        expect(text).toContain('ip daddr 8.8.8.0/24 meta l4proto udp accept');
    });
});

describe('compileProxyPolicy（过滤代理的有序规则）', () => {
    const endpoints = { hostIps: ['172.16.99.1'], bridge: { subnet: '10.89.0.0/24', gateway: '10.89.0.1' }, containers: {} };

    test('域名行原样、地址行展开成集合、udp 行不进来、暂停行不进来', () => {
        const policy = p.normalizePolicy({
            preset: 'allowlist',
            outbound: [rule('allow', 'github.com'), rule('deny', '*.ads.com', { ports: '443' }), rule('allow', '@host', { ports: '11434' }), rule('allow', '10.0.0.1', { proto: 'udp' }), rule('allow', 'x.com', { enabled: false })]
        });
        const compiled = p.compileProxyPolicy(policy, endpoints);
        expect(compiled.default).toBe('deny');
        expect(compiled.rules.map(r => r.domain || r.addr.inc.join(','))).toEqual(['github.com', '*.ads.com', '172.16.99.1']);
        expect(compiled.rules[2]).toEqual({ action: 'allow', addr: { any: false, inc: ['172.16.99.1/32'.replace('/32', '')], exc: [] }, ports: '11434', proto: 'all' });
    });

    test('restricted 末尾带模式默认的拒绝行，默认放行；sensitive 包含 @host / 内网 / 元数据', () => {
        const compiled = p.compileProxyPolicy(p.normalizePolicy({ outbound: [rule('deny', 'ads.com')] }), endpoints);
        expect(compiled.default).toBe('allow');
        expect(compiled.rules.slice(1).every(r => r.action === 'deny' && r.addr)).toBe(true);
        expect(compiled.sensitive).toEqual(expect.arrayContaining(['172.16.99.1', '10.0.0.0/8', '169.254.169.254']));
    });

    test('派生行（其他容器入站放行本容器）排在用户规则之前', () => {
        const compiled = p.compileProxyPolicy(p.normalizePolicy({ outbound: [rule('allow', 'a.com')] }), { ...endpoints, derived: [{ ip: '10.89.0.9', ports: '7000', proto: 'tcp' }] });
        expect(compiled.rules[0]).toEqual({ action: 'allow', addr: { any: false, inc: ['10.89.0.9'], exc: [] }, ports: '7000', proto: 'tcp' });
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
