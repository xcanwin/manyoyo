'use strict';

// 「从本机导入」：把本机已有的 Claude / Codex 的 Key、地址、模型读出来，让用户预览后写成模型服务。
// 数据源与 `manyoyo init` 相同（环境变量、~/.claude/settings.json 的 env、~/.codex 的 OPENAI_API_KEY 与 config.toml），
// 但只提取 Key / 地址 / 模型，不加任何挂载（init 会把整个 ~/.codex 读写挂进容器），也不碰 OAuth 登录凭据。
const { AGENT_ENV_SCHEMA, collectClaudeInitData, collectCodexInitData } = require('./init-config');
const { findProviderByBaseUrl } = require('./provider-presets');
const { listModelServices, keyValueOf, uniqueRunName } = require('./model-services');
const { buildAgentRunProfile } = require('./setup');

const IMPORT_AGENTS = [
    { id: 'claude', collect: collectClaudeInitData, sources: '环境变量、~/.claude/settings.json' },
    { id: 'codex', collect: collectCodexInitData, sources: '环境变量、~/.codex/auth.json、~/.codex/config.toml' }
];

// 读不了文件时只当没有，不往终端打印
const SILENT_CTX = { colors: { YELLOW: '', NC: '' }, log: () => {} };

function keyTail(secret) {
    return secret.length >= 8 ? `…${secret.slice(-4)}` : '…';
}

/**
 * 扫描本机，返回候选（含内部 env，调用方不能原样下发给前端）。
 * 每个候选：{ id, agent, env, baseUrl, model, secret, duplicate, invalid }
 */
function scanLocalServices(homeDir, config) {
    const existing = listModelServices(config);
    const existingKeys = new Set(existing.map(item => `${item.agent}|${keyValueOf(config, item.name)}`));
    const candidates = [];
    for (const agent of IMPORT_AGENTS) {
        const spec = AGENT_ENV_SCHEMA[agent.id];
        const { values } = agent.collect(homeDir, SILENT_CTX);
        const env = {};
        for (const item of spec.env) {
            const value = values[item.name];
            // OAuth 令牌不导入：订阅登录只做引导
            if (item.name.includes('OAUTH')) continue;
            if (typeof value === 'string' && value.trim()) env[item.name] = value.trim();
        }
        const keyName = spec.requiredAnyOf.find(name => env[name]);
        if (!keyName) continue;
        const secret = env[keyName];
        let invalid = '';
        try {
            buildAgentRunProfile(agent.id, env, {});
        } catch (e) {
            invalid = e.message;
        }
        candidates.push({
            id: agent.id,
            agent: agent.id,
            env,
            secret,
            baseUrl: env[spec.baseUrlKey] || '',
            model: env[spec.modelKey] || '',
            duplicate: existingKeys.has(`${agent.id}|${secret}`),
            invalid
        });
    }
    return candidates;
}

/** 给前端预览用：只有 Key 末 4 位，没有 env 原文 */
function toPreview(candidates) {
    return candidates.map(item => {
        const provider = findProviderByBaseUrl(item.agent, item.baseUrl);
        return {
            id: item.id,
            agent: item.agent,
            agentLabel: AGENT_ENV_SCHEMA[item.agent].label,
            providerLabel: provider ? provider.label : (item.baseUrl ? '自定义地址' : '官方'),
            baseUrl: item.baseUrl,
            model: item.model,
            keyTail: keyTail(item.secret),
            duplicate: item.duplicate,
            invalid: item.invalid
        };
    });
}

/** 把选中的候选变成要写入的 [{ name, profile }]；名字冲突就加数字，绝不覆盖已有的运行配置 */
function buildImportRuns(config, candidates, ids, options = {}) {
    const runs = { ...(config && config.runs ? config.runs : {}) };
    const built = [];
    for (const id of ids) {
        const item = candidates.find(candidate => candidate.id === id);
        if (!item) throw new Error(`本机没有可导入的 ${id}`);
        if (item.invalid) throw new Error(`${AGENT_ENV_SCHEMA[item.agent].label} 的本机配置不能导入：${item.invalid}`);
        const provider = findProviderByBaseUrl(item.agent, item.baseUrl);
        const name = uniqueRunName(runs, `${item.agent}-${provider ? provider.id : 'local'}`);
        const profile = buildAgentRunProfile(item.agent, item.env, { defaultHostPath: options.defaultHostPath });
        profile.containerName = `my-${name}-{now}`;
        runs[name] = profile;
        built.push({ name, profile });
    }
    return built;
}

module.exports = { IMPORT_AGENTS, scanLocalServices, toPreview, buildImportRuns };
