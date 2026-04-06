'use strict';

function parseJsonObjectLine(line) {
    const text = String(line || '').trim();
    if (!text) {
        return null;
    }
    try {
        const payload = JSON.parse(text);
        return payload && typeof payload === 'object' ? payload : null;
    } catch (e) {
        return null;
    }
}

function collectStructuredText(value) {
    if (typeof value === 'string') {
        return value.trim();
    }
    if (Array.isArray(value)) {
        return value.map(item => collectStructuredText(item)).filter(Boolean).join('\n').trim();
    }
    if (!value || typeof value !== 'object') {
        return '';
    }
    if (typeof value.text === 'string' && value.text.trim()) {
        return value.text.trim();
    }
    if (typeof value.content === 'string' && value.content.trim()) {
        return value.content.trim();
    }
    if (Array.isArray(value.content)) {
        return value.content.map(item => collectStructuredText(item)).filter(Boolean).join('\n').trim();
    }
    return '';
}

function createStructuredOutputHelpers(deps) {
    const {
        pickFirstString,
        toPlainObject,
        extractAgentMessageFromCodexJsonl
    } = deps;

    function extractClaudeAgentMessage(text) {
        let lastMessage = '';
        for (const rawLine of String(text || '').split('\n')) {
            const payload = parseJsonObjectLine(rawLine);
            if (!payload || payload.type !== 'assistant') {
                continue;
            }
            const message = toPlainObject(payload.message);
            const content = Array.isArray(message.content) ? message.content : [];
            const nextMessage = content
                .filter(item => item && typeof item === 'object' && item.type === 'text')
                .map(item => collectStructuredText(item))
                .filter(Boolean)
                .join('\n')
                .trim();
            if (nextMessage) {
                lastMessage = nextMessage;
            }
        }
        return lastMessage.trim();
    }

    function extractGeminiAgentMessage(text) {
        let lastMessage = '';
        let deltaMessage = '';
        for (const rawLine of String(text || '').split('\n')) {
            const payload = parseJsonObjectLine(rawLine);
            if (!payload || payload.type !== 'message' || payload.role !== 'assistant') {
                continue;
            }
            const content = collectStructuredText(payload.content);
            if (!content) {
                continue;
            }
            if (payload.delta === true) {
                deltaMessage += content;
                lastMessage = deltaMessage.trim();
                continue;
            }
            deltaMessage = '';
            lastMessage = content;
        }
        return lastMessage.trim();
    }

    function extractOpenCodeAgentMessage(text) {
        let lastMessage = '';
        let deltaMessage = '';
        for (const rawLine of String(text || '').split('\n')) {
            const payload = parseJsonObjectLine(rawLine);
            if (!payload) {
                continue;
            }
            const eventType = pickFirstString(payload.type);
            const message = toPlainObject(payload.message);
            const role = pickFirstString(payload.role, message.role);
            if (eventType !== 'message' && eventType !== 'assistant' && eventType !== 'assistant_message' && eventType !== 'text') {
                continue;
            }
            if (role && role !== 'assistant') {
                continue;
            }
            const content = collectStructuredText(message.content || payload.content || payload.text || payload);
            if (!content) {
                continue;
            }
            if (payload.delta === true) {
                deltaMessage += content;
                lastMessage = deltaMessage.trim();
                continue;
            }
            deltaMessage = '';
            lastMessage = content;
        }
        return lastMessage.trim();
    }

    function extractAgentMessageFromStructuredOutput(agentProgram, text) {
        if (agentProgram === 'codex') {
            return extractAgentMessageFromCodexJsonl(text);
        }
        if (agentProgram === 'claude') {
            return extractClaudeAgentMessage(text);
        }
        if (agentProgram === 'gemini') {
            return extractGeminiAgentMessage(text);
        }
        if (agentProgram === 'opencode') {
            return extractOpenCodeAgentMessage(text);
        }
        return '';
    }

    return {
        parseJsonObjectLine,
        collectStructuredText,
        extractAgentMessageFromStructuredOutput
    };
}

module.exports = {
    parseJsonObjectLine,
    collectStructuredText,
    createStructuredOutputHelpers
};
