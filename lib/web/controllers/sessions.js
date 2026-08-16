'use strict';

async function handleSessionEventsRequest(req, res, ctx, state, sessionName, dependencies) {
    const sessionRef = dependencies.getValidSessionRef(ctx, res, sessionName);
    if (!sessionRef) {
        return;
    }
    const requestUrl = new URL(req.url || '/api/sessions/x/events', 'http://localhost');
    const cursor = requestUrl.searchParams.get('cursor') || '0';
    const history = dependencies.loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
    const agentSession = dependencies.getWebAgentSession(history, sessionRef.agentId)
        || dependencies.createEmptyWebAgentSession(sessionRef.agentId);
    const controlEvents = dependencies.loadWebSessionControlEvents(state.webHistoryDir, sessionRef, agentSession.events);
    try {
        const events = dependencies.selectEventsAfterCursor(controlEvents, cursor);
        const requestedCursor = Number(cursor || 0);
        const deliveredCursor = events.reduce((latest, event) => (
            Number.isInteger(event && event.seq) && event.seq > latest ? event.seq : latest
        ), requestedCursor);
        dependencies.sendJson(res, 200, {
            name: dependencies.buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
            events,
            cursor: deliveredCursor
        });
    } catch (error) {
        dependencies.sendJson(res, 400, { error: error.message || 'cursor 无效' });
    }
}

async function handleSessionAuditRequest(req, res, ctx, state, sessionName, dependencies) {
    const sessionRef = dependencies.getValidSessionRef(ctx, res, sessionName);
    if (!sessionRef) {
        return;
    }
    dependencies.sendJson(res, 200, {
        name: dependencies.buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
        audit: dependencies.buildSessionAudit(ctx, state, sessionRef)
    });
}

async function handleSessionMessagesRequest(res, ctx, state, sessionName, dependencies) {
    const sessionRef = dependencies.getValidSessionRef(ctx, res, sessionName);
    if (!sessionRef) return;
    const history = dependencies.loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
    const agentSession = dependencies.getWebAgentSession(history, sessionRef.agentId)
        || dependencies.createEmptyWebAgentSession(sessionRef.agentId);
    dependencies.sendJson(res, 200, { name: dependencies.buildWebSessionKey(sessionRef.containerName, sessionRef.agentId), containerName: sessionRef.containerName, agentId: sessionRef.agentId, messages: agentSession.messages });
}

async function handleSessionDetailRequest(res, ctx, state, sessionName, dependencies) {
    const sessionRef = dependencies.getValidSessionRef(ctx, res, sessionName);
    if (!sessionRef) return;
    const detail = dependencies.buildSessionDetail(ctx, state, dependencies.listWebManyoyoContainers(ctx), sessionRef);
    dependencies.sendJson(res, 200, { name: dependencies.buildWebSessionKey(sessionRef.containerName, sessionRef.agentId), detail });
}

async function handleSessionCreateRequest(req, res, ctx, state, dependencies) {
    const payload = await dependencies.readJsonBody(req);
    let runtime = null;
    try {
        runtime = dependencies.buildCreateRuntime(ctx, state, payload);
    } catch (error) {
        dependencies.sendJson(res, 400, { error: error.message || '创建参数错误' });
        return;
    }

    await dependencies.ensureWebContainer(ctx, state, runtime);
    dependencies.setWebSessionAgentPromptCommand(state.webHistoryDir, runtime.containerName, runtime.agentPromptCommand);
    dependencies.patchWebSessionHistory(state.webHistoryDir, runtime.containerName, { applied: runtime.applied });
    dependencies.sendJson(res, 200, { name: runtime.containerName, applied: runtime.applied });
}

async function handleSessionsListRequest(req, res, ctx, state, dependencies) {
    const containerMap = dependencies.listWebManyoyoContainers(ctx);
    const names = new Set([
        ...Object.keys(containerMap),
        ...dependencies.listWebHistorySessionNames(state.webHistoryDir, ctx.isValidContainerName)
    ]);
    const sessions = Array.from(names)
        .flatMap(name => {
            const history = dependencies.loadWebSessionHistory(state.webHistoryDir, name);
            return dependencies.listWebAgentSessions(history, { includeSyntheticDefault: true })
                .map(agentSession => dependencies.buildSessionSummary(ctx, state, containerMap, {
                    containerName: name,
                    agentId: agentSession.agentId
                }))
                .filter(Boolean);
        })
        .sort(dependencies.compareWebSessionCreatedDesc);
    dependencies.sendJson(res, 200, { sessions });
}

