'use strict';

const fs = require('fs');
const path = require('path');
const { extractClaudeContextUsage, normalizeStoredContextUsage } = require('../lib/web/context-usage');

// 真实 claude 2.1.310 + 智谱的流（精简）：3 次模型请求，message_start 全是 0，message_delta 才有值
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-partial-usage.ndjson'), 'utf8');

describe('上下文占用（lib/web/context-usage.js）', () => {
    test('取最后一次请求的四项之和，不是整轮累加；窗口取自 modelUsage', () => {
        const usage = extractClaudeContextUsage(FIXTURE);
        // 最后一次请求：input 8264 + cache_read 1024 + cache_creation 0 + output 862
        expect(usage).toEqual({ usedTokens: 10150, window: 1000000, inputTokens: 8264, cacheReadTokens: 1024, cacheCreationTokens: 0 });
    });

    test('子 Agent 的请求（带 parent_tool_use_id）不算', () => {
        const sub = JSON.stringify({ type: 'stream_event', parent_tool_use_id: 'toolu_1', event: { type: 'message_delta', usage: { input_tokens: 99999, output_tokens: 1 } } });
        expect(extractClaudeContextUsage(`${FIXTURE}${sub}\n`).usedTokens).toBe(10150);
    });

    test('message_start 有值时与 message_delta 取各项最大值', () => {
        const lines = [
            { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 500, cache_read_input_tokens: 100 } } } },
            { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } }
        ].map(item => JSON.stringify(item)).join('\n');
        expect(extractClaudeContextUsage(lines)).toMatchObject({ usedTokens: 640, inputTokens: 500, cacheReadTokens: 100, window: 0 });
    });

    test('没有数据、坏行、全是 0：返回 null', () => {
        expect(extractClaudeContextUsage('')).toBeNull();
        expect(extractClaudeContextUsage('not json\n{"a":')).toBeNull();
        const zero = JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 0, output_tokens: 0 } } });
        expect(extractClaudeContextUsage(zero)).toBeNull();
    });

    test('落盘规整：负数 / 非数字 / 非对象丢掉', () => {
        expect(normalizeStoredContextUsage({ usedTokens: 10, window: 'x', inputTokens: -1, updatedAt: 'bad' })).toEqual({ usedTokens: 10, window: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, updatedAt: null });
        expect(normalizeStoredContextUsage({ usedTokens: 0 })).toBeNull();
        expect(normalizeStoredContextUsage([])).toBeNull();
        expect(normalizeStoredContextUsage(null)).toBeNull();
        expect(normalizeStoredContextUsage({ usedTokens: 5, updatedAt: '2026-10-25T00:00:00.000Z' }).updatedAt).toBe('2026-10-25T00:00:00.000Z');
    });
});
