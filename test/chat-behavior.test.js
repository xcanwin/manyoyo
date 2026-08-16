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

describe('ManyoyoChatBehavior.buildTraceNarrative', () => {
    const { buildTraceNarrative } = loadChatBehavior();

    test('command：成功执行，带退出码，生成输出代码块', () => {
        const result = buildTraceNarrative({
            kind: 'command',
            command: 'ls -al',
            exitCode: 0,
            result: 'total 8\ndrwxr-xr-x'
        });
        expect(result).toEqual({
            sentence: '执行命令 `ls -al`，退出码 0',
            tone: 'neutral',
            codeBlocks: [{ label: '输出', text: 'total 8\ndrwxr-xr-x' }]
        });
    });

    test('command：无退出码但有 status 时用 status 描述', () => {
        const result = buildTraceNarrative({ kind: 'command', command: 'sleep 1', status: 'running' });
        expect(result.sentence).toBe('执行命令 `sleep 1`，状态：running');
        expect(result.codeBlocks).toEqual([]);
    });

    test('command：带 error 字段但 kind 仍为 command 时不标红（tone 由 kind 决定，不由字段决定）', () => {
        const result = buildTraceNarrative({ kind: 'command', command: 'false', exitCode: 1, error: '命令执行失败' });
        expect(result.tone).toBe('neutral');
        expect(result.codeBlocks).toEqual(expect.arrayContaining([{ label: '错误', text: '命令执行失败' }]));
    });

    test('mcp：拼接 server.tool 与参数摘要，对象类型参数转 JSON', () => {
        const result = buildTraceNarrative({
            kind: 'mcp',
            server: 'playwright',
            tool: 'click',
            argumentSummary: '点击登录按钮',
            arguments: { selector: '#login' },
            result: 'ok'
        });
        expect(result.sentence).toBe('调用 MCP 工具 `playwright.click`（点击登录按钮）');
        expect(result.codeBlocks).toEqual([
            { label: '参数', text: JSON.stringify({ selector: '#login' }, null, 2) },
            { label: '结果', text: 'ok' }
        ]);
    });

    test('tool：无 argumentSummary 时叙述句不追加括号', () => {
        const result = buildTraceNarrative({ kind: 'tool', toolName: 'Bash', result: 'done' });
        expect(result.sentence).toBe('调用工具 `Bash`');
        expect(result.codeBlocks).toEqual([{ label: '结果', text: 'done' }]);
    });

    test('agent_message：叙述句直接用 detail 文本，无代码块', () => {
        const result = buildTraceNarrative({ kind: 'agent_message', detail: '当前目录结构清晰。' });
        expect(result).toEqual({ sentence: '当前目录结构清晰。', tone: 'neutral', codeBlocks: [] });
    });

    test('error：叙述句固定前缀，detail 全文进代码块，tone 为 error', () => {
        const result = buildTraceNarrative({ kind: 'error', detail: '连接超时' });
        expect(result.sentence).toBe('出现错误：连接超时');
        expect(result.tone).toBe('error');
        expect(result.codeBlocks).toEqual([{ label: '详情', text: '连接超时' }]);
    });

    test('error：无 detail 时叙述句不带冒号，也没有代码块', () => {
        const result = buildTraceNarrative({ kind: 'error' });
        expect(result.sentence).toBe('出现错误');
        expect(result.codeBlocks).toEqual([]);
    });

    test('空字段（无可展示内容）时 codeBlocks 为空数组', () => {
        const result = buildTraceNarrative({ kind: 'command', command: 'true' });
        expect(result.codeBlocks).toEqual([]);
    });

    test('status：无 detail 时回退使用 text 字段', () => {
        const result = buildTraceNarrative({ kind: 'status', text: '状态更新' });
        expect(result.sentence).toBe('状态更新');
        expect(result.codeBlocks).toEqual([]);
    });

    test('无法识别的 kind（如 thread/turn）兜底使用 text 字段，不抛异常', () => {
        const result = buildTraceNarrative({ kind: 'thread', text: '新会话开始' });
        expect(result).toEqual({ sentence: '新会话开始', tone: 'neutral', codeBlocks: [] });
    });

    test('传入 null/undefined 不抛异常', () => {
        expect(buildTraceNarrative(null)).toEqual({ sentence: '', tone: 'neutral', codeBlocks: [] });
        expect(buildTraceNarrative(undefined)).toEqual({ sentence: '', tone: 'neutral', codeBlocks: [] });
    });
});
