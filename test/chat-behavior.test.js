'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadChatBehavior() {
    const scriptPath = path.join(__dirname, '..', 'lib', 'web', 'frontend', 'chat-behavior.js');
    const script = fs.readFileSync(scriptPath, 'utf-8');
    const window = {};
    const context = { window, globalThis: window, self: window, console };
    vm.runInNewContext(script, context, { filename: 'chat-behavior.js' });
    return window.ManyoyoChatBehavior;
}

describe('ManyoyoChatBehavior.isNearBottom', () => {
    const { isNearBottom } = loadChatBehavior();

    test('返回 true：滚动条已经在底部（distance = 0）', () => {
        expect(isNearBottom(160, 200, 40, 40)).toBe(true);
    });

    test('返回 true：距离底部正好等于阈值', () => {
        expect(isNearBottom(120, 200, 40, 40)).toBe(true);
    });

    test('返回 false：距离底部超过阈值（用户正在往上翻看历史）', () => {
        expect(isNearBottom(0, 200, 40, 40)).toBe(false);
    });

    test('返回 true：内容本身不足以滚动（scrollHeight <= clientHeight）', () => {
        expect(isNearBottom(0, 40, 200, 40)).toBe(true);
    });

    test('未传阈值时默认使用 40px', () => {
        expect(isNearBottom(160, 200, 40)).toBe(true);
        expect(isNearBottom(100, 200, 40)).toBe(false);
    });
});

describe('ManyoyoChatBehavior.summarizeTraceFlow', () => {
    const { summarizeTraceFlow } = loadChatBehavior();

    test('空数组：返回暂无步骤', () => {
        expect(summarizeTraceFlow([])).toEqual({ count: 0, label: '暂无步骤' });
    });

    test('包含错误事件：标记为有错误（优先级最高）', () => {
        const events = [
            { kind: 'command' },
            { kind: 'error' },
            { kind: 'tool' }
        ];
        expect(summarizeTraceFlow(events, { pending: true })).toEqual({ count: 3, label: '3 步 · 有错误' });
    });

    test('仍在执行且无错误：标记为进行中', () => {
        const events = [{ kind: 'command' }, { kind: 'tool' }];
        expect(summarizeTraceFlow(events, { pending: true })).toEqual({ count: 2, label: '2 步 · 进行中' });
    });

    test('已结束且无错误：标记为已完成', () => {
        const events = [{ kind: 'command' }];
        expect(summarizeTraceFlow(events, { pending: false })).toEqual({ count: 1, label: '1 步 · 已完成' });
    });

    test('未传 options 时按已完成处理', () => {
        const events = [{ kind: 'command' }];
        expect(summarizeTraceFlow(events)).toEqual({ count: 1, label: '1 步 · 已完成' });
    });
});


describe('ManyoyoChatBehavior.buildDocumentTitle', () => {
    const { buildDocumentTitle } = loadChatBehavior();

    test('有 agent 名时拼接标题', () => {
        expect(buildDocumentTitle('AGENT 1')).toBe('AGENT 1 · MANYOYO Web');
    });

    test('未传/空字符串时回退默认标题', () => {
        expect(buildDocumentTitle('')).toBe('MANYOYO Web');
        expect(buildDocumentTitle()).toBe('MANYOYO Web');
    });

    test('仅空白字符时回退默认标题', () => {
        expect(buildDocumentTitle('   ')).toBe('MANYOYO Web');
    });
});

