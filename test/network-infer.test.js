'use strict';

const { extractEndpointTokens, inferEndpointCandidates, withScriptEndpoints, MAX_INPUT_BYTES } = require('../lib/network-infer');
const { normalizePolicy } = require('../lib/network-policy');

// 测试里不查真实 DNS：默认把域名解析成公网地址，个别用例覆盖
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '10.2.3.4', family: 4 }];

function targets(result) {
    return result.candidates.map(c => `${c.kind}|${c.target}|${c.ports}`);
}

describe('network-infer：URL 提取', () => {
    test('带 scheme 的 URL：取域名 / 端口，去掉 userinfo、path、query，证据里也不出现', async () => {
        const result = await inferEndpointCandidates({
            firstCommand: 'curl -fsSL https://user:pass@llm.corp.example/v1/chat?token=secret#frag',
            preset: 'allowlist',
            lookup: publicLookup
        });
        expect(targets(result)).toEqual(['domain|llm.corp.example|443']);
        const candidate = result.candidates[0];
        expect(candidate.evidence).toBe('https://llm.corp.example');
        expect(candidate.proto).toBe('tcp');
        expect(candidate.sources).toEqual(['first']);
        const raw = JSON.stringify(result);
        expect(raw).not.toContain('user');
        expect(raw).not.toContain('pass');
        expect(raw).not.toContain('/v1/chat');
        expect(raw).not.toContain('token');
        expect(raw).not.toContain('secret');
    });

    test('默认端口按协议：http 80 / https 443 / ws 80 / wss 443 / ftp 21；显式端口保留', async () => {
        const result = await inferEndpointCandidates({
            firstCommand: [
                'curl http://a.example.com/x',
                'curl https://b.example.com/x',
                'curl ws://c.example.com/x',
                'curl wss://d.example.com/x',
                'curl ftp://e.example.com/x',
                'curl https://f.example.com:8443/x'
            ].join('\n'),
            preset: 'allowlist',
            lookup: publicLookup
        });
        expect(targets(result)).toEqual([
            'domain|a.example.com|80',
            'domain|b.example.com|443',
            'domain|c.example.com|80',
            'domain|d.example.com|443',
            'domain|e.example.com|21',
            'domain|f.example.com|8443'
        ]);
    });

    test('IPv6 URL、宿主机别名、环回地址', async () => {
        const result = await inferEndpointCandidates({
            firstCommand: [
                'curl http://[fd00::5]:8443/health',
                'curl http://host.containers.internal:8080/ok',
                'curl http://localhost:3000/x',
                'curl http://127.0.0.1:3000/x',
                'curl http://[::1]:3000/x'
            ].join('\n'),
            preset: 'allowlist',
            lookup: publicLookup
        });
        expect(targets(result)).toEqual([
            'cidr|fd00::5|8443',
            'host|@host|8080'
        ]);
        expect(result.candidates[1].evidence).toBe('@host:8080');
    });
});

describe('network-infer：非 URL 写法', () => {
    test('host:port、git@host:path、ssh -p', async () => {
        const result = await inferEndpointCandidates({
            firstCommand: [
                'nc db.internal 5432',
                'telnet legacy.internal:2323',
                'git clone git@git.internal:team/repo.git',
                'ssh -p 2222 deploy@bastion.internal uptime'
            ].join('\n'),
            preset: 'allowlist',
            lookup: publicLookup
        });
        expect(targets(result)).toEqual([
            'domain|db.internal|',
            'domain|legacy.internal|2323',
            'domain|git.internal|22',
            'domain|bastion.internal|2222'
        ]);
    });

    test('裸 IP / 网段：跳过 0.0.0.0、组播、广播；元数据地址标记 risk', async () => {
        const result = await inferEndpointCandidates({
            firstCommand: 'ping 10.2.3.4\ncurl 10.9.0.0/16\ncurl 169.254.169.254\ncurl 0.0.0.0\ncurl 224.0.0.1\ncurl 255.255.255.255',
            preset: 'allowlist',
            lookup: publicLookup
        });
        expect(targets(result)).toEqual([
            'cidr|10.2.3.4|',
            'cidr|10.9.0.0/16|',
            'cidr|169.254.169.254|'
        ]);
        expect(result.candidates[0].proto).toBe('all');
        expect(result.candidates[2].risk).toBe('metadata');
        expect(result.candidates[2].defaultChecked).toBe(false);
    });

    test('命令行里的裸域名：网络命令 / 网络参数所在行；文件名与版本号不误收；www./api. 例外', async () => {
        const result = await inferEndpointCandidates({
            firstCommand: [
                'npm install --registry https://registry.npmjs.org',
                'pip install -i https://pypi.org/simple pkg',
                'cp build/app.js /tmp/app.js',
                'echo 2.3.2',
                'curl internal.example.com',
                'curl www.public-example.com',
                'curl api.public-example.com'
            ].join('\n'),
            preset: 'allowlist',
            lookup: publicLookup
        });
        expect(targets(result)).toEqual(expect.arrayContaining([
            'domain|registry.npmjs.org|443',
            'domain|pypi.org|443',
            'domain|internal.example.com|',
            'domain|www.public-example.com|',
            'domain|api.public-example.com|'
        ]));
        expect(targets(result)).not.toContain('domain|app.js|');
        expect(targets(result)).not.toContain('domain|2.3.2|');
    });

    test('通配域名：kind domain、wide、默认不勾', async () => {
        const result = await inferEndpointCandidates({
            firstCommand: 'curl "https://*.corp.example.com/api"',
            preset: 'allowlist',
            lookup: publicLookup
        });
        expect(targets(result)).toContain('domain|*.corp.example.com|');
        const wildcard = result.candidates.find(c => c.target === '*.corp.example.com');
        expect(wildcard.risk).toBe('wide');
        expect(wildcard.defaultChecked).toBe(false);
    });

    test('代理变量不算目标；非代理 KEY=值 的值是完整域名 / URL 时接受', async () => {
        const result = await inferEndpointCandidates({
            autostart: 'export https_proxy=http://proxy.corp.example:3128\nexport API_HOST=llm.corp.example\nhttp_proxy=http://another.proxy:8080',
            preset: 'allowlist',
            lookup: publicLookup
        });
        const found = targets(result);
        expect(found).not.toContain('domain|proxy.corp.example|3128');
        expect(found).not.toContain('domain|another.proxy|8080');
        expect(found).toContain('domain|llm.corp.example|');
    });
});

