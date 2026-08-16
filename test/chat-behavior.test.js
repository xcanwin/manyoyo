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

describe('ManyoyoChatBehavior.shouldExpandComposer', () => {
    const { shouldExpandComposer } = loadChatBehavior();

    test('聚焦输入框时展开', () => {
        expect(shouldExpandComposer({ focused: true, hasDraft: false })).toBe(true);
    });

    test('有草稿内容时展开（即使未聚焦，例如刚失焦但还没清空）', () => {
        expect(shouldExpandComposer({ focused: false, hasDraft: true })).toBe(true);
    });

    test('未聚焦且无草稿时收起', () => {
        expect(shouldExpandComposer({ focused: false, hasDraft: false })).toBe(false);
    });

    test('未传参数时按收起处理', () => {
        expect(shouldExpandComposer()).toBe(false);
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

describe('ManyoyoChatBehavior.reorderMessagesForDisplay', () => {
    const { reorderMessagesForDisplay } = loadChatBehavior();

    test('trace 紧跟着最终回复：显示时把回复挪到 trace 前面', () => {
        const user = { id: 'u1', role: 'user' };
        const trace = { id: 't1', role: 'assistant', streamTrace: true };
        const reply = { id: 'r1', role: 'assistant', mode: 'agent' };
        expect(reorderMessagesForDisplay([user, trace, reply])).toEqual([user, reply, trace]);
    });

    test('trace 紧跟着流式回复（streamingReply）：同样挪到前面', () => {
        const trace = { id: 't1', role: 'assistant', streamTrace: true };
        const streamingReply = { id: 'r1', role: 'assistant', streamingReply: true };
        expect(reorderMessagesForDisplay([trace, streamingReply])).toEqual([streamingReply, trace]);
    });

    test('trace 后面还没有回复（仍在等待）：保持原样', () => {
        const trace = { id: 't1', role: 'assistant', streamTrace: true };
        expect(reorderMessagesForDisplay([trace])).toEqual([trace]);
    });

    test('trace 后面跟着的不是 assistant 回复：不误swap', () => {
        const trace = { id: 't1', role: 'assistant', streamTrace: true };
        const user = { id: 'u2', role: 'user' };
        expect(reorderMessagesForDisplay([trace, user])).toEqual([trace, user]);
    });

    test('trace 后面跟着另一个 trace：不误swap', () => {
        const trace1 = { id: 't1', role: 'assistant', streamTrace: true };
        const trace2 = { id: 't2', role: 'assistant', streamTrace: true };
        expect(reorderMessagesForDisplay([trace1, trace2])).toEqual([trace1, trace2]);
    });

    test('多轮对话：每一对 trace+回复独立换序，互不影响', () => {
        const u1 = { id: 'u1', role: 'user' };
        const t1 = { id: 't1', role: 'assistant', streamTrace: true };
        const r1 = { id: 'r1', role: 'assistant', mode: 'agent' };
        const u2 = { id: 'u2', role: 'user' };
        const t2 = { id: 't2', role: 'assistant', streamTrace: true };
        const r2 = { id: 'r2', role: 'assistant', mode: 'agent' };
        expect(reorderMessagesForDisplay([u1, t1, r1, u2, t2, r2])).toEqual([u1, r1, t1, u2, r2, t2]);
    });

    test('非数组/空输入不抛异常', () => {
        expect(reorderMessagesForDisplay(null)).toEqual([]);
        expect(reorderMessagesForDisplay(undefined)).toEqual([]);
        expect(reorderMessagesForDisplay([])).toEqual([]);
    });
});
