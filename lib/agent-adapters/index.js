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

// Codex 0.164 实测：`exec` 不认环境变量 OPENAI_BASE_URL，也不读 OPENAI_API_KEY（DeepSeek 返回 401），
// 也不读 OPENAI_MODEL；要用自定义 model_provider（env_key 指定读哪个变量，wire_api=responses）。
// 向导给 Codex 配“兼容服务”写的是环境变量，所以执行 codex 的命令要在容器里由 shell 展开成 -c / --model：
// 变量没设就一个参数都不多；值只在容器里从环境变量读，不拼进命令文本（也就不会出现在日志和 ps 里）。
// 只处理以 codex 开头（可带前置的 KEY=值）的命令；命令里已经写了 openai_base_url / model_provider 就以用户的为准。
// 只有地址没有 OPENAI_API_KEY 时（Codex 用 ChatGPT 登录、地址指向 chatgpt.com 的后端）走内置 provider 换地址的老办法；
// 两个都有才用自定义 provider。老写法总是带上（对自定义 provider 无影响），这样没有 Key 的老配置不退化。
const CODEX_BASE_URL_FLAGS = '${OPENAI_BASE_URL:+-c "openai_base_url=\\"$OPENAI_BASE_URL\\""}';
const CODEX_PROVIDER_FLAGS = '${OPENAI_BASE_URL:+${OPENAI_API_KEY:+-c model_provider=manyoyo -c model_providers.manyoyo.name=manyoyo -c "model_providers.manyoyo.base_url=\\"$OPENAI_BASE_URL\\"" -c model_providers.manyoyo.env_key=OPENAI_API_KEY -c model_providers.manyoyo.wire_api=responses}}';
const CODEX_MODEL_FLAGS = '${OPENAI_MODEL:+--model "$OPENAI_MODEL"}';
// 有 exec / exec resume 子命令时插在它们后面（codex exec -c … --json …），保持 `codex exec` 连在一起
const CODEX_COMMAND_START = /^((?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]*)\s+)*\s*)codex(?:\s+exec(?:\s+resume)?)?(?=\s|$)/;
// codex 不允许 --model 出现两次，命令里已经指定了模型（会话里选的）就不再追加环境变量里的
const CODEX_HAS_MODEL = /(?:^|\s)(?:--model|-m)(?:[\s=]|$)|(?:^|\s)model=/;

// 我们自己拼进命令的系统说明（-c 'developer_instructions=…'）里有任意文字，判断“用户有没有写过”时要先去掉
const CODEX_INSTRUCTIONS_FLAG = /-c\s+'developer_instructions=(?:[^']|'\\'')*'/g;

// 传入的应该是还带着 {prompt} 占位的模板（或没有提示词的命令）：渲染进提示词之后再调用，用户的提示词会干扰“已经写过”的判断
function withCodexBaseUrl(command) {
    const text = String(command || '');
    if (!text) return text;
    const match = text.match(CODEX_COMMAND_START);
    if (!match) return text;
    const detect = text.replace(CODEX_INSTRUCTIONS_FLAG, ' ');
    const parts = [];
    if (!/openai_base_url|model_provider/.test(detect)) parts.push(CODEX_BASE_URL_FLAGS, CODEX_PROVIDER_FLAGS);
    if (!CODEX_HAS_MODEL.test(detect)) parts.push(CODEX_MODEL_FLAGS);
    if (!parts.length) return text;
    return `${match[0]} ${parts.join(' ')}${text.slice(match[0].length)}`;
}

module.exports = {
    AGENT_ADAPTERS,
    findAdapterByAlias,
    resolveYoloCommand,
    withCodexBaseUrl
};
