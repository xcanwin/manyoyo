'use strict';

const {
    createControlEvent,
    validateControlEvent,
    selectEventsAfterCursor,
    projectSessionEvents
} = require('../lib/core/events');

describe('ControlEvent contract', () => {
    test('creates a versioned event with an aggregate sequence', () => {
        const event = createControlEvent({
            type: 'session.ready',
            aggregateId: 'demo',
            seq: 2,
            timestamp: '2026-08-16T00:00:00.000Z',
            data: { containerName: 'demo' }
        });

        expect(event).toEqual(expect.objectContaining({
            type: 'session.ready',
            version: 1,
            aggregateId: 'demo',
            sessionId: 'demo',
            seq: 2,
            timestamp: '2026-08-16T00:00:00.000Z'
        }));
        expect(event.id).toEqual(expect.any(String));
        expect(validateControlEvent(event)).toEqual(event);
    });

    test('rejects unknown event types and invalid sequence numbers', () => {
        expect(() => createControlEvent({ type: 'unknown.event', aggregateId: 'demo', seq: 1 }))
            .toThrow('未知事件类型');
        expect(() => createControlEvent({ type: 'session.ready', version: 2, aggregateId: 'demo', seq: 1 }))
            .toThrow('不支持的事件版本');
        expect(() => createControlEvent({ type: 'session.ready', aggregateId: 'demo', seq: 0 }))
            .toThrow('seq 必须为正整数');
    });

    test('returns only events after a cursor and rejects duplicate or unordered sequences', () => {
        const events = [1, 2, 3].map(seq => createControlEvent({
            type: 'process.stdout',
            aggregateId: 'demo',
            seq,
            data: { text: String(seq) }
        }));

        expect(selectEventsAfterCursor(events, 1).map(event => event.seq)).toEqual([2, 3]);
        expect(() => selectEventsAfterCursor([events[1], events[0]], 0)).toThrow('seq 必须严格递增');
        expect(() => selectEventsAfterCursor([events[0], events[0]], 0)).toThrow('seq 必须严格递增');
    });

    test('projects mutually exclusive completed, interrupted and failed states', () => {
        const events = [
            createControlEvent({ type: 'session.created', aggregateId: 'demo', seq: 1 }),
            createControlEvent({ type: 'process.started', aggregateId: 'demo', seq: 2 }),
            createControlEvent({ type: 'process.interrupted', aggregateId: 'demo', seq: 3 })
        ];

        expect(projectSessionEvents(events)).toEqual(expect.objectContaining({
            aggregateId: 'demo',
            status: 'interrupted',
            lastSeq: 3
        }));
    });

    test('projects third-party child session observations without changing parent lifecycle', () => {
        const events = [
            createControlEvent({ type: 'agent.turn.started', aggregateId: 'parent', seq: 1 }),
            createControlEvent({
                type: 'agent.child.observed',
                aggregateId: 'parent',
                seq: 2,
                data: { childSessionId: 'child-1', agentProgram: 'claude' }
            }),
            createControlEvent({
                type: 'agent.child.completed',
                aggregateId: 'parent',
                seq: 3,
                data: { childSessionId: 'child-1' }
            })
        ];

        expect(projectSessionEvents(events)).toEqual(expect.objectContaining({
            status: 'running',
            childSessions: [{ id: 'child-1', agentProgram: 'claude', status: 'completed' }]
        }));
    });
});
