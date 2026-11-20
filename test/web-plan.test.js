'use strict';

const planLib = require('../lib/web/plan');

const tool = (toolName, extra = {}) => ({ kind: 'tool', provider: 'claude', toolName, toolId: `${toolName}-1`, phase: 'started', ...extra });
const todo = (text, status = 'pending') => ({ content: text, status, activeForm: text });

describe('web/plan：计划投影', () => {
    test('空计划稳定；normalizePlan 对缺失 / 损坏 / 超长返回可用结构', () => {
        const empty = planLib.emptyPlan();
        expect(empty).toEqual({ version: 1, revision: 0, updatedAt: null, items: [], dod: [] });
        expect(planLib.normalizePlan(undefined)).toEqual(empty);
        expect(planLib.normalizePlan({ items: 'x', dod: {} })).toEqual(empty);
        const long = planLib.normalizePlan({ items: [{ subject: 'a'.repeat(600), status: 'weird' }], dod: [{ text: 'b'.repeat(600), note: 'c'.repeat(1100) }] });
        expect(long.items[0].subject).toHaveLength(500);
        expect(long.items[0].status).toBe('pending');
        expect(long.dod[0].text).toHaveLength(500);
        expect(long.dod[0].note).toHaveLength(1000);
        expect(long.dod[0].id).toBe('dod-1');
        expect(planLib.planEtag(empty)).toMatch(/^[0-9a-f]{16}$/);
        expect(planLib.planEtag(planLib.normalizePlan(undefined))).toBe(planLib.planEtag(empty));
    });

    test('TodoWrite 整份替换（id 用 todo:<序号>），空数组清空；重复上报内容相同不算变化', () => {
        const first = planLib.applyPlanEvents(planLib.emptyPlan(), [tool('TodoWrite', { arguments: { todos: [todo('写代码', 'in_progress'), todo('写测试')] } })]);
        expect(first.items).toEqual([
            expect.objectContaining({ id: 'todo:1', subject: '写代码', status: 'in_progress', source: 'agent' }),
            expect.objectContaining({ id: 'todo:2', subject: '写测试', status: 'pending' })
        ]);
        const same = planLib.applyPlanEvents(first, [tool('TodoWrite', { arguments: { todos: [todo('写代码', 'in_progress'), todo('写测试')] } })]);
        expect(same).toBe(first);
        const cleared = planLib.applyPlanEvents(first, [tool('TodoWrite', { arguments: { todos: [] } })]);
        expect(cleared.items).toEqual([]);
        expect(cleared.revision).toBe(first.revision + 1);
    });

    test('TaskCreate 先给临时 id，完成事件补 #N 与 subject；同一 toolId 不重复追加', () => {
        const created = planLib.applyPlanEvents(planLib.emptyPlan(), [
            tool('TaskCreate', { toolId: 't1', arguments: { subject: '跑测试' } }),
            tool('TaskCreate', { toolId: 't1', arguments: { subject: '跑测试' } })
        ]);
        expect(created.items).toEqual([expect.objectContaining({ id: 'task:tool:t1', subject: '跑测试', status: 'pending' })]);
        const completed = planLib.applyPlanEvents(created, [
            tool('TaskCreate', { toolId: 't1', phase: 'completed', status: 'success', result: 'Task #3 created successfully' })
        ]);
        expect(completed.items).toEqual([expect.objectContaining({ id: 'task:3', subject: '跑测试' })]);
        const again = planLib.applyPlanEvents(completed, [
            tool('TaskCreate', { toolId: 't1', phase: 'completed', status: 'success', result: 'Task #3 created successfully' })
        ]);
        expect(again).toBe(completed);
    });

    test('TaskUpdate 更新 / 删除；completed 事件忽略；TaskCreate 与 TodoWrite 互不影响', () => {
        let plan = planLib.applyPlanEvents(planLib.emptyPlan(), [
            tool('TodoWrite', { arguments: { todos: [todo('列表一')] } }),
            tool('TaskCreate', { toolId: 't1', arguments: { subject: '任务一' } }),
            tool('TaskCreate', { toolId: 't2', arguments: { subject: '任务二' } }),
            tool('TaskCreate', { toolId: 't1', phase: 'completed', result: 'Task #1 created successfully' }),
            tool('TaskCreate', { toolId: 't2', phase: 'completed', result: 'Task #2 created successfully' })
        ]);
        plan = planLib.applyPlanEvents(plan, [
            tool('TaskUpdate', { toolId: 'u1', arguments: { taskId: '1', status: 'in_progress', subject: '任务一（改名）' } }),
            tool('TaskUpdate', { toolId: 'u1', phase: 'completed', arguments: { taskId: '1', status: 'completed' } }),
            tool('TaskUpdate', { toolId: 'u2', arguments: { taskId: 2, status: 'deleted' } })
        ]);
        expect(plan.items.map(item => [item.id, item.subject, item.status])).toEqual([
            ['todo:1', '列表一', 'pending'],
            ['task:1', '任务一（改名）', 'in_progress']
        ]);
        expect(planLib.applyPlanEvents(plan, [tool('TaskUpdate', { toolId: 'u3', arguments: { taskId: '9', status: 'completed' } })])).toBe(plan);
    });

    test('子 Agent 与非 tool 事件忽略；坏参数不崩溃；超 100 项截断', () => {
        const ignored = planLib.applyPlanEvents(planLib.emptyPlan(), [
            { ...tool('TodoWrite', { arguments: { todos: [todo('子')] } }), parentToolId: 'parent' },
            { kind: 'agent_message', text: 'x' },
            tool('Read', { arguments: {} })
        ]);
        expect(ignored.items).toEqual([]);
        const todos = Array.from({ length: 120 }, (_, i) => todo(`t${i}`));
        const capped = planLib.applyPlanEvents(planLib.emptyPlan(), [tool('TodoWrite', { arguments: { todos } })]);
        expect(capped.items).toHaveLength(100);
        expect(planLib.applyPlanEvents(planLib.emptyPlan(), [tool('TodoWrite', { arguments: { todos: 'nope' } })])).toEqual(planLib.emptyPlan());
    });

    test('recomputeFromMessages：按保留的消息顺序重放，TodoWrite 整份替换能恢复', () => {
        const messages = [
            { traceEvents: [tool('TaskCreate', { toolId: 'a', arguments: { subject: '早期任务' } })] },
            { traceEvents: [tool('TodoWrite', { arguments: { todos: [todo('当前一', 'completed'), todo('当前二')] } })] }
        ];
        const plan = planLib.recomputeFromMessages(messages);
        expect(plan.items.map(item => [item.id, item.subject, item.status])).toEqual([
            ['todo:1', '当前一', 'completed'],
            ['todo:2', '当前二', 'pending']
        ]);
        // 消息被裁剪后，早期 TaskCreate 丢了就丢了；TodoWrite 的快照仍在
        expect(planLib.recomputeFromMessages(messages.slice(1)).items).toHaveLength(2);
        expect(planLib.recomputeFromMessages([])).toEqual(planLib.emptyPlan());
    });

    test('mergeDod：保留合法 id / 顺序、新项生成 id、勾选时间；items 不动；内容相同不算变化', () => {
        const base = planLib.applyPlanEvents(planLib.emptyPlan(), [tool('TodoWrite', { arguments: { todos: [todo('保留我')] } })]);
        const merged = planLib.mergeDod(base, [
            { id: 'dod_a1', text: '跑通测试', note: '本地', checked: true },
            { text: '检查 diff', checked: false }
        ], '2026-01-01T00:00:00.000Z');
        expect(merged.items).toEqual(base.items);
        expect(merged.dod[0]).toEqual(expect.objectContaining({ id: 'dod_a1', text: '跑通测试', note: '本地', checked: true, checkedAt: '2026-01-01T00:00:00.000Z', checkedBy: 'user' }));
        expect(merged.dod[1].id).toMatch(/^[0-9a-f-]{36}$/);
        expect(merged.dod[1].checkedAt).toBeNull();
        expect(merged.revision).toBe(base.revision + 1);
        const same = planLib.mergeDod(merged, merged.dod, '2026-01-02T00:00:00.000Z');
        expect(same).toBe(merged);
    });
});
