'use strict';

const crypto = require('crypto');

// 会话计划（Agent 的 TodoWrite / TaskCreate / TaskUpdate 投影）与用户维护的验收清单（DoD）。
// 纯函数：不读写文件、不做 I/O；落盘由 lib/web/server.js 在同一个同步读改写段里完成。
const MAX_ITEMS = 100;
const MAX_DOD = 50;
const MAX_SUBJECT = 500;
const MAX_NOTE = 1000;
const STATUSES = new Set(['pending', 'in_progress', 'completed']);
const VALID_ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/;

function cleanText(value, max) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .slice(0, max);
}

function mapStatus(value) {
    return STATUSES.has(value) ? value : 'pending';
}

function emptyPlan() {
    return { version: 1, revision: 0, updatedAt: null, items: [], dod: [] };
}

function normalizeItem(raw, index) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const subject = cleanText(raw.subject, MAX_SUBJECT);
    if (!subject) return null;
    const id = typeof raw.id === 'string' && VALID_ID_RE.test(raw.id) ? raw.id : `item-${index + 1}`;
    return {
        id,
        subject,
        status: mapStatus(raw.status),
        source: 'agent',
        updatedAt: typeof raw.updatedAt === 'string' ? cleanText(raw.updatedAt, 40) : null,
        ref: raw.ref && typeof raw.ref === 'object' && !Array.isArray(raw.ref)
            ? {
                ...(typeof raw.ref.messageId === 'string' ? { messageId: cleanText(raw.ref.messageId, 80) } : {}),
                ...(typeof raw.ref.toolId === 'string' ? { toolId: cleanText(raw.ref.toolId, 80) } : {})
            }
            : undefined
    };
}

function normalizeDod(raw, index) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const text = cleanText(raw.text, MAX_SUBJECT);
    if (!text) return null;
    const checked = raw.checked === true;
    return {
        id: typeof raw.id === 'string' && VALID_ID_RE.test(raw.id) ? raw.id : `dod-${index + 1}`,
        text,
        note: cleanText(raw.note, MAX_NOTE),
        checked,
        checkedAt: checked && typeof raw.checkedAt === 'string' ? cleanText(raw.checkedAt, 40) : null,
        checkedBy: 'user'
    };
}

function normalizePlan(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const seen = new Set();
    const items = [];
    (Array.isArray(source.items) ? source.items : []).forEach((raw, index) => {
        const item = normalizeItem(raw, index);
        if (!item || seen.has(item.id)) return;
        seen.add(item.id);
        items.push(item);
    });
    const dod = (Array.isArray(source.dod) ? source.dod : [])
        .map((raw, index) => normalizeDod(raw, index))
        .filter(Boolean)
        .slice(0, MAX_DOD);
    return {
        version: 1,
        revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
        updatedAt: typeof source.updatedAt === 'string' ? cleanText(source.updatedAt, 40) : null,
        items: items.slice(0, MAX_ITEMS),
        dod
    };
}

function planEtag(plan) {
    return crypto.createHash('sha256').update(JSON.stringify(normalizePlan(plan))).digest('hex').slice(0, 16);
}

function sameItems(a, b) {
    // 只比较内容（id / subject / status）：updatedAt 每次现算，不能参与“有没有变化”的判断
    const key = list => normalizePlan({ items: list }).items.map(item => [item.id, item.subject, item.status]);
    return JSON.stringify(key(a)) === JSON.stringify(key(b));
}

function bump(plan, items, extra = {}) {
    return {
        ...plan,
        ...extra,
        items: items.slice(0, MAX_ITEMS),
        revision: plan.revision + 1,
        updatedAt: new Date().toISOString()
    };
}

