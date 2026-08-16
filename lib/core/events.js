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

function projectSessionEvents(events) {
    const orderedEvents = selectEventsAfterCursor(events, 0);
    const projection = {
        aggregateId: orderedEvents.length ? orderedEvents[0].aggregateId : '',
        status: 'idle',
        lastSeq: orderedEvents.length ? orderedEvents[orderedEvents.length - 1].seq : 0,
        childSessions: []
    };
    const childSessions = new Map();

    for (const event of orderedEvents) {
        if (event.type === 'session.created') projection.status = 'starting';
        if (event.type === 'session.ready' || event.type === 'process.started' || event.type === 'agent.turn.started') projection.status = 'running';
        if (event.type === 'session.stopping') projection.status = 'stopping';
        if (event.type === 'session.stopped' || event.type === 'process.interrupted') projection.status = 'interrupted';
        if (event.type === 'session.failed' || event.type === 'agent.turn.failed') projection.status = 'failed';
        if (event.type === 'process.exited') {
            projection.status = Number(event.data.exitCode) === 0 ? 'completed' : 'failed';
        }
        if (event.type.startsWith('agent.child.')) {
            const childSessionId = String(event.data.childSessionId || '').trim();
            if (!childSessionId) {
                continue;
            }
            const current = childSessions.get(childSessionId) || { id: childSessionId, agentProgram: '', status: 'observed' };
            if (event.data.agentProgram) {
                current.agentProgram = String(event.data.agentProgram);
            }
            if (event.type === 'agent.child.completed') current.status = 'completed';
            if (event.type === 'agent.child.failed') current.status = 'failed';
            if (event.type === 'agent.child.interrupted') current.status = 'interrupted';
            childSessions.set(childSessionId, current);
        }
    }
    projection.childSessions = Array.from(childSessions.values());
    return projection;
}

module.exports = {
    EVENT_VERSION,
    EVENT_TYPES,
    createControlEvent,
    validateControlEvent,
    selectEventsAfterCursor,
    projectSessionEvents
};
