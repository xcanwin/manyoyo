'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { __testing } = require('../lib/web/server');

const { finalizeWebAgentExecution, loadWebSessionHistory, saveWebSessionHistory, patchWebAgentSessionState } = __testing;

const ORIGINAL = '0d6c1f6a-1111-4a2b-9c3d-123456789abc';
const FORKED = 'f0f0f0f0-2222-4a2b-9c3d-123456789abc';
const AT = '11111111-2222-4333-8444-555555555555';

function claudeOutput(sessionId) {
    return [
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', result: '好', session_id: sessionId }
    ].map(item => JSON.stringify(item)).join('\n');
}

describe('分叉的收尾（finalizeWebAgentExecution）', () => {
    let dir;
    const ref = { containerName: 'box', agentId: 'agent-2' };
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-finalize-'));
        const history = loadWebSessionHistory(dir, 'box');
        saveWebSessionHistory(dir, 'box', history);
        patchWebAgentSessionState(dir, ref, { engineSessionId: ORIGINAL, forkPending: true, rewindToUuid: AT });
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const read = () => loadWebSessionHistory(dir, 'box').agents['agent-2'];
    const run = (stdout, exitCode, engineSessionId) => {
        const agentSession = read();
        finalizeWebAgentExecution({ webHistoryDir: dir }, ref, agentSession, { agentProgram: 'claude' }, { contextMode: 'resume', resumeAttempted: true, resumeSucceeded: true, resumeError: '', engineSessionId }, { exitCode, output: '好', stdout });
    };

    test('拿到新会话 id：记下新 id，清掉 forkPending 和回退位置', () => {
        run(claudeOutput(FORKED), 0, ORIGINAL);
        expect(read()).toMatchObject({ engineSessionId: FORKED, forkPending: false, rewindToUuid: '' });
    });

    test('没拿到新 id（命令失败）：保留 forkPending 和回退位置，下一轮仍是分叉，不会退化成续接原会话', () => {
        run('', 1, ORIGINAL);
        expect(read()).toMatchObject({ engineSessionId: ORIGINAL, forkPending: true, rewindToUuid: AT });
    });

    test('init 之后命令才失败（输出里有新 id 但退出码非 0）：不算分叉完成，保留，下一轮重新从原会话分叉', () => {
        run(claudeOutput(FORKED), 1, ORIGINAL);
        expect(read()).toMatchObject({ forkPending: true, rewindToUuid: AT });
    });

    test('输出里的 id 还是原会话（没有真的分叉）：同样保留', () => {
        run(claudeOutput(ORIGINAL), 0, ORIGINAL);
        expect(read()).toMatchObject({ engineSessionId: ORIGINAL, forkPending: true, rewindToUuid: AT });
    });

    test('普通 AGENT（没有 forkPending）：回退位置照旧每轮清掉', () => {
        patchWebAgentSessionState(dir, ref, { forkPending: false });
        run(claudeOutput(ORIGINAL), 0, ORIGINAL);
        expect(read()).toMatchObject({ engineSessionId: ORIGINAL, forkPending: false, rewindToUuid: '' });
    });
});

describe('提前记下引擎会话 id（extractEarlyEngineSessionId）', () => {
    const { extractEarlyEngineSessionId } = __testing;
    test('claude 的 init、codex 的 thread.started 才算；别的事件、别的 Agent、非法 id 都不算', () => {
        expect(extractEarlyEngineSessionId('claude', { type: 'system', subtype: 'init', session_id: ORIGINAL })).toBe(ORIGINAL);
        expect(extractEarlyEngineSessionId('codex', { type: 'thread.started', thread_id: '01a173d2-aed8-76e2-90a3-56f7516b7abe' })).toBe('01a173d2-aed8-76e2-90a3-56f7516b7abe');
        expect(extractEarlyEngineSessionId('claude', { type: 'result', session_id: ORIGINAL })).toBe('');
        expect(extractEarlyEngineSessionId('codex', { type: 'system', subtype: 'init', session_id: ORIGINAL })).toBe('');
        expect(extractEarlyEngineSessionId('gemini', { type: 'system', subtype: 'init', session_id: ORIGINAL })).toBe('');
        expect(extractEarlyEngineSessionId('claude', { type: 'system', subtype: 'init', session_id: 'x; rm -rf /' })).toBe('');
        expect(extractEarlyEngineSessionId('claude', null)).toBe('');
    });
});
