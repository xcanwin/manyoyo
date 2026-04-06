'use strict';

function createStructuredTraceHelpers(deps) {
    const {
        pickFirstString,
        toPlainObject,
        collectStructuredText,
        clipText,
        stripAnsi
    } = deps;

    function shortenTraceText(value, maxChars = 140) {
        const raw = clipText(stripAnsi(String(value || '')).replace(/\s+/g, ' ').trim(), maxChars);
        return raw.trim();
    }

    function summarizeTraceArguments(args) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return '';
        }
        const parts = [];
        for (const [key, value] of Object.entries(args)) {
            if (value === undefined || value === null) continue;
            if (typeof value === 'string') {
                const textValue = value.trim();
                if (!textValue) continue;
                parts.push(`${key}=${shortenTraceText(textValue, 80)}`);
                continue;
            }
            if (typeof value === 'number' || typeof value === 'boolean') {
                parts.push(`${key}=${String(value)}`);
            }
        }
        return parts.slice(0, 3).join(', ');
    }

    function createStructuredTraceEvent(provider, kind, eventType, textValue, extra = {}) {
        const normalizedText = String(textValue || '').trim();
        if (!normalizedText) {
            return null;
        }
        return {
            provider,
            kind,
            eventType,
            text: normalizedText,
            ...extra
        };
    }

    return {
        pickFirstString,
        toPlainObject,
        collectStructuredText,
        shortenTraceText,
        summarizeTraceArguments,
        createStructuredTraceEvent
    };
}

