'use strict';

const {
    listSetupAgents,
    getConfiguredAgents,
    buildAgentRunProfile,
    classifyConnectionResult,
    redactSecrets
} = require('../lib/setup');
const { AGENT_ENV_SCHEMA, agentEnvKeys } = require('../lib/init-config');

describe('setup helpers', () => {
    test('schema is the single source: every agent lists its env with secret flags and presets', () => {
        const agents = listSetupAgents();
        expect(agents.map(a => a.id)).toEqual(['claude', 'codex', 'gemini', 'opencode']);
        const claude = agents.find(a => a.id === 'claude');
        expect(claude.env.map(e => e.name)).toEqual(agentEnvKeys('claude'));
        expect(claude.env.find(e => e.name === 'ANTHROPIC_AUTH_TOKEN').secret).toBe(true);
        expect(claude.env.find(e => e.name === 'ANTHROPIC_MODEL').secret).toBe(false);
        expect(claude.baseUrlPresets[0].value).toBe('https://api.anthropic.com');
        // 返回的是拷贝，改它不能污染单一数据源
        claude.env[0].name = 'CHANGED';
        expect(AGENT_ENV_SCHEMA.claude.env[0].name).toBe('ANTHROPIC_AUTH_TOKEN');
    });

    test('configured agents need a non-empty required key', () => {
        expect(getConfiguredAgents({})).toEqual([]);
        expect(getConfiguredAgents({ runs: { claude: { env: { ANTHROPIC_AUTH_TOKEN: '' } } } })).toEqual([]);
        expect(getConfiguredAgents({
            runs: {
                claude: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } },
                codex: { env: { OPENAI_API_KEY: 'k' } },
                gemini: { env: {} },
                other: { env: { OPENAI_API_KEY: 'k' } }
            }
        })).toEqual(['claude', 'codex']);
    });

    test('builds a run profile with defaults', () => {
        const profile = buildAgentRunProfile('claude', { ANTHROPIC_AUTH_TOKEN: ' sk-abc ', ANTHROPIC_MODEL: '' }, { defaultHostPath: '/w' });
        expect(profile).toEqual({
            containerName: 'my-claude-{now}',
            yolo: 'c',
            hostPath: '/w',
            env: { ANTHROPIC_AUTH_TOKEN: 'sk-abc' }
        });
    });

    test('keeps unrelated fields and existing env of a previous run', () => {
        const profile = buildAgentRunProfile('codex', { OPENAI_MODEL: 'm2' }, {
            existingRun: { containerName: 'mine', volumes: ['/a:/b'], env: { OPENAI_API_KEY: 'old', OPENAI_MODEL: 'm1' } },
            defaultHostPath: '/w'
        });
        expect(profile).toEqual({
            containerName: 'mine',
            volumes: ['/a:/b'],
            env: { OPENAI_API_KEY: 'old', OPENAI_MODEL: 'm2' },
            yolo: 'cx',
            hostPath: '/w'
        });
    });

    test.each([
        ['unknown agent', 'nope', {}, /不支持的 Agent/],
        ['unknown key', 'claude', { PATH: '/x' }, /不支持的变量/],
        ['shell metacharacters', 'claude', { ANTHROPIC_AUTH_TOKEN: 'a;rm -rf /' }, /非法字符/],
        ['newline', 'claude', { ANTHROPIC_AUTH_TOKEN: 'a\nb' }, /非法字符/],
        ['non-string', 'claude', { ANTHROPIC_AUTH_TOKEN: 5 }, /字符串/],
        ['missing required', 'claude', { ANTHROPIC_MODEL: 'm' }, /请填写/],
        ['env not an object', 'claude', [], /对象/]
    ])('rejects %s', (_name, agent, env, pattern) => {
        expect(() => buildAgentRunProfile(agent, env)).toThrow(pattern);
    });

    test('classifies the four outcomes', () => {
        expect(classifyConnectionResult({ exitCode: 0, output: 'OK' }).category).toBe('success');
        expect(classifyConnectionResult({ exitCode: 1, output: 'Error: 401 Unauthorized' }).category).toBe('auth');
        expect(classifyConnectionResult({ exitCode: 1, output: 'invalid x-api-key' }).category).toBe('auth');
        expect(classifyConnectionResult({ exitCode: 1, output: 'getaddrinfo ENOTFOUND api.example.com' }).category).toBe('network');
        expect(classifyConnectionResult({ exitCode: 124, output: '' }).category).toBe('network');
        expect(classifyConnectionResult({ exitCode: 2, output: 'segfault' }).category).toBe('other');
    });

    test('detail never echoes secrets and is truncated', () => {
        const secret = 'supersecretvalue123';
        const result = classifyConnectionResult(
            { exitCode: 1, output: `${'x'.repeat(1000)} key=${secret} Bearer abcdefghijkl sk-abcdefghijklmnop` },
            [secret]
        );
        expect(result.detail.length).toBeLessThanOrEqual(300);
        expect(result.detail).not.toContain(secret);
        expect(result.detail).not.toContain('abcdefghijkl');
        expect(redactSecrets('token abcd here', ['abcd'])).toBe('token **** here');
        expect(redactSecrets('x', ['ab'])).toBe('x');
    });
});
