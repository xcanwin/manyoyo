'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeConfigFileSecure } = require('./secure-file');
const store = require('./extensions-store');

// 把宿主级共享技能 / MCP 下发到某个容器。
// 新容器只读挂载共享目录并建“受管链接”；没有挂载的旧容器按需复制。MCP 一律用 Agent 原生 CLI 增删：
// Claude 的 JSON 通过容器内的 bash 脚本从 stdin 读取（不进宿主机 argv），Codex 的 env 值经 buildExecArgs 的
// 0600 临时 env 文件传入、脚本里只出现变量名。所有失败只写 warning，不影响 Agent 启动。
const SHARED_ROOT = '/run/manyoyo-extensions/skills';
const STATE_VERSION = 1;

// 容器内：按受管清单建链接 / 清旧链接 / 记录冲突，参数是 JSON argv（不拼 shell）
const SKILL_LINK_SCRIPT = `
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const p = JSON.parse(process.argv[1]);
const home = process.env.HOME || '/root';
const out = { skills: { claude: [], codex: [] }, conflicts: [], warnings: [] };
const baseOf = agent => path.join(home, agent === 'claude' ? '.claude/skills' : '.codex/skills');
for (const agent of ['claude', 'codex']) {
  const base = baseOf(agent);
  try { fs.mkdirSync(base, { recursive: true }); } catch (e) { out.warnings.push('mkdir ' + base + ': ' + e.message); continue; }
  for (const name of (p.previous[agent] || [])) {
    const dest = path.join(base, name);
    try {
      const st = fs.lstatSync(dest);
      if (st.isSymbolicLink() && fs.readlinkSync(dest).startsWith('${SHARED_ROOT}/')) fs.unlinkSync(dest);
    } catch (e) { /* 不存在 */ }
  }
  for (const item of (p.items[agent] || [])) {
    const dest = path.join(base, item.name);
    let st = null;
    try { st = fs.lstatSync(dest); } catch (e) { st = null; }
    if (st) {
      if (st.isSymbolicLink() && fs.readlinkSync(dest).startsWith('${SHARED_ROOT}/')) {
        fs.unlinkSync(dest);
      } else {
        out.conflicts.push({ type: 'skill', agent, name: item.name });
        continue;
      }
    }
    if (p.workDir) {
      try {
        if (fs.existsSync(path.join(p.workDir, '.claude/skills', item.name))) {
          out.conflicts.push({ type: 'project_skill', agent, name: item.name });
          continue;
        }
      } catch (e) { /* 忽略 */ }
    }
    try {
      fs.symlinkSync('${SHARED_ROOT}/' + item.dir, dest);
      out.skills[agent].push(item.name);
    } catch (e) {
      out.warnings.push('symlink ' + item.name + ': ' + e.message);
    }
  }
}
process.stdout.write(JSON.stringify(out));
`;

// 容器内（复制模式）：只清理“有受管标记且哈希匹配”的旧副本；没有标记 / 标记不匹配一律当用户目录保留。
const SKILL_COPY_PREPARE_SCRIPT = `
const fs = require('fs');
const path = require('path');
const p = JSON.parse(process.argv[1]);
const home = process.env.HOME || '/root';
const MARKER = '.manyoyo-managed';
const baseOf = agent => path.join(home, agent === 'claude' ? '.claude/skills' : '.codex/skills');
const readMarker = dir => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    return m && m.app === 'manyoyo' && m.version === 1 && typeof m.hash === 'string' ? m : null;
  } catch (e) { return null; }
};
const out = { base: {}, copy: [], upToDate: [], conflicts: [] };
for (const agent of ['claude', 'codex']) {
  const base = baseOf(agent);
  try { fs.mkdirSync(base, { recursive: true }); } catch (e) { out.conflicts.push({ type: 'skill', agent, name: e.message }); continue; }
  out.base[agent] = base;
  for (const raw of (p.previous[agent] || [])) {
    const entry = typeof raw === 'string' ? { name: raw, hash: '' } : raw;
    if (!entry || !entry.name) continue;
    const dest = path.join(base, entry.name);
    let st = null;
    try { st = fs.lstatSync(dest); } catch (e) { st = null; }
    if (!st) continue;
    const marker = readMarker(dest);
    if (marker && entry.hash && marker.hash === entry.hash) {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) { /* 尽力 */ }
    } else {
      out.conflicts.push({ type: 'skill', agent, name: entry.name, reason: marker ? 'marker-mismatch' : 'user-replaced' });
    }
  }
  for (const item of (p.items[agent] || [])) {
    const dest = path.join(base, item.name);
    let st = null;
    try { st = fs.lstatSync(dest); } catch (e) { st = null; }
    if (!st) { out.copy.push({ agent, name: item.name }); continue; }
    const marker = readMarker(dest);
    if (marker && marker.hash === item.hash) { out.upToDate.push({ agent, name: item.name }); continue; }
    if (marker) {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) { /* 尽力 */ }
      out.copy.push({ agent, name: item.name });
      continue;
    }
    out.conflicts.push({ type: 'skill', agent, name: item.name, reason: 'user-replaced' });
  }
}
process.stdout.write(JSON.stringify(out));
`;