describe('ManyoyoChatBehavior.mergeTraceIntoReply', () => {
    const { mergeTraceIntoReply } = loadChatBehavior();

    test('trace 紧跟着最终回复：合并成一条，携带 pairedTrace，时间用 trace 的时间', () => {
        const user = { id: 'u1', role: 'user' };
        const trace = { id: 't1', role: 'assistant', streamTrace: true, timestamp: '2026-01-01T00:00:00.000Z' };
        const reply = { id: 'r1', role: 'assistant', mode: 'agent', content: '你好', timestamp: '2026-01-01T00:00:05.000Z' };
        const result = mergeTraceIntoReply([user, trace, reply]);
        expect(result).toEqual([
            user,
            { id: 'r1', role: 'assistant', mode: 'agent', content: '你好', timestamp: '2026-01-01T00:00:00.000Z', pairedTrace: trace }
        ]);
    });

    test('trace 紧跟着流式回复（streamingReply）：同样合并', () => {
        const trace = { id: 't1', role: 'assistant', streamTrace: true, timestamp: 't' };
        const streamingReply = { id: 'r1', role: 'assistant', streamingReply: true, content: '进行中', timestamp: 'r' };
        const result = mergeTraceIntoReply([trace, streamingReply]);
        expect(result).toEqual([
            { id: 'r1', role: 'assistant', streamingReply: true, content: '进行中', timestamp: 't', pairedTrace: trace }
        ]);
    });

    test('trace 后面还没有回复（仍在等待）：保持原样，不合并', () => {
        const trace = { id: 't1', role: 'assistant', streamTrace: true };
        expect(mergeTraceIntoReply([trace])).toEqual([trace]);
    });

    test('trace 后面跟着的不是 assistant 回复：不误合并', () => {
        const trace = { id: 't1', role: 'assistant', streamTrace: true };
        const user = { id: 'u2', role: 'user' };
        expect(mergeTraceIntoReply([trace, user])).toEqual([trace, user]);
    });

    test('trace 后面跟着另一个 trace：不误合并', () => {
        const trace1 = { id: 't1', role: 'assistant', streamTrace: true };
        const trace2 = { id: 't2', role: 'assistant', streamTrace: true };
        expect(mergeTraceIntoReply([trace1, trace2])).toEqual([trace1, trace2]);
    });

    test('多轮对话：每一对 trace+回复独立合并，互不影响', () => {
        const u1 = { id: 'u1', role: 'user' };
        const t1 = { id: 't1', role: 'assistant', streamTrace: true, timestamp: 't1' };
        const r1 = { id: 'r1', role: 'assistant', mode: 'agent', timestamp: 'r1' };
        const u2 = { id: 'u2', role: 'user' };
        const t2 = { id: 't2', role: 'assistant', streamTrace: true, timestamp: 't2' };
        const r2 = { id: 'r2', role: 'assistant', mode: 'agent', timestamp: 'r2' };
        const result = mergeTraceIntoReply([u1, t1, r1, u2, t2, r2]);
        expect(result).toEqual([
            u1,
            { id: 'r1', role: 'assistant', mode: 'agent', timestamp: 't1', pairedTrace: t1 },
            u2,
            { id: 'r2', role: 'assistant', mode: 'agent', timestamp: 't2', pairedTrace: t2 }
        ]);
    });

    test('不修改原始消息对象（不产生副作用）', () => {
        const trace = { id: 't1', role: 'assistant', streamTrace: true, timestamp: 't' };
        const reply = { id: 'r1', role: 'assistant', mode: 'agent', timestamp: 'r' };
        mergeTraceIntoReply([trace, reply]);
        expect(reply.pairedTrace).toBeUndefined();
        expect(reply.timestamp).toBe('r');
        expect(trace.timestamp).toBe('t');
    });

    test('非数组/空输入不抛异常', () => {
        expect(mergeTraceIntoReply(null)).toEqual([]);
        expect(mergeTraceIntoReply(undefined)).toEqual([]);
        expect(mergeTraceIntoReply([])).toEqual([]);
    });
});

