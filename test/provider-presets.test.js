'use strict';

const { PROVIDER_PRESETS, providersForAgent, thirdPartyCodexModels, findProviderByBaseUrl } = require('../lib/provider-presets');
const { AGENT_ENV_SCHEMA } = require('../lib/init-config');
const { listSetupAgents, buildAgentRunProfile } = require('../lib/setup');

describe('服务商预设', () => {
    test('每条数据格式正确：https 地址、官方说明链接、Key 变量在该 Agent 的白名单里', () => {
        expect(PROVIDER_PRESETS.length).toBeGreaterThan(5);
        const ids = new Set();
        for (const item of PROVIDER_PRESETS) {
            expect(ids.has(item.id)).toBe(false);
            ids.add(item.id);
            expect(item.label).toBeTruthy();
            expect(item.docUrl).toMatch(/^https:\/\//);
            for (const agentId of ['claude', 'codex']) {
                const entry = item[agentId];
                if (!entry) continue;
                expect(entry.baseUrl).toMatch(/^https:\/\//);
                const spec = AGENT_ENV_SCHEMA[agentId];
                expect(spec.requiredAnyOf).toContain(entry.keyEnv);
                expect(spec.env.map(e => e.name)).toContain(entry.keyEnv);
            }
        }
    });

    test('Codex 只收确认支持 Responses 的五家（DeepSeek 文档没讲，但用真实 Key 实测对话和调工具都通）；Gemini / OpenCode 没有', () => {
        expect(providersForAgent('codex').map(item => item.id)).toEqual(['openai', 'deepseek', 'zhipu', 'kimi', 'volcengine', 'minimax']);
        expect(providersForAgent('codex').map(item => item.baseUrl)).toEqual([
            'https://api.openai.com/v1',
            'https://api.deepseek.com',
            'https://open.bigmodel.cn/api/v1',
            'https://api.moonshot.cn/v1',
            'https://ark.cn-beijing.volces.com/api/coding/v3',
            'https://api.minimax.cn/v1'
        ]);
        providersForAgent('codex').forEach(item => expect(item.keyEnv).toBe('OPENAI_API_KEY'));
        expect(providersForAgent('gemini')).toEqual([]);
        expect(providersForAgent('opencode')).toEqual([]);
        expect(providersForAgent('claude').length).toBe(PROVIDER_PRESETS.length - 1);
        expect(providersForAgent('claude')[0]).toMatchObject({ id: 'anthropic', baseUrl: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY' });
    });

    test('Codex 条目带自己的官方说明链接（有就用，没有退回通用的）', () => {
        const byId = Object.fromEntries(providersForAgent('codex').map(item => [item.id, item]));
        expect(byId.zhipu.docUrl).toBe('https://docs.bigmodel.cn/cn/coding-plan/tool/codex');
        expect(byId.volcengine.docUrl).toBe(PROVIDER_PRESETS.find(item => item.id === 'volcengine').docUrl);
    });

    test('DeepSeek 带必填的默认模型，Kimi Code 用 ANTHROPIC_API_KEY，火山地址不是 /api/v3', () => {
        const byId = Object.fromEntries(providersForAgent('claude').map(item => [item.id, item]));
        expect(byId.deepseek.defaultModel).toBe('deepseek-flash[1m]');
        expect(byId['kimi-code'].keyEnv).toBe('ANTHROPIC_API_KEY');
        expect(byId.volcengine.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/coding');
        expect(byId.zhipu.defaultModel).toBe('');
    });

    // Codex 不认 OPENAI_MODEL 之外的默认模型，第三方必须显式带模型：实测过的两家有默认值
    test('Codex 的智谱 / DeepSeek 带默认模型；智谱的 Claude 条目带 ENABLE_TOOL_SEARCH=false，DeepSeek 不带', () => {
        const codex = Object.fromEntries(providersForAgent('codex').map(item => [item.id, item]));
        expect(codex.zhipu.defaultModel).toBe('glm-5.3');
        expect(codex.deepseek.defaultModel).toBe('deepseek-flash');
        const claude = Object.fromEntries(providersForAgent('claude').map(item => [item.id, item]));
        expect(claude.zhipu.extraEnv).toEqual({ ENABLE_TOOL_SEARCH: 'false' });
        expect(claude.deepseek.extraEnv).toEqual({});
        // extraEnv 里的变量都得能通过向导的保存校验
        const profile = buildAgentRunProfile('claude', { ANTHROPIC_AUTH_TOKEN: 'k-123456', ...claude.zhipu.extraEnv }, {});
        expect(profile.env.ENABLE_TOOL_SEARCH).toBe('false');
        for (const item of providersForAgent('claude')) {
            for (const name of Object.keys(item.extraEnv)) {
                expect(AGENT_ENV_SCHEMA.claude.env.map(e => e.name)).toContain(name);
            }
        }
    });

    test('经 listSetupAgents 下发，且 ANTHROPIC_API_KEY 能通过向导的保存校验', () => {
        const claude = listSetupAgents().find(agent => agent.id === 'claude');
        expect(claude.providers.length).toBeGreaterThan(0);
        expect(listSetupAgents().find(agent => agent.id === 'codex').providers.length).toBe(6);
        const profile = buildAgentRunProfile('claude', { ANTHROPIC_API_KEY: 'k-123456', ANTHROPIC_BASE_URL: 'https://api.kimi.ai/coding/' }, {});
        expect(profile.env.ANTHROPIC_API_KEY).toBe('k-123456');
    });
});

describe('Codex 第三方模型下拉', () => {
    test('没配 OPENAI_BASE_URL 不是第三方（走 codex 自己的目录）', () => {
        expect(thirdPartyCodexModels({})).toBeNull();
        expect(thirdPartyCodexModels({ OPENAI_API_KEY: 'k' })).toBeNull();
        expect(thirdPartyCodexModels(null)).toBeNull();
    });

    test('认得的服务商列预设模型，当前模型不在里面时补上；认不得的只列当前模型', () => {
        expect(thirdPartyCodexModels({ OPENAI_BASE_URL: 'https://api.deepseek.com/', OPENAI_MODEL: 'deepseek-flash' }).map(m => m.value)).toEqual(['deepseek-flash']);
        expect(thirdPartyCodexModels({ OPENAI_BASE_URL: 'https://open.bigmodel.cn/api/v1', OPENAI_MODEL: 'glm-x' }).map(m => m.value)).toEqual(['glm-5.3', 'glm-x']);
        expect(thirdPartyCodexModels({ OPENAI_BASE_URL: 'https://llm.example.com/v1', OPENAI_MODEL: 'm1' })).toEqual([{ value: 'm1', label: 'm1', description: '' }]);
        expect(thirdPartyCodexModels({ OPENAI_BASE_URL: 'https://llm.example.com/v1' })).toEqual([]);
        expect(findProviderByBaseUrl('codex', 'HTTPS://API.DEEPSEEK.COM')).toMatchObject({ id: 'deepseek' });
    });
});
