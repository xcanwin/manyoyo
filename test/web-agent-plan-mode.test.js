'use strict';

const { __testing } = require('../lib/web/server');

const { buildClaudeAgentExecCommand } = __testing;
const build = (template, prompt = 'hi', options = {}) => buildClaudeAgentExecCommand(template, prompt, { permissionMode: 'plan', ...options });

// 实测（claude 2.1.310）：-p 下 --permission-mode plan 和 --dangerously-skip-permissions 同时出现时计划模式无效，直接改文件
describe('计划模式：命令构造', () => {
    test('加 --permission-mode plan，并去掉模板里的免确认参数', () => {
        const command = build('IS_SANDBOX=1 claude --dangerously-skip-permissions -p {prompt}');
        expect(command).toContain('--permission-mode plan');
        expect(command).not.toContain('--dangerously-skip-permissions');
        expect(command).toMatch(/^IS_SANDBOX=1 claude /);
    });

    test('--allow-dangerously-skip-permissions、--permission-mode <其它值>、等号写法都去掉；只剩一个 permission-mode', () => {
        for (const template of [
            'claude --allow-dangerously-skip-permissions -p {prompt}',
            'claude --permission-mode bypassPermissions -p {prompt}',
            'claude --permission-mode=acceptEdits -p {prompt}',
            'claude --dangerously-skip-permissions --permission-mode bypassPermissions -p {prompt}'
        ]) {
            const command = build(template);
            expect(command.match(/--permission-mode/g)).toHaveLength(1);
            expect(command).toContain('--permission-mode plan');
            expect(command).not.toMatch(/skip-permissions|bypassPermissions|acceptEdits/);
        }
    });

    test('提示词里写了这些字样时原样保留（只处理模板，不碰提示词）', () => {
        const prompt = '请解释 --dangerously-skip-permissions 和 --permission-mode bypassPermissions 是什么';
        const command = build('claude --dangerously-skip-permissions -p {prompt}', prompt);
        expect(command).toContain(prompt);
        expect(command.match(/--dangerously-skip-permissions/g)).toHaveLength(1);
        expect(command).toContain('--permission-mode plan');
    });

    test('forwardSubagentText 为 auto 时探测语句在前，计划模式参数仍在 claude 之后', () => {
        const command = build('claude --dangerously-skip-permissions -p {prompt}', 'hi', { forwardSubagentText: 'auto', effort: 'low' });
        expect(command).toMatch(/^MANYOYO_FWD_SUBAGENT=.*; CLAUDE_CODE_EFFORT_LEVEL=low claude /);
        expect(command).toContain('--permission-mode plan');
        expect(command).not.toContain('--dangerously-skip-permissions');
    });

    test('不是计划模式：模板原样（免确认参数保留）；非法取值当没选', () => {
        for (const permissionMode of [undefined, '', 'bypassPermissions', 'plan; id', 5]) {
            const command = buildClaudeAgentExecCommand('claude --dangerously-skip-permissions -p {prompt}', 'hi', { permissionMode });
            expect(command).toContain('--dangerously-skip-permissions');
            expect(command).not.toContain('--permission-mode');
        }
    });

    test('用户模板里已经是 --permission-mode plan：不重复', () => {
        const command = build('claude --permission-mode plan -p {prompt}');
        expect(command.match(/--permission-mode/g)).toHaveLength(1);
    });
});
