'use strict';

const { resolveYoloCommand } = require('../lib/agent-adapters');

describe('lib/agent-adapters resolveYoloCommand', () => {
    test('keeps an omitted yolo setting as an empty command', () => {
        expect(resolveYoloCommand('')).toBe('');
    });

    test.each([
        ['claude', 'IS_SANDBOX=1 claude --dangerously-skip-permissions'],
        ['cc', 'IS_SANDBOX=1 claude --dangerously-skip-permissions'],
        ['c', 'IS_SANDBOX=1 claude --dangerously-skip-permissions'],
        ['gemini', 'gemini --yolo'],
        ['gm', 'gemini --yolo'],
        ['g', 'gemini --yolo'],
        ['codex', 'codex --dangerously-bypass-approvals-and-sandbox'],
        ['cx', 'codex --dangerously-bypass-approvals-and-sandbox'],
        ['opencode', 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode'],
        ['oc', 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode']
    ])('resolves "%s" to its YOLO command', (alias, expected) => {
        expect(resolveYoloCommand(alias)).toBe(expected);
    });

    test('is case-insensitive and trims whitespace', () => {
        expect(resolveYoloCommand(' CC ')).toBe('IS_SANDBOX=1 claude --dangerously-skip-permissions');
    });

    test('throws for an unknown alias', () => {
        expect(() => resolveYoloCommand('npm')).toThrow('未知 yolo 值: npm');
    });
});

// Codex 0.164 实测：`exec` 不认环境变量 OPENAI_BASE_URL，也不读 OPENAI_API_KEY（DeepSeek 返回 401）；
// 要用自定义 model_provider（env_key 指定读哪个变量）。命令由 shell 在容器里展开，值不拼进命令文本
describe('lib/agent-adapters withCodexBaseUrl', () => {
    const { withCodexBaseUrl } = require('../lib/agent-adapters');
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    function runShim(command, envVars) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shim-'));
        try {
            fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
            const env = { PATH: `${dir}:${process.env.PATH}`, ...envVars };
            return spawnSync('bash', ['-c', command], { encoding: 'utf8', env }).stdout.trimEnd().split('\n');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    const baseUrlArgs = url => ['-c', `openai_base_url="${url}"`];
    const providerArgs = url => [
        ...baseUrlArgs(url),
        '-c', 'model_provider=manyoyo',
        '-c', 'model_providers.manyoyo.name=manyoyo',
        '-c', `model_providers.manyoyo.base_url="${url}"`,
        '-c', 'model_providers.manyoyo.env_key=OPENAI_API_KEY',
        '-c', 'model_providers.manyoyo.wire_api=responses'
    ];

    test('命令文本里不含地址，只有由 shell 展开的占位', () => {
        const command = withCodexBaseUrl('codex --dangerously-bypass-approvals-and-sandbox');
        expect(command).toContain('${OPENAI_BASE_URL:+');
        expect(command).toContain('env_key=OPENAI_API_KEY');
        expect(command).not.toContain('OPENAI_API_KEY=');
        expect(command).toMatch(/^codex .*--dangerously-bypass-approvals-and-sandbox$/);
        expect(command).not.toMatch(/https?:/);
    });

    test('只处理以 codex 开头的命令（可带前置环境变量）；用户已写了 provider / 地址 / 模型的不重复加；别的命令原样返回', () => {
        expect(withCodexBaseUrl('claude --x')).toBe('claude --x');
        expect(withCodexBaseUrl('')).toBe('');
        expect(withCodexBaseUrl('echo codex')).toBe('echo codex');
        const already = 'codex -c openai_base_url="http://x" exec hi';
        expect(withCodexBaseUrl(already)).not.toContain('model_providers.manyoyo');
        const provider = 'codex -c model_provider=mine exec hi';
        expect(withCodexBaseUrl(provider)).not.toContain('model_providers.manyoyo');
        const full = 'codex -c model_provider=mine --model m exec hi';
        expect(withCodexBaseUrl(full)).toBe(full);
        expect(withCodexBaseUrl('FOO=1 BAR="a b" codex exec hi')).toMatch(/^FOO=1 BAR="a b" codex exec \$\{OPENAI_BASE_URL:\+.*\} hi$/);
        expect(withCodexBaseUrl('codex exec resume --json abc hi')).toMatch(/^codex exec resume \$\{OPENAI_BASE_URL:\+.*\} --json abc hi$/);
    });

    test.each([
        ['有地址、Key 和模型', { OPENAI_BASE_URL: 'https://open.bigmodel.cn/api/v1', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'glm-5.3' }, [...providerArgs('https://open.bigmodel.cn/api/v1'), '--model', 'glm-5.3']],
        ['有地址、Key', { OPENAI_BASE_URL: 'http://127.0.0.1:18778/v1', OPENAI_API_KEY: 'k' }, providerArgs('http://127.0.0.1:18778/v1')],
        // ChatGPT 登录（没有 OPENAI_API_KEY）+ 自定义地址：不能退化，仍是老写法，不换成要读 Key 的自定义 provider
        ['只有地址（没有 Key）', { OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex' }, baseUrlArgs('https://chatgpt.com/backend-api/codex')],
        ['只有模型', { OPENAI_MODEL: 'gpt-x' }, ['--model', 'gpt-x']],
        ['都没有', {}, []]
    ])('bash 展开（codex exec）：%s', (_label, envVars, expected) => {
        expect(runShim(withCodexBaseUrl("codex exec 'hi there'"), envVars)).toEqual(['exec', ...expected, 'hi there']);
    });

    test('exec resume 同样展开', () => {
        const envVars = { OPENAI_BASE_URL: 'https://api.deepseek.com', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'deepseek-flash' };
        expect(runShim(withCodexBaseUrl("codex exec resume --json sid 'hi'"), envVars))
            .toEqual(['exec', 'resume', ...providerArgs('https://api.deepseek.com'), '--model', 'deepseek-flash', '--json', 'sid', 'hi']);
    });

    // codex 不允许 --model 出现两次：会话里选了模型（命令里已有 --model / -m）时，不再用 OPENAI_MODEL
    test.each([
        ["codex exec --model picked 'hi'", ['exec', ...providerArgs('https://x.test/v1'), '--model', 'picked', 'hi']],
        ["codex exec -m picked 'hi'", ['exec', ...providerArgs('https://x.test/v1'), '-m', 'picked', 'hi']],
        ["codex exec -c model=picked 'hi'", ['exec', ...providerArgs('https://x.test/v1'), '-c', 'model=picked', 'hi']]
    ])('命令已指定模型时 OPENAI_MODEL 不再追加：%s', (command, expected) => {
        expect(runShim(withCodexBaseUrl(command), { OPENAI_BASE_URL: 'https://x.test/v1', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'env-model' })).toEqual(expected);
    });
});
