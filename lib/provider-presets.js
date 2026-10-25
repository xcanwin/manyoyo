'use strict';

// 模型服务商预设：网页向导与命令行向导共用的唯一数据源。
// 只收录实测可用（Base URL 不带 Key 请求得到 401）且官方文档给了接入方式的服务商。
// claude：Anthropic 兼容接口；codex：Responses 接口（只收官方文档确认支持 Responses 的）。
// models 只作“模型”输入框的占位提示，不会自动写入配置；defaultModel 是官方文档要求必须填的，用户可改。
// Codex 0.164 实测：exec 不认 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL，向导写的仍是环境变量，
// 由 lib/agent-adapters 的 withCodexBaseUrl 在容器里展开成自定义 model_provider + --model 才生效，所以 Codex 条目必须有 defaultModel。
// extraEnv：这家服务必须附带的变量（写进同一个运行配置）。Claude Code 2.1.310 的“工具搜索”会把工具收进 ToolSearch，
// 智谱的兼容接口用不了（实测模型看不到 Bash），要 ENABLE_TOOL_SEARCH=false；DeepSeek 实测不需要。其余没有 Key 实测的先带上（代价只是多耗一点 token）。
// 智谱的接口把鉴权失败写在 200 响应体里（`{"code":401,...}`），其余三家直接返回 HTTP 401。
const PROVIDER_PRESETS = [
    {
        id: 'anthropic',
        label: 'Anthropic（官方）',
        docUrl: 'https://docs.claude.com/en/api/overview',
        claude: { baseUrl: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY' }
    },
    {
        id: 'openai',
        label: 'OpenAI（官方）',
        docUrl: 'https://platform.openai.com/docs/api-reference/responses',
        // 官方 Key 的用法没有实测过（没有 Key）：模型名要自己填
        codex: { baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', models: ['gpt-5-codex'] }
    },
    {
        id: 'deepseek',
        label: 'DeepSeek',
        docUrl: 'https://api-docs.deepseek.com/guides/coding_agents',
        claude: { baseUrl: 'https://api.deepseek.com/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN', models: ['deepseek-flash[1m]'], defaultModel: 'deepseek-flash[1m]' },
        codex: { baseUrl: 'https://api.deepseek.com', keyEnv: 'OPENAI_API_KEY', models: ['deepseek-flash'], defaultModel: 'deepseek-flash' }
    },
    {
        id: 'zhipu',
        label: '智谱 GLM',
        docUrl: 'https://docs.bigmodel.cn/cn/coding-plan/tool/claude',
        claude: { baseUrl: 'https://open.bigmodel.cn/api/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN', extraEnv: { ENABLE_TOOL_SEARCH: 'false' } },
        codex: { baseUrl: 'https://open.bigmodel.cn/api/v1', keyEnv: 'OPENAI_API_KEY', models: ['glm-5.3'], defaultModel: 'glm-5.3', docUrl: 'https://docs.bigmodel.cn/cn/coding-plan/tool/codex' }
    },
    {
        id: 'zai',
        label: 'Z.ai（智谱国际）',
        docUrl: 'https://docs.z.ai/devpack/tool/claude',
        claude: { baseUrl: 'https://api.z.ai/api/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN', extraEnv: { ENABLE_TOOL_SEARCH: 'false' } }
    },
    {
        id: 'kimi',
        label: 'Kimi',
        docUrl: 'https://platform.kimi.com/docs/guide/claude-code-kimi.md',
        claude: { baseUrl: 'https://api.moonshot.cn/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN', extraEnv: { ENABLE_TOOL_SEARCH: 'false' } },
        codex: { baseUrl: 'https://api.moonshot.cn/v1', keyEnv: 'OPENAI_API_KEY', docUrl: 'https://platform.kimi.com/docs/guide/codex-kimi.md' }
    },
    {
        id: 'kimi-code',
        label: 'Kimi Code（订阅，海外）',
        docUrl: 'https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html',
        claude: { baseUrl: 'https://api.kimi.ai/coding/', keyEnv: 'ANTHROPIC_API_KEY', extraEnv: { ENABLE_TOOL_SEARCH: 'false' } }
    },
    {
        id: 'aliyun',
        label: '阿里云百炼',
        docUrl: 'https://help.aliyun.com/zh/model-studio/claude-code',
        claude: { baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN', extraEnv: { ENABLE_TOOL_SEARCH: 'false' } }
    },
    {
        id: 'tencent',
        label: '腾讯云',
        docUrl: 'https://cloud.tencent.com/document/product/1823/130097',
        claude: { baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN', models: ['glm-5'], extraEnv: { ENABLE_TOOL_SEARCH: 'false' } }
    },
    {
        id: 'volcengine',
        label: '火山方舟',
        docUrl: 'https://www.volcengine.com/docs/82379/1928262',
        claude: { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', keyEnv: 'ANTHROPIC_AUTH_TOKEN', extraEnv: { ENABLE_TOOL_SEARCH: 'false' } },
        codex: { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', keyEnv: 'OPENAI_API_KEY' }
    },
    {
        id: 'minimax',
        label: 'MiniMax',
        docUrl: 'https://platform.minimax.cn/docs/token-plan/claude-code',
        claude: { baseUrl: 'https://api.minimax.cn/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN', extraEnv: { ENABLE_TOOL_SEARCH: 'false' } },
        codex: { baseUrl: 'https://api.minimax.cn/v1', keyEnv: 'OPENAI_API_KEY', docUrl: 'https://platform.minimax.cn/docs/token-plan/codex' }
    }
];

/** 某个 Agent 可用的预设（扁平：{id, label, docUrl, baseUrl, keyEnv, models, defaultModel, extraEnv}） */
function providersForAgent(agentId) {
    return PROVIDER_PRESETS
        .filter(item => item[agentId])
        .map(item => ({
            id: item.id,
            label: item.label,
            docUrl: item[agentId].docUrl || item.docUrl,
            baseUrl: item[agentId].baseUrl,
            keyEnv: item[agentId].keyEnv,
            models: [...(item[agentId].models || [])],
            defaultModel: item[agentId].defaultModel || '',
            extraEnv: { ...(item[agentId].extraEnv || {}) }
        }));
}

function normalizeUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

/** 按 Base URL 找某个 Agent 的预设，对不上返回 null */
function findProviderByBaseUrl(agentId, baseUrl) {
    const url = normalizeUrl(baseUrl);
    if (!url) return null;
    return providersForAgent(agentId).find(item => normalizeUrl(item.baseUrl) === url) || null;
}

/**
 * Codex 接了第三方（env 里有 OPENAI_BASE_URL）时的模型下拉：只列这家的预设模型和当前模型。
 * `codex app-server` 的目录永远是 OpenAI 的模型名，选了第三方会直接报错。不是第三方返回 null。
 */
function thirdPartyCodexModels(env) {
    const source = env && typeof env === 'object' ? env : {};
    const baseUrl = typeof source.OPENAI_BASE_URL === 'string' ? source.OPENAI_BASE_URL.trim() : '';
    if (!baseUrl) return null;
    const provider = findProviderByBaseUrl('codex', baseUrl);
    const names = [...(provider ? provider.models : [])];
    const current = typeof source.OPENAI_MODEL === 'string' ? source.OPENAI_MODEL.trim() : '';
    if (current && !names.includes(current)) names.push(current);
    return names.map(value => ({ value, label: value, description: provider ? provider.label : '' }));
}

module.exports = { PROVIDER_PRESETS, providersForAgent, findProviderByBaseUrl, thirdPartyCodexModels };