async function handleSessionAgentCreateRequest(res, ctx, state, sessionName, dependencies) {
    const sessionRef = dependencies.getValidSessionRef(ctx, res, sessionName);
    if (!sessionRef) return;
    const history = dependencies.loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
    const agentSession = dependencies.createWebAgentSession(history);
    dependencies.saveWebSessionHistory(state.webHistoryDir, sessionRef.containerName, history);
    dependencies.sendJson(res, 200, {
        name: dependencies.buildWebSessionKey(sessionRef.containerName, agentSession.agentId),
        containerName: sessionRef.containerName,
        agentId: agentSession.agentId,
        agentName: agentSession.agentName
    });
}

async function handleSessionAgentStopRequest(req, res, ctx, state, sessionName, dependencies) {
    const sessionRef = dependencies.getValidSessionRef(ctx, res, sessionName);
    if (!sessionRef) return;
    const stopped = dependencies.stopWebAgentRun(state, sessionRef.containerName);
    if (!stopped) {
        dependencies.sendJson(res, 404, { error: '当前会话没有运行中的 agent 任务' });
        return;
    }
    dependencies.appendWebSessionControlEvent(state.webHistoryDir, sessionRef, 'session.stopping');
    dependencies.sendJson(res, 200, { ok: true, stopping: true });
}

async function handleSessionAgentTemplateRequest(req, res, ctx, state, sessionName, dependencies) {
    const sessionRef = dependencies.getValidSessionRef(ctx, res, sessionName);
    if (!sessionRef) return;
    let payload = null;
    try {
        payload = await dependencies.readJsonBody(req);
    } catch (error) {
        dependencies.sendJson(res, 400, { error: error.message || '请求参数错误' });
        return;
    }
    const normalizedPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const hasContainerTemplate = dependencies.hasOwn(normalizedPayload, 'containerAgentPromptCommand');
    const hasAgentOverride = dependencies.hasOwn(normalizedPayload, 'agentPromptCommandOverride');
    if (!hasContainerTemplate && !hasAgentOverride) {
        dependencies.sendJson(res, 400, { error: '至少提供一个模板字段' });
        return;
    }
    if (hasAgentOverride && sessionRef.agentId === dependencies.defaultAgentId) {
        dependencies.sendJson(res, 400, { error: '默认 AGENT 不支持单独覆盖模板，请直接修改容器模板' });
        return;
    }
    try {
        if (hasContainerTemplate) {
            dependencies.setWebSessionAgentPromptCommand(
                state.webHistoryDir,
                sessionRef.containerName,
                normalizedPayload.containerAgentPromptCommand
            );
        }
        if (hasAgentOverride) {
            dependencies.setWebAgentSessionPromptCommand(
                state.webHistoryDir,
                sessionRef,
                normalizedPayload.agentPromptCommandOverride
            );
        }
    } catch (error) {
        dependencies.sendJson(res, 400, { error: error.message || '保存 Agent 模板失败' });
        return;
    }
    const detail = dependencies.buildSessionDetail(
        ctx,
        state,
        dependencies.listWebManyoyoContainers(ctx),
        sessionRef
    );
    dependencies.sendJson(res, 200, {
        saved: true,
        name: dependencies.buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
        detail
    });
}

async function handleSessionRunRequest(req, res, ctx, state, sessionName, dependencies) {
    const sessionRef = dependencies.getValidSessionRef(ctx, res, sessionName);
    if (!sessionRef) return;
    const payload = await dependencies.readJsonBody(req);
    const command = String(payload && payload.command || '').trim();
    if (!command) {
        dependencies.sendJson(res, 400, { error: 'command 不能为空' });
        return;
    }
    await dependencies.ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
    dependencies.appendWebSessionMessage(state.webHistoryDir, sessionRef, 'user', command);
    const result = await dependencies.execCommandInWebContainer(ctx, sessionRef.containerName, command);
    dependencies.appendWebSessionMessage(
        state.webHistoryDir,
        sessionRef,
        'assistant',
        result.output,
        { exitCode: result.exitCode }
    );
    dependencies.sendJson(res, 200, { exitCode: result.exitCode, output: result.output });
}