describe('ManyoyoChatBehavior.buildStructuredTraceResidualLines', () => {
    const { buildStructuredTraceResidualLines } = loadChatBehavior();

    test('多行 traceEvent.text（如完整的说明/详情内容）拆行后应逐行去重，不再产生噪音残留', () => {
        const detail = '当前目录内容如下：\n\n**目录**：`.agents`、`.github`\n\n**文件**：\n- 配置/元数据：`package.json`';
        const message = {
            content: [
                '[执行过程]',
                '等待 Agent 启动…',
                '上下文模式: first-turn',
                `[说明] ${detail}`,
                '[任务] 已完成'
            ].join('\n'),
            traceEvents: [
                { kind: 'agent_message', phase: 'completed', text: `[说明] ${detail}` }
            ]
        };
        expect(buildStructuredTraceResidualLines(message)).toEqual([
            '等待 Agent 启动…',
            '上下文模式: first-turn',
            '[任务] 已完成'
        ]);
    });

    test('单行 traceEvent.text 精确匹配时照常去重（不回归）', () => {
        const message = {
            content: ['[执行过程]', '等待 Agent 启动…', '[工具完成] Bash (success)'].join('\n'),
            traceEvents: [
                { kind: 'tool', phase: 'completed', text: '[工具完成] Bash (success)' }
            ]
        };
        expect(buildStructuredTraceResidualLines(message)).toEqual(['等待 Agent 启动…']);
    });

    test('没有任何 traceEvent 覆盖的行原样保留', () => {
        const message = {
            content: ['[执行过程]', '等待 Agent 启动…', '上下文模式: first-turn'].join('\n'),
            traceEvents: []
        };
        expect(buildStructuredTraceResidualLines(message)).toEqual(['等待 Agent 启动…', '上下文模式: first-turn']);
    });

    test('[执行过程] 头部行始终被过滤', () => {
        const message = { content: '[执行过程]', traceEvents: [] };
        expect(buildStructuredTraceResidualLines(message)).toEqual([]);
    });

    test('重复出现的相同行按次数消费（多重计数不回归）', () => {
        const message = {
            content: ['[执行过程]', '重复行', '重复行', '重复行'].join('\n'),
            traceEvents: [
                { kind: 'status', text: '重复行' }
            ]
        };
        expect(buildStructuredTraceResidualLines(message)).toEqual(['重复行', '重复行']);
    });

    test('message/content/traceEvents 缺失时不抛异常', () => {
        expect(buildStructuredTraceResidualLines(null)).toEqual([]);
        expect(buildStructuredTraceResidualLines({})).toEqual([]);
        expect(buildStructuredTraceResidualLines({ content: '正常行' })).toEqual(['正常行']);
    });
});

