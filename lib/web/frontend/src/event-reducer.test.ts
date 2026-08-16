import { describe, expect, test } from 'vitest';
import { createActivityState, reduceActivityEvent } from './event-reducer';

describe('activity event reducer', () => {
    test('projects raw, delta, tool, result, error and interrupted events', () => {
        let state = createActivityState();
        state = reduceActivityEvent(state, { type: 'process.stdout', data: { text: 'raw output' } });
        state = reduceActivityEvent(state, { type: 'agent.turn.delta', data: { text: 'hello ' } });
        state = reduceActivityEvent(state, { type: 'agent.turn.delta', data: { text: 'world' } });
        state = reduceActivityEvent(state, { type: 'agent.tool.observed', data: { name: 'shell', text: 'pwd' } });
        state = reduceActivityEvent(state, { type: 'agent.child.observed', data: { childSessionId: 'child-1', agentProgram: 'claude' } });
        state = reduceActivityEvent(state, { type: 'agent.child.completed', data: { childSessionId: 'child-1' } });
        state = reduceActivityEvent(state, { type: 'agent.message.completed', data: { text: 'done' } });
        state = reduceActivityEvent(state, { type: 'process.interrupted', data: {} });

        expect(state).toMatchObject({
            status: 'interrupted',
            interrupted: true,
            finalMessage: 'done',
            output: ['raw output', 'hello world'],
            tools: [{ name: 'shell', text: 'pwd' }]
        });
        expect(state.childSessions).toEqual([{ id: 'child-1', agentProgram: 'claude', status: 'completed' }]);

        state = reduceActivityEvent(state, { type: 'agent.turn.failed', data: { error: 'boom' } });
        expect(state).toMatchObject({ status: 'failed', error: 'boom' });
    });
});
