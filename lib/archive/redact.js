'use strict';

// 导出时“不带密钥”的全部规则（纯函数）：
// ① 凭据文件整份跳过；② 配置文件按字段清空；③ 变量名识别；④ 已知密钥的值与常见密钥格式从文本里抹掉。
// 工作目录里的文件不处理（项目自己的 .env 原样带上，弹窗与文档如实写明）。

const AGENT_HOME = '/root';

// 各 Agent / 常用工具保存登录凭据的文件：不带密钥导出时整份跳过
const CREDENTIAL_FILES = [
    `${AGENT_HOME}/.claude/.credentials.json`,
    `${AGENT_HOME}/.codex/auth.json`,
    `${AGENT_HOME}/.gemini/oauth_creds.json`,
    `${AGENT_HOME}/.gemini/google_accounts.json`,
    `${AGENT_HOME}/.local/share/opencode/auth.json`,
    `${AGENT_HOME}/.config/opencode/auth.json`,
    `${AGENT_HOME}/.npmrc`,
    `${AGENT_HOME}/.git-credentials`,
    `${AGENT_HOME}/.netrc`,
    `${AGENT_HOME}/.docker/config.json`,
    `${AGENT_HOME}/.pypirc`,
    `${AGENT_HOME}/.aws/credentials`,
    `${AGENT_HOME}/.kube/config`,
    `${AGENT_HOME}/.config/gh/hosts.yml`
];
const SSH_DIR = `${AGENT_HOME}/.ssh`;
const SSH_PUBLIC_NAMES = new Set(['known_hosts', 'config']);

function isCredentialFile(p) {
    if (CREDENTIAL_FILES.includes(p)) return true;
    if (p.startsWith(`${SSH_DIR}/`)) {
        const rest = p.slice(SSH_DIR.length + 1);
        const base = rest.split('/').pop();
        // .ssh 下除公钥、known_hosts、config 以外的全部文件（私钥、authorized_keys、证书…）
        return !(base.endsWith('.pub') || (!rest.includes('/') && SSH_PUBLIC_NAMES.has(base)));
    }
    return false;
}

// 命令 / 脚本文本里写死的 `NAME=值`
const SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE|COOKIE|SESSION)/i;
const SECRET_NAME_WORDS = new Set(['PWD', 'PASS', 'PAT']);

function isSecretName(name) {
    const text = String(name || '');
    if (SECRET_NAME_PATTERN.test(text)) return true;
    // PWD / PASS / PAT 只认整词（PATH、PASSENGER 不算）
    return text.toUpperCase().split(/[^A-Z0-9]+/).some(part => SECRET_NAME_WORDS.has(part));
}

const SECRET_ASSIGN = /([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE|COOKIE|SESSION|PWD|PASS|PAT)[A-Za-z0-9_]*=)(?:"[^"]*"|'[^']*'|[^\s"';&|]+)/gi;

// `scheme://user:pass@host` 里的密码一律去掉（不管变量名是什么）
const URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@"']+):[^\s/@"']*@/g;
function stripUrlPassword(text) {
    return String(text || '').replace(URL_USERINFO, '$1@');
}
function urlPasswords(text) {
    const out = [];
    String(text || '').replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@"']+:([^\s/@"']+)@/g, (all, pass) => { out.push(pass); return all; });
    return out;
}

function redactCommandText(text) {
    return stripUrlPassword(String(text || '').replace(SECRET_ASSIGN, (all, head) => {
        // 变量名里恰好含 PAT / PASS / PWD 的需要是整词，否则不动（如 PATH=…）
        const name = head.slice(0, -1);
        return isSecretName(name) ? head : all;
    }));
}

function redactEnvValue(key, value) {
    return isSecretName(key) ? '' : stripUrlPassword(value);
}

function redactEnvMap(map) {
    if (!map || typeof map !== 'object') return map;
    const out = {};
    for (const [key, value] of Object.entries(map)) out[key] = typeof value === 'string' ? redactEnvValue(key, value) : value;
    return out;
}

// 一份 env 里需要抹掉的值：密钥变量的值，以及其它变量里 URL 的密码
function secretValuesOfEnv(map) {
    const out = [];
    if (!map || typeof map !== 'object') return out;
    for (const [key, value] of Object.entries(map)) {
        if (typeof value !== 'string' || !value) continue;
        if (isSecretName(key)) out.push(value);
        else out.push(...urlPasswords(value));
    }
    return out;
}

// ---------- 按字段改写的配置文件 ----------

const FIELD_REWRITE_FILES = [
    `${AGENT_HOME}/.claude/settings.json`,
    `${AGENT_HOME}/.claude.json`,
    `${AGENT_HOME}/.codex/config.toml`
];
const isFieldRewriteFile = p => FIELD_REWRITE_FILES.includes(p);

// 各级 mcpServers.<名>.env / headers 里的密钥（claude mcp add 写在 .claude.json 的 projects.<路径>.mcpServers 里）
function redactMcpServers(node, removed, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    for (const [key, value] of Object.entries(node)) {
        if (key === 'mcpServers' && value && typeof value === 'object') {
            for (const server of Object.values(value)) {
                if (server && typeof server === 'object') {
                    redactJsonEnvBlock(server.env, removed);
                    redactJsonEnvBlock(server.headers, removed);
                }
            }
        } else if (value && typeof value === 'object') {
            redactMcpServers(value, removed, depth + 1);
        }
    }
}

