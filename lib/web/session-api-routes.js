'use strict';

function createSessionApiRoutes(deps) {
    const {
        req,
        res,
        ctx,
        state,
        WEB_DEFAULT_AGENT_ID,
        withSessionRef,
        withJsonBody,
        withSessionJsonBody,
        getRequiredBodyText,
        prepareAgentRequest,
        sendJson,
        sendNdjson,
        buildCreateRuntime,
        ensureWebContainer,
        setWebSessionAgentPromptCommand,
        patchWebSessionHistory,
        listWebManyoyoContainers,
        listWebHistorySessionNames,
        loadWebSessionHistory,
        listWebAgentSessions,
        buildSessionSummary,
        createWebAgentSession,
        saveWebSessionHistory,
        buildWebSessionKey,
        getWebAgentSession,
        createEmptyWebAgentSession,
        buildSessionDetail,
        hasOwn,
        setWebAgentSessionPromptCommand,
        appendWebSessionMessage,
        execCommandInWebContainer,
        finalizeWebAgentExecution,
        execAgentInWebContainerStream,
        appendWebAgentTraceMessage,
        stopWebAgentRun,
        removeWebSessionHistory
    } = deps;

    return [
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/sessions' ? [] : null,
            handler: async () => {
                const containerMap = listWebManyoyoContainers(ctx);
                const names = new Set([
                    ...Object.keys(containerMap),
                    ...listWebHistorySessionNames(state.webHistoryDir, ctx.isValidContainerName)
                ]);

                const sessions = Array.from(names)
                    .flatMap(name => {
                        const history = loadWebSessionHistory(state.webHistoryDir, name);
                        return listWebAgentSessions(history, { includeSyntheticDefault: true })
                            .map(agentSession => buildSessionSummary(ctx, state, containerMap, {
                                containerName: name,
                                agentId: agentSession.agentId
                            }))
                            .filter(Boolean);
                    })
                    .sort((a, b) => {
                        const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                        const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                        return timeB - timeA;
                    });

                sendJson(res, 200, { sessions });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath === '/api/sessions' ? [] : null,
            handler: withJsonBody(async payload => {
                let runtime = null;
                try {
                    runtime = buildCreateRuntime(ctx, state, payload);
                } catch (e) {
                    sendJson(res, 400, { error: e.message || '创建参数错误' });
                    return;
                }

                await ensureWebContainer(ctx, state, runtime);
                setWebSessionAgentPromptCommand(state.webHistoryDir, runtime.containerName, runtime.agentPromptCommand);
                patchWebSessionHistory(state.webHistoryDir, runtime.containerName, {
                    applied: runtime.applied
                });
                sendJson(res, 200, { name: runtime.containerName, applied: runtime.applied });
            })
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agents$/),
            handler: withSessionRef(async sessionRef => {
                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                const agentSession = createWebAgentSession(history);
                saveWebSessionHistory(state.webHistoryDir, sessionRef.containerName, history);
                sendJson(res, 200, {
                    name: buildWebSessionKey(sessionRef.containerName, agentSession.agentId),
                    containerName: sessionRef.containerName,
                    agentId: agentSession.agentId,
                    agentName: agentSession.agentName
                });
            })
        },
        {
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/messages$/),
            handler: withSessionRef(async sessionRef => {
                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                const agentSession = getWebAgentSession(history, sessionRef.agentId)
                    || createEmptyWebAgentSession(sessionRef.agentId);
                sendJson(res, 200, {
                    name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
                    containerName: sessionRef.containerName,
                    agentId: sessionRef.agentId,
                    messages: agentSession.messages
                });
            })
        },
        {
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/detail$/),
            handler: withSessionRef(async sessionRef => {
                const containerMap = listWebManyoyoContainers(ctx);
                const detail = buildSessionDetail(ctx, state, containerMap, sessionRef);
                sendJson(res, 200, { name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId), detail });
            })
        },
        {
            method: 'PUT',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agent-template$/),
            handler: withSessionJsonBody(async (sessionRef, payload) => {
                const normalizedPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
                const hasContainerTemplate = hasOwn(normalizedPayload, 'containerAgentPromptCommand');
                const hasAgentOverride = hasOwn(normalizedPayload, 'agentPromptCommandOverride');
                if (!hasContainerTemplate && !hasAgentOverride) {
                    sendJson(res, 400, { error: '至少提供一个模板字段' });
                    return;
                }
                if (hasAgentOverride && sessionRef.agentId === WEB_DEFAULT_AGENT_ID) {
                    sendJson(res, 400, { error: '默认 AGENT 不支持单独覆盖模板，请直接修改容器模板' });
                    return;
                }

                try {
                    if (hasContainerTemplate) {
                        setWebSessionAgentPromptCommand(
                            state.webHistoryDir,
                            sessionRef.containerName,
                            normalizedPayload.containerAgentPromptCommand
                        );
                    }
                    if (hasAgentOverride) {
                        setWebAgentSessionPromptCommand(
                            state.webHistoryDir,
                            sessionRef,
                            normalizedPayload.agentPromptCommandOverride
                        );
                    }
                } catch (e) {
                    sendJson(res, 400, { error: e.message || '保存 Agent 模板失败' });
                    return;
                }

                const containerMap = listWebManyoyoContainers(ctx);
                const detail = buildSessionDetail(ctx, state, containerMap, sessionRef);
                sendJson(res, 200, {
                    saved: true,
                    name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
                    detail
                });
            }, '请求参数错误')
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/run$/),
            handler: withSessionJsonBody(async (sessionRef, payload) => {
                const command = getRequiredBodyText(payload, 'command', 'command 不能为空');
                if (!command) {
                    return;
                }

                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                appendWebSessionMessage(state.webHistoryDir, sessionRef, 'user', command);
                const result = await execCommandInWebContainer(ctx, sessionRef.containerName, command);
                appendWebSessionMessage(
                    state.webHistoryDir,
                    sessionRef,
                    'assistant',
                    result.output,
                    { exitCode: result.exitCode }
                );
                sendJson(res, 200, { exitCode: result.exitCode, output: result.output });
            })
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agent$/),
            handler: withSessionJsonBody(async (sessionRef, payload) => {
                const prompt = getRequiredBodyText(payload, 'prompt', 'prompt 不能为空');
                if (!prompt) {
                    return;
                }

                const prepared = await prepareAgentRequest(sessionRef, prompt);
                if (!prepared) {
                    return;
                }

                const { agentSession, agentMeta, command, contextMode, resumeAttempted, resumeSucceeded, resumeError } = prepared;
                appendWebSessionMessage(state.webHistoryDir, sessionRef, 'user', prompt, {
                    mode: 'agent',
                    contextMode
                });
                const result = await execCommandInWebContainer(ctx, sessionRef.containerName, command, {
                    agentProgram: agentMeta.agentProgram
                });
                finalizeWebAgentExecution(state, sessionRef, agentSession, agentMeta, {
                    contextMode,
                    resumeAttempted,
                    resumeSucceeded,
                    resumeError
                }, result);
                sendJson(res, 200, {
                    exitCode: result.exitCode,
                    output: result.output,
                    contextMode,
                    resumeAttempted,
                    resumeSucceeded,
                    interrupted: result.interrupted === true
                });
            })
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agent\/stream$/),
            handler: withSessionJsonBody(async (sessionRef, payload) => {
                const prompt = getRequiredBodyText(payload, 'prompt', 'prompt 不能为空');
                if (!prompt) {
                    return;
                }
                if (state.agentRuns.has(sessionRef.containerName)) {
                    sendJson(res, 409, { error: '当前会话已有运行中的 agent 任务' });
                    return;
                }

                const prepared = await prepareAgentRequest(sessionRef, prompt);
                if (!prepared) {
                    return;
                }

                const { agentSession, agentMeta, command, contextMode, resumeAttempted, resumeSucceeded, resumeError } = prepared;
                const traceLines = ['[执行过程]'];
                const traceEvents = [];
                appendWebSessionMessage(state.webHistoryDir, sessionRef, 'user', prompt, {
                    mode: 'agent',
                    contextMode
                });

                res.writeHead(200, {
                    'Content-Type': 'application/x-ndjson; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'X-Accel-Buffering': 'no'
                });
                sendNdjson(res, {
                    type: 'meta',
                    containerName: sessionRef.containerName,
                    sessionName: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
                    contextMode,
                    resumeAttempted,
                    resumeSucceeded,
                    agentProgram: agentMeta.agentProgram
                });
                if (contextMode) {
                    traceLines.push(`上下文模式: ${contextMode}`);
                }
                if (resumeAttempted) {
                    traceLines.push(resumeSucceeded ? '会话恢复成功' : '会话恢复失败，已回退到历史注入');
                }

                try {
                    const result = await execAgentInWebContainerStream(ctx, state, sessionRef, command, {
                        agentProgram: agentMeta.agentProgram,
                        onEvent: event => {
                            if (event && event.type === 'trace' && event.text) {
                                traceLines.push(String(event.text));
                                if (event.traceEvent && typeof event.traceEvent === 'object') {
                                    traceEvents.push(event.traceEvent);
                                }
                            }
                            sendNdjson(res, event);
                        }
                    });
                    traceLines.push(result.interrupted === true ? '[任务] 已停止' : '[任务] 已完成');
                    appendWebAgentTraceMessage(state.webHistoryDir, sessionRef, traceLines.join('\n'), {
                        traceEvents,
                        contextMode,
                        resumeAttempted,
                        resumeSucceeded,
                        interrupted: result.interrupted === true
                    });
                    finalizeWebAgentExecution(state, sessionRef, agentSession, agentMeta, {
                        contextMode,
                        resumeAttempted,
                        resumeSucceeded,
                        resumeError
                    }, result);
                    sendNdjson(res, {
                        type: 'result',
                        exitCode: result.exitCode,
                        output: result.output,
                        contextMode,
                        resumeAttempted,
                        resumeSucceeded,
                        interrupted: result.interrupted === true
                    });
                } catch (e) {
                    traceLines.push(`[错误] ${e && e.message ? e.message : 'Agent 执行失败'}`);
                    appendWebAgentTraceMessage(state.webHistoryDir, sessionRef, traceLines.join('\n'), {
                        traceEvents,
                        contextMode,
                        resumeAttempted,
                        resumeSucceeded,
                        interrupted: true
                    });
                    sendNdjson(res, {
                        type: 'error',
                        error: e && e.message ? e.message : 'Agent 执行失败'
                    });
                } finally {
                    res.end();
                }
            })
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agent\/stop$/),
            handler: withSessionRef(async sessionRef => {
                const stopped = stopWebAgentRun(state, sessionRef.containerName);
                if (!stopped) {
                    sendJson(res, 404, { error: '当前会话没有运行中的 agent 任务' });
                    return;
                }
                sendJson(res, 200, { ok: true, stopping: true });
            })
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/remove$/),
            handler: withSessionRef(async sessionRef => {
                if (ctx.containerExists(sessionRef.containerName)) {
                    ctx.removeContainer(sessionRef.containerName);
                    appendWebSessionMessage(state.webHistoryDir, sessionRef, 'system', `容器 ${sessionRef.containerName} 已删除。`);
                }

                sendJson(res, 200, { removed: true, name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId) });
            })
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/remove-with-history$/),
            handler: withSessionRef(async sessionRef => {
                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                if (history.agents && typeof history.agents === 'object') {
                    if (sessionRef.agentId === WEB_DEFAULT_AGENT_ID) {
                        delete history.agents[WEB_DEFAULT_AGENT_ID];
                    } else {
                        delete history.agents[sessionRef.agentId];
                    }
                }
                if (!Object.keys(history.agents || {}).length && !ctx.containerExists(sessionRef.containerName)) {
                    removeWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                } else {
                    saveWebSessionHistory(state.webHistoryDir, sessionRef.containerName, history);
                }
                sendJson(res, 200, {
                    removedHistory: true,
                    name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId)
                });
            })
        }
    ];
}

module.exports = {
    createSessionApiRoutes
};
