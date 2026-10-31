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

// /tmp 整体不导出，但 Agent 的浏览器工具把截图、二维码等产物放在这里（用户要看的东西），单独放行
const KEEP_PATHS = ['/tmp/.playwright-cli'];

function isExcludedPath(containerPath) {
    const p = normalizeContainerPath(containerPath);
    if (!p) return true;
    if (KEEP_PATHS.some(keep => isUnder(p, keep))) return false;
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
const AGENT_DIRS = [`${AGENT_HOME}/.claude`, `${AGENT_HOME}/.codex`, `${AGENT_HOME}/.gemini`, `${AGENT_HOME}/.config/opencode`, `${AGENT_HOME}/.local/share/opencode`, ...KEEP_PATHS];

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

// 同一个目录下要单独取的路径超过这个数，就改成取这个目录（每次 cp 都有固定开销，podman 约 0.1 秒；合并会把目录里没改动的内容也读一遍，所以阈值给得比较大）
const SCOPE_MERGE_THRESHOLD = 200;
// cp 范围的总数上限
const MAX_SCOPES = 600;

/**
 * 要 cp 的容器内路径（cp 整棵子树，再按 diff 与分类过滤）。enabled：启用的内容项 id 集合（与分类同名）。
 * 只取真正改动的路径：类型 A 的最上层路径（目录取整棵子树、文件取它自己），
 * 以及没有任何下级改动的 C（被改过的文件）；有下级的 C 是被牵连的父目录，不取。
 * added：Map<路径, 'A'|'C'>；deleted：被删除的路径（它们的父目录也算“有下级改动”）。
 * 同一个目录下要取的太多就改成取这个目录，总数太多就整体往上提一级（每次 cp 都有固定开销，podman 约 0.1 秒）。
 */
function layerScopes(enabled, added = new Map(), deleted = [], options = {}) {
    const threshold = options.mergeThreshold || SCOPE_MERGE_THRESHOLD;
    const maxScopes = options.maxScopes || MAX_SCOPES;
    const mounts = options.mounts || [];
    const kinds = new Map();
    for (const [raw, kind] of added instanceof Map ? added : new Map(added)) {
        const p = normalizeContainerPath(raw);
        const cls = p ? classifyLayerPath(p, mounts) : null;
        if (cls && enabled.has(cls)) kinds.set(p, kind);
    }
    const parents = new Set(options.parents || []);
    for (const p of [...kinds.keys(), ...deleted.map(normalizeContainerPath).filter(Boolean)]) parents.add(path.posix.dirname(p));
    const hasAncestorA = p => {
        for (let dir = path.posix.dirname(p); dir !== '/' && dir !== '.'; dir = path.posix.dirname(dir)) {
            if (kinds.get(dir) === 'A') return true;
        }
        return false;
    };
    let picked = [];
    for (const [p, kind] of kinds) {
        if (kind === 'A' && !hasAncestorA(p)) picked.push(p);
        else if (kind === 'C' && !parents.has(p)) picked.push(p);
    }
    const mergeable = dir => dir !== '/' && classifyLayerPath(dir, mounts) !== null && enabled.has(classifyLayerPath(dir, mounts));
    const groupByParent = list => {
        const byParent = new Map();
        for (const p of list) {
            const dir = path.posix.dirname(p);
            if (!byParent.has(dir)) byParent.set(dir, []);
            byParent.get(dir).push(p);
        }
        return byParent;
    };
    // 同一个目录下要取的太多：合并成取这个目录
    const scopes = new Set();
    for (const [dir, list] of groupByParent(picked)) {
        if (list.length > threshold && mergeable(dir)) scopes.add(dir);
        else list.forEach(p => scopes.add(p));
    }
    // 总数还是太多：整体往上提一级，直到不超过上限或已经只剩三级目录（再往上会把 /usr/lib 这种几个 GB 的目录整个读一遍）
    while (scopes.size > maxScopes) {
        const raised = new Set();
        for (const scope of scopes) {
            const parent = path.posix.dirname(scope);
            raised.add(scope.split('/').filter(Boolean).length > 3 && mergeable(parent) ? parent : scope);
        }
        if (raised.size === scopes.size && [...raised].every(item => scopes.has(item))) break;
        scopes.clear();
        raised.forEach(item => scopes.add(item));
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

const { CREDENTIAL_FILES, isCredentialFile, isSecretName, redactCommandText } = require('./redact');

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
    SCOPE_MERGE_THRESHOLD,
    MAX_SCOPES,
    parseDiff,
    isSecretName,
    isCredentialFile,
    redactCommandText,
    CREDENTIAL_FILES
};
