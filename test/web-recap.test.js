'use strict';

const { RECAP_IDLE_MS, findRecapTarget, shouldGenerateRecap, normalizeStoredRecap } = require('../lib/web/recap');

const T0 = Date.parse('2026-10-25T10:00:00.000Z');
const msg = (id, role, content, extra = {}) => ({ id, role, content, mode: 'agent', timestamp: new Date(T0).toISOString(), ...extra });
const conversation = () => [
    msg('u1', 'user', '修一下 bug'),
    msg('t1', 'assistant', '[执行过程]', { streamTrace: true }),
    msg('a1', 'assistant', '已经修好了')
];

describe('回顾（lib/web/recap.js）', () => {
    test('目标：最后一条已完成的最终回复和它前面的用户提示词；执行过程消息不算', () => {
        expect(findRecapTarget(conversation())).toMatchObject({ replyId: 'a1', replyText: '已经修好了', promptText: '修一下 bug', replyAtMs: T0 });
    });

    test('最后一条是执行中 / 被中断 / 用户消息 / 系统命令输出：没有目标', () => {
        expect(findRecapTarget([...conversation().slice(0, 2), msg('a1', 'assistant', '写到一半', { pending: true })])).toBeNull();
        expect(findRecapTarget([...conversation().slice(0, 2), msg('a1', 'assistant', '被中断', { interrupted: true })])).toBeNull();
        expect(findRecapTarget([...conversation(), msg('u2', 'user', '再来')])).toBeNull();
        expect(findRecapTarget([...conversation(), msg('c1', 'assistant', 'ls 输出', { mode: 'command' })])).toBeNull();
        expect(findRecapTarget([msg('a1', 'assistant', '没有提问的回复')])).toBeNull();
        expect(findRecapTarget([])).toBeNull();
        expect(findRecapTarget(null)).toBeNull();
    });

    test('空闲 30 分钟才生成；不到不生成；force 无视时间和已有回顾', () => {
        const session = { messages: conversation(), recap: null };
        expect(shouldGenerateRecap(session, T0 + RECAP_IDLE_MS - 1, false)).toBeNull();
        expect(shouldGenerateRecap(session, T0 + RECAP_IDLE_MS, false)).toMatchObject({ replyId: 'a1' });
        expect(shouldGenerateRecap(session, T0 + 1000, true)).toMatchObject({ replyId: 'a1' });
    });

    test('已经给这条回复生成过就不再生成；有了新回复又可以生成', () => {
        const session = { messages: conversation(), recap: { forMessageId: 'a1', text: '修好了', createdAt: null } };
        expect(shouldGenerateRecap(session, T0 + 3 * RECAP_IDLE_MS, false)).toBeNull();
        expect(shouldGenerateRecap(session, T0 + 1000, true)).not.toBeNull();
        const next = { ...session, messages: [...conversation(), msg('u2', 'user', '继续'), msg('a2', 'assistant', '继续完成')] };
        expect(shouldGenerateRecap(next, T0 + 3 * RECAP_IDLE_MS, false)).toMatchObject({ replyId: 'a2' });
    });

    test('落盘规整', () => {
        const clean = text => (typeof text === 'string' ? text.trim() : '');
        expect(normalizeStoredRecap({ forMessageId: 'a1', text: ' 好 ', createdAt: 'bad' }, clean)).toEqual({ forMessageId: 'a1', text: '好', createdAt: null });
        expect(normalizeStoredRecap({ forMessageId: '', text: 'x' }, clean)).toBeNull();
        expect(normalizeStoredRecap({ forMessageId: 'a', text: '' }, clean)).toBeNull();
        expect(normalizeStoredRecap('x', clean)).toBeNull();
    });
});
