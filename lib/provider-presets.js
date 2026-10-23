'use strict';

// 模型服务商预设：网页向导与命令行向导共用的唯一数据源。
// 只收录实测可用（Base URL 不带 Key 请求得到 401）且官方文档给了 Claude Code 接入方式的服务商。
// models 只作“模型”输入框的占位提示，不会自动写入配置；defaultModel 是官方文档要求必须填的，用户可改。
// 没有 codex 条目：Codex 0.160 不认环境变量 OPENAI_BASE_URL（只认 config.toml 的 openai_base_url），
// 向导写的是环境变量，所以先不提供。
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
        claude: { baseUrl: 'https://open.bigmodel.cn/api/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN' }
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
        claude: { baseUrl: 'https://api.moonshot.cn/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN' }
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
        claude: { baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', keyEnv: 'ANTHROPIC_AUTH_TOKEN' }
    },
    {
        id: 'minimax',
        label: 'MiniMax',
        docUrl: 'https://platform.minimax.cn/docs/token-plan/claude-code',
        claude: { baseUrl: 'https://api.minimax.cn/anthropic', keyEnv: 'ANTHROPIC_AUTH_TOKEN' }
    }
];

/** 某个 Agent 可用的预设（扁平：{id, label, docUrl, baseUrl, keyEnv, models, defaultModel}） */
function providersForAgent(agentId) {
    return PROVIDER_PRESETS
        .filter(item => item[agentId])
        .map(item => ({
            id: item.id,
            label: item.label,
            docUrl: item.docUrl,
            baseUrl: item[agentId].baseUrl,
            keyEnv: item[agentId].keyEnv,
            models: [...(item[agentId].models || [])],
            defaultModel: item[agentId].defaultModel || ''
        }));
}

module.exports = { PROVIDER_PRESETS, providersForAgent };
