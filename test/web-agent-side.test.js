'use strict';

const side = require('../lib/web/agent-side');
const { __testing } = require('../lib/web/server');

const SID = '0d6c1f6a-1111-4a2b-9c3d-123456789abc';

describe('侧问命令（lib/web/agent-side.js）', () => {
    test('claude：分叉但不落盘；带强度前缀；问题是被转义的最后一个参数', () => {
        const command = side.buildClaudeSideCommand({ sessionId: SID, model: 'opus', effort: 'low', question: "it's; rm -rf /" });
        expect(command).toBe(`CLAUDE_CODE_EFFORT_LEVEL=low claude -p -r ${SID} --fork-session --no-session-persistence --output-format json --model 'opus' 'it'"'"'s; rm -rf /'`);
    });

    test('claude：没有引擎会话 id 就不带 -r / --fork-session；非法会话 id、模型、强度一律丢掉', () => {
        const command = side.buildClaudeSideCommand({ sessionId: '', model: '', effort: '', question: 'hi' });
        expect(command).toBe("claude -p --no-session-persistence --output-format json 'hi'");
        const bad = side.buildClaudeSideCommand({ sessionId: 'x; id', model: 'a b;c', effort: 'LOW', question: 'hi' });
        expect(bad).toBe("claude -p --no-session-persistence --output-format json 'hi'");
    });

    test('codex：exec fork <线程> --ephemeral，经 buildCodexAgentExecCommand 展开兼容服务参数', () => {
        const template = side.buildCodexSideTemplate({ threadId: SID, model: 'glm-5.3', effort: 'high' });
        expect(template).toBe(`codex exec fork ${SID} --json --ephemeral --skip-git-repo-check --model 'glm-5.3' -c model_reasoning_effort=high {prompt}`);
        const command = __testing.buildCodexAgentExecCommand(template, "what's up", {});
        expect(command).toContain(`fork ${SID}`);
        expect(command).toContain('--ephemeral');
        expect(command).toContain('OPENAI_BASE_URL');
        expect(command.endsWith("'what'\"'\"'s up'")).toBe(true);
        // 命令里已经有 --model：不会再追加环境变量里的模型（codex 不允许出现两次）
        expect(command.match(/--model/g)).toHaveLength(1);
    });

    test('codex：没有线程 id 时是不带上下文的一次性提问', () => {
        const template = side.buildCodexSideTemplate({ threadId: '', model: '', effort: '' });
        expect(template).toBe('codex exec --json --ephemeral --skip-git-repo-check -s read-only {prompt}');
    });

    test('问题：去首尾空白、空 / 超长 / 非字符串视为无效', () => {
        expect(side.normalizeSideQuestion('  hi  ')).toBe('hi');
        expect(side.normalizeSideQuestion('')).toBe('');
        expect(side.normalizeSideQuestion('   ')).toBe('');
        expect(side.normalizeSideQuestion(5)).toBe('');
        expect(side.normalizeSideQuestion('字'.repeat(4001))).toBe('');
        expect(side.normalizeSideQuestion('字'.repeat(4000))).toHaveLength(4000);
    });

    test('答案限长', () => {
        expect(side.clipAnswer(' 好 ')).toBe('好');
        expect(side.clipAnswer('x'.repeat(30000))).toMatch(/\[truncated\]$/);
    });
});
