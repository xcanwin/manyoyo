'use strict';

const q = require('../lib/web/agent-queue');

describe('agent-queue', () => {
    test('now/step 排在 turn 之前，同类先来先到', () => {
        const s = {};
        q.enqueue(s, { clientMessageId: 'c-turn-001', text: 't1', when: 'turn' });
        q.enqueue(s, { clientMessageId: 'c-step-001', text: 's1', when: 'step' });
        q.enqueue(s, { clientMessageId: 'c-now-0001', text: 'n1', when: 'now' });
        q.enqueue(s, { clientMessageId: 'c-turn-002', text: 't2', when: 'turn' });
        expect(s.queue.map(i => i.text)).toEqual(['s1', 'n1', 't1', 't2']);
    });

    test('同一个 clientMessageId 只入队一次', () => {
        const s = {};
        const a = q.enqueue(s, { clientMessageId: 'c-dup-0001', text: 'x', when: 'turn' });
        const b = q.enqueue(s, { clientMessageId: 'c-dup-0001', text: 'x', when: 'turn' });
        expect(b.duplicate).toBe(true);
        expect(b.item.id).toBe(a.item.id);
        expect(s.queue).toHaveLength(1);
    });

    test('最多 10 条，超出返回 full', () => {
        const s = {};
        for (let i = 0; i < q.QUEUE_MAX; i += 1) {
            expect(q.enqueue(s, { clientMessageId: `c-full-${String(i).padStart(4, '0')}`, text: 'x', when: 'turn' }).ok).toBe(true);
        }
        expect(q.enqueue(s, { clientMessageId: 'c-full-9999', text: 'x', when: 'turn' })).toEqual({ ok: false, full: true });
    });

    test('取消与取队首', () => {
        const s = {};
        const a = q.enqueue(s, { clientMessageId: '', text: 'a', when: 'turn' }).item;
        q.enqueue(s, { clientMessageId: '', text: 'b', when: 'turn' });
        expect(q.removeFromQueue(s, a.id).text).toBe('a');
        expect(q.removeFromQueue(s, 'nope')).toBeNull();
        expect(q.takeNext(s).text).toBe('b');
        expect(q.takeNext(s)).toBeNull();
    });

    test('步骤边界：完成的工具 / 子 Agent / 说明，不含开始与流式增量', () => {
        const ev = (kind, phase) => ({ type: 'trace', traceEvent: { kind, phase } });
        expect(q.isStepBoundary(ev('tool', 'completed'))).toBe(true);
        expect(q.isStepBoundary(ev('command', 'completed'))).toBe(true);
        expect(q.isStepBoundary(ev('thread', 'completed'))).toBe(false);
        expect(q.isStepBoundary(ev('subagent', 'completed'))).toBe(true);
        expect(q.isStepBoundary(ev('agent_message', 'completed'))).toBe(true);
        expect(q.isStepBoundary(ev('tool', 'started'))).toBe(false);
        expect(q.isStepBoundary({ type: 'content_delta', partial: true })).toBe(false);
        expect(q.isStepBoundary({ type: 'trace', text: 'x' })).toBe(false);
    });

    test('when 白名单', () => {
        expect(q.normalizeWhen('now')).toBe('now');
        expect(q.normalizeWhen('later')).toBeNull();
    });
});
