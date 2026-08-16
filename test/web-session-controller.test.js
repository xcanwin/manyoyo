const {
    handleSessionAuditRequest,
    handleSessionEventsRequest,
    handleSessionCreateRequest,
    handleSessionAgentCreateRequest,
    handleSessionAgentStopRequest,
    handleSessionsListRequest,
    handleSessionAgentTemplateRequest,
    handleSessionRunRequest,
    handleSessionAgentRequest,
    handleSessionAgentStreamRequest
} = require('../lib/web/controllers/sessions');

describe('Web session controllers', () => {
    test('events controller validates cursor and returns the delivered event cursor', async () => {
        const sendJson = jest.fn();
        const sessionRef = { containerName: 'demo', agentId: 'agent-1' };
        await handleSessionEventsRequest(
            { url: '/api/sessions/demo~agent-1/events?cursor=2' },
            {},
            {},
            { webHistoryDir: '/tmp/history' },
            'demo~agent-1',
            {
                sendJson,
                getValidSessionRef: () => sessionRef,
                loadWebSessionHistory: () => ({ agents: {} }),
                getWebAgentSession: () => ({ events: [] }),
                createEmptyWebAgentSession: () => ({ events: [] }),
                loadWebSessionControlEvents: () => [{ seq: 3 }],
                selectEventsAfterCursor: events => events,
                buildWebSessionKey: () => 'demo~agent-1'
            }
        );

        expect(sendJson).toHaveBeenCalledWith({}, 200, {
            name: 'demo~agent-1',
            events: [{ seq: 3 }],
            cursor: 3
        });
    });

    test('audit controller returns the application audit for the validated session', async () => {
        const sendJson = jest.fn();
        await handleSessionAuditRequest({}, {}, {}, {}, 'demo~default', {
            sendJson,
            getValidSessionRef: () => ({ containerName: 'demo', agentId: 'default' }),
            buildWebSessionKey: () => 'demo~default',
            buildSessionAudit: () => ({ projection: { status: 'completed' } })
        });

        expect(sendJson).toHaveBeenCalledWith({}, 200, {
            name: 'demo~default',
            audit: { projection: { status: 'completed' } }
        });
    });

    test('create controller persists the resolved runtime after the container is ready', async () => {
        const sendJson = jest.fn();
        const runtime = { containerName: 'demo', agentPromptCommand: 'codex', applied: { containerMode: 'sock' } };
        await handleSessionCreateRequest({}, {}, { dockerCmd: 'docker' }, { webHistoryDir: '/tmp/history' }, {
            sendJson,
            readJsonBody: async () => ({ containerName: 'demo' }),
            buildCreateRuntime: () => runtime,
            ensureWebContainer: jest.fn(),
            setWebSessionAgentPromptCommand: jest.fn(),
            patchWebSessionHistory: jest.fn()
        });

        expect(sendJson).toHaveBeenCalledWith({}, 200, { name: 'demo', applied: { containerMode: 'sock' } });
    });

    test('agent stop controller validates the session and records its stopping event', async () => {
        const sendJson = jest.fn();
        const appendWebSessionControlEvent = jest.fn();
        await handleSessionAgentStopRequest({}, {}, {}, { webHistoryDir: '/tmp/history' }, 'demo~agent-1', {
            sendJson,
            getValidSessionRef: () => ({ containerName: 'demo', agentId: 'agent-1' }),
            stopWebAgentRun: () => true,
            appendWebSessionControlEvent
        });

        expect(appendWebSessionControlEvent).toHaveBeenCalledWith('/tmp/history', { containerName: 'demo', agentId: 'agent-1' }, 'session.stopping');
        expect(sendJson).toHaveBeenCalledWith({}, 200, { ok: true, stopping: true });
    });

    test('list controller combines live containers with persisted session history', async () => {
        const sendJson = jest.fn();
        await handleSessionsListRequest({}, {}, { isValidContainerName: () => true }, { webHistoryDir: '/tmp/history' }, {
            sendJson,
            listWebManyoyoContainers: () => ({ live: {} }),
            listWebHistorySessionNames: () => ['saved'],
            loadWebSessionHistory: () => ({ agents: {} }),
            listWebAgentSessions: () => [{ agentId: 'default' }],
            buildSessionSummary: (_ctx, _state, _containers, sessionRef) => ({ name: sessionRef.containerName, updatedAt: '2026-01-01T00:00:00Z' }),
            compareWebSessionCreatedDesc: () => 0
        });

        expect(sendJson).toHaveBeenCalledWith({}, 200, { sessions: [{ name: 'live', updatedAt: '2026-01-01T00:00:00Z' }, { name: 'saved', updatedAt: '2026-01-01T00:00:00Z' }] });
    });

    test('agent template controller saves an agent override and returns refreshed details', async () => {
        const sendJson = jest.fn();
        const setWebAgentSessionPromptCommand = jest.fn();
        await handleSessionAgentTemplateRequest({}, {}, {}, { webHistoryDir: '/tmp/history' }, 'demo~agent-1', {
            sendJson,
            readJsonBody: async () => ({ agentPromptCommandOverride: 'codex resume {prompt}' }),
            getValidSessionRef: () => ({ containerName: 'demo', agentId: 'agent-1' }),
            hasOwn: (value, key) => Object.prototype.hasOwnProperty.call(value, key),
            defaultAgentId: 'default',
            setWebSessionAgentPromptCommand: jest.fn(),
            setWebAgentSessionPromptCommand,
            listWebManyoyoContainers: () => ({ demo: {} }),
            buildSessionDetail: () => ({ name: 'demo~agent-1' }),
            buildWebSessionKey: () => 'demo~agent-1'
        });

        expect(setWebAgentSessionPromptCommand).toHaveBeenCalledWith('/tmp/history', { containerName: 'demo', agentId: 'agent-1' }, 'codex resume {prompt}');
        expect(sendJson).toHaveBeenCalledWith({}, 200, { saved: true, name: 'demo~agent-1', detail: { name: 'demo~agent-1' } });
    });

    test('command controller writes input and output around the injected container execution', async () => {
        const sendJson = jest.fn();
        const appendWebSessionMessage = jest.fn();
        await handleSessionRunRequest({}, {}, {}, { webHistoryDir: '/tmp/history' }, 'demo~agent-1', {
            sendJson,
            readJsonBody: async () => ({ command: 'pwd' }),
            getValidSessionRef: () => ({ containerName: 'demo', agentId: 'agent-1' }),
            ensureWebContainer: jest.fn(),
            appendWebSessionMessage,
            execCommandInWebContainer: async () => ({ exitCode: 0, output: '/workspace\n' })
        });

        expect(appendWebSessionMessage).toHaveBeenNthCalledWith(1, '/tmp/history', { containerName: 'demo', agentId: 'agent-1' }, 'user', 'pwd');
        expect(appendWebSessionMessage).toHaveBeenNthCalledWith(2, '/tmp/history', { containerName: 'demo', agentId: 'agent-1' }, 'assistant', '/workspace\n', { exitCode: 0 });
        expect(sendJson).toHaveBeenCalledWith({}, 200, { exitCode: 0, output: '/workspace\n' });
    });

    test('agent controller delegates preparation and finalization without parsing Agent commands', async () => {
        const sendJson = jest.fn();
        const appendWebSessionMessage = jest.fn();
        const finalizeWebAgentExecution = jest.fn();
        await handleSessionAgentRequest({}, {}, {}, { webHistoryDir: '/tmp/history' }, 'demo~agent-1', {
            sendJson,
            readJsonBody: async () => ({ prompt: 'inspect this' }),
            getValidSessionRef: () => ({ containerName: 'demo', agentId: 'agent-1' }),
            prepareWebAgentExecution: async () => ({ agentSession: { agentId: 'agent-1' }, agentMeta: { agentProgram: 'codex' }, command: 'codex exec', contextMode: 'resume', resumeAttempted: true, resumeSucceeded: true, resumeError: '', engineSessionId: 'session-1' }),
            appendWebSessionMessage,
            execCommandInWebContainer: async () => ({ exitCode: 0, output: 'done', interrupted: false }),
            finalizeWebAgentExecution
        });

        expect(appendWebSessionMessage).toHaveBeenCalledWith('/tmp/history', { containerName: 'demo', agentId: 'agent-1' }, 'user', 'inspect this', { mode: 'agent', contextMode: 'resume' });
        expect(finalizeWebAgentExecution).toHaveBeenCalled();
        expect(sendJson).toHaveBeenCalledWith({}, 200, expect.objectContaining({ exitCode: 0, output: 'done', contextMode: 'resume', resumeSucceeded: true }));
    });

    test('stream controller rejects a second active Agent run for the same container', async () => {
        const sendJson = jest.fn();
        await handleSessionAgentStreamRequest({}, {}, {}, { agentRuns: new Map([['demo', {}]]) }, 'demo~agent-1', {
            sendJson,
            readJsonBody: async () => ({ prompt: 'inspect this' }),
            getValidSessionRef: () => ({ containerName: 'demo', agentId: 'agent-1' })
        });

        expect(sendJson).toHaveBeenCalledWith({}, 409, { error: '当前会话已有运行中的 agent 任务' });
    });
});