// 容器内：复制完成后写受管标记（下次同步只删有标记且哈希匹配的副本）
const SKILL_MARK_SCRIPT = `
const fs = require('fs');
const path = require('path');
const p = JSON.parse(process.argv[1]);
const home = process.env.HOME || '/root';
const written = [];
for (const item of p.items) {
  const base = path.join(home, item.agent === 'claude' ? '.claude/skills' : '.codex/skills');
  const dir = path.join(base, item.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.manyoyo-managed'), JSON.stringify({ app: 'manyoyo', version: 1, hash: item.hash }) + '\n', { mode: 0o600 });
  written.push(item.agent + '/' + item.name);
}
process.stdout.write(JSON.stringify({ written }));
`;

// 容器内：清理复制失败的半成品（没有受管标记的新副本，删掉才能下次重试）
const SKILL_DROP_SCRIPT = `
const fs = require('fs');
const path = require('path');
const p = JSON.parse(process.argv[1]);
const home = process.env.HOME || '/root';
for (const item of p.items) {
  const base = path.join(home, item.agent === 'claude' ? '.claude/skills' : '.codex/skills');
  try { fs.rmSync(path.join(base, item.name), { recursive: true, force: true }); } catch (e) { /* 尽力 */ }
}
process.stdout.write('{}');
`;

// 容器内：探测容器里已有的 MCP 名字（只读配置，不连接、不做健康检查）
const MCP_EXISTS_SCRIPT = `
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const home = process.env.HOME || '/root';
const out = { claude: [], codex: [] };
try {
  const json = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  const servers = json && json.mcpServers;
  if (servers && typeof servers === 'object') out.claude = Object.keys(servers);
} catch (e) { /* 没有配置 */ }
try {
  const text = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
  for (const m of text.matchAll(/^\\s*\\[mcp_servers\\.([^\\]]+)\\]/gm)) out.codex.push(m[1].replace(/^"|"$/g, ''));
} catch (e) { /* 没有配置 */ }
process.stdout.write(JSON.stringify(out));
`;

// 容器内：删除上次登记、现在不再下发的 MCP
const MCP_REMOVE_SCRIPT = `
const p = JSON.parse(process.argv[1]);
const { spawnSync } = require('child_process');
const out = [];
for (const item of p.items) {
  const args = item.agent === 'claude' ? ['mcp', 'remove', item.name, '-s', 'user'] : ['mcp', 'remove', item.name];
  try { spawnSync(item.agent === 'claude' ? 'claude' : 'codex', args, { stdio: 'ignore' }); out.push(item.agent + '/' + item.name); } catch (e) { /* 忽略 */ }
}
process.stdout.write(JSON.stringify(out));
`;

