'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeConfigFileSecure } = require('./secure-file');

// 宿主级共享技能 / MCP 的唯一存储（~/.manyoyo/extensions）。不依赖容器运行时：
// 校验、脱敏、读写都集中在这里，Web 接口与容器下发共用。
// 目录：skills/{common,claude,codex}/<name>/SKILL.md；mcp.json（0600）；state/<容器 id>.json（下发记录）。
const AGENTS = ['common', 'claude', 'codex'];
const MCP_AGENTS = ['claude', 'codex'];
const TRANSPORTS = ['stdio', 'http', 'sse'];
const KEEP = '__KEEP__';
const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_SKILLS = 200;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_MCP = 100;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY_RE = /^[A-Za-z0-9-]+$/;

function extensionsDir(homeDir) {
    return path.join(homeDir, '.manyoyo', 'extensions');
}

function pathsOf(homeDir) {
    const dir = extensionsDir(homeDir);
    return {
        dir,
        skills: path.join(dir, 'skills'),
        mcp: path.join(dir, 'mcp.json'),
        state: path.join(dir, 'state')
    };
}

/** 共享技能目录存在时才挂载（docker 对不存在的 bind 源会报错） */
function skillsMountDir(homeDir) {
    const dir = pathsOf(homeDir).skills;
    try {
        return fs.statSync(dir).isDirectory() ? dir : '';
    } catch (e) {
        return '';
    }
}

function ensureDir(dir, mode = 0o700) {
    fs.mkdirSync(dir, { recursive: true, mode });
    try { fs.chmodSync(dir, mode); } catch (e) { /* 尽力 */ }
}

function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, max) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .slice(0, max);
}

function assertName(name) {
    const text = String(name === undefined || name === null ? '' : name);
    if (!NAME_RE.test(text)) throw new Error('技能名只能包含字母、数字、下划线和短横线（1-64 位）');
    return text;
}

function assertAgent(agent) {
    if (!AGENTS.includes(agent)) throw new Error('agent 只支持 common / claude / codex');
    return agent;
}

function assertMcpAgent(agent) {
    if (!MCP_AGENTS.includes(agent)) throw new Error('MCP 只支持 claude / codex');
    return agent;
}

function skillDirOf(homeDir, agent, name) {
    return path.join(pathsOf(homeDir).skills, assertAgent(agent), assertName(name));
}

