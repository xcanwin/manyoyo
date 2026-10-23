'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const rewind = require('../lib/web/rewind');

const SID = '11111111-2222-3333-4444-555555555555';
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// 结构取自 Claude Code 2.1.304 的真实会话文件：第一条用户记录 parentUuid 为空，后面挂 attachment，
// 下一轮的用户记录挂在上一轮最后一条记录（assistant）后面；工具结果也是 user 类型但内容是 tool_result
function sampleRecords() {
    const rec = (n, parent, type, extra = {}) => JSON.stringify({ uuid: id(n), parentUuid: parent === null ? null : id(parent), type, timestamp: `2026-10-24T00:00:${String(n).padStart(2, '0')}.000Z`, isSidechain: false, ...extra });
    return [
        JSON.stringify({ type: 'queue-operation', timestamp: '2026-10-24T00:00:00.000Z' }),
        rec(1, null, 'user', { message: { role: 'user', content: '第一轮：建文件' } }),
        rec(2, 1, 'attachment'),
        rec(3, 2, 'assistant', { message: { role: 'assistant', content: [{ type: 'text', text: '建好了' }] } }),
        rec(4, 3, 'user', { message: { role: 'user', content: '第二轮：改文件' } }),
        rec(5, 4, 'attachment'),
        rec(6, 5, 'assistant', { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1' }] } }),
        rec(7, 6, 'user', { message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
        rec(8, 7, 'assistant', { message: { role: 'assistant', content: [{ type: 'text', text: '改好了' }] } }),
        rec(9, 8, 'system'),
        rec(10, 9, 'user', { message: { role: 'user', content: '第三轮：改文件' } }),
        rec(11, 10, 'assistant', { message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } }),
        'not json'
    ].join('\n');
}

describe('Claude 会话记录读取（在容器里跑的脚本）', () => {
    test('只给合法 UUID 生成命令；脚本读出记录，用户提示词带文本，工具结果不算提示词', () => {
        expect(rewind.buildClaudeRecordsCommand('../etc')).toBe('');
        expect(rewind.buildClaudeRecordsCommand('')).toBe('');
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-rewind-'));
        try {
            const dir = path.join(home, '.claude', 'projects', '-work');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${SID}.jsonl`), sampleRecords());
            const out = spawnSync('bash', ['-c', rewind.buildClaudeRecordsCommand(SID)], { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' } }).stdout;
            const records = rewind.parseClaudeRecords(out);
            expect(records.map(r => r.t)).toEqual(['user', 'attachment', 'assistant', 'user', 'attachment', 'assistant', 'user', 'assistant', 'system', 'user', 'assistant']);
            expect(records.find(r => r.u === id(1)).x).toBe('第一轮：建文件');
            expect(records.find(r => r.u === id(7)).x).toBe('');
            expect(records.find(r => r.u === id(1)).p).toBeNull();
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    test('找不到文件：没有输出，解析成空数组', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-rewind-'));
        try {
            const out = spawnSync('bash', ['-c', rewind.buildClaudeRecordsCommand(SID)], { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' } }).stdout;
            expect(rewind.parseClaudeRecords(out)).toEqual([]);
            expect(rewind.parseClaudeRecords('garbage')).toEqual([]);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('pickClaudeResumeAt', () => {
    const records = rewind.parseClaudeRecords(JSON.stringify([
        { u: id(1), p: null, t: 'user', ts: '2026-10-24T00:00:01.000Z', x: '第一轮：建文件' },
        { u: id(2), p: id(1), t: 'attachment', ts: '' },
        { u: id(3), p: id(2), t: 'assistant', ts: '' },
        { u: id(4), p: id(3), t: 'user', ts: '2026-10-24T00:00:04.000Z', x: '第二轮：改文件' },
        { u: id(5), p: id(4), t: 'assistant', ts: '' },
        { u: id(9), p: id(5), t: 'system', ts: '' },
        { u: id(10), p: id(9), t: 'user', ts: '2026-10-24T00:00:10.000Z', x: '第三轮：改文件' },
        { u: id(11), p: id(10), t: 'user', ts: '2026-10-24T00:01:10.000Z', x: '第三轮：改文件' }
    ]));

    test('回退到第 2 轮：取它之前最近的 assistant 记录（跳过 system / attachment）', () => {
        expect(rewind.pickClaudeResumeAt(records, { text: '第二轮：改文件', timeMs: Date.parse('2026-10-24T00:00:04.000Z') })).toEqual({ found: true, uuid: id(3) });
        expect(rewind.pickClaudeResumeAt(records, { text: '第三轮：改文件', timeMs: Date.parse('2026-10-24T00:00:10.500Z') })).toEqual({ found: true, uuid: id(5) });
    });

    test('回退到第 1 轮：uuid 为 null（清掉引擎会话，开新会话）', () => {
        expect(rewind.pickClaudeResumeAt(records, { text: '第一轮：建文件', timeMs: 0 })).toEqual({ found: true, uuid: null });
    });

    test('同样的提示词出现两次：按时间最近的那条', () => {
        const twice = rewind.parseClaudeRecords(JSON.stringify([
            { u: id(1), p: null, t: 'user', ts: '2026-10-24T00:00:01.000Z', x: '继续' },
            { u: id(2), p: id(1), t: 'assistant', ts: '' },
            { u: id(3), p: id(2), t: 'user', ts: '2026-10-24T00:05:00.000Z', x: '继续' },
            { u: id(4), p: id(3), t: 'assistant', ts: '' },
            { u: id(5), p: id(4), t: 'user', ts: '2026-10-24T00:10:00.000Z', x: '继续' }
        ]));
        expect(rewind.pickClaudeResumeAt(twice, { text: '继续', timeMs: Date.parse('2026-10-24T00:05:01.000Z') })).toEqual({ found: true, uuid: id(2) });
        expect(rewind.pickClaudeResumeAt(twice, { text: '继续', timeMs: Date.parse('2026-10-24T00:09:59.000Z') })).toEqual({ found: true, uuid: id(4) });
    });

    test('找不到那条提示词 / 空文本：没找到', () => {
        expect(rewind.pickClaudeResumeAt(records, { text: '不存在', timeMs: 0 })).toEqual({ found: false });
        expect(rewind.pickClaudeResumeAt(records, { text: '  ', timeMs: 0 })).toEqual({ found: false });
        expect(rewind.pickClaudeResumeAt([], { text: 'x', timeMs: 0 })).toEqual({ found: false });
    });

    test('父链成环不会死循环', () => {
        const loop = [{ u: id(1), p: id(2), t: 'user', ts: '', x: 'a' }, { u: id(2), p: id(1), t: 'attachment', ts: '' }];
        expect(rewind.pickClaudeResumeAt(loop, { text: 'a', timeMs: 0 })).toEqual({ found: true, uuid: null });
    });
});
