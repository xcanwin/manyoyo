'use strict';

function createWebRuntimeStateHelpers(options = {}) {
    const createMap = () => new Map();

    return {
        createInitialWebRuntimeState(baseState = {}) {
            return {
                ...baseState,
                authSessions: createMap(),
                terminalSessions: createMap(),
                agentRuns: createMap()
            };
        },
        stopWebAgentRun(state, containerName) {
            const runState = state.agentRuns.get(containerName);
            if (!runState || !runState.process || runState.process.killed) {
                return false;
            }
            runState.stopping = true;
            try {
                runState.process.kill('SIGTERM');
            } catch {
                return false;
            }
            return true;
        },
        cleanupWebRuntimeState(state) {
            for (const session of state.terminalSessions.values()) {
                const ptyProcess = session && session.ptyProcess;
                if (ptyProcess && !ptyProcess.killed) {
                    try { ptyProcess.kill('SIGTERM'); } catch {}
                }
            }
            state.terminalSessions.clear();

            for (const runState of state.agentRuns.values()) {
                const child = runState && runState.process;
                if (child && !child.killed) {
                    try { child.kill('SIGTERM'); } catch {}
                }
            }
            state.agentRuns.clear();
        }
    };
}

module.exports = {
    createWebRuntimeStateHelpers
};