function shellQuote(value) {
    const text = String(value === undefined || value === null ? '' : value);
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

function claudeJsonOf(server) {
    if (server.transport === 'stdio') {
        return {
            type: 'stdio',
            command: server.command,
            args: server.args || [],
            ...(Object.keys(server.env || {}).length ? { env: server.env } : {})
        };
    }
    return {
        type: server.transport,
        url: server.url,
        ...(Object.keys(server.headers || {}).length ? { headers: server.headers } : {})
    };
}

/** Claude：add-json 不接受 stdin，把 JSON 写进容器内 0600 临时文件再以 argv 传入（脚本本身走 stdin） */
function buildClaudeMcpScript(servers) {
    const lines = [];
    servers.forEach(server => {
        lines.push(`claude mcp remove ${shellQuote(server.name)} -s user >/dev/null 2>&1 || true`);
        const dir = `/tmp/manyoyo-mcp-${process.pid}-${Math.random().toString(16).slice(2, 8)}.json`;
        lines.push(`umask 077; cat > ${shellQuote(dir)} <<'MANYOYO_MCP_EOF'`);
        lines.push(JSON.stringify(claudeJsonOf(server)));
        lines.push('MANYOYO_MCP_EOF');
        lines.push(`claude mcp add-json ${shellQuote(server.name)} "$(cat ${shellQuote(dir)})" -s user`);
        lines.push(`rm -f ${shellQuote(dir)}`);
    });
    return lines.join('\n');
}

/** Codex：env 值由 buildExecArgs 的临时 env 文件提供，脚本里只写变量名 */
function buildCodexMcpScript(servers) {
    const lines = [];
    servers.forEach(server => {
        lines.push(`codex mcp remove ${shellQuote(server.name)} >/dev/null 2>&1 || true`);
        const parts = ['codex', 'mcp', 'add', shellQuote(server.name)];
        Object.keys(server.env || {}).forEach(key => parts.push('--env', `${key}="$` + `{${key}}"`));
        if (server.transport === 'stdio') {
            parts.push('--', shellQuote(server.command), ...(server.args || []).map(shellQuote));
        } else {
            parts.push('--url', shellQuote(server.url));
            if (server.bearerTokenEnvVar) parts.push('--bearer-token-env-var', shellQuote(server.bearerTokenEnvVar));
        }
        lines.push(parts.join(' '));
    });
    return lines.join('\n');
}

function stateFileOf(homeDir, containerId) {
    if (!/^[0-9a-f]{16}$/.test(String(containerId || ''))) return '';
    return path.join(store.paths(homeDir).state, `${containerId}.json`);
}

function readState(homeDir, containerId) {
    const file = stateFileOf(homeDir, containerId);
    if (!file) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (!parsed || parsed.version !== STATE_VERSION) return null;
        return parsed;
    } catch (e) {
        return null;
    }
}

function writeState(homeDir, containerId, state) {
    const file = stateFileOf(homeDir, containerId);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeConfigFileSecure(file, `${JSON.stringify({ version: STATE_VERSION, ...state }, null, 2)}\n`);
}

// 技能目录内容哈希：受管标记用它判断“这个副本是不是我们下发的、是不是同一版”。
// 超限目录（任何辅助文件 > 1 MB / 总大小 > 20 MB / 有符号链接）直接返回空串，不读内容。
function skillDirHash(dir) {
    const scan = store.scanSkillDirectory(dir);
    if (!scan.ok) return '';
    const hash = crypto.createHash('sha256');
    scan.files.forEach(file => {
        hash.update(`F\0${file.rel}\0`);
        hash.update(fs.readFileSync(file.path));
        hash.update('\0');
    });
    return hash.digest('hex').slice(0, 16);
}

function skillSourceDir(homeDir, skill) {
    const root = store.paths(homeDir).skills;
    return skill.agent === 'common' ? path.join(root, 'common', skill.name) : path.join(root, skill.agent, skill.name);
}

function skillItems(homeDir, warnings = []) {
    const all = store.listSkills(homeDir);
    const items = { claude: [], codex: [] };
    all.forEach(skill => {
        const sourceDir = skillSourceDir(homeDir, skill);
        const scan = store.scanSkillDirectory(sourceDir);
        if (!scan.ok) {
            // 超限技能整体跳过（复制 / 挂载都不做）：warning 说明是哪个文件，不阻塞其它技能
            warnings.push(`技能 ${skill.agent}/${skill.name} 已跳过：${scan.warnings[0] || '超过大小上限'}`);
            return;
        }
        const hash = skillDirHash(sourceDir);
        if (skill.agent === 'claude') items.claude.push({ name: skill.name, dir: `claude/${skill.name}`, hash });
        else if (skill.agent === 'codex') items.codex.push({ name: skill.name, dir: `codex/${skill.name}`, hash });
        else {
            items.claude.push({ name: skill.name, dir: `common/${skill.name}`, hash });
            items.codex.push({ name: skill.name, dir: `common/${skill.name}`, hash });
        }
    });
    return items;
}

function mcpItems(homeDir) {
    return {
        claude: store.enabledFor(homeDir, 'claude'),
        codex: store.enabledFor(homeDir, 'codex')
    };
}

/**
 * @param {object} options
 * @param {string} options.homeDir
 * @param {string} options.containerName
 * @param {string} options.containerId
 * @param {'mount'|'copy'} options.mode
 * @param {string} [options.workDir] 容器内的工作目录（项目同名技能冲突检查）
 * @param {boolean} [options.force]
 * @param {(args: string[], opts?: object) => Promise<{code:number, stdout:string, stderr:string}>} options.runInContainer 执行 node / bash 脚本（参数数组，不拼 shell）
 * @param {(sourceDir: string, destDir: string) => Promise<void>} [options.copySkill] 复制模式的宿主 → 容器复制
 * @returns {Promise<{applied:boolean, skipped?:boolean, conflicts:any[], warnings:string[]}>}
 */