function parseFrontmatter(content) {
    const text = String(content || '');
    const matched = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!matched) return {};
    const fields = {};
    matched[1].split('\n').forEach(line => {
        const pair = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
        if (pair && !(pair[1] in fields)) fields[pair[1]] = pair[2].replace(/^["']|["']$/g, '');
    });
    return fields;
}

function readSkillFile(homeDir, agent, name) {
    const dir = skillDirOf(homeDir, agent, name);
    const file = path.join(dir, 'SKILL.md');
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error('SKILL.md 不是普通文件');
    if (stat.size > MAX_SKILL_BYTES) throw new Error('SKILL.md 超过 1 MB');
    return fs.readFileSync(file, 'utf-8');
}

function listSkills(homeDir) {
    const root = pathsOf(homeDir).skills;
    const out = [];
    let total = 0;
    AGENTS.forEach(agent => {
        let entries = [];
        try {
            entries = fs.readdirSync(path.join(root, agent), { withFileTypes: true });
        } catch (e) {
            return;
        }
        entries.forEach(entry => {
            if (!entry.isDirectory() || !NAME_RE.test(entry.name)) return;
            if (out.length >= MAX_SKILLS) return;
            try {
                const file = path.join(root, agent, entry.name, 'SKILL.md');
                const stat = fs.lstatSync(file);
                if (!stat.isFile()) return;
                total += stat.size;
                if (total > MAX_TOTAL_BYTES) return;
                const fields = parseFrontmatter(fs.readFileSync(file, 'utf-8').slice(0, 4096));
                out.push({
                    agent,
                    name: entry.name,
                    description: cleanText(fields.description, 200),
                    updatedAt: stat.mtime.toISOString(),
                    // 目录名与 frontmatter 的 name 不一致时提示（真实 Agent 可能不认）
                    nameMismatch: Boolean(fields.name && fields.name !== entry.name)
                });
            } catch (e) { /* 读不了就跳过 */ }
        });
    });
    return out;
}

function readSkill(homeDir, agent, name) {
    const content = readSkillFile(homeDir, agent, name);
    const fields = parseFrontmatter(content.slice(0, 4096));
    return { name, agent, description: cleanText(fields.description, 200), content, nameMismatch: Boolean(fields.name && fields.name !== name) };
}

function writeSkill(homeDir, agent, name, content) {
    const text = String(content === undefined || content === null ? '' : content);
    if (!text.trim()) throw new Error('SKILL.md 不能为空');
    if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw new Error('SKILL.md 超过 1 MB');
    if (listSkills(homeDir).length >= MAX_SKILLS) throw new Error(`技能最多 ${MAX_SKILLS} 个`);
    const dir = skillDirOf(homeDir, agent, name);
    if (fs.existsSync(dir) && !fs.lstatSync(dir).isDirectory()) throw new Error('同名路径已存在且不是目录');
    ensureDir(dir);
    writeConfigFileSecure(path.join(dir, 'SKILL.md'), text);
    const fields = parseFrontmatter(text.slice(0, 4096));
    return { name, agent, description: cleanText(fields.description, 200), nameMismatch: Boolean(fields.name && fields.name !== name) };
}

function deleteSkill(homeDir, agent, name) {
    const dir = skillDirOf(homeDir, agent, name);
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) throw new Error('技能路径不是目录');
    fs.rmSync(dir, { recursive: true, force: true });
}

function emptyMcpStore() {
    return { version: 1, servers: [] };
}

function readMcpStore(homeDir) {
    const file = pathsOf(homeDir).mcp;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const servers = Array.isArray(parsed && parsed.servers) ? parsed.servers : [];
        return { version: 1, servers: servers.filter(isPlainObject).slice(0, MAX_MCP) };
    } catch (e) {
        return emptyMcpStore();
    }
}

function writeMcpStore(homeDir, store) {
    const p = pathsOf(homeDir);
    ensureDir(p.dir);
    writeConfigFileSecure(p.mcp, `${JSON.stringify({ version: 1, servers: store.servers }, null, 2)}\n`);
}

function maskSecret(value) {
    const text = String(value === undefined || value === null ? '' : value);
    return text.length > 4 ? `****${text.slice(-4)}` : '****';
}

function maskedEntries(map) {
    return Object.keys(isPlainObject(map) ? map : {}).map(key => ({ key, masked: maskSecret(map[key]) }));
}

function publicMcp(server) {
    return {
        id: server.id,
        name: server.name,
        agents: server.agents,
        transport: server.transport,
        enabled: server.enabled !== false,
        hasEnv: Object.keys(server.env || {}).length > 0,
        hasHeaders: Object.keys(server.headers || {}).length > 0,
        updatedAt: server.updatedAt || null
    };
}

function listMcp(homeDir) {
    return readMcpStore(homeDir).servers.map(publicMcp);
}

function urlOrigin(value) {
    try {
        const url = new URL(String(value || ''));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
        return `${url.protocol}//${url.host}`;
    } catch (e) {
        return '';
    }
}