function applyPlanEvents(plan, events) {
    const base = normalizePlan(plan);
    let items = base.items.map(item => ({ ...item }));
    let changed = false;
    const seen = new Set();
    const now = () => new Date().toISOString();

    for (const event of Array.isArray(events) ? events : []) {
        if (!event || event.kind !== 'tool' || event.parentToolId) continue;
        const toolName = event.toolName;
        const toolId = typeof event.toolId === 'string' ? event.toolId : '';
        const args = event.arguments && typeof event.arguments === 'object' && !Array.isArray(event.arguments) ? event.arguments : {};

        if (toolName === 'TodoWrite') {
            if (event.phase !== 'started' || seen.has(`todo:${toolId}`)) continue;
            seen.add(`todo:${toolId}`);
            if (!Array.isArray(args.todos)) continue;
            const next = args.todos.map((raw, index) => {
                const subject = cleanText(raw && (raw.content !== undefined ? raw.content : raw.subject), MAX_SUBJECT);
                if (!subject) return null;
                return { id: `todo:${index + 1}`, subject, status: mapStatus(raw && raw.status), source: 'agent', updatedAt: now(), ref: toolId ? { toolId } : undefined };
            }).filter(Boolean);
            if (!sameItems(items, next)) {
                items = next;
                changed = true;
            }
            continue;
        }

        if (toolName === 'TaskCreate') {
            if (event.phase === 'started') {
                if (!toolId || seen.has(`create:${toolId}`)) continue;
                seen.add(`create:${toolId}`);
                const subject = cleanText(args.subject, MAX_SUBJECT);
                if (!subject) continue;
                items.push({ id: `task:tool:${toolId}`, subject, status: 'pending', source: 'agent', updatedAt: now(), ref: { toolId } });
                changed = true;
            } else if (event.phase === 'completed') {
                // 完成事件只用来把临时 id 补成结果里的 #N（以及补 subject），不重复追加
                const match = /#(\d+)/.exec(String(event.result || ''));
                if (!match) continue;
                const index = items.findIndex(item => item.id === `task:tool:${toolId}`);
                if (index < 0) continue;
                const nextId = `task:${match[1]}`;
                if (items.some((item, i) => i !== index && item.id === nextId)) continue;
                items[index] = { ...items[index], id: nextId };
                changed = true;
            }
            continue;
        }

        if (toolName === 'TaskUpdate') {
            if (event.phase !== 'started' || !toolId || seen.has(`update:${toolId}`)) continue;
            seen.add(`update:${toolId}`);
            const taskId = args.taskId === undefined || args.taskId === null ? '' : String(args.taskId);
            if (!taskId) continue;
            const index = items.findIndex(item => item.id === `task:${taskId}`);
            if (index < 0) continue;
            if (args.status === 'deleted') {
                items.splice(index, 1);
                changed = true;
                continue;
            }
            const subject = args.subject !== undefined ? cleanText(args.subject, MAX_SUBJECT) : '';
            items[index] = {
                ...items[index],
                ...(subject ? { subject } : {}),
                status: args.status !== undefined ? mapStatus(args.status) : items[index].status,
                updatedAt: now()
            };
            changed = true;
        }
    }

    if (!changed) {
        // 没变化：返回原对象（调用方据此判断“不用写盘、不用发流事件”）
        return plan && typeof plan === 'object' && planEtag(plan) === planEtag(base) ? plan : base;
    }
    if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);
    return bump(base, items);
}

/** 回退 / 分叉后按保留的消息重算计划（TodoWrite 的整份快照通常能恢复；被裁掉的 TaskCreate 就丢了）。 */
function recomputeFromMessages(messages) {
    let plan = emptyPlan();
    for (const message of Array.isArray(messages) ? messages : []) {
        const events = message && Array.isArray(message.traceEvents) ? message.traceEvents : [];
        if (events.length) plan = applyPlanEvents(plan, events);
    }
    return plan;
}

function sameDod(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 保存用户的验收清单：只改 dod，不动 Agent 的 items。
 * 合法 id 原样保留（顺序以传入为准），新项生成 uuid；勾选时间由服务端补。
 */
function mergeDod(plan, dodItems, now = new Date().toISOString()) {
    const base = normalizePlan(plan);
    const next = [];
    for (const raw of Array.isArray(dodItems) ? dodItems : []) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const text = cleanText(raw.text, MAX_SUBJECT);
        if (!text) continue;
        const checked = raw.checked === true;
        const id = typeof raw.id === 'string' && VALID_ID_RE.test(raw.id) ? raw.id : crypto.randomUUID();
        next.push({
            id,
            text,
            note: cleanText(raw.note, MAX_NOTE),
            checked,
            checkedAt: checked ? (typeof raw.checkedAt === 'string' && raw.checkedAt ? cleanText(raw.checkedAt, 40) : now) : null,
            checkedBy: 'user'
        });
        if (next.length >= MAX_DOD) break;
    }
    if (sameDod(base.dod, next)) {
        return plan && typeof plan === 'object' && planEtag(plan) === planEtag(base) ? plan : base;
    }
    return { ...base, dod: next, revision: base.revision + 1, updatedAt: now };
}

module.exports = {
    MAX_ITEMS,
    MAX_DOD,
    emptyPlan,
    normalizePlan,
    planEtag,
    applyPlanEvents,
    recomputeFromMessages,
    mergeDod
};