async function applyExtensions(options) {
    const homeDir = options.homeDir;
    const containerId = options.containerId;
    const run = options.runInContainer;
    const warnings = [];
    if (!stateFileOf(homeDir, containerId)) throw new Error('非法的容器 id');
    const hash = store.catalogHash(homeDir);
    const previous = readState(homeDir, containerId);
    // 只有“上次完整成功”才允许跳过；pending 的失败状态下次自动重试
    if (!options.force && previous && previous.catalogHash === hash && previous.pending !== true) {
        return { applied: false, skipped: true, conflicts: previous.conflicts || [], warnings: [] };
    }
    const mode = options.mode === 'mount' ? 'mount' : 'copy';
    const items = skillItems(homeDir, warnings);
    const mcp = mcpItems(homeDir);
    const conflicts = [];
    const skillState = { claude: [], codex: [] };
    const skillHashes = { claude: {}, codex: {} };
    const previousSkills = previous && previous.skills ? previous.skills : { claude: [], codex: [] };
    const previousHashes = previous && previous.skillHashes ? previous.skillHashes : { claude: {}, codex: {} };
    let skillsOk = true;
    let mcpOk = true;
    const hashOf = {};
    ['claude', 'codex'].forEach(agent => items[agent].forEach(item => { hashOf[`${agent}/${item.name}`] = item.hash; }));
    const previousEntries = agent => (previousSkills[agent] || []).map(name => ({ name, hash: (previousHashes[agent] || {})[name] || '' }));

    try {
        if (mode === 'mount') {
            const parsed = await run(['node', '-e', SKILL_LINK_SCRIPT, JSON.stringify({ items, previous: previousSkills, workDir: options.workDir || '' })], { timeoutMs: 30000 });
            if (!parsed || parsed.code !== 0) {
                skillsOk = false;
                warnings.push(`同步共享技能失败: ${String((parsed && parsed.stderr) || '脚本退出码非 0').slice(0, 200)}`);
            } else {
                const result = JSON.parse(String(parsed.stdout || '{}'));
                Object.assign(skillState, result.skills || {});
                (result.conflicts || []).forEach(item => conflicts.push(item));
                (result.warnings || []).forEach(message => warnings.push(message));
                if ((result.warnings || []).length) skillsOk = false;
            }
        } else {
            const prepared = await run(['node', '-e', SKILL_COPY_PREPARE_SCRIPT, JSON.stringify({ items, previous: { claude: previousEntries('claude'), codex: previousEntries('codex') } })], { timeoutMs: 30000 });
            if (!prepared || prepared.code !== 0) {
                skillsOk = false;
                warnings.push(`准备共享技能目录失败: ${String((prepared && prepared.stderr) || '脚本退出码非 0').slice(0, 200)}`);
            } else {
                const result = JSON.parse(String(prepared.stdout || '{}'));
                const upToDate = new Set((result.upToDate || []).map(item => `${item.agent}/${item.name}`));
                const toCopy = new Set((result.copy || []).map(item => `${item.agent}/${item.name}`));
                (result.conflicts || []).forEach(item => conflicts.push(item));
                const marks = [];
                for (const agent of ['claude', 'codex']) {
                    for (const item of items[agent]) {
                        const key = `${agent}/${item.name}`;
                        if (upToDate.has(key)) {
                            skillState[agent].push(item.name);
                            continue;
                        }
                        if (!toCopy.has(key)) continue; // 冲突项已记录，跳过
                        const source = skillSourceDir(homeDir, { agent: item.dir.startsWith('common/') ? 'common' : agent, name: item.name });
                        const destBase = result.base && result.base[agent];
                        if (!destBase || typeof options.copySkill !== 'function') {
                            skillsOk = false;
                            warnings.push(`跳过 ${agent}/${item.name}：复制模式不可用`);
                            continue;
                        }
                        try {
                            await options.copySkill(source, `${destBase}/${item.name}`);
                            skillState[agent].push(item.name);
                            marks.push({ agent, name: item.name, hash: item.hash });
                        } catch (e) {
                            skillsOk = false;
                            warnings.push(`复制 ${agent}/${item.name} 失败: ${e.message}`);
                            await run(['node', '-e', SKILL_DROP_SCRIPT, JSON.stringify({ items: [{ agent, name: item.name }] })], { timeoutMs: 15000 }).catch(() => {});
                        }
                    }
                }
                if (marks.length) {
                    const marked = await run(['node', '-e', SKILL_MARK_SCRIPT, JSON.stringify({ items: marks })], { timeoutMs: 30000 });
                    if (!marked || marked.code !== 0) {
                        skillsOk = false;
                        warnings.push(`写受管标记失败: ${String((marked && marked.stderr) || '脚本退出码非 0').slice(0, 200)}`);
                        // 半成品没有标记，下次会被当成用户目录；先清掉才能自动重试
                        await run(['node', '-e', SKILL_DROP_SCRIPT, JSON.stringify({ items: marks.map(item => ({ agent: item.agent, name: item.name })) })], { timeoutMs: 15000 }).catch(() => {});
                    }
                }
            }
        }
    } catch (e) {
        skillsOk = false;
        warnings.push(`同步共享技能失败: ${e.message}`);
    }

    // 只记录真正完成（复制 + 标记 / 已是最新）的技能哈希；失败的下次按 pending 重试
    ['claude', 'codex'].forEach(agent => {
        skillState[agent] = [...new Set(skillState[agent])];
        skillState[agent].forEach(name => {
            const value = hashOf[`${agent}/${name}`];
            if (value) skillHashes[agent][name] = value;
        });
    });

    const mcpState = { claude: [], codex: [] };
    try {
        const existsResult = await run(['node', '-e', MCP_EXISTS_SCRIPT], { timeoutMs: 15000 });
        if (!existsResult || existsResult.code !== 0) {
            mcpOk = false;
            warnings.push(`探测容器 MCP 失败: ${String((existsResult && existsResult.stderr) || '脚本退出码非 0').slice(0, 200)}`);
        }
        const exists = existsResult && existsResult.code === 0 ? JSON.parse(String(existsResult.stdout || '{}')) : { claude: [], codex: [] };
        const previousMcp = previous && previous.mcp ? previous.mcp : { claude: [], codex: [] };
        for (const agent of ['claude', 'codex']) {
            const wanted = mcp[agent];
            const had = new Set(previousMcp[agent] || []);
            const present = new Set(exists[agent] || []);
            const conflictsForAgent = wanted.filter(server => present.has(server.name) && !had.has(server.name));
            conflictsForAgent.forEach(server => conflicts.push({ type: 'mcp', agent, name: server.name }));
            const toApply = wanted.filter(server => !conflictsForAgent.some(item => item.name === server.name));
            if (toApply.length) {
                let result;
                if (agent === 'claude') {
                    result = await run(['/bin/bash', '-s'], { stdin: buildClaudeMcpScript(toApply), timeoutMs: 30000 });
                } else {
                    const envs = [];
                    toApply.forEach(server => Object.keys(server.env || {}).forEach(key => envs.push(`${key}=${server.env[key]}`)));
                    result = await run(['/bin/bash', '-s'], { stdin: buildCodexMcpScript(toApply), timeoutMs: 30000, extraEnv: envs });
                }
                if (!result || result.code !== 0) {
                    mcpOk = false;
                    warnings.push(`${agent === 'claude' ? 'Claude' : 'Codex'} MCP 下发失败: ${String((result && result.stderr) || '脚本退出码非 0').slice(0, 200)}`);
                } else {
                    mcpState[agent] = toApply.map(server => server.name);
                }
            }
            const removed = (previousMcp[agent] || []).filter(name => !wanted.some(server => server.name === name));
            if (removed.length) {
                const result = await run(['node', '-e', MCP_REMOVE_SCRIPT, JSON.stringify({ items: removed.map(name => ({ agent, name })) })], { timeoutMs: 15000 }).catch(e => ({ code: 1, stderr: e.message }));
                if (!result || result.code !== 0) {
                    mcpOk = false;
                    warnings.push(`移除 ${agent} MCP 失败: ${String((result && result.stderr) || '脚本退出码非 0').slice(0, 200)}`);
                }
            }
        }
    } catch (e) {
        mcpOk = false;
        warnings.push(`同步共享 MCP 失败: ${e.message}`);
    }

    const pending = !(skillsOk && mcpOk);
    writeState(homeDir, containerId, {
        mode,
        catalogHash: hash,
        pending,
        skills: skillState,
        skillHashes,
        mcp: mcpState,
        conflicts,
        at: new Date().toISOString()
    });
    return { applied: true, pending, conflicts, warnings };
}

module.exports = {
    SHARED_ROOT,
    SKILL_LINK_SCRIPT,
    SKILL_COPY_PREPARE_SCRIPT,
    SKILL_MARK_SCRIPT,
    SKILL_DROP_SCRIPT,
    MCP_EXISTS_SCRIPT,
    buildClaudeMcpScript,
    buildCodexMcpScript,
    applyExtensions,
    readState,
    writeState,
    skillItems,
    skillDirHash,
    mcpItems
};