function prepareClaudeTraceEvents(payload, state, helpers) {
    const { pickFirstString, toPlainObject, collectStructuredText, summarizeTraceArguments, createStructuredTraceEvent } = helpers;
    const eventType = pickFirstString(payload.type);
    const subtype = pickFirstString(payload.subtype);
    const message = toPlainObject(payload.message);
    const content = Array.isArray(message.content) ? message.content : [];
    const toolNamesById = state.toolNamesById;
    const events = [];

    if (eventType === 'system' && subtype === 'init') {
        events.push(createStructuredTraceEvent('claude', 'thread', eventType, '[会话] Claude 已开始处理', {
            phase: 'started',
            status: 'started',
            subtype
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'assistant') {
        content.forEach(item => {
            if (!item || typeof item !== 'object') {
                return;
            }
            if (item.type === 'text') {
                const detail = collectStructuredText(item);
                if (detail) {
                    events.push(createStructuredTraceEvent('claude', 'agent_message', eventType, `[说明] ${detail}`, {
                        phase: 'completed',
                        status: 'completed',
                        detail
                    }));
                }
                return;
            }
            if (item.type === 'tool_use') {
                const toolName = pickFirstString(item.name, item.id, 'tool');
                const toolId = pickFirstString(item.id);
                if (toolId) {
                    toolNamesById.set(toolId, toolName);
                }
                const summary = summarizeTraceArguments(toPlainObject(item.input));
                events.push(createStructuredTraceEvent(
                    'claude',
                    'tool',
                    eventType,
                    summary ? `[工具开始] ${toolName} (${summary})` : `[工具开始] ${toolName}`,
                    {
                        phase: 'started',
                        status: 'in_progress',
                        toolName,
                        toolId,
                        arguments: toPlainObject(item.input),
                        argumentSummary: summary
                    }
                ));
            }
        });
        return events.filter(Boolean);
    }
    if (eventType === 'user') {
        content.forEach(item => {
            if (!item || typeof item !== 'object' || item.type !== 'tool_result') {
                return;
            }
            const toolId = pickFirstString(item.tool_use_id);
            const toolName = pickFirstString(toolNamesById.get(toolId), toolId, 'tool');
            const status = item.is_error === true ? 'error' : 'success';
            events.push(createStructuredTraceEvent('claude', 'tool', eventType, `[工具完成] ${toolName} (${status})`, {
                phase: 'completed',
                status,
                toolName,
                toolId,
                result: collectStructuredText(item.content),
                error: item.is_error === true ? collectStructuredText(item.content) : ''
            }));
        });
        return events.filter(Boolean);
    }
    if (eventType === 'result') {
        events.push(createStructuredTraceEvent('claude', 'turn', eventType, '[回合] 响应完成', {
            phase: 'completed',
            status: pickFirstString(subtype, 'completed'),
            subtype
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'error') {
        const detail = pickFirstString(payload.message, payload.error);
        events.push(createStructuredTraceEvent('claude', 'error', eventType, detail ? `[错误] ${detail}` : '[错误] Claude 返回了错误事件', {
            status: 'error',
            detail
        }));
        return events.filter(Boolean);
    }
    return [];
}

function prepareGeminiTraceEvents(payload, state, helpers) {
    const { pickFirstString, toPlainObject, collectStructuredText, summarizeTraceArguments, createStructuredTraceEvent } = helpers;
    const eventType = pickFirstString(payload.type);
    const toolNamesById = state.toolNamesById;
    const events = [];

    if (eventType === 'init') {
        events.push(createStructuredTraceEvent('gemini', 'thread', eventType, '[会话] Gemini 已开始处理', {
            phase: 'started',
            status: 'started',
            sessionId: pickFirstString(payload.session_id),
            model: pickFirstString(payload.model)
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'message' && payload.role === 'assistant') {
        if (payload.delta === true) {
            return [];
        }
        const detail = collectStructuredText(payload.content);
        if (!detail) {
            return [];
        }
        events.push(createStructuredTraceEvent('gemini', 'agent_message', eventType, `[说明] ${detail}`, {
            phase: 'completed',
            status: 'completed',
            detail
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'tool_use') {
        const toolName = pickFirstString(payload.tool_name, payload.tool_id, 'tool');
        const toolId = pickFirstString(payload.tool_id);
        if (toolId) {
            toolNamesById.set(toolId, toolName);
        }
        const summary = summarizeTraceArguments(toPlainObject(payload.parameters));
        events.push(createStructuredTraceEvent(
            'gemini',
            'tool',
            eventType,
            summary ? `[工具开始] ${toolName} (${summary})` : `[工具开始] ${toolName}`,
            {
                phase: 'started',
                status: 'in_progress',
                toolName,
                toolId,
                arguments: toPlainObject(payload.parameters),
                argumentSummary: summary
            }
        ));
        return events.filter(Boolean);
    }
    if (eventType === 'tool_result') {
        const toolId = pickFirstString(payload.tool_id);
        const toolName = pickFirstString(toolNamesById.get(toolId), toolId, 'tool');
        const status = pickFirstString(payload.status, 'completed');
        events.push(createStructuredTraceEvent('gemini', 'tool', eventType, `[工具完成] ${toolName} (${status})`, {
            phase: 'completed',
            status,
            toolName,
            toolId,
            result: collectStructuredText(payload.output),
            error: toPlainObject(payload.error)
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'result') {
        events.push(createStructuredTraceEvent('gemini', 'turn', eventType, '[回合] 响应完成', {
            phase: 'completed',
            status: pickFirstString(payload.status, 'completed')
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'error') {
        const detail = pickFirstString(payload.message);
        events.push(createStructuredTraceEvent('gemini', 'error', eventType, detail ? `[错误] ${detail}` : '[错误] Gemini 返回了错误事件', {
            status: pickFirstString(payload.severity, 'error'),
            detail
        }));
        return events.filter(Boolean);
    }
    return [];
}

function prepareOpenCodeTraceEvents(payload, state, helpers) {
    const { pickFirstString, toPlainObject, collectStructuredText, summarizeTraceArguments, createStructuredTraceEvent } = helpers;
    const eventType = pickFirstString(payload.type);
    const message = toPlainObject(payload.message);
    const role = pickFirstString(payload.role, message.role);
    const toolNamesById = state.toolNamesById;
    const events = [];

    if (eventType === 'session.start' || eventType === 'init') {
        events.push(createStructuredTraceEvent('opencode', 'thread', eventType, '[会话] OpenCode 已开始处理', {
            phase: 'started',
            status: 'started',
            sessionId: pickFirstString(payload.session_id, payload.sessionID)
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'message' || eventType === 'assistant' || eventType === 'assistant_message' || eventType === 'text') {
        if (role && role !== 'assistant') {
            return [];
        }
        if (payload.delta === true) {
            return [];
        }
        const detail = collectStructuredText(message.content || payload.content || payload.text || payload);
        if (!detail) {
            return [];
        }
        events.push(createStructuredTraceEvent('opencode', 'agent_message', eventType, `[说明] ${detail}`, {
            phase: 'completed',
            status: 'completed',
            detail
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'tool_use' || eventType === 'step_start') {
        const toolName = pickFirstString(payload.tool_name, payload.name, payload.tool, payload.step, payload.tool_id, 'tool');
        const toolId = pickFirstString(payload.tool_id, payload.id);
        if (toolId) {
            toolNamesById.set(toolId, toolName);
        }
        const argumentsValue = toPlainObject(payload.parameters || payload.input || payload.arguments);
        const summary = summarizeTraceArguments(argumentsValue);
        events.push(createStructuredTraceEvent(
            'opencode',
            'tool',
            eventType,
            summary ? `[工具开始] ${toolName} (${summary})` : `[工具开始] ${toolName}`,
            {
                phase: 'started',
                status: pickFirstString(payload.status, 'in_progress'),
                toolName,
                toolId,
                arguments: argumentsValue,
                argumentSummary: summary
            }
        ));
        return events.filter(Boolean);
    }
    if (eventType === 'tool_result' || eventType === 'step_finish') {
        const toolId = pickFirstString(payload.tool_id, payload.id);
        const toolName = pickFirstString(toolNamesById.get(toolId), payload.tool_name, payload.name, payload.tool, toolId, 'tool');
        const status = pickFirstString(payload.status, payload.state, 'completed');
        events.push(createStructuredTraceEvent('opencode', 'tool', eventType, `[工具完成] ${toolName} (${status})`, {
            phase: 'completed',
            status,
            toolName,
            toolId,
            result: collectStructuredText(payload.output || payload.result),
            error: toPlainObject(payload.error)
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'result') {
        events.push(createStructuredTraceEvent('opencode', 'turn', eventType, '[回合] 响应完成', {
            phase: 'completed',
            status: pickFirstString(payload.status, 'completed')
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'error') {
        const detail = pickFirstString(payload.message, payload.error && payload.error.message);
        events.push(createStructuredTraceEvent('opencode', 'error', eventType, detail ? `[错误] ${detail}` : '[错误] OpenCode 返回了错误事件', {
            status: 'error',
            detail
        }));
        return events.filter(Boolean);
    }
    return [];
}

function prepareCodexTraceEvent(payload, helpers) {
    const { pickFirstString, clipText, stripAnsi } = helpers;
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const eventType = typeof payload.type === 'string' ? payload.type : '';
    const item = payload.item && typeof payload.item === 'object' && !Array.isArray(payload.item)
        ? payload.item
        : {};
    const itemType = typeof item.type === 'string' ? item.type : '';
    const text = pickFirstString(
        item.title,
        item.summary,
        item.text,
        item.name,
        item.command,
        payload.message,
        payload.text
    );
    const toolName = pickFirstString(
        item.name,
        item.tool_name,
        item.tool,
        item.command
    );
    const commandText = pickFirstString(item.command);
    const mcpServer = pickFirstString(item.server);
    const mcpTool = pickFirstString(item.tool);
    const itemStatus = pickFirstString(item.status);

    function shortenText(value, maxChars = 140) {
        const raw = clipText(stripAnsi(String(value || '')).replace(/\s+/g, ' ').trim(), maxChars);
        return raw.trim();
    }

    function summarizeArguments(args) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return '';
        }
        const parts = [];
        for (const [key, value] of Object.entries(args)) {
            if (value === undefined || value === null) continue;
            if (typeof value === 'string') {
                const textValue = value.trim();
                if (!textValue) continue;
                parts.push(`${key}=${shortenText(textValue, 80)}`);
                continue;
            }
            if (typeof value === 'number' || typeof value === 'boolean') {
                parts.push(`${key}=${String(value)}`);
            }
        }
        return parts.slice(0, 3).join(', ');
    }

    function pickDisplayStatus(defaultStatus) {
        const status = String(itemStatus || defaultStatus || '').trim();
        return status || '';
    }

    function createTraceEvent(kind, textValue, extra = {}) {
        const normalizedText = String(textValue || '').trim();
        if (!normalizedText) {
            return null;
        }
        return {
            provider: 'codex',
            kind,
            eventType,
            itemType: itemType || '',
            text: normalizedText,
            ...extra
        };
    }

    if (eventType === 'thread.started') {
        return createTraceEvent('thread', '[会话] Codex 已开始处理', {
            phase: 'started',
            status: 'started'
        });
    }
    if (eventType === 'thread.completed') {
        return createTraceEvent('thread', '[会话] Codex 已完成当前任务', {
            phase: 'completed',
            status: 'completed'
        });
    }
    if (eventType === 'turn.started') {
        return createTraceEvent('turn', '[回合] 开始生成响应', {
            phase: 'started',
            status: 'started'
        });
    }
    if (eventType === 'turn.completed') {
        return createTraceEvent('turn', '[回合] 响应完成', {
            phase: 'completed',
            status: 'completed'
        });
    }
    if (eventType === 'item.started') {
        if (itemType === 'tool_call') {
            return createTraceEvent('tool', `[工具开始] ${toolName || 'tool_call'}`, {
                phase: 'started',
                status: pickDisplayStatus('in_progress'),
                toolName: toolName || 'tool_call'
            });
        }
        if (itemType === 'command_execution') {
            return createTraceEvent('command', `[命令开始] ${commandText || 'command_execution'}`, {
                phase: 'started',
                status: pickDisplayStatus('in_progress'),
                command: commandText || 'command_execution'
            });
        }
        if (itemType === 'mcp_tool_call') {
            const summary = summarizeArguments(item.arguments);
            return createTraceEvent(
                'mcp',
                summary
                    ? `[MCP开始] ${mcpServer || 'mcp'}.${mcpTool || 'tool'} (${summary})`
                    : `[MCP开始] ${mcpServer || 'mcp'}.${mcpTool || 'tool'}`,
                {
                    phase: 'started',
                    status: pickDisplayStatus('in_progress'),
                    server: mcpServer || 'mcp',
                    tool: mcpTool || 'tool',
                    arguments: item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
                        ? item.arguments
                        : null,
                    argumentSummary: summary
                }
            );
        }
        if (itemType === 'reasoning') {
            return createTraceEvent('status', text ? `[状态] ${text}` : '[状态] Codex 正在分析', {
                phase: 'started',
                status: pickDisplayStatus('in_progress'),
                detail: text || 'Codex 正在分析'
            });
        }
        if (itemType === 'agent_message') {
            return createTraceEvent('agent_message', text ? `[说明] ${text}` : '[回复] 正在生成最终答复', {
                phase: 'started',
                status: pickDisplayStatus('in_progress'),
                detail: text || '正在生成最终答复'
            });
        }
        return createTraceEvent('event', text ? `[事件开始] ${text}` : `[事件开始] ${itemType || eventType}`, {
            phase: 'started',
            status: pickDisplayStatus('in_progress'),
            detail: text || itemType || eventType
        });
    }
    if (eventType === 'item.completed') {
        if (itemType === 'tool_call') {
            return createTraceEvent('tool', `[工具完成] ${toolName || 'tool_call'}`, {
                phase: 'completed',
                status: pickDisplayStatus('completed'),
                toolName: toolName || 'tool_call'
            });
        }
        if (itemType === 'command_execution') {
            const suffix = itemStatus || (typeof item.exit_code === 'number' ? `exit=${item.exit_code}` : 'completed');
            return createTraceEvent('command', `[命令完成] ${commandText || 'command_execution'} (${suffix})`, {
                phase: 'completed',
                status: pickDisplayStatus(suffix),
                command: commandText || 'command_execution',
                exitCode: typeof item.exit_code === 'number' ? item.exit_code : null
            });
        }
        if (itemType === 'mcp_tool_call') {
            const summary = summarizeArguments(item.arguments);
            return createTraceEvent(
                'mcp',
                summary
                    ? `[MCP完成] ${mcpServer || 'mcp'}.${mcpTool || 'tool'} (${summary})`
                    : `[MCP完成] ${mcpServer || 'mcp'}.${mcpTool || 'tool'}`,
                {
                    phase: 'completed',
                    status: pickDisplayStatus('completed'),
                    server: mcpServer || 'mcp',
                    tool: mcpTool || 'tool',
                    arguments: item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
                        ? item.arguments
                        : null,
                    argumentSummary: summary,
                    result: item.result !== undefined ? item.result : null,
                    error: item.error !== undefined ? item.error : null
                }
            );
        }
        if (itemType === 'reasoning') {
            return createTraceEvent('status', text ? `[状态] ${text}` : '', {
                phase: 'completed',
                status: pickDisplayStatus('completed'),
                detail: text || ''
            });
        }
        if (itemType === 'agent_message') {
            return createTraceEvent('agent_message', text ? `[说明] ${text}` : '[回复] 已生成', {
                phase: 'completed',
                status: pickDisplayStatus('completed'),
                detail: text || '已生成'
            });
        }
        return createTraceEvent('event', text ? `[事件完成] ${text}` : `[事件完成] ${itemType || eventType}`, {
            phase: 'completed',
            status: pickDisplayStatus('completed'),
            detail: text || itemType || eventType
        });
    }
    if (eventType === 'error') {
        return createTraceEvent('error', text ? `[错误] ${text}` : '[错误] Codex 返回了错误事件', {
            status: 'error',
            detail: text || 'Codex 返回了错误事件'
        });
    }

    return createTraceEvent('event', `[事件] ${eventType}`, {
        status: itemStatus || '',
        detail: eventType
    });
}

function prepareStructuredTraceEvents(agentProgram, payload, state, deps) {
    if (!payload || typeof payload !== 'object') {
        return [];
    }
    const helpers = createStructuredTraceHelpers(deps);
    if (agentProgram === 'codex') {
        const traceEvent = prepareCodexTraceEvent(payload, helpers);
        return traceEvent ? [traceEvent] : [];
    }
    if (agentProgram === 'claude') {
        return prepareClaudeTraceEvents(payload, state, helpers);
    }
    if (agentProgram === 'gemini') {
        return prepareGeminiTraceEvents(payload, state, helpers);
    }
    if (agentProgram === 'opencode') {
        return prepareOpenCodeTraceEvents(payload, state, helpers);
    }
    return [];
}

function extractContentDeltaFromPayload(agentProgram, payload, deps) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const { pickFirstString, toPlainObject, collectStructuredText } = deps;
    if (agentProgram === 'claude') {
        if (pickFirstString(payload.type) !== 'assistant') {
            return null;
        }
        const message = toPlainObject(payload.message);
        const content = Array.isArray(message.content) ? message.content : [];
        const text = content
            .filter(item => item && typeof item === 'object' && item.type === 'text')
            .map(item => collectStructuredText(item))
            .filter(Boolean)
            .join('\n')
            .trim();
        if (!text) {
            return null;
        }
        return { text, reset: true };
    }
    if (agentProgram === 'gemini' || agentProgram === 'opencode') {
        const eventType = pickFirstString(payload.type);
        if (eventType !== 'message') {
            return null;
        }
        const role = pickFirstString(payload.role);
        if (role !== 'assistant') {
            return null;
        }
        const text = collectStructuredText(payload.content);
        if (!text) {
            return null;
        }
        if (payload.delta === true) {
            return { text, reset: false };
        }
        return { text, reset: true };
    }
    return null;
}

module.exports = {
    prepareStructuredTraceEvents,
    extractContentDeltaFromPayload
};
