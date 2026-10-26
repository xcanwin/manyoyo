'use strict';

// 容器导出 / 导入的档位与范围：服务端单一数据源，前端只渲染（GET /api/transfer/preview 下发）。

const path = require('path');

const FORMAT = 1;
const AGENT_HOME = '/root';

// 内容项。always：每档都带，不可取消的核心（取消 agentSessions 会让续接失效，自定义里允许取消，导入时会清掉续接标记）
const ITEMS = [
    { id: 'history', label: '网页聊天记录', hint: '对话、备注、置顶、标题', tiers: ['light', 'standard', 'full'] },
    { id: 'agentSessions', label: 'Agent 会话记录', hint: '换机器后能接着聊的关键', tiers: ['light', 'standard', 'full'] },
    { id: 'settings', label: '容器设置', hint: '环境变量、自启动脚本、系统提示词、网络规则', tiers: ['light', 'standard', 'full'] },
    { id: 'uploads', label: '聊天里的图片', hint: '', tiers: ['standard', 'full'] },
    { id: 'agentExtras', label: 'Agent 其余改动', hint: '技能、MCP、设置、记忆', tiers: ['standard', 'full'] },
    { id: 'workdir', label: '工作目录', hint: '宿主机上的项目文件', tiers: ['standard', 'full'] },
    { id: 'systemLayer', label: '容器里其它改动', hint: '装的软件、全局包；只在镜像版本相同时还原', tiers: ['full'] },
    { id: 'snapshots', label: '按轮回退快照', hint: '可能很大', tiers: ['full'] }
];

const TIERS = [
    { id: 'light', label: '轻量' },
    { id: 'standard', label: '标准', recommended: true },
    { id: 'full', label: '完整' }
];

function itemsForTier(tier) {
    return ITEMS.filter(item => item.tiers.includes(tier)).map(item => item.id);
}

// 勾选集合正好等于某档就返回那一档，否则 'custom'
function matchTier(itemIds) {
    const set = new Set(itemIds);
    for (const tier of TIERS) {
        const expected = itemsForTier(tier.id);
        if (expected.length === set.size && expected.every(id => set.has(id))) return tier.id;
    }
    return 'custom';
}

function normalizeItems(input, tier) {
    const known = new Set(ITEMS.map(item => item.id));
    if (Array.isArray(input)) {
        const picked = [...new Set(input.map(String))];
        const unknown = picked.find(id => !known.has(id));
        if (unknown) throw new Error(`未知的导出内容: ${unknown}`);
        return ITEMS.map(item => item.id).filter(id => picked.includes(id));
    }
    if (!TIERS.some(item => item.id === tier)) throw new Error(`未知的档位: ${tier}`);
    return itemsForTier(tier);
}

// 容器里永远不导出的位置：缓存、临时目录、运行时生成的文件
const EXCLUDED_PREFIXES = [
    '/tmp', '/var/tmp', '/run', '/var/run', '/var/cache', '/var/lib/apt/lists', '/var/log',
    '/root/.cache', '/root/.npm/_cacache', '/root/.codex/.tmp', '/root/.codex/tmp',
    '/proc', '/sys', '/dev',
    '/etc/hosts', '/etc/hostname', '/etc/resolv.conf', '/etc/mtab'
];

// 容器内路径统一成不含 .. 的绝对 POSIX 路径；不是绝对路径返回 null
function normalizeContainerPath(input) {
    if (typeof input !== 'string' || !input.startsWith('/') || input.includes('\0')) return null;
    const normalized = path.posix.normalize(input);
    if (normalized.split('/').includes('..')) return null;
    return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
}

function isUnder(target, base) {
    return target === base || target.startsWith(`${base}/`);
}

function isExcludedPath(containerPath) {
    const p = normalizeContainerPath(containerPath);
    if (!p) return true;
    if (EXCLUDED_PREFIXES.some(prefix => isUnder(p, prefix))) return true;
    return p.split('/').some((segment, index, all) => segment === 'node_modules' && all[index + 1] === '.cache');
}

// Agent 会话记录：续接必需。清单由真实续接实测校准（见 FEEDBACK），少了补、多了无妨
const AGENT_SESSION_PATHS = [
    `${AGENT_HOME}/.claude/projects`,
    `${AGENT_HOME}/.claude.json`,
    `${AGENT_HOME}/.codex/sessions`,
    `${AGENT_HOME}/.codex/archived_sessions`,
    `${AGENT_HOME}/.codex/session_index.jsonl`,
    `${AGENT_HOME}/.gemini/tmp`,
    `${AGENT_HOME}/.local/share/opencode`
];
const AGENT_SESSION_PATTERNS = [/^\/root\/\.codex\/[^/]+\.sqlite[^/]*$/];
// Agent 其余目录：整个目录里相对镜像有变化的文件（会话记录部分已单独归类）
const AGENT_DIRS = [`${AGENT_HOME}/.claude`, `${AGENT_HOME}/.codex`, `${AGENT_HOME}/.gemini`, `${AGENT_HOME}/.config/opencode`, `${AGENT_HOME}/.local/share/opencode`];