describe('ManyoyoChatBehavior.mergeToolTraceEvents', () => {
    const { mergeToolTraceEvents } = loadChatBehavior();

    test('非数组/空输入不抛异常', () => {
        expect(mergeToolTraceEvents(null)).toEqual([]);
        expect(mergeToolTraceEvents(undefined)).toEqual([]);
        expect(mergeToolTraceEvents([])).toEqual([]);
    });

    test('无匹配 toolId 的单个工具事件：原样保留', () => {
        const events = [
            { kind: 'tool', toolId: 'toolu_1', phase: 'started', text: '[工具开始] Bash' }
        ];
        expect(mergeToolTraceEvents(events)).toEqual(events);
    });

    test('同一 toolId 的 started + completed 合并成一条，completed 字段覆盖 started', () => {
        const started = {
            kind: 'tool',
            toolId: 'toolu_1',
            phase: 'started',
            status: 'in_progress',
            text: '[工具开始] Bash (command=ls -la)',
            toolName: 'Bash',
            arguments: { command: 'ls -la' },
            argumentSummary: 'command=ls -la'
        };
        const completed = {
            kind: 'tool',
            toolId: 'toolu_1',
            phase: 'completed',
            status: 'success',
            text: '[工具完成] Bash (success)',
            toolName: 'Bash',
            result: 'ok'
        };
        const result = mergeToolTraceEvents([started, completed]);
        expect(result).toEqual([
            {
                kind: 'tool',
                toolId: 'toolu_1',
                phase: 'completed',
                status: 'success',
                text: '[工具完成] Bash (success)',
                toolName: 'Bash',
                arguments: { command: 'ls -la' },
                argumentSummary: 'command=ls -la',
                result: 'ok'
            }
        ]);
    });

    test('不同 toolId 的多个工具调用：各自独立保留', () => {
        const a1 = { kind: 'tool', toolId: 'a', phase: 'started', text: 'a-start' };
        const b1 = { kind: 'tool', toolId: 'b', phase: 'started', text: 'b-start' };
        const a2 = { kind: 'tool', toolId: 'a', phase: 'completed', text: 'a-done' };
        const b2 = { kind: 'tool', toolId: 'b', phase: 'completed', text: 'b-done' };
        const result = mergeToolTraceEvents([a1, b1, a2, b2]);
        expect(result).toEqual([
            { kind: 'tool', toolId: 'a', phase: 'completed', text: 'a-done' },
            { kind: 'tool', toolId: 'b', phase: 'completed', text: 'b-done' }
        ]);
    });

    test('合并后的条目保持在首次出现的位置（不会跳到后面）', () => {
        const agentMessage = { kind: 'agent_message', text: '[说明] 我先看看目录' };
        const toolStart = { kind: 'tool', toolId: 'toolu_1', phase: 'started', text: 'start' };
        const toolDone = { kind: 'tool', toolId: 'toolu_1', phase: 'completed', text: 'done' };
        const finalMessage = { kind: 'agent_message', text: '[说明] 完成了' };
        const result = mergeToolTraceEvents([agentMessage, toolStart, finalMessage, toolDone]);
        expect(result).toEqual([
            agentMessage,
            { kind: 'tool', toolId: 'toolu_1', phase: 'completed', text: 'done' },
            finalMessage
        ]);
    });

    test('无 toolId 的事件（agent_message/thread/turn/error）即使重复也不合并', () => {
        const events = [
            { kind: 'agent_message', text: '第一句' },
            { kind: 'agent_message', text: '第二句' },
            { kind: 'error', text: '出错了' },
            { kind: 'error', text: '又出错了' }
        ];
        expect(mergeToolTraceEvents(events)).toEqual(events);
    });

    test('command 和 mcp 两种 kind 同样支持按 toolId 合并（Codex 场景）', () => {
        const cmdStart = { kind: 'command', toolId: 'item_1', phase: 'started', text: '[命令开始] ls -la' };
        const cmdDone = { kind: 'command', toolId: 'item_1', phase: 'completed', text: '[命令完成] ls -la (completed)', exitCode: 0 };
        const mcpStart = { kind: 'mcp', toolId: 'item_2', phase: 'started', text: '[MCP开始] search' };
        const mcpDone = { kind: 'mcp', toolId: 'item_2', phase: 'completed', text: '[MCP完成] search', result: 'ok' };
        const result = mergeToolTraceEvents([cmdStart, mcpStart, cmdDone, mcpDone]);
        expect(result).toEqual([
            { kind: 'command', toolId: 'item_1', phase: 'completed', text: '[命令完成] ls -la (completed)', exitCode: 0 },
            { kind: 'mcp', toolId: 'item_2', phase: 'completed', text: '[MCP完成] search', result: 'ok' }
        ]);
    });

    test('不同 kind 使用相同 toolId 不会误合并', () => {
        const toolEvent = { kind: 'tool', toolId: 'x', phase: 'started', text: 'tool-x' };
        const commandEvent = { kind: 'command', toolId: 'x', phase: 'started', text: 'command-x' };
        expect(mergeToolTraceEvents([toolEvent, commandEvent])).toEqual([toolEvent, commandEvent]);
    });

    test('不修改原始事件对象（不产生副作用）', () => {
        const started = { kind: 'tool', toolId: 'toolu_1', phase: 'started', text: 'start' };
        const completed = { kind: 'tool', toolId: 'toolu_1', phase: 'completed', text: 'done' };
        mergeToolTraceEvents([started, completed]);
        expect(started.phase).toBe('started');
        expect(completed.phase).toBe('completed');
    });
});