function redactJsonEnvBlock(obj, removed) {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string' && value && isSecretName(key)) {
            removed.push(value);
            obj[key] = '';
        } else if (typeof value === 'string') {
            removed.push(...urlPasswords(value));
            obj[key] = stripUrlPassword(value);
        }
    }
}

// 只处理“名字像密钥、值是带引号的字符串”的行；数字（如 model_auto_compact_token_limit = 200000）和“指向环境变量名”的行（env_key = "OPENAI_API_KEY"）不动
const TOML_SECRET_LINE = /^(\s*)([A-Za-z0-9_.-]*(?:token|key|secret)[A-Za-z0-9_.-]*)(\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')(.*)$/i;
const TOML_ENV_NAME_KEY = /(^|[_.-])env([_.-]key)?$/i;

/**
 * 改写配置文件里的密钥字段，保留文件本身。返回 { text, removed: [被清掉的值] }；解析不了的 JSON 原样返回（交给后面的按值抹除）。
 */
function redactFieldFile(abs, text) {
    const removed = [];
    if (abs === `${AGENT_HOME}/.claude/settings.json`) {
        let data;
        try { data = JSON.parse(text); } catch (error) { return { text, removed }; }
        if (data && typeof data === 'object') {
            redactJsonEnvBlock(data.env, removed);
            redactMcpServers(data, removed);
        }
        return { text: `${JSON.stringify(data, null, 2)}\n`, removed };
    }
    if (abs === `${AGENT_HOME}/.claude.json`) {
        let data;
        try { data = JSON.parse(text); } catch (error) { return { text, removed }; }
        if (data && typeof data === 'object') {
            if (typeof data.primaryApiKey === 'string' && data.primaryApiKey) { removed.push(data.primaryApiKey); data.primaryApiKey = ''; }
            if (data.customApiKeyResponses && typeof data.customApiKeyResponses === 'object') {
                for (const list of Object.values(data.customApiKeyResponses)) if (Array.isArray(list)) removed.push(...list.filter(item => typeof item === 'string'));
                data.customApiKeyResponses = { approved: [], rejected: [] };
            }
            redactMcpServers(data, removed);
        }
        return { text: JSON.stringify(data), removed };
    }
    if (abs === `${AGENT_HOME}/.codex/config.toml`) {
        const lines = String(text).split('\n').map(line => {
            const match = TOML_SECRET_LINE.exec(line);
            if (!match || TOML_ENV_NAME_KEY.test(match[2])) return line;
            const value = match[4].slice(1, -1);
            if (value) removed.push(value);
            return `${match[1]}${match[2]}${match[3]}""${match[5]}`;
        });
        return { text: lines.join('\n'), removed };
    }
    return { text, removed };
}

// ---------- 按值 / 按格式抹除 ----------

// 前面不能紧挨字母数字：risk-assessment-framework-docs 之类的普通词不是密钥
const SECRET_PATTERNS = [
    /(?<![A-Za-z0-9])sk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/g,
    /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{20,}/g,
    /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
    /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g,
    /(?<![A-Za-z0-9])xox[abp]-[A-Za-z0-9-]{10,}/g,
    /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];
const MIN_SECRET_LENGTH = 8;

// 路径（SSH_AUTH_SOCK=/run/...）和不带账号的网址不是密钥，名字里带 AUTH 也不能把它们从聊天记录里整段删掉
const isScrubbable = value => typeof value === 'string' && value.length >= MIN_SECRET_LENGTH && !value.startsWith('/') && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s@]*$/.test(value);

class SecretScrubber {
    constructor(values = []) {
        this.values = new Set();
        this.add(values);
    }

    add(values) {
        for (const value of values) if (isScrubbable(value)) this.values.add(value);
    }

    get size() {
        return this.values.size;
    }

    // 把已知的值（JSON 转义后的写法和原文都要）和常见密钥格式替换成空串
    scrub(text) {
        let out = String(text);
        const ordered = [...this.values].sort((a, b) => b.length - a.length);
        for (const value of ordered) {
            const escaped = JSON.stringify(value).slice(1, -1);
            if (escaped !== value && out.includes(escaped)) out = out.split(escaped).join('');
            if (out.includes(value)) out = out.split(value).join('');
        }
        for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '');
        return out;
    }
}

// 开头 8KB 里有 NUL 就当二进制（sqlite、图片等），不做文本替换
function isProbablyText(buffer) {
    const head = buffer.subarray(0, 8192);
    return !head.includes(0);
}

module.exports = {
    AGENT_HOME,
    CREDENTIAL_FILES,
    FIELD_REWRITE_FILES,
    SecretScrubber,
    isCredentialFile,
    isFieldRewriteFile,
    isProbablyText,
    isSecretName,
    redactCommandText,
    redactEnvMap,
    redactEnvValue,
    redactFieldFile,
    secretValuesOfEnv,
    stripUrlPassword,
    urlPasswords
};
