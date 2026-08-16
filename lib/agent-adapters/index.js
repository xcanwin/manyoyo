'use strict';

const AGENT_ADAPTERS = {
    claude: {
        id: 'claude',
        aliases: ['claude', 'cc', 'c'],
        yoloCommand: 'IS_SANDBOX=1 claude --dangerously-skip-permissions'
    },
    gemini: {
        id: 'gemini',
        aliases: ['gemini', 'gm', 'g'],
        yoloCommand: 'gemini --yolo'
    },
    codex: {
        id: 'codex',
        aliases: ['codex', 'cx'],
        yoloCommand: 'codex --dangerously-bypass-approvals-and-sandbox'
    },
    opencode: {
        id: 'opencode',
        aliases: ['opencode', 'oc'],
        yoloCommand: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode'
    }
};

function findAdapterByAlias(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!key) return null;
    return Object.values(AGENT_ADAPTERS).find(adapter => adapter.aliases.includes(key)) || null;
}

function resolveYoloCommand(yolo) {
    const key = String(yolo || '').trim();
    if (!key) {
        return '';
    }
    const adapter = findAdapterByAlias(key);
    if (!adapter) {
        throw new Error(`未知 yolo 值: ${yolo}`);
    }
    return adapter.yoloCommand;
}

module.exports = {
    AGENT_ADAPTERS,
    resolveYoloCommand
};
