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
  test('并进策略并去重；open 预设不动；没有端点原样返回', async () => {
    const base = normalizePolicy({ host: [{ ports: '11434' }] });
    const merged = await withEnvEndpoints(base, ['A=http://host.containers.internal:11434', 'B=http://192.168.1.50:8000'], lookup);
    expect(merged.host).toEqual([{ ports: '11434', proto: 'tcp' }]);
    expect(merged.egress.rules).toEqual([{ cidr: '192.168.1.50', ports: '8000', proto: 'tcp' }]);
    // 模型服务的域名在任何预设下都登记进白名单列表（代理 / 主机别名 / IP 不算）
    const withDomains = await withEnvEndpoints(normalizePolicy({ preset: 'allowlist', egress: { domains: ['github.com'] } }), [
      'ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic', 'HTTPS_PROXY=http://proxy.corp.example:3128', 'OLLAMA=http://host.containers.internal:11434', 'LAN=http://192.168.1.50:8000'
    ], lookup);
    expect(withDomains.egress.domains).toEqual(['github.com', 'open.bigmodel.cn']);
    const open = normalizePolicy({ preset: 'open' });
    expect(await withEnvEndpoints(open, ['B=http://192.168.1.50:8000'], lookup)).toBe(open);
    expect(await withEnvEndpoints(base, ['C=x'], lookup)).toBe(base);
  });
});