function isAgentSessionPath(p) {
    return AGENT_SESSION_PATHS.some(base => isUnder(p, base)) || AGENT_SESSION_PATTERNS.some(re => re.test(p));
}

/**
 * 容器内一个路径属于哪一类：'agentSessions' | 'agentExtras' | 'systemLayer'；永远不导出的返回 null。
 * mounts：容器的挂载点目的地（含其下全部内容都不导出）。
 */
function classifyLayerPath(containerPath, mounts = []) {
    const p = normalizeContainerPath(containerPath);
    if (!p || p === '/') return null;
    if (isExcludedPath(p)) return null;
    for (const mount of mounts) {
        const m = normalizeContainerPath(mount);
        if (m && isUnder(p, m)) return null;
    }
    if (isAgentSessionPath(p)) return 'agentSessions';
    if (AGENT_DIRS.some(base => isUnder(p, base))) return 'agentExtras';
    return 'systemLayer';
}

// 要 cp 的容器内顶层路径（cp 整棵子树，再按 diff 与分类过滤）。enabled：启用的内容项 id 集合
function layerScopes(enabled, diffPaths) {
    const has = id => enabled.has(id);
    const scopes = new Set();
    if (has('agentExtras')) {
        AGENT_DIRS.forEach(dir => scopes.add(dir));
        scopes.add(`${AGENT_HOME}/.claude.json`);
    } else if (has('agentSessions')) {
        [`${AGENT_HOME}/.claude/projects`, `${AGENT_HOME}/.claude.json`, `${AGENT_HOME}/.codex`, `${AGENT_HOME}/.gemini/tmp`, `${AGENT_HOME}/.local/share/opencode`]
            .forEach(dir => scopes.add(dir));
    }
    if (has('systemLayer')) {
        for (const raw of diffPaths) {
            const p = normalizeContainerPath(raw);
            if (!p || classifyLayerPath(p) !== 'systemLayer') continue;
            const parts = p.split('/').filter(Boolean);
            scopes.add(`/${parts.slice(0, Math.min(parts.length, 2)).join('/')}`);
        }
    }
    // 去掉被别的范围包含的
    const list = [...scopes].sort();
    return list.filter(scope => !list.some(other => other !== scope && isUnder(scope, other)));
}

// 解析 `diff` 输出：每行 `A|C|D <绝对路径>`
function parseDiff(output) {
    const added = new Map();
    const deleted = [];
    for (const line of String(output || '').split('\n')) {
        const match = /^([ACD])\s+(\/.*)$/.exec(line.trim());
        if (!match) continue;
        const p = normalizeContainerPath(match[2]);
        if (!p) continue;
        if (match[1] === 'D') deleted.push(p);
        else added.set(p, match[1]);
    }
    return { added, deleted };
}

// 各 Agent 在容器里保存登录凭据的文件：不带密钥导出时必须跳过
const CREDENTIAL_FILES = [
    `${AGENT_HOME}/.claude/.credentials.json`,
    `${AGENT_HOME}/.codex/auth.json`,
    `${AGENT_HOME}/.gemini/oauth_creds.json`,
    `${AGENT_HOME}/.gemini/google_accounts.json`,
    `${AGENT_HOME}/.local/share/opencode/auth.json`,
    `${AGENT_HOME}/.config/opencode/auth.json`
];
const isCredentialFile = p => CREDENTIAL_FILES.includes(p);

// 命令 / 脚本文本里写死的 `NAME=值`（名字含密钥词）：值清空
function redactCommandText(text) {
    return String(text || '').replace(/([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)[A-Za-z0-9_]*=)(?:"[^"]*"|'[^']*'|[^\s"';&|]+)/gi, '$1');
}

// 密钥变量：名字含这些词的值
const SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i;
const isSecretName = name => SECRET_NAME_PATTERN.test(String(name || ''));

module.exports = {
    FORMAT,
    AGENT_HOME,
    ITEMS,
    TIERS,
    EXCLUDED_PREFIXES,
    AGENT_SESSION_PATHS,
    AGENT_DIRS,
    itemsForTier,
    matchTier,
    normalizeItems,
    normalizeContainerPath,
    isExcludedPath,
    isUnder,
    isAgentSessionPath,
    classifyLayerPath,
    layerScopes,
    parseDiff,
    isSecretName,
    isCredentialFile,
    redactCommandText,
    CREDENTIAL_FILES
};
