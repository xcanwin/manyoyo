'use strict';

// 模型服务商预设：网页向导与命令行向导共用的唯一数据源。
// 只收录实测可用（Base URL 不带 Key 请求得到 401）且官方文档给了接入方式的服务商。
// claude：Anthropic 兼容接口；codex：Responses 接口（只收官方文档确认支持 Responses 的）。
// models 只作“模型”输入框的占位提示，不会自动写入配置；defaultModel 是官方文档要求必须填的，用户可改。
// Codex 不认环境变量 OPENAI_BASE_URL（0.160 / 0.164 实测），向导写的仍是环境变量，
// 由 lib/agent-adapters 的 withCodexBaseUrl 在容器里展开成 `-c openai_base_url=…` 才生效。
// 智谱的接口把鉴权失败写在 200 响应体里（`{"code":401,...}`），其余三家直接返回 HTTP 401。
const PROVIDER_PRESETS = [
    {
        id: 'deepseek',
        label: 'DeepSeek',
        docUrl: 'https://api-docs.deepseek.com/guides/coding_agents',
        claude: { baseUrl: 'https://api.deepseek.com/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN', models: ['deepseek-flash[1m]'], defaultModel: 'deepseek-flash[1m]' }
    },
    {
        id: 'zhipu',
        label: '智谱 GLM',
        docUrl: 'https://docs.bigmodel.cn/cn/coding-plan/tool/claude',
        claude: { baseUrl: 'https://open.bigmodel.cn/api/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN' },
        codex: { baseUrl: 'https://open.bigmodel.cn/api/v1', keyEnv: 'OPENAI_API_KEY', docUrl: 'https://docs.bigmodel.cn/cn/coding-plan/tool/codex' }
    },
    {
        id: 'zai',
        label: 'Z.ai（智谱国际）',
        docUrl: 'https://docs.z.ai/devpack/tool/claude',
        claude: { baseUrl: 'https://api.z.ai/api/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN' }
    },
    {
        id: 'kimi',
        label: 'Kimi',
        docUrl: 'https://platform.kimi.com/docs/guide/claude-code-kimi.md',
        claude: { baseUrl: 'https://api.moonshot.cn/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN' },
        codex: { baseUrl: 'https://api.moonshot.cn/v1', keyEnv: 'OPENAI_API_KEY', docUrl: 'https://platform.kimi.com/docs/guide/codex-kimi.md' }
    },
    {
        id: 'kimi-code',
        label: 'Kimi Code（订阅，海外）',
        docUrl: 'https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html',
        claude: { baseUrl: 'https://api.kimi.ai/coding/', keyEnv: 'ANTHROPIC_API_KEY' }
    },
    {
        id: 'aliyun',
        label: '阿里云百炼',
        docUrl: 'https://help.aliyun.com/zh/model-studio/claude-code',
        claude: { baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN' }
    },
    {
        id: 'tencent',
        label: '腾讯云',
        docUrl: 'https://cloud.tencent.com/document/product/1823/130097',
        claude: { baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN', models: ['glm-5'] }
    },
    {
        id: 'volcengine',
        label: '火山方舟',
        docUrl: 'https://www.volcengine.com/docs/82379/1928262',
        claude: { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', keyEnv: 'ANTHROPIC_AUTH_TOKEN' },
        codex: { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', keyEnv: 'OPENAI_API_KEY' }
    },
    {
        id: 'minimax',
        label: 'MiniMax',
        docUrl: 'https://platform.minimax.cn/docs/token-plan/claude-code',
        claude: { baseUrl: 'https://api.minimax.cn/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN' },
        codex: { baseUrl: 'https://api.minimax.cn/v1', keyEnv: 'OPENAI_API_KEY', docUrl: 'https://platform.minimax.cn/docs/token-plan/codex' }
    }
];

/** 某个 Agent 可用的预设（扁平：{id, label, docUrl, baseUrl, keyEnv, models, defaultModel}） */
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
            defaultModel: item[agentId].defaultModel || ''
        }));
}

module.exports = { PROVIDER_PRESETS, providersForAgent };
