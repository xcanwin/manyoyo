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

// Codex 0.160 / 0.164 实测不认环境变量 OPENAI_BASE_URL，只认 `-c openai_base_url=...`。
// 向导给 Codex 配“兼容服务”写的是环境变量，所以执行 codex 的命令要在容器里由 shell 展开出 -c：
// 变量没设就一个参数都不多；地址只在容器里从环境变量读，不拼进命令文本（也就不会出现在日志和 ps 里）。
// 只处理以 codex 开头（可带前置的 KEY=值）的命令；命令里已经写了 openai_base_url 就以用户的为准。
const CODEX_BASE_URL_FLAGS = '${OPENAI_BASE_URL:+-c "openai_base_url=\\"$OPENAI_BASE_URL\\""}';
// 有 exec / exec resume 子命令时插在它们后面（codex exec -c … --json …），保持 `codex exec` 连在一起
const CODEX_COMMAND_START = /^((?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]*)\s+)*\s*)codex(?:\s+exec(?:\s+resume)?)?(?=\s|$)/;

function withCodexBaseUrl(command) {
    const text = String(command || '');
    if (!text || /openai_base_url/.test(text)) return text;
    const match = text.match(CODEX_COMMAND_START);
    if (!match) return text;
    return `${match[0]} ${CODEX_BASE_URL_FLAGS}${text.slice(match[0].length)}`;
}

module.exports = {
    AGENT_ADAPTERS,
    resolveYoloCommand,
    withCodexBaseUrl
};
