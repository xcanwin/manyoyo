'use strict';

// 「模型服务」：一套模型服务 = 一个 runs.<名>（Key 写在它的 env 里），不新增配置结构。
// 这里只放纯逻辑：认出已有的服务、给出“这个 Key 也能给另一个 Agent 用”的建议、构造要写入的配置改动；
// 读写文件与接口在 lib/web/model-services.js，写盘走 lib/setup-config + lib/secure-file。
const { AGENT_ENV_SCHEMA } = require('./init-config');
const { parseEnvEntry } = require('./runtime-normalizers');
const { providersForAgent, findProviderByBaseUrl } = require('./provider-presets');
const { identifyRunAgent, buildAgentRunProfile } = require('./setup');
const { upsertValueByPath, removeValueByPath } = require('./json5-text-edit');

const RUN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
// 订阅登录用的长期令牌；保存它时要删掉同一个运行配置里会盖过订阅的 API Key 类变量（Claude Code 同时有 Key 时优先用 Key）
const CLAUDE_OAUTH_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';
const CLAUDE_API_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function envText(env, key) {
    const value = isPlainObject(env) ? env[key] : undefined;
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function keyTail(secret) {
    const text = String(secret || '');
    return text.length >= 8 ? `…${text.slice(-4)}` : (text ? '…' : '');
}

// 这个运行配置里实际生效的凭据变量：按 schema 的优先顺序取第一个非空的
function findKey(spec, env) {
    for (const name of spec.requiredAnyOf) {
        const value = envText(env, name);
        if (value) return { name, value };
    }
    return null;
}

/** 列出已有的模型服务；响应里只有 Key 的末 4 位，绝不带出 Key 本身 */
function listModelServices(config) {
    const runs = isPlainObject(config && config.runs) ? config.runs : {};
    const services = [];
    for (const [name, run] of Object.entries(runs)) {
        const agent = identifyRunAgent(name, run);
        if (!agent) continue;
        const spec = AGENT_ENV_SCHEMA[agent];
        const env = isPlainObject(run) ? run.env : null;
        const key = findKey(spec, env);
        if (!key) continue;
        const baseUrl = envText(env, spec.baseUrlKey);
        const provider = findProviderByBaseUrl(agent, baseUrl);
        const subscription = key.name === CLAUDE_OAUTH_KEY;
        // 这家服务必需的附加变量里，运行配置里还没有（或值不对）的：界面据此提示“一键修复”
        const missingExtraEnv = {};
        if (provider && !subscription) {
            for (const [extraKey, extraValue] of Object.entries(provider.extraEnv || {})) {
                if (envText(env, extraKey) !== extraValue) missingExtraEnv[extraKey] = extraValue;
            }
        }
        services.push({
            name,
            agent,
            agentLabel: spec.label,
            providerId: provider ? provider.id : '',
            providerLabel: subscription ? '订阅登录' : (provider ? provider.label : (baseUrl ? '自定义地址' : '官方')),
            authMode: subscription ? 'subscription' : 'key',
            baseUrl,
            keyEnv: key.name,
            keyTail: keyTail(key.value),
            model: envText(env, spec.modelKey),
            missingExtraEnv
        });
    }
    return services;
}

function keyValueOf(config, name) {
    const run = config.runs && config.runs[name];
    const agent = identifyRunAgent(name, run);
    const found = agent ? findKey(AGENT_ENV_SCHEMA[agent], run.env) : null;
    return found ? found.value : '';
}

/** “这个 Key 也能给另一个 Agent 用”：同一服务商在另一个 Agent 上有预设、且还没有用同一个 Key 的服务 */
function suggestReuse(config) {
    const services = listModelServices(config);
    const seen = new Set(services.map(item => `${item.agent}|${item.providerId}|${keyValueOf(config, item.name)}`));
    const suggestions = [];
    for (const item of services) {
        if (!item.providerId || item.authMode !== 'key') continue;
        const secret = keyValueOf(config, item.name);
        for (const target of ['claude', 'codex']) {
            if (target === item.agent) continue;
            if (!providersForAgent(target).some(p => p.id === item.providerId)) continue;
            const id = `${target}|${item.providerId}|${secret}`;
            if (seen.has(id)) continue;
            seen.add(id);
            suggestions.push({
                from: item.name,
                agent: target,
                providerId: item.providerId,
                label: `${item.providerLabel} 的 Key 也能给 ${AGENT_ENV_SCHEMA[target].label} 用`
            });
        }
    }
    return suggestions;
}

function uniqueRunName(runs, base) {
    const taken = isPlainObject(runs) ? runs : {};
    const root = String(base).replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 36) || 'model';
    if (!taken[root]) return root;
    for (let i = 2; i < 1000; i += 1) {
        if (!taken[`${root}-${i}`]) return `${root}-${i}`;
    }
    throw new Error('无法生成不重名的名字');
}

