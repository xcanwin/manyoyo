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

// Codex 0.160 / 0.164 实测不认环境变量 OPENAI_BASE_URL（只认 `-c openai_base_url=...`）：
// 容器里配了 OPENAI_BASE_URL 时，命令要由 shell 在容器里展开出 `-c`，值不拼进命令文本
describe('lib/agent-adapters withCodexBaseUrl', () => {
    const { withCodexBaseUrl } = require('../lib/agent-adapters');
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    test('命令文本里不含地址，只有一段由 shell 展开的占位', () => {
        const command = withCodexBaseUrl('codex --dangerously-bypass-approvals-and-sandbox');
        expect(command).toContain('${OPENAI_BASE_URL:+');
        expect(command).toMatch(/^codex .*--dangerously-bypass-approvals-and-sandbox$/);
        expect(command).not.toMatch(/https?:/);
    });

    test('只处理以 codex 开头的命令（可带前置环境变量）；已经写了 openai_base_url 的不重复加；别的命令原样返回', () => {
        expect(withCodexBaseUrl('claude --x')).toBe('claude --x');
        expect(withCodexBaseUrl('')).toBe('');
        expect(withCodexBaseUrl('echo codex')).toBe('echo codex');
        const already = 'codex -c openai_base_url="http://x" exec hi';
        expect(withCodexBaseUrl(already)).toBe(already);
        expect(withCodexBaseUrl('FOO=1 BAR="a b" codex exec hi')).toMatch(/^FOO=1 BAR="a b" codex exec \$\{OPENAI_BASE_URL:\+.*\} hi$/);
        expect(withCodexBaseUrl('codex exec resume --json abc hi')).toMatch(/^codex exec resume \$\{OPENAI_BASE_URL:\+.*\} --json abc hi$/);
    });

    // 用真 bash 跑一个会打印参数的假 codex：变量有值就多出 `-c openai_base_url="<值>"`，没有就一个参数都不多
    test.each([
        ['http://127.0.0.1:18778/v1', ['exec', '-c', 'openai_base_url="http://127.0.0.1:18778/v1"', 'hi there']],
        ['https://open.bigmodel.cn/api/v1', ['exec', '-c', 'openai_base_url="https://open.bigmodel.cn/api/v1"', 'hi there']],
        ['', ['exec', 'hi there']]
    ])('bash 展开：OPENAI_BASE_URL=%j', (value, expected) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shim-'));
        try {
            fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
            const command = withCodexBaseUrl("codex exec 'hi there'");
            const env = { PATH: `${dir}:${process.env.PATH}` };
            if (value) env.OPENAI_BASE_URL = value;
            const out = spawnSync('bash', ['-c', command], { encoding: 'utf8', env }).stdout.trimEnd().split('\n');
            expect(out).toEqual(expected);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
