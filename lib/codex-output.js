'use strict';

function extractAgentMessageFromCodexJsonl(text) {
    let lastMessage = '';
    for (const rawLine of String(text || '').split('\n')) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        let payload;
        try {
            payload = JSON.parse(line);
        } catch (error) {
            continue;
        }
        if (payload && payload.type === 'item.completed' && payload.item && payload.item.type === 'agent_message') {
            lastMessage = String(payload.item.text || '');
        }
    }
    return lastMessage.trim();
}

module.exports = {
    extractAgentMessageFromCodexJsonl
};