function assertRunName(name) {
    if (!RUN_NAME_PATTERN.test(String(name || ''))) {
        throw new Error('名字只能包含字母、数字、下划线、点和横线，且以字母或数字开头，最长 40 个字符');
    }
}

function presetFor(agent, providerId) {
    const preset = providersForAgent(agent).find(item => item.id === providerId);
    if (!preset) throw new Error(`${AGENT_ENV_SCHEMA[agent].label} 没有这个服务商的预设`);
    return preset;
}

/**
 * 新增一套服务，返回要写入的 { name, profile }；绝不覆盖已有的运行配置。
 * input：{ agent, providerId | baseUrl, key, model?, name?, subscription? }
 */
function buildNewService(config, input, options = {}) {
    const agent = String(input.agent || '').trim();
    const spec = AGENT_ENV_SCHEMA[agent];
    if (!spec) throw new Error(`不支持的 Agent: ${agent}`);
    const runs = isPlainObject(config && config.runs) ? config.runs : {};
    const secret = String(input.key || '').trim();
    if (!secret) throw new Error(input.subscription ? '请粘贴订阅令牌' : '请填写 API Key');

    const env = {};
    let baseName = agent;
    if (input.subscription) {
        if (agent !== 'claude') throw new Error('订阅登录令牌目前只支持 Claude Code');
        env[CLAUDE_OAUTH_KEY] = secret;
        baseName = `${agent}-subscription`;
    } else if (input.providerId) {
        const preset = presetFor(agent, String(input.providerId));
        env[preset.keyEnv] = secret;
        env[spec.baseUrlKey] = preset.baseUrl;
        const model = String(input.model || '').trim() || preset.defaultModel;
        if (model) env[spec.modelKey] = model;
        Object.assign(env, preset.extraEnv);
        baseName = `${agent}-${preset.id}`;
    } else {
        const baseUrl = String(input.baseUrl || '').trim();
        if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
        env[spec.requiredAnyOf.find(name => !name.includes('OAUTH')) || spec.requiredAnyOf[0]] = secret;
        if (baseUrl) env[spec.baseUrlKey] = baseUrl;
        const model = String(input.model || '').trim();
        if (model) env[spec.modelKey] = model;
        baseName = `${agent}-custom`;
    }
    if (agent === 'codex' && env[spec.baseUrlKey] && !env[spec.modelKey]) {
        throw new Error('Codex 接兼容服务必须填写模型名');
    }
    const name = input.name ? String(input.name).trim() : uniqueRunName(runs, baseName);
    assertRunName(name);
    if (runs[name]) throw new Error(`已有名为 ${name} 的运行配置，请换一个名字`);
    const profile = buildAgentRunProfile(agent, env, { defaultHostPath: options.defaultHostPath });
    profile.containerName = `my-${name}-{now}`;
    return { name, profile };
}

