'use strict';

const { spawn } = require('child_process');

function createTextBuffer(maxChars) {
    let value = '';
    let truncated = false;
    return {
        append(chunk) {
            if (!chunk) {
                return;
            }
            const text = chunk.toString('utf-8');
            if (!text) {
                return;
            }
            if (value.length >= maxChars) {
                truncated = true;
                return;
            }
            const remain = maxChars - value.length;
            if (text.length > remain) {
                value += text.slice(0, remain);
                truncated = true;
                return;
            }
            value += text;
        },
        buildOutput(suffix) {
            return truncated ? `${value}\n...${suffix}` : value;
        }
    };
}

function drainLines(text, carry, handleLine) {
    let pending = carry + String(text || '');
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
        handleLine(line);
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf('\n');
    }
    return pending;
}

function createWebContainerExecHelpers(options = {}) {
    const buildWebSessionKey = options.buildWebSessionKey || (() => '');
    const defaultAgentId = options.defaultAgentId || 'default';
    const extractAgentMessageFromStructuredOutput = options.extractAgentMessageFromStructuredOutput || (() => '');
    const parseJsonObjectLine = options.parseJsonObjectLine || (() => null);
    const prepareStructuredTraceEvents = options.prepareStructuredTraceEvents || (() => []);
    const extractContentDeltaFromPayload = options.extractContentDeltaFromPayload || (() => null);
    const structuredTraceDeps = options.structuredTraceDeps || {};
    const clipText = options.clipText || (text => String(text || ''));
    const stripAnsi = options.stripAnsi || (text => String(text || ''));
    const maxRawOutputChars = Number.isInteger(options.maxRawOutputChars) ? options.maxRawOutputChars : 32 * 1024 * 1024;

    function buildFinalOutput(agentProgram, stdoutBuffer, stderrBuffer) {
        const clippedStdout = stdoutBuffer.buildOutput('[stdout-truncated]');
        const clippedStderr = stderrBuffer.buildOutput('[stderr-truncated]');
        const clippedRaw = `${clippedStdout}${clippedStdout && clippedStderr ? '\n' : ''}${clippedStderr}`;
        const extractedAgentMessage = extractAgentMessageFromStructuredOutput(agentProgram, clippedStdout);
        const cleanOutputSource = extractedAgentMessage || clippedRaw;
        return clipText(stripAnsi(cleanOutputSource).trim() || '(无输出)');
    }

    return {
        async execCommandInWebContainer(ctx, containerName, command, options = {}) {
            const opts = options && typeof options === 'object' ? options : {};
            const agentProgram = typeof opts.agentProgram === 'string' ? opts.agentProgram : '';
            return await new Promise((resolve, reject) => {
                const process = spawn(
                    ctx.dockerCmd,
                    ['exec', containerName, '/bin/bash', '-lc', command],
                    { stdio: ['ignore', 'pipe', 'pipe'] }
                );

                const stdoutBuffer = createTextBuffer(maxRawOutputChars);
                const stderrBuffer = createTextBuffer(maxRawOutputChars);

                process.stdout.on('data', chunk => stdoutBuffer.append(chunk));
                process.stderr.on('data', chunk => stderrBuffer.append(chunk));

                process.on('error', reject);
                process.on('close', code => {
                    const exitCode = typeof code === 'number' ? code : 1;
                    resolve({
                        exitCode,
                        output: buildFinalOutput(agentProgram, stdoutBuffer, stderrBuffer)
                    });
                });
            });
        },
        async execAgentInWebContainerStream(ctx, state, sessionRefOrContainerName, command, options = {}) {
            const opts = options && typeof options === 'object' ? options : {};
            const sessionRef = typeof sessionRefOrContainerName === 'string'
                ? { containerName: sessionRefOrContainerName, agentId: defaultAgentId }
                : sessionRefOrContainerName;
            const sessionKey = buildWebSessionKey(sessionRef.containerName, sessionRef.agentId);
            const agentProgram = typeof opts.agentProgram === 'string' ? opts.agentProgram : '';
            const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
            const process = spawn(
                ctx.dockerCmd,
                ['exec', sessionRef.containerName, '/bin/bash', '-lc', command],
                { stdio: ['ignore', 'pipe', 'pipe'] }
            );

            const runState = {
                containerName: sessionRef.containerName,
                sessionKey,
                process,
                command,
                startedAt: new Date().toISOString(),
                stopping: false
            };
            state.agentRuns.set(sessionRef.containerName, runState);

            return await new Promise((resolve, reject) => {
                const stdoutBuffer = createTextBuffer(maxRawOutputChars);
                const stderrBuffer = createTextBuffer(maxRawOutputChars);
                let stdoutPending = '';
                let stderrPending = '';
                const structuredTraceState = {
                    toolNamesById: new Map()
                };
                let contentDeltaAccumulator = '';

                function emitStdoutTraceLine(line) {
                    const rawLine = String(line || '').trim();
                    if (!rawLine) {
                        return;
                    }
                    if (agentProgram === 'claude' || agentProgram === 'gemini' || agentProgram === 'codex' || agentProgram === 'opencode') {
                        const payload = parseJsonObjectLine(rawLine);
                        if (payload) {
                            const traceEvents = prepareStructuredTraceEvents(agentProgram, payload, structuredTraceState, structuredTraceDeps);
                            traceEvents.forEach(traceEvent => {
                                if (!traceEvent || !traceEvent.text) {
                                    return;
                                }
                                onEvent({
                                    type: 'trace',
                                    stream: 'stdout',
                                    text: traceEvent.text,
                                    traceEvent
                                });
                            });
                            const deltaContent = extractContentDeltaFromPayload(agentProgram, payload, structuredTraceDeps);
                            if (deltaContent !== null) {
                                if (deltaContent.reset) {
                                    contentDeltaAccumulator = deltaContent.text;
                                } else {
                                    contentDeltaAccumulator += deltaContent.text;
                                }
                                onEvent({
                                    type: 'content_delta',
                                    content: contentDeltaAccumulator
                                });
                            }
                            return;
                        }
                        if (agentProgram === 'codex' && (/^OpenAI Codex\b/.test(rawLine) || /^tokens used\b/i.test(rawLine))) {
                            return;
                        }
                    }
                    onEvent({ type: 'trace', stream: 'stdout', text: rawLine });
                }

                function emitStderrTraceLine(line) {
                    const rawLine = String(line || '').trim();
                    if (!rawLine) {
                        return;
                    }
                    onEvent({ type: 'trace', stream: 'stderr', text: `[stderr] ${rawLine}` });
                }

                process.stdout.on('data', chunk => {
                    stdoutBuffer.append(chunk);
                    stdoutPending = drainLines(chunk.toString('utf-8'), stdoutPending, emitStdoutTraceLine);
                });
                process.stderr.on('data', chunk => {
                    stderrBuffer.append(chunk);
                    stderrPending = drainLines(chunk.toString('utf-8'), stderrPending, emitStderrTraceLine);
                });

                process.on('error', error => {
                    state.agentRuns.delete(sessionRef.containerName);
                    reject(error);
                });
                process.on('close', code => {
                    state.agentRuns.delete(sessionRef.containerName);
                    if (stdoutPending) {
                        emitStdoutTraceLine(stdoutPending);
                        stdoutPending = '';
                    }
                    if (stderrPending) {
                        emitStderrTraceLine(stderrPending);
                        stderrPending = '';
                    }
                    const exitCode = typeof code === 'number' ? code : 1;
                    resolve({
                        exitCode,
                        output: buildFinalOutput(agentProgram, stdoutBuffer, stderrBuffer),
                        interrupted: exitCode !== 0 && runState.stopping === true
                    });
                });
            });
        }
    };
}

module.exports = {
    createWebContainerExecHelpers
};
