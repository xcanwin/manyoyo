'use strict';

const { __testing } = require('../lib/web/server');

const { buildClaudeAgentExecCommand, buildCodexAgentExecCommand } = __testing;

describe('推理强度：命令构造', () => {
    test('claude：用命令前缀的环境变量覆盖（环境变量优先于 --effort），放在 claude 之前', () => {
        const command = buildClaudeAgentExecCommand('claude -p {prompt}', 'hi', { effort: 'low' });
        expect(command).toMatch(/^CLAUDE_CODE_EFFORT_LEVEL=low claude /);
        expect(command).not.toContain('--effort');
    });

    test('claude：模板已有环境变量前缀时接在它们后面、紧贴 claude', () => {
        const command = buildClaudeAgentExecCommand('IS_SANDBOX=1 claude --dangerously-skip-permissions -p {prompt}', 'hi', { effort: 'max' });
        expect(command).toMatch(/^IS_SANDBOX=1 CLAUDE_CODE_EFFORT_LEVEL=max claude /);
    });

    test('claude：forwardSubagentText 为 auto 时，探测语句在前、前缀仍紧贴 claude', () => {
        const command = buildClaudeAgentExecCommand('claude -p {prompt}', 'hi', { effort: 'high', forwardSubagentText: 'auto' });
        expect(command).toMatch(/^MANYOYO_FWD_SUBAGENT=.*; CLAUDE_CODE_EFFORT_LEVEL=high claude --verbose /);
    });

    test('claude：没选强度不注入；模板里自己写了就以模板为准；提示词里的字样不影响', () => {
        expect(buildClaudeAgentExecCommand('claude -p {prompt}', 'hi', {})).not.toContain('CLAUDE_CODE_EFFORT_LEVEL');
        expect(buildClaudeAgentExecCommand('claude -p {prompt}', 'hi', { effort: '' })).not.toContain('CLAUDE_CODE_EFFORT_LEVEL');
        const own = buildClaudeAgentExecCommand('CLAUDE_CODE_EFFORT_LEVEL=max claude -p {prompt}', 'hi', { effort: 'low' });
        expect(own.match(/CLAUDE_CODE_EFFORT_LEVEL=/g)).toHaveLength(1);
        expect(own).toContain('CLAUDE_CODE_EFFORT_LEVEL=max');
        const prompt = buildClaudeAgentExecCommand('claude -p {prompt}', 'CLAUDE_CODE_EFFORT_LEVEL=max claude', { effort: 'low' });
        expect(prompt).toMatch(/^CLAUDE_CODE_EFFORT_LEVEL=low claude /);
    });

    test('claude：非法强度（含注入）不注入', () => {
        for (const effort of ['low; rm -rf /', 'LOW', 'a b', '']) {
            expect(buildClaudeAgentExecCommand('claude -p {prompt}', 'hi', { effort })).not.toContain('CLAUDE_CODE_EFFORT_LEVEL');
        }
    });

    test('codex：-c model_reasoning_effort=…；模板已写则不加；非法不加', () => {
        const command = buildCodexAgentExecCommand('codex exec {prompt}', 'hi', { effort: 'high' });
        expect(command).toContain('-c model_reasoning_effort=high');
        const own = buildCodexAgentExecCommand('codex exec -c model_reasoning_effort=low {prompt}', 'hi', { effort: 'high' });
        expect(own.match(/model_reasoning_effort/g)).toHaveLength(1);
        expect(buildCodexAgentExecCommand('codex exec {prompt}', 'hi', { effort: 'x y' })).not.toContain('model_reasoning_effort');
        expect(buildCodexAgentExecCommand('codex exec {prompt}', 'hi', {})).not.toContain('model_reasoning_effort');
        // resume 形态也带
        expect(buildCodexAgentExecCommand('codex exec {prompt}', 'hi', { effort: 'low', sessionId: 'abc' })).toContain('model_reasoning_effort=low');
    });
});