function validateUrl(value) {
    let url;
    try {
        url = new URL(String(value || ''));
    } catch (e) {
        throw new Error('URL 格式不对');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL 只支持 http / https');
    if (url.username || url.password) throw new Error('URL 里不能带用户名密码，请改用 headers 或 bearerTokenEnvVar');
    return url.toString();
}

function normalizeSecretEntries(input, keyRe, label) {
    if (input === undefined || input === null) return undefined;
    if (!Array.isArray(input)) throw new Error(`${label} 必须是数组`);
    const out = [];
    const seen = new Set();
    for (const entry of input) {
        if (!isPlainObject(entry)) throw new Error(`${label} 的条目必须是对象`);
        const key = String(entry.key === undefined || entry.key === null ? '' : entry.key).trim();
        if (!keyRe.test(key)) throw new Error(`${label} 的 key 非法: ${cleanText(key, 40)}`);
        if (seen.has(key)) throw new Error(`${label} 的 key 重复: ${key}`);
        seen.add(key);
        const value = entry.value;
        if (value === undefined || value === null || value === KEEP) {
            out.push({ key, keep: true });
            continue;
        }
        out.push({ key, value: cleanText(value, 4096) });
    }
    return out;
}

function mergeSecrets(previous, entries) {
    if (entries === undefined) return { ...(previous || {}) };
    const out = {};
    entries.forEach(entry => {
        if (entry.keep) {
            if (isPlainObject(previous) && Object.prototype.hasOwnProperty.call(previous, entry.key)) out[entry.key] = previous[entry.key];
        } else if (entry.value !== '') {
            out[entry.key] = entry.value;
        }
    });
    return out;
}

function normalizeMcpInput(input, previous) {
    if (!isPlainObject(input)) throw new Error('请求体必须是对象');
    const name = String(input.name === undefined || input.name === null ? '' : input.name);
    if (!MCP_NAME_RE.test(name)) throw new Error('MCP 名称只能包含字母、数字、点、下划线和短横线（1-64 位）');
    const agents = Array.isArray(input.agents) ? input.agents.map(assertMcpAgent) : [];
    if (!agents.length) throw new Error('agents 至少选一个');
    const transport = String(input.transport || 'stdio');
    if (!TRANSPORTS.includes(transport)) throw new Error('transport 只支持 stdio / http / sse');
    if (transport === 'sse' && (agents.length !== 1 || agents[0] !== 'claude')) throw new Error('SSE 只支持 Claude');
    const headers = mergeSecrets(previous && previous.headers, normalizeSecretEntries(input.headers, HEADER_KEY_RE, 'headers'));
    const env = mergeSecrets(previous && previous.env, normalizeSecretEntries(input.env, ENV_KEY_RE, 'env'));
    const out = {
        id: previous && previous.id ? previous.id : crypto.randomBytes(8).toString('hex'),
        name,
        agents,
        transport,
        command: '',
        args: [],
        env,
        url: '',
        headers,
        bearerTokenEnvVar: '',
        enabled: input.enabled !== false,
        updatedAt: new Date().toISOString()
    };
    if (transport === 'stdio') {
        out.command = cleanText(input.command, 256).trim();
        if (!out.command) throw new Error('stdio 必须填 command');
        const args = input.args === undefined ? [] : input.args;
        if (!Array.isArray(args) || args.length > 64) throw new Error('args 必须是不超过 64 项的数组');
        out.args = args.map(arg => cleanText(arg, 1024));
    } else {
        if (Object.keys(env).length) throw new Error('只有 stdio 能带 env');
        // 编辑时留空 = 保留原 URL
        const rawUrl = input.url === undefined || input.url === '' ? (previous && previous.url) || '' : input.url;
        out.url = validateUrl(rawUrl);
        if (transport === 'http' && agents.includes('codex') && Object.keys(headers).length) {
            throw new Error('Codex 的 HTTP MCP 不支持自定义 headers，请改用 bearerTokenEnvVar');
        }
        if (transport === 'http') {
            out.bearerTokenEnvVar = cleanText(input.bearerTokenEnvVar === undefined ? (previous && previous.bearerTokenEnvVar) || '' : input.bearerTokenEnvVar, 128).trim();
            if (out.bearerTokenEnvVar && !ENV_KEY_RE.test(out.bearerTokenEnvVar)) throw new Error('bearerTokenEnvVar 必须是环境变量名');
        }
    }
    return out;
}

function getMcpInternal(homeDir, id) {
    const server = readMcpStore(homeDir).servers.find(item => item.id === id);
    return server || null;
}

function getMcp(homeDir, id) {
    const server = getMcpInternal(homeDir, id);
    if (!server) return null;
    return {
        id: server.id,
        name: server.name,
        agents: server.agents,
        transport: server.transport,
        command: server.command,
        args: server.args,
        // 只回 origin：path / query 里可能有令牌
        url: urlOrigin(server.url),
        bearerTokenEnvVar: server.bearerTokenEnvVar,
        enabled: server.enabled !== false,
        env: maskedEntries(server.env),
        headers: maskedEntries(server.headers)
    };
}

function saveMcp(homeDir, input, id) {
    const store = readMcpStore(homeDir);
    let previous = null;
    if (id) {
        previous = store.servers.find(item => item.id === id);
        if (!previous) throw new Error('MCP 不存在');
    }
    const next = normalizeMcpInput(input, previous);
    if (!id) {
        if (store.servers.length >= MAX_MCP) throw new Error(`MCP 最多 ${MAX_MCP} 个`);
        if (store.servers.some(item => item.name === next.name)) throw new Error(`MCP 名称已存在: ${next.name}`);
        store.servers.push(next);
    } else {
        if (store.servers.some(item => item.name === next.name && item.id !== id)) throw new Error(`MCP 名称已存在: ${next.name}`);
        store.servers = store.servers.map(item => (item.id === id ? next : item));
    }
    writeMcpStore(homeDir, store);
    return next;
}

function deleteMcp(homeDir, id) {
    const store = readMcpStore(homeDir);
    if (!store.servers.some(item => item.id === id)) throw new Error('MCP 不存在');
    store.servers = store.servers.filter(item => item.id !== id);
    writeMcpStore(homeDir, store);
}

/** 某个 Agent 适用的启用条目（带完整密钥，只在服务端下发时使用） */
function enabledFor(homeDir, agent) {
    assertMcpAgent(agent);
    return readMcpStore(homeDir).servers.filter(server => server.enabled !== false && Array.isArray(server.agents) && server.agents.includes(agent));
}

function agentSkills(homeDir, agent) {
    assertMcpAgent(agent);
    const all = listSkills(homeDir);
    return all.filter(item => item.agent === 'common' || item.agent === agent).map(item => item.name);
}

/** 共享库内容哈希（技能文件内容 + mcp.json 原文）：没变就跳过自动下发。 */
function catalogHash(homeDir) {
    const hash = crypto.createHash('sha256');
    const root = pathsOf(homeDir).skills;
    AGENTS.forEach(agent => {
        let entries = [];
        try { entries = fs.readdirSync(path.join(root, agent), { withFileTypes: true }); } catch (e) { return; }
        entries.sort((a, b) => (a.name < b.name ? -1 : 1)).forEach(entry => {
            if (!entry.isDirectory()) return;
            const dir = path.join(root, agent, entry.name);
            let files = [];
            try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            files.sort((a, b) => (a.name < b.name ? -1 : 1)).forEach(file => {
                if (!file.isFile()) return;
                try {
                    hash.update(`${agent}/${entry.name}/${file.name}\0`);
                    hash.update(fs.readFileSync(path.join(dir, file.name)));
                    hash.update('\0');
                } catch (e) { /* 读不了跳过 */ }
            });
        });
    });
    try {
        hash.update('mcp\0');
        hash.update(fs.readFileSync(pathsOf(homeDir).mcp));
    } catch (e) { /* 没有 mcp.json */ }
    return hash.digest('hex').slice(0, 32);
}

module.exports = {
    AGENTS,
    MCP_AGENTS,
    TRANSPORTS,
    KEEP,
    MAX_SKILLS,
    MAX_SKILL_BYTES,
    MAX_TOTAL_BYTES,
    MAX_MCP,
    extensionsDir,
    skillsMountDir,
    paths: pathsOf,
    listSkills,
    readSkill,
    writeSkill,
    deleteSkill,
    listMcp,
    getMcp,
    getMcpInternal,
    saveMcp,
    deleteMcp,
    enabledFor,
    agentSkills,
    catalogHash,
    maskSecret,
    parseFrontmatter,
    urlOrigin
};