async function handleSessionAgentRequest(req, res, ctx, state, sessionName, dependencies) {
    const sessionRef = dependencies.getValidSessionRef(ctx, res, sessionName);
    if (!sessionRef) return;
    const payload = await dependencies.readJsonBody(req);
    const prompt = String(payload && payload.prompt || '').trim();
    if (!prompt) {
        dependencies.sendJson(res, 400, { error: 'prompt 不能为空' });
        return;
    }
    let prepared = null;
    try {
        prepared = await dependencies.prepareWebAgentExecution(ctx, state, sessionRef, prompt);
    } catch (error) {
        dependencies.sendJson(res, 400, { error: error && error.message ? error.message : 'Agent 执行准备失败' });
        return;
    }
    const { agentSession, agentMeta, command, contextMode, resumeAttempted, resumeSucceeded, resumeError, engineSessionId } = prepared;
    dependencies.appendWebSessionMessage(state.webHistoryDir, sessionRef, 'user', prompt, {
        mode: 'agent',
        contextMode
    });
    const result = await dependencies.execCommandInWebContainer(ctx, sessionRef.containerName, command, {
        agentProgram: agentMeta.agentProgram
    });
    dependencies.finalizeWebAgentExecution(state, sessionRef, agentSession, agentMeta, {
        contextMode,
        resumeAttempted,
        resumeSucceeded,
        resumeError,
        engineSessionId
    }, result);
    dependencies.sendJson(res, 200, {
        exitCode: result.exitCode,
        output: result.output,
        contextMode,
        resumeAttempted,
        resumeSucceeded,
        interrupted: result.interrupted === true
    });
}