describe('network-infer：按模式过滤与 DNS', () => {
    test('restricted 只保留私有地址、@host 和解析到私有地址的域名', async () => {
        const lookup = async host => {
            if (host === 'llm.corp.example') return [{ address: '10.2.3.4', family: 4 }];
            if (host === 'public.example.com') return [{ address: '93.184.216.34', family: 4 }];
            throw new Error('nxdomain');
        };
        const result = await inferEndpointCandidates({
            firstCommand: [
                'curl https://llm.corp.example/v1',
                'curl https://public.example.com/',
                'curl http://host.containers.internal:8080/',
                'curl http://10.9.8.7:9000/',
                'curl 172.20.0.0/16',
                'curl https://nxdomain.example/'
            ].join('\n'),
            preset: 'restricted',
            lookup
        });
        expect(targets(result)).toEqual([
            'domain|llm.corp.example|443',
            'host|@host|8080',
            'cidr|10.9.8.7|9000',
            'cidr|172.20.0.0/16|'
        ]);
        const llm = result.candidates.find(c => c.target === 'llm.corp.example');
        expect(llm.resolved).toEqual(['10.2.3.4']);
        expect(llm.risk).toBe('private');
        expect(llm.defaultChecked).toBe(true);
    });

    test('allowlist 收公网域名；DNS 失败仍保留域名候选但 resolved 为空', async () => {
        const lookup = async () => { throw new Error('timeout'); };
        const result = await inferEndpointCandidates({
            firstCommand: 'curl https://public.example.com/',
            preset: 'allowlist',
            lookup
        });
        expect(targets(result)).toEqual(['domain|public.example.com|443']);
        expect(result.candidates[0].resolved).toEqual([]);
    });

    test('DNS 全部返回环回 / 未指定 / 组播时跳过候选', async () => {
        const lookup = async () => [
            { address: '127.0.0.1', family: 4 },
            { address: '0.0.0.0', family: 4 },
            { address: '224.0.0.1', family: 4 }
        ];
        const result = await inferEndpointCandidates({
            firstCommand: 'curl https://weird.example.com/',
            preset: 'allowlist',
            lookup
        });
        expect(result.candidates).toEqual([]);
    });

    test('custom 不生成候选并说明原因', async () => {
        const result = await inferEndpointCandidates({
            firstCommand: 'curl https://api.example.com/',
            preset: 'custom',
            lookup: publicLookup
        });
        expect(result.candidates).toEqual([]);
        expect(result.preset).toBe('custom');
        expect(result.reason).toBe('unrestricted');
    });

    test('DNS 单 host 超时与总预算：超时返回未解析候选，不报错', async () => {
        const slow = () => new Promise(() => {});
        const started = Date.now();
        const result = await inferEndpointCandidates({
            firstCommand: 'curl https://slow.example.com/',
            preset: 'allowlist',
            lookup: slow,
            lookupTimeoutMs: 50,
            totalLookupBudgetMs: 200
        });
        expect(Date.now() - started).toBeLessThan(1500);
        expect(targets(result)).toEqual(['domain|slow.example.com|443']);
        expect(result.candidates[0].resolved).toEqual([]);
    });
});

