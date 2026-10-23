'use strict';

const { inferEnvEndpoints, withEnvEndpoints } = require('../lib/network-endpoints');
const { normalizePolicy } = require('../lib/network-policy');

const lookup = async host => ({ 'llm.corp.example': ['10.2.3.4'], 'public.example.com': ['8.8.8.8'], 'loop.example': ['127.0.0.1'] }[host] || []);

describe('inferEnvEndpoints', () => {
  test('宿主机别名 → host 端口；私有解析结果 → egress 规则；公网与环回不管', async () => {
    const out = await inferEnvEndpoints([
      'OLLAMA_BASE_URL=http://host.containers.internal:11434/v1',
      'ANTHROPIC_BASE_URL=https://llm.corp.example',
      'PUBLIC=https://public.example.com/x',
      'LOOP=http://loop.example:9000',
      'LAN_IP=http://192.168.1.50:8000/v1',
      'NOT_URL=hello',
      'DUP=https://llm.corp.example/other'
    ], lookup);
    expect(out.host).toEqual([{ ports: '11434', proto: 'tcp' }]);
    expect(out.domains).toEqual(['llm.corp.example', 'public.example.com', 'loop.example']);
    expect(out.rules).toEqual([
      { cidr: '10.2.3.4', ports: '443', proto: 'tcp' },
      { cidr: '192.168.1.50', ports: '8000', proto: 'tcp' }
    ]);
  });

  test('解析失败不抛错', async () => {
    const out = await inferEnvEndpoints(['X=http://nx.example'], async () => { throw new Error('nx'); });
    expect(out).toEqual({ host: [], rules: [], domains: ['nx.example'] });
  });
});

describe('withEnvEndpoints', () => {
  const ruleRows = policy => policy.outbound.map(r => `${r.action} ${r.target}${r.ports ? ` ${r.ports}` : ''}`);

  test('宿主机端口 → 允许 @host，私有地址 → 允许该 IP，并去重；没有端点原样返回', async () => {
    const base = normalizePolicy({ outbound: [{ action: 'allow', target: '@host', ports: '11434', proto: 'tcp' }] });
    const merged = await withEnvEndpoints(base, ['A=http://host.containers.internal:11434', 'B=http://192.168.1.50:8000', 'C=https://llm.corp.example'], lookup);
    expect(ruleRows(merged)).toEqual(['allow @host 11434', 'allow 192.168.1.50 8000', 'allow 10.2.3.4 443']);
    expect(await withEnvEndpoints(base, ['C=x'], lookup)).toBe(base);
  });

  test('模型服务域名只在仅白名单下加成允许行（代理 / 主机别名 / IP 不算）；收紧下不再加域名行', async () => {
    const envLines = ['ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic', 'HTTPS_PROXY=http://proxy.corp.example:3128', 'OLLAMA=http://host.containers.internal:11434', 'LAN=http://192.168.1.50:8000'];
    const allow = await withEnvEndpoints(normalizePolicy({ preset: 'allowlist', outbound: [{ action: 'allow', target: 'github.com' }] }), envLines, lookup);
    expect(ruleRows(allow)).toEqual(['allow github.com', 'allow @host 11434', 'allow 192.168.1.50 8000', 'allow open.bigmodel.cn']);
    const restricted = await withEnvEndpoints(normalizePolicy({}), envLines, lookup);
    expect(ruleRows(restricted)).toEqual(['allow @host 11434', 'allow 192.168.1.50 8000']);
    expect(restricted.outbound.every(r => r.enabled)).toBe(true);
  });

  test('不限制的自定义策略不动', async () => {
    const open = normalizePolicy({ preset: 'custom' });
    expect(await withEnvEndpoints(open, ['B=http://192.168.1.50:8000'], lookup)).toBe(open);
  });
});

describe('modelDomains（Agent 自己的模型域名）', () => {
    const { modelDomains } = require('../lib/network-endpoints');

    test('配了 BASE_URL：只认 env 里的域名，不再加官方域名', () => {
        expect(modelDomains(['ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic'], 'claude')).toEqual(['api.deepseek.com']);
    });

    test('没配 BASE_URL：加上该 Agent 的官方默认域名', () => {
        expect(modelDomains([], 'claude')).toEqual(['api.anthropic.com']);
        expect(modelDomains(['OPENAI_API_KEY=x'], 'codex')).toEqual(['api.openai.com']);
    });

    test('不指定 Agent：只算配了 Key 的 Agent 的官方域名', () => {
        expect(modelDomains(['ANTHROPIC_AUTH_TOKEN=x'])).toEqual(['api.anthropic.com']);
        expect(modelDomains([])).toEqual([]);
    });

    test('未知 Agent 不报错', () => {
        expect(modelDomains([], 'nope')).toEqual([]);
    });
});

describe('agentModelDomains（判断被拦的是不是 Agent 自己的模型地址）', () => {
    const { agentModelDomains } = require('../lib/network-endpoints');

    test('配了 BASE_URL 只认它；没配认官方域名；env 里别的 URL（npm 源等）不算', () => {
        expect(agentModelDomains(['ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic', 'NPM_CONFIG_REGISTRY=https://registry.npmmirror.com'], 'claude')).toEqual(['api.deepseek.com']);
        expect(agentModelDomains(['NPM_CONFIG_REGISTRY=https://registry.npmmirror.com'], 'claude')).toEqual(['api.anthropic.com']);
        expect(agentModelDomains([], 'nope')).toEqual([]);
        expect(agentModelDomains(['OPENAI_BASE_URL=http://host.containers.internal:11434/v1'], 'codex')).toEqual([]);
    });
});
