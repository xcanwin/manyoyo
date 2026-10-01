'use strict';

const { AGENT_ENV_SCHEMA } = require('./init-config');
const { parseEnvEntry } = require('./runtime-normalizers');

const SETUP_AGENTS = Object.keys(AGENT_ENV_SCHEMA);

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function listSetupAgents() {
    return SETUP_AGENTS.map(id => {
        const spec = AGENT_ENV_SCHEMA[id];
        return {
            id,
            label: spec.label,
            yolo: spec.yolo,
            modelKey: spec.modelKey,
            requiredAnyOf: [...spec.requiredAnyOf],
            baseUrlKey: spec.baseUrlKey,
            baseUrlPresets: spec.baseUrlPresets.map(item => ({ ...item })),
            env: spec.env.map(item => ({ ...item }))
        };
    });
}

function hasNonEmptyRequiredKey(spec, env) {
    const source = isPlainObject(env) ? env : {};
    return spec.requiredAnyOf.some(key => typeof source[key] === 'string' && source[key].trim() !== '');
}

// 已有可用 runs.<agent>：run 存在，且必填变量（任意一个）非空
function getConfiguredAgents(config) {
    const runs = isPlainObject(config && config.runs) ? config.runs : {};
    return SETUP_AGENTS.filter(id => isPlainObject(runs[id]) && hasNonEmptyRequiredKey(AGENT_ENV_SCHEMA[id], runs[id].env));
}

/**
 * 校验请求里的 env 并合并到已有 run 上，返回要写入的 runs.<agent> 对象。
 * - agent 必须在 schema 内，env key 必须属于该 agent，值按 parseEnvEntry 校验；
 * - 空字符串表示“不改动/不设置”，已有 run 的其它字段（volumes、ports…）原样保留。
 */
function buildAgentRunProfile(agent, envInput, options = {}) {
    const spec = AGENT_ENV_SCHEMA[agent];
    if (!spec) {
        throw new Error(`不支持的 Agent: ${agent}`);
    }
    if (!isPlainObject(envInput)) {
        throw new Error('env 必须是对象(map)');
    }
    const allowed = new Set(spec.env.map(item => item.name));
    const provided = {};
    for (const [key, rawValue] of Object.entries(envInput)) {
        if (!allowed.has(key)) {
            throw new Error(`${agent} 不支持的变量: ${key}`);
        }
        if (typeof rawValue !== 'string') {
            throw new Error(`env 值必须是字符串: ${key}`);
        }
        const value = rawValue.trim();
        if (!value) continue;
        parseEnvEntry(`${key}=${value}`);
        provided[key] = value;
    }

    const existing = isPlainObject(options.existingRun) ? options.existingRun : {};
    const existingEnv = isPlainObject(existing.env) ? existing.env : {};
    const profile = { ...existing };
    profile.env = { ...existingEnv, ...provided };
    if (!hasNonEmptyRequiredKey(spec, profile.env)) {
        throw new Error(`请填写 ${spec.requiredAnyOf.join(' 或 ')}`);
    }
    if (profile.containerName === undefined) profile.containerName = `my-${agent}-{now}`;
    if (profile.yolo === undefined) profile.yolo = spec.yolo;
    if (options.hostPath) profile.hostPath = options.hostPath;
    else if (profile.hostPath === undefined && options.defaultHostPath) profile.hostPath = options.defaultHostPath;
    return profile;
}

const CONNECTION_RULES = [
    {
        category: 'auth',
        pattern: /\b(401|403)\b|unauthori[sz]ed|invalid[ _-]?(x-)?api[ _-]?key|incorrect api key|authentication[ _](failed|error)|forbidden|permission_denied|invalid[ _]token/i,
        message: '认证失败：Key 或令牌无效，请检查后重新填写'
    },
    {
        category: 'network',
        pattern: /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|fetch failed|getaddrinfo|could not resolve|network (is )?unreachable|connection (refused|reset|timed out)|socket hang up|unable to connect/i,
        message: '网络不可达：无法连接到 API 地址，请检查网络、代理或 Base URL'
    }
];