describe('network-infer：去重、来源、排序与上限', () => {
    test('同一目标只出现一次，来源按 autostart → first → first.env → first.envFile 合并', async () => {
        const result = await inferEndpointCandidates({
            autostart: 'curl https://api.example.com/health',
            firstCommand: 'curl https://API.example.com/other',
            firstEnvLines: ['API_BASE=https://api.example.com'],
            preset: 'allowlist',
            lookup: publicLookup
        });
        expect(targets(result)).toEqual(['domain|api.example.com|443']);
        expect(result.candidates[0].sources).toEqual(['autostart', 'first', 'first.env']);
    });

    test('候选按来源顺序稳定排序；超过 50 条置 truncated 并只返回前 50 条', async () => {
        const lines = Array.from({ length: 60 }, (_, i) => `curl https://h${i}.example.com/`).join('\n');
        const result = await inferEndpointCandidates({ firstCommand: lines, preset: 'allowlist', lookup: publicLookup });
        expect(result.candidates).toHaveLength(50);
        expect(result.truncated).toBe(true);
        expect(result.candidates[0].target).toBe('h0.example.com');
        expect(result.candidates[49].target).toBe('h49.example.com');
    });

    test('输入超过上限时报错（由接口转成 400）', async () => {
        await expect(inferEndpointCandidates({
            autostart: 'x'.repeat(MAX_INPUT_BYTES + 1),
            preset: 'allowlist',
            lookup: publicLookup
        })).rejects.toThrow(/过大|too large/i);
    });
});

describe('network-infer：extractEndpointTokens', () => {
    test('只返回解析后的 token，不含原文；同一段文本里的 URL 与 host:port 去重前都能看到', () => {
        const tokens = extractEndpointTokens('curl https://h.example.com:8443/path?token=1\nnc other.example:99', { source: 'first' });
        expect(tokens).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'domain', target: 'h.example.com', ports: '8443' }),
            expect.objectContaining({ kind: 'domain', target: 'other.example', ports: '99' })
        ]));
        expect(JSON.stringify(tokens)).not.toContain('token=1');
        expect(tokens[0].source).toBe('first');
    });
});

describe('withScriptEndpoints：没有候选界面的入口自动放行', () => {
    test('restricted：自启动里的 host.docker.internal:<端口> 自动加 @host 允许规则，插在最前', async () => {
        const policy = normalizePolicy({ preset: 'restricted', outbound: [{ action: 'allow', target: 'keep.example.com', ports: '', proto: 'all', enabled: true }] });
        const next = await withScriptEndpoints(policy, { autostart: 'curl -fsS http://host.docker.internal:9999/health' });
        expect(next.outbound[0]).toEqual({ action: 'allow', target: '@host', ports: '9999', proto: 'tcp', enabled: true });
        expect(next.outbound[1]).toEqual({ action: 'allow', target: 'keep.example.com', ports: '', proto: 'all', enabled: true });
        expect(policy.outbound).toHaveLength(1); // 不原地修改
        const again = await withScriptEndpoints(next, { autostart: 'curl -fsS http://host.docker.internal:9999/health' });
        expect(again).toBe(next); // 已存在就不重复加
    });

    test('first 命令与 first.env 里的地址也会放行；metadata / 宽网段 / 通配域名不加', async () => {
        const policy = normalizePolicy({ preset: 'allowlist' });
        const next = await withScriptEndpoints(policy, {
            firstCommand: 'curl https://api.example.com:8443/v1\ncurl 169.254.169.254\ncurl 10.0.0.0/8\ncurl "https://*.corp.example.com/x"',
            firstEnvLines: ['API_HOST=llm.corp.example'],
            lookup: async () => [{ address: '93.184.216.34', family: 4 }]
        });
        const targets = next.outbound.map(rule => `${rule.target}|${rule.ports}|${rule.proto}`);
        expect(targets).toContain('api.example.com|8443|tcp');
        expect(targets).toContain('llm.corp.example||all');
        expect(targets).not.toContain('169.254.169.254||all');
        expect(targets).not.toContain('10.0.0.0/8||all');
        expect(targets).not.toContain('*.corp.example.com||all');
    });

    test('restricted 下解析不到私有地址的公网域名不加；custom / 空输入 / DNS 失败都不改变策略', async () => {
        const restricted = normalizePolicy({ preset: 'restricted' });
        const publicOnly = await withScriptEndpoints(restricted, { firstCommand: 'curl https://api.example.com', lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
        expect(publicOnly).toBe(restricted);
        const failedDns = await withScriptEndpoints(normalizePolicy({ preset: 'allowlist' }), { firstCommand: 'curl https://nx.example.com', lookup: async () => { throw new Error('nx'); } });
        expect(failedDns.outbound.map(rule => rule.target)).toEqual(['nx.example.com']);
        const custom = normalizePolicy({ preset: 'custom', outbound: [{ action: 'allow', target: '@any', ports: '', proto: 'all', enabled: true }] });
        expect(await withScriptEndpoints(custom, { autostart: 'curl http://10.2.3.4:80' })).toBe(custom);
        expect(await withScriptEndpoints(restricted, {})).toBe(restricted);
    });
});