/** 把已有服务的 Key 复用给另一个 Agent（同一服务商）。返回 { name, profile } */
function buildReuseService(config, fromName, targetAgent, options = {}) {
    const services = listModelServices(config);
    const source = services.find(item => item.name === fromName);
    if (!source) throw new Error(`找不到模型服务: ${fromName}`);
    if (!source.providerId || source.authMode !== 'key') throw new Error('这个服务不能直接复用给别的 Agent');
    const built = buildNewService(config, {
        agent: targetAgent,
        providerId: source.providerId,
        key: keyValueOf(config, fromName)
    }, options);
    const sourceRun = config.runs[fromName];
    if (typeof sourceRun.hostPath === 'string' && sourceRun.hostPath && !built.profile.hostPath) {
        built.profile.hostPath = sourceRun.hostPath;
    }
    return built;
}

/**
 * 编辑已有服务：key 留空表示不改。返回配置改动列表 ops（set / remove，路径从根开始）。
 * 订阅令牌：换成订阅令牌时删掉同一个运行配置里的 API Key 类变量和 Base URL。
 */
function buildServiceEdit(config, name, patch) {
    const runs = isPlainObject(config && config.runs) ? config.runs : {};
    const run = runs[name];
    const agent = identifyRunAgent(name, run);
    if (!agent) throw new Error(`找不到模型服务: ${name}`);
    const spec = AGENT_ENV_SCHEMA[agent];
    const current = findKey(spec, run.env);
    const ops = [];
    const setEnv = (key, value) => {
        parseEnvEntry(`${key}=${value}`);
        ops.push({ type: 'set', path: ['runs', name, 'env', key], value: String(value) });
    };
    if (patch.applyPresetExtras) {
        const service = listModelServices(config).find(item => item.name === name);
        for (const [key, value] of Object.entries(service ? service.missingExtraEnv : {})) setEnv(key, value);
    }
    const secret = String(patch.key || '').trim();
    if (secret) {
        if (patch.subscription) {
            if (agent !== 'claude') throw new Error('订阅登录令牌目前只支持 Claude Code');
            setEnv(CLAUDE_OAUTH_KEY, secret);
            [...CLAUDE_API_KEYS, spec.baseUrlKey].forEach(key => {
                if (isPlainObject(run.env) && key in run.env) ops.push({ type: 'remove', path: ['runs', name, 'env', key] });
            });
        } else {
            setEnv(current && current.name !== CLAUDE_OAUTH_KEY ? current.name : spec.requiredAnyOf.find(n => !n.includes('OAUTH')), secret);
        }
    }
    if (patch.baseUrl !== undefined) {
        const baseUrl = String(patch.baseUrl).trim();
        if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
        if (baseUrl) setEnv(spec.baseUrlKey, baseUrl);
        else if (isPlainObject(run.env) && spec.baseUrlKey in run.env) ops.push({ type: 'remove', path: ['runs', name, 'env', spec.baseUrlKey] });
    }
    if (patch.model !== undefined) {
        const model = String(patch.model).trim();
        if (model) setEnv(spec.modelKey, model);
        else if (isPlainObject(run.env) && spec.modelKey in run.env) ops.push({ type: 'remove', path: ['runs', name, 'env', spec.modelKey] });
    }
    return { agent, ops };
}

// 把改动列表落到配置原文上（局部替换，保留注释和其它字段）
function applyConfigOps(baseRaw, ops) {
    let raw = baseRaw;
    for (const op of ops) {
        raw = op.type === 'remove'
            ? removeValueByPath(raw, op.path)
            : upsertValueByPath(raw, op.path, JSON.stringify(op.value, null, 4));
    }
    return raw;
}

module.exports = {
    RUN_NAME_PATTERN,
    listModelServices,
    suggestReuse,
    buildNewService,
    buildReuseService,
    buildServiceEdit,
    applyConfigOps,
    assertRunName,
    keyValueOf,
    uniqueRunName
};
