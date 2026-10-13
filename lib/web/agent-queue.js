'use strict';

// 任务进行中追加的提示词队列：存在 agentSession.queue 里，随历史落盘。
// 只放纯函数，调用方负责 saveWebSessionHistory。

const crypto = require('crypto');

const QUEUE_MAX = 10;
const QUEUE_WHEN = ['now', 'step', 'turn'];
const STEP_FALLBACK_MS = 120 * 1000;
// 这些 kind 完成不代表“一步”结束（会话 / 回合 / 错误）
const NON_STEP_KINDS = new Set(['thread', 'turn', 'error']);

function normalizeWhen(value) {
    return QUEUE_WHEN.includes(value) ? value : null;
}

function getQueue(agentSession) {
    if (!agentSession) {
        return [];
    }
    if (!Array.isArray(agentSession.queue)) {
        agentSession.queue = [];
    }
    return agentSession.queue;
}

function publicQueue(agentSession) {
    const queue = agentSession && Array.isArray(agentSession.queue) ? agentSession.queue : [];
    return queue.map(item => ({
        id: item.id,
        clientMessageId: item.clientMessageId,
        text: item.text,
        when: item.when,
        createdAt: item.createdAt
    }));
}

// now / step 排在所有 turn 之前（它们之间保持先来先到）；turn 排到队尾
function enqueue(agentSession, { clientMessageId, text, when }) {
    const queue = getQueue(agentSession);
    if (clientMessageId) {
        const existing = queue.find(item => item.clientMessageId === clientMessageId);
        if (existing) {
            return { ok: true, duplicate: true, item: existing };
        }
    }
    if (queue.length >= QUEUE_MAX) {
        return { ok: false, full: true };
    }
    const item = {
        id: `q-${crypto.randomBytes(6).toString('hex')}`,
        clientMessageId: clientMessageId || '',
        text,
        when,
        createdAt: new Date().toISOString()
    };
    if (when === 'turn') {
        queue.push(item);
    } else {
        const firstTurn = queue.findIndex(entry => entry.when === 'turn');
        queue.splice(firstTurn === -1 ? queue.length : firstTurn, 0, item);
    }
    return { ok: true, duplicate: false, item };
}

function removeFromQueue(agentSession, id) {
    const queue = getQueue(agentSession);
    const index = queue.findIndex(item => item.id === id);
    if (index === -1) {
        return null;
    }
    return queue.splice(index, 1)[0];
}

function takeNext(agentSession) {
    const queue = getQueue(agentSession);
    return queue.length ? queue.shift() : null;
}

// 一次工具调用 / 子 Agent 结束，或一条 assistant 消息完整落地
function isStepBoundary(event) {
    const traceEvent = event && event.type === 'trace' ? event.traceEvent : null;
    return Boolean(traceEvent)
        && typeof traceEvent.kind === 'string'
        && !NON_STEP_KINDS.has(traceEvent.kind)
        && traceEvent.phase === 'completed';
}

// 从磁盘读回时的白名单：只留结构合法的条目
function normalizeStoredQueue(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.text === 'string'
            && item.text.trim() && QUEUE_WHEN.includes(item.when))
        .slice(0, QUEUE_MAX)
        .map(item => ({
            id: item.id,
            clientMessageId: typeof item.clientMessageId === 'string' ? item.clientMessageId : '',
            text: item.text,
            when: item.when,
            createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString()
        }));
}

module.exports = {
    normalizeStoredQueue,
    QUEUE_MAX,
    QUEUE_WHEN,
    STEP_FALLBACK_MS,
    normalizeWhen,
    getQueue,
    publicQueue,
    enqueue,
    removeFromQueue,
    takeNext,
    isStepBoundary
};
