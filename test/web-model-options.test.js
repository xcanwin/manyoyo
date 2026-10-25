'use strict';

const { buildEnvModelOptions } = require('../lib/web/server');

describe('buildEnvModelOptions', () => {
    test('claude：每个档位别名一行（即使指向同一模型也不合并），默认单独给出', () => {
        const result = buildEnvModelOptions('claude', {
            ANTHROPIC_MODEL: 'glm-5.3-flash[1m]',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3[1m]',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
            ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.3[1m]',
            ANTHROPIC_AUTH_TOKEN: 'secret'
        });
        expect(result.defaultModel).toBe('glm-5.3-flash[1m]');
        expect(result.options).toEqual([
            { value: 'fable', label: 'glm-5.3[1m]', description: 'fable' },
            { value: 'opus', label: 'glm-5.3[1m]', description: 'opus' },
            { value: 'sonnet', label: 'glm-5.3[1m]', description: 'sonnet' },
            { value: 'haiku', label: 'glm-5.3-flash[1m]', description: 'haiku' }
        ]);
        expect(JSON.stringify(result)).not.toContain('secret');
    });

    test('没配置 / 非法值 / 未知 Agent 都给空选项', () => {
        expect(buildEnvModelOptions('claude', {})).toEqual({ defaultModel: '', options: [] });
        expect(buildEnvModelOptions('claude', { ANTHROPIC_MODEL: 'a b; rm' }).defaultModel).toBe('');
        expect(buildEnvModelOptions('', { ANTHROPIC_MODEL: 'x' }).options).toEqual([]);
    });

    test('codex 用 OPENAI_MODEL，gemini 用 GEMINI_MODEL，只有默认没有档位选项', () => {
        expect(buildEnvModelOptions('codex', { OPENAI_MODEL: 'gpt-x' })).toEqual({ defaultModel: 'gpt-x', options: [] });
        expect(buildEnvModelOptions('gemini', { GEMINI_MODEL: 'gemini-2.5-pro' }).defaultModel).toBe('gemini-2.5-pro');
    });
});
