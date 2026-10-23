'use strict';

const { PROVIDER_PRESETS, providersForAgent } = require('../lib/provider-presets');
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

    test('不收录 Codex 条目（Codex 不认 OPENAI_BASE_URL），Gemini / OpenCode 也没有', () => {
        expect(providersForAgent('codex')).toEqual([]);
        expect(providersForAgent('gemini')).toEqual([]);
        expect(providersForAgent('opencode')).toEqual([]);
        expect(providersForAgent('claude').length).toBe(PROVIDER_PRESETS.length);
    });

    test('DeepSeek 带必填的默认模型，Kimi Code 用 ANTHROPIC_API_KEY，火山地址不是 /api/v3', () => {
        const byId = Object.fromEntries(providersForAgent('claude').map(item => [item.id, item]));
        expect(byId.deepseek.defaultModel).toBe('deepseek-flash[1m]');
        expect(byId['kimi-code'].keyEnv).toBe('ANTHROPIC_API_KEY');
        expect(byId.volcengine.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/coding');
        expect(byId.zhipu.defaultModel).toBe('');
    });

    test('经 listSetupAgents 下发，且 ANTHROPIC_API_KEY 能通过向导的保存校验', () => {
        const claude = listSetupAgents().find(agent => agent.id === 'claude');
        expect(claude.providers.length).toBeGreaterThan(0);
        expect(listSetupAgents().find(agent => agent.id === 'codex').providers).toEqual([]);
        const profile = buildAgentRunProfile('claude', { ANTHROPIC_API_KEY: 'k-123456', ANTHROPIC_BASE_URL: 'https://api.kimi.ai/coding/' }, {});
        expect(profile.env.ANTHROPIC_API_KEY).toBe('k-123456');
    });
});
