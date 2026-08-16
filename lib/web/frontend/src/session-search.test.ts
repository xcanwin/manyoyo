import { describe, expect, test } from 'vitest';
import { filterSessions } from './session-search';

describe('session search', () => {
    test('matches container and Agent labels without changing source data', () => {
        const sessions = [
            { name: 'alpha~agent-1', containerName: 'alpha', agentName: 'AGENT 1' },
            { name: 'beta~agent-2', containerName: 'beta', agentName: 'Review Bot' }
        ];

        expect(filterSessions(sessions, 'review')).toEqual([sessions[1]]);
        expect(filterSessions(sessions, 'alpha')).toEqual([sessions[0]]);
        expect(filterSessions(sessions, '  ')).toEqual(sessions);
    });
});