/**
 * 把容器内最小请求的结果归类为 success / network / auth / other。
 * 返回值只含固定文案和经过脱敏的尾部片段，不回传完整输出。
 */
function classifyConnectionResult(result, secrets = []) {
    const exitCode = result && Number.isInteger(result.exitCode) ? result.exitCode : 1;
    const output = String(result && result.output || '');
    if (exitCode === 0) {
        return { category: 'success', message: '连接成功', detail: '' };
    }
    const detail = redactSecrets(output.trim().slice(-300), secrets);
    if (exitCode === 124) {
        return { category: 'network', message: '请求超时：60 秒内没有得到响应，请检查网络、代理或 Base URL', detail };
    }
    for (const rule of CONNECTION_RULES) {
        if (rule.pattern.test(output)) {
            return { category: rule.category, message: rule.message, detail };
        }
    }
    return { category: 'other', message: '测试失败，请查看详情', detail };
}

function redactSecrets(text, secrets = []) {
    let result = String(text || '');
    for (const secret of secrets) {
        const value = String(secret || '');
        if (value.length >= 4) {
            result = result.split(value).join('****');
        }
    }
    return result
        .replace(/\b(sk|pk|key)-[A-Za-z0-9_-]{8,}/g, '$1-****')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1****')
        .replace(/(api[_-]?key["'=:\s]+)[A-Za-z0-9._-]{8,}/gi, '$1****');
}

// 软件源预设（单一数据源，经 /api/setup/agents 下发给向导）；“官方默认”与“自定义”由前端补。
// apt 只填镜像站主机（保留 /ubuntu、/ubuntu-ports 路径）。value 都必须通过 normalizeMirrors。
const MIRROR_PRESETS = {
    apt: [
        { label: '阿里云', value: 'https://mirrors.aliyun.com' },
        { label: '清华', value: 'https://mirrors.tuna.tsinghua.edu.cn' },
        { label: '中科大', value: 'https://mirrors.ustc.edu.cn' },
        { label: '腾讯云', value: 'https://mirrors.tencent.com' }
    ],
    npm: [
        { label: '阿里云', value: 'https://registry.npmmirror.com/' },
        { label: '腾讯云', value: 'https://mirrors.tencent.com/npm/' },
        { label: '华为云', value: 'https://repo.huaweicloud.com/repository/npm/' }
    ],
    pip: [
        { label: '阿里云', value: 'https://mirrors.aliyun.com/pypi/simple/' },
        { label: '清华', value: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
        { label: '中科大', value: 'https://pypi.mirrors.ustc.edu.cn/simple/' },
        { label: '腾讯云', value: 'https://mirrors.tencent.com/pypi/simple' }
    ]
};

function listMirrorPresets() {
    return Object.fromEntries(Object.entries(MIRROR_PRESETS).map(([tool, items]) => [tool, items.map(item => ({ ...item }))]));
}

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

// 返回空字符串表示通过，否则是给用户看的原因
function validateSetupPassword(password) {
    if (typeof password !== 'string') {
        return '请填写登录密码';
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
        return `密码至少 ${PASSWORD_MIN_LENGTH} 位`;
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
        return `密码不能超过 ${PASSWORD_MAX_LENGTH} 位`;
    }
    if (/[\u0000-\u001f\u007f]/.test(password)) {
        return '密码不能包含换行、制表符等控制字符';
    }
    return '';
}

module.exports = {
    MIRROR_PRESETS,
    listMirrorPresets,
    PASSWORD_MIN_LENGTH,
    PASSWORD_MAX_LENGTH,
    validateSetupPassword,
    SETUP_AGENTS,
    listSetupAgents,
    getConfiguredAgents,
    buildAgentRunProfile,
    classifyConnectionResult,
    redactSecrets
};