async function handleSessionAgentStreamRequest(req, res, ctx, state, sessionName, dependencies) {
    const sessionRef = dependencies.getValidSessionRef(ctx, res, sessionName);
    if (!sessionRef) return;
    const payload = await dependencies.readJsonBody(req);
    const prompt = String(payload && payload.prompt || '').trim();
    if (!prompt) {
        dependencies.sendJson(res, 400, { error: 'prompt 不能为空' });
        return;
    }
    if (state.agentRuns.has(sessionRef.containerName)) {
        dependencies.sendJson(res, 409, { error: '当前会话已有运行中的 agent 任务' });
        return;
    }
    const userMessage = dependencies.appendWebSessionMessage(state.webHistoryDir, sessionRef, 'user', prompt, {
        mode: 'agent', pending: true
    });
    const traceMessage = dependencies.appendWebAgentTraceMessage(
        state.webHistoryDir, sessionRef, '[执行过程]\n等待 Agent 启动…', { traceEvents: [], pending: true }
    );
    let prepared = null;
    try {
        prepared = await dependencies.prepareWebAgentExecution(ctx, state, sessionRef, prompt);
    } catch (error) {
        dependencies.removeWebSessionMessage(state.webHistoryDir, sessionRef, traceMessage && traceMessage.id);
        dependencies.removeWebSessionMessage(state.webHistoryDir, sessionRef, userMessage && userMessage.id);
        dependencies.sendJson(res, 400, { error: error && error.message ? error.message : 'Agent 执行准备失败' });
        return;
    }
    const { agentSession, agentMeta, command, contextMode, resumeAttempted, resumeSucceeded, resumeError, engineSessionId } = prepared;
    const traceLines = ['[执行过程]'];
    const traceEvents = [];
    let streamingReplyMessageId = '';
    dependencies.patchWebSessionMessage(state.webHistoryDir, sessionRef, userMessage && userMessage.id, {
        pending: true, contextMode
    });
    res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
    });
    const emitStreamEvent = dependencies.createWebStreamEmitter(res, state.webHistoryDir, sessionRef);
    emitStreamEvent({
        type: 'meta', containerName: sessionRef.containerName,
        sessionName: dependencies.buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
        contextMode, resumeAttempted, resumeSucceeded, agentProgram: agentMeta.agentProgram
    }, 'session.ready', { agentProgram: agentMeta.agentProgram });
    if (contextMode) traceLines.push(`上下文模式: ${contextMode}`);
    if (resumeAttempted) traceLines.push(resumeSucceeded ? '会话恢复成功' : '会话恢复失败，已回退到历史注入');
    dependencies.patchWebSessionMessage(state.webHistoryDir, sessionRef, traceMessage && traceMessage.id, {
        content: traceLines.join('\n'), traceEvents: traceEvents.slice(), contextMode, resumeAttempted, resumeSucceeded, pending: true
    });
    try {
        const result = await dependencies.execAgentInWebContainerStream(ctx, state, sessionRef, command, {
            agentProgram: agentMeta.agentProgram,
            onEvent: event => {
                if (event && event.type === 'trace' && event.text) {
                    traceLines.push(String(event.text));
                    if (event.traceEvent && typeof event.traceEvent === 'object') traceEvents.push(event.traceEvent);
                    dependencies.patchWebSessionMessage(state.webHistoryDir, sessionRef, traceMessage && traceMessage.id, {
                        content: traceLines.join('\n'), traceEvents: traceEvents.slice(), pending: true
                    });
                }
                if (event && event.type === 'content_delta' && typeof event.content === 'string') {
                    if (!streamingReplyMessageId) {
                        const reply = dependencies.appendWebSessionMessage(state.webHistoryDir, sessionRef, 'assistant', event.content, {
                            mode: 'agent', streamingReply: true, pending: true
                        });
                        streamingReplyMessageId = reply && reply.id ? reply.id : '';
                    } else {
                        dependencies.patchWebSessionMessage(state.webHistoryDir, sessionRef, streamingReplyMessageId, {
                            content: event.content, pending: true
                        });
                    }
                }
                emitStreamEvent(event, dependencies.resolveWebStreamControlEventType(event), {
                    transportType: event && event.type ? event.type : '',
                    text: event && (event.text || event.content) ? String(event.text || event.content) : ''
                });
            }
        });
        traceLines.push(result.interrupted === true ? '[任务] 已停止' : '[任务] 已完成');
        dependencies.patchWebSessionMessage(state.webHistoryDir, sessionRef, userMessage && userMessage.id, {
            pending: false, contextMode, resumeAttempted, resumeSucceeded
        });
        dependencies.patchWebSessionMessage(state.webHistoryDir, sessionRef, traceMessage && traceMessage.id, {
            content: traceLines.join('\n'), traceEvents, contextMode, resumeAttempted, resumeSucceeded,
            interrupted: result.interrupted === true, pending: false
        });
        if (streamingReplyMessageId) dependencies.removeWebSessionMessage(state.webHistoryDir, sessionRef, streamingReplyMessageId);
        dependencies.finalizeWebAgentExecution(state, sessionRef, agentSession, agentMeta, {
            contextMode, resumeAttempted, resumeSucceeded, resumeError, engineSessionId
        }, result);
        emitStreamEvent({
            type: 'result', exitCode: result.exitCode, output: result.output, contextMode,
            resumeAttempted, resumeSucceeded, interrupted: result.interrupted === true
        }, result.interrupted === true ? 'process.interrupted' : 'process.exited', { exitCode: result.exitCode });
    } catch (error) {
        const message = error && error.message ? error.message : 'Agent 执行失败';
        traceLines.push(`[错误] ${message}`);
        dependencies.patchWebSessionMessage(state.webHistoryDir, sessionRef, userMessage && userMessage.id, {
            pending: false, contextMode, resumeAttempted, resumeSucceeded
        });
        dependencies.patchWebSessionMessage(state.webHistoryDir, sessionRef, traceMessage && traceMessage.id, {
            content: traceLines.join('\n'), traceEvents, contextMode, resumeAttempted, resumeSucceeded, interrupted: true, pending: false
        });
        if (streamingReplyMessageId) dependencies.removeWebSessionMessage(state.webHistoryDir, sessionRef, streamingReplyMessageId);
        emitStreamEvent({ type: 'error', error: message }, 'agent.turn.failed', { error: message });
    } finally {
        res.end();
    }
}

module.exports = {
    handleSessionAuditRequest,
    handleSessionEventsRequest,
    handleSessionMessagesRequest,
    handleSessionDetailRequest,
    handleSessionsListRequest,
    handleSessionCreateRequest,
    handleSessionAgentCreateRequest,
    handleSessionAgentStopRequest,
    handleSessionAgentTemplateRequest,
    handleSessionRunRequest,
    handleSessionAgentRequest,
    handleSessionAgentStreamRequest
};
