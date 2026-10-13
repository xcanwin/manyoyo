'use strict';

const fs = require('fs');
const path = require('path');
const { __testing } = require('../lib/web/server');

const { prepareStructuredTraceEvents, extractContentDeltaFromPayload, extractAgentMessageFromStructuredOutput } = __testing;
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-subagent.ndjson'), 'utf8');
const payloads = fixture.split('\n').filter(Boolean).map(line => JSON.parse(line));

function traceAll(items) {
    const state = { toolNamesById: new Map() };
    return items.flatMap(payload => prepareStructuredTraceEvents('claude', payload, state));
}

describe('子 Agent 的解析（真实 Claude Code 2.1.290 样本 test/fixtures/claude-subagent.ndjson）', () => {
    const events = traceAll(payloads);
    const agentStart = events.find(event => event.kind === 'subagent' && event.phase === 'started');

    test('Agent 工具调用生成 kind=subagent 事件：子 Agent 类型、描述、提示词', () => {
        expect(agentStart).toMatchObject({ kind: 'subagent', toolName: 'Agent', subagentType: 'Explore', description: 'List /etc/apt files' });
        expect(agentStart.toolId).toMatch(/^call_/);
        expect(agentStart.parentToolId).toBeUndefined();
        expect(agentStart.text).toContain('[子 Agent]');
    });

    test('子 Agent 里的事件带 parentToolId（发起它的那次 Agent 调用的 id），主对话的事件不带', () => {
        const children = events.filter(event => event.parentToolId === agentStart.toolId);
        expect(children.length).toBeGreaterThanOrEqual(3);
        expect(children.some(event => event.kind === 'tool' && event.toolName === 'Bash' && event.phase === 'started')).toBe(true);
        expect(children.some(event => event.kind === 'tool' && event.phase === 'completed')).toBe(true);
        const top = events.filter(event => !event.parentToolId);
        expect(top.some(event => event.kind === 'subagent')).toBe(true);
        expect(top.some(event => event.toolName === 'Bash')).toBe(false);
    });

    test('Agent 的 tool_result 合成同一个 subagent 的完成事件（结果与状态），toolId 相同', () => {
        const done = events.find(event => event.kind === 'subagent' && event.phase === 'completed');
        expect(done.toolId).toBe(agentStart.toolId);
        expect(done.status).toBe('success');
        expect(done.result).toContain('7');
    });

    test('旧名字 Task 也认', () => {
        const state = { toolNamesById: new Map() };
        const started = prepareStructuredTraceEvents('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { description: 'd', subagent_type: 'general-purpose', prompt: 'p' } }] } }, state);
        expect(started[0]).toMatchObject({ kind: 'subagent', subagentType: 'general-purpose', toolId: 't1' });
        const done = prepareStructuredTraceEvents('claude', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }, state);
        expect(done[0]).toMatchObject({ kind: 'subagent', phase: 'completed', toolId: 't1' });
    });

    test('已有事件只增加字段：普通工具调用仍是 kind=tool 且字段不变', () => {
        const state = { toolNamesById: new Map() };
        const started = prepareStructuredTraceEvents('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls', description: 'd' } }] } }, state);
        expect(started[0]).toMatchObject({ kind: 'tool', toolName: 'Bash', phase: 'started', status: 'in_progress', toolId: 'b1' });
        expect(started[0].parentToolId).toBeUndefined();
    });
});

describe('子 Agent 的说话内容不能当成主 Agent 的回复', () => {
    test('content_delta 与最终回复提取都跳过带 parent_tool_use_id 的 assistant 消息', () => {
        const sub = { type: 'assistant', parent_tool_use_id: 'call_x', message: { content: [{ type: 'text', text: '子 Agent 的话' }] } };
        const main = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '主 Agent 的话' }] } };
        expect(extractContentDeltaFromPayload('claude', sub, {})).toBeNull();
        expect(extractContentDeltaFromPayload('claude', main, {})).toMatchObject({ text: '主 Agent 的话' });
        expect(extractAgentMessageFromStructuredOutput('claude', `${JSON.stringify(main)}\n${JSON.stringify(sub)}\n`)).toBe('主 Agent 的话');
    });

    test('用真实样本：最终回复是主 Agent 最后那句，不是子 Agent 的总结', () => {
        const reply = extractAgentMessageFromStructuredOutput('claude', fixture);
        expect(reply).not.toContain('Directories (6)');
        expect(reply.length).toBeGreaterThan(0);
    });
});

describe('--forward-subagent-text 只在容器里的 claude 支持时才生效', () => {
    const { buildClaudeAgentExecCommand } = __testing;
    test('auto：命令里先探测，支持就展开成参数、不支持展开成空；不会无条件追加', () => {
        const command = buildClaudeAgentExecCommand('claude -p {prompt}', 'hi', { forwardSubagentText: 'auto' });
        expect(command).toContain("claude --help 2>&1 | grep -q -- '--forward-subagent-text'");
        expect(command).toContain('$MANYOYO_FWD_SUBAGENT');
        // 参数放在整条命令末尾，前面已有参数的顺序不变
        expect(command.endsWith("-p 'hi' $MANYOYO_FWD_SUBAGENT")).toBe(true);
    });

    test('真的在 shell 里执行：用假 claude 验证——支持的版本拿到参数，旧版本（不认这个参数）拿不到', () => {
        const { spawnSync } = require('child_process');
        const os = require('os');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-fwd-'));
        try {
            const make = (name, helpText) => {
                fs.mkdirSync(path.join(dir, name));
                fs.writeFileSync(path.join(dir, name, 'claude'), `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "${helpText}"; exit 0; fi\necho "ARGS: $@"\n`, { mode: 0o755 });
            };
            make('new', '  --forward-subagent-text  forward');
            make('old', '  --verbose');
            const command = buildClaudeAgentExecCommand('claude -p {prompt}', 'hi', { forwardSubagentText: 'auto' });
            const run = which => spawnSync('/bin/bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, PATH: `${path.join(dir, which)}:${process.env.PATH}` } }).stdout;
            expect(run('new')).toContain('--forward-subagent-text');
            expect(run('old')).not.toContain('--forward-subagent-text');
            expect(run('old')).toContain('ARGS:');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('forwardSubagentText: true 直接加；模板里已经写了不重复', () => {
        expect(buildClaudeAgentExecCommand('claude -p {prompt}', 'hi', { forwardSubagentText: true })).toContain('--forward-subagent-text');
        expect(buildClaudeAgentExecCommand('claude -p {prompt}', 'hi', {})).not.toContain('--forward-subagent-text');
        const twice = buildClaudeAgentExecCommand('claude --forward-subagent-text -p {prompt}', 'hi', { forwardSubagentText: true });
        expect(twice.match(/--forward-subagent-text/g)).toHaveLength(1);
    });
});
