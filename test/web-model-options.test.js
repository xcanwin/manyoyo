'use strict';

const { buildEnvModelOptions } = require('../lib/web/server');

describe('buildEnvModelOptions', () => {
    test('claude：真实模型名在前，默认与档位别名写进描述，同名合并', () => {
        const result = buildEnvModelOptions('claude', {
            ANTHROPIC_MODEL: 'glm-5.3-flash',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3-pro',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3-flash',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-air',
            ANTHROPIC_AUTH_TOKEN: 'secret'
        });
        expect(result.defaultModel).toBe('glm-5.3-flash');
        expect(result.options).toEqual([
            { value: 'glm-5.3-flash', label: 'glm-5.3-flash', description: '默认 · sonnet' },
            { value: 'glm-5.3-pro', label: 'glm-5.3-pro', description: 'opus' },
            { value: 'glm-5.3-air', label: 'glm-5.3-air', description: 'haiku' }
        ]);
        expect(JSON.stringify(result)).not.toContain('secret');
    });

    test('没配置 / 非法值 / 未知 Agent 都给空选项', () => {
        expect(buildEnvModelOptions('claude', {})).toEqual({ defaultModel: '', options: [] });
        expect(buildEnvModelOptions('claude', { ANTHROPIC_MODEL: 'a b; rm' }).options).toEqual([]);
        expect(buildEnvModelOptions('', { ANTHROPIC_MODEL: 'x' }).options).toEqual([]);
    });

    test('codex 用 OPENAI_MODEL，gemini 用 GEMINI_MODEL，[1m] 后缀原样保留', () => {
        expect(buildEnvModelOptions('codex', { OPENAI_MODEL: 'gpt-x' }).defaultModel).toBe('gpt-x');
        expect(buildEnvModelOptions('gemini', { GEMINI_MODEL: 'gemini-2.5-pro' }).options[0].value).toBe('gemini-2.5-pro');
        expect(buildEnvModelOptions('claude', { ANTHROPIC_MODEL: 'sonnet[1m]' }).options[0].value).toBe('sonnet[1m]');
    });
});
