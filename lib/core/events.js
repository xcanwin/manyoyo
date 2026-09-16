'use strict';

const crypto = require('crypto');

const EVENT_VERSION = 1;
const EVENT_TYPES = new Set([
    'session.created',
    'session.ready',
    'session.stopping',
    'session.stopped',
    'session.failed',
    'process.started',
    'process.stdout',
    'process.stderr',
    'process.exited',
    'process.interrupted',
    'agent.turn.started',
    'agent.turn.delta',
    'agent.message.completed',
    'agent.turn.failed',
    'agent.tool.observed',
    'agent.child.observed',
    'agent.child.completed',
    'agent.child.failed',
    'agent.child.interrupted',
    'artifact.created',
    'artifact.changed',
    'artifact.deleted',
    'terminal.opened',
    'terminal.resized',
    'terminal.closed'
]);

function createControlEvent(input = {}) {
    const aggregateId = String(input.aggregateId || input.sessionId || '').trim();
    const event = {
        id: input.id || crypto.randomUUID(),
        type: input.type,
        version: input.version === undefined ? EVENT_VERSION : input.version,
        aggregateId,
        sessionId: input.sessionId || aggregateId,
        seq: input.seq,
        timestamp: input.timestamp || new Date().toISOString(),
        data: input.data || {}
    };
    return validateControlEvent(event);
}

function validateControlEvent(event) {
    if (!event || typeof event !== 'object') {
        throw new Error('事件必须为对象');
    }
    if (!EVENT_TYPES.has(event.type)) {
        throw new Error(`未知事件类型: ${event.type}`);
    }
    if (event.version !== EVENT_VERSION) {
        throw new Error(`不支持的事件版本: ${event.version}`);
    }
    if (!String(event.id || '').trim()) {
        throw new Error('事件 id 不能为空');
    }
    if (!String(event.aggregateId || '').trim()) {
        throw new Error('aggregateId 不能为空');
    }
    if (!Number.isInteger(event.seq) || event.seq <= 0) {
        throw new Error('seq 必须为正整数');
    }
    if (!String(event.timestamp || '').trim()) {
        throw new Error('timestamp 不能为空');
    }
    if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
        throw new Error('data 必须为对象');
    }
    return event;
}

function selectEventsAfterCursor(events, cursor = 0) {
    const normalizedCursor = Number(cursor || 0);
    if (!Number.isInteger(normalizedCursor) || normalizedCursor < 0) {
        throw new Error('cursor 必须为非负整数');
    }

    let previousSeq = 0;
    let aggregateId = '';
    const result = [];
    for (const event of events || []) {
        validateControlEvent(event);
        if (!aggregateId) {
            aggregateId = event.aggregateId;
        } else if (aggregateId !== event.aggregateId) {
            throw new Error('事件 aggregateId 必须一致');
        }
        if (event.seq <= previousSeq) {
            throw new Error('seq 必须严格递增');
        }
        previousSeq = event.seq;
        if (event.seq > normalizedCursor) {
            result.push(event);
        }
    }
    return result;
}

function emptyProjection(aggregateId = '') {
    return {
        aggregateId,
        status: 'idle',
        lastSeq: 0,
        childSessions: []
    };
}

// 单条事件对投影的影响只取决于"这条事件本身 + 上一次的投影结果"，不依赖更早
// 的历史（status 各分支互相覆盖，取的始终是最后一条命中事件的值；childSessions
// 按 id 增量合并）。这个性质让 FileEventStore.append() 可以在内存里增量维护
// 投影，不必每次追加事件都重新扫一遍该聚合的全部历史事件。
function applyEventToProjection(projection, event) {
    const next = {
        aggregateId: event.aggregateId,
        status: projection.status,
        lastSeq: event.seq,
        childSessions: projection.childSessions.map(child => ({ ...child }))
    };

    if (event.type === 'session.created') next.status = 'starting';
    if (event.type === 'session.ready' || event.type === 'process.started' || event.type === 'agent.turn.started') next.status = 'running';
    if (event.type === 'session.stopping') next.status = 'stopping';
    if (event.type === 'session.stopped' || event.type === 'process.interrupted') next.status = 'interrupted';
    if (event.type === 'session.failed' || event.type === 'agent.turn.failed') next.status = 'failed';
    if (event.type === 'process.exited') {
        next.status = Number(event.data.exitCode) === 0 ? 'completed' : 'failed';
    }
    if (event.type.startsWith('agent.child.')) {
        const childSessionId = String(event.data.childSessionId || '').trim();
        if (childSessionId) {
            const existingIndex = next.childSessions.findIndex(child => child.id === childSessionId);
            const current = existingIndex >= 0
                ? next.childSessions[existingIndex]
                : { id: childSessionId, agentProgram: '', status: 'observed' };
            if (event.data.agentProgram) {
                current.agentProgram = String(event.data.agentProgram);
            }
            if (event.type === 'agent.child.completed') current.status = 'completed';
            if (event.type === 'agent.child.failed') current.status = 'failed';
            if (event.type === 'agent.child.interrupted') current.status = 'interrupted';
            if (existingIndex >= 0) {
                next.childSessions[existingIndex] = current;
            } else {
                next.childSessions.push(current);
            }
        }
    }
    return next;
}

function projectSessionEvents(events) {
    const orderedEvents = selectEventsAfterCursor(events, 0);
    return orderedEvents.reduce(
        applyEventToProjection,
        emptyProjection(orderedEvents.length ? orderedEvents[0].aggregateId : '')
    );
}

module.exports = {
    EVENT_VERSION,
    EVENT_TYPES,
    createControlEvent,
    validateControlEvent,
    selectEventsAfterCursor,
    emptyProjection,
    applyEventToProjection,
    projectSessionEvents
};
