'use strict';

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

// 容器内（复制模式）：准备目录、清掉上次登记的受管副本、报告已存在的同名项
const SKILL_COPY_PREPARE_SCRIPT = `
const fs = require('fs');
const path = require('path');
const p = JSON.parse(process.argv[1]);
const home = process.env.HOME || '/root';
const baseOf = agent => path.join(home, agent === 'claude' ? '.claude/skills' : '.codex/skills');
const out = { base: {}, existing: [], conflicts: [] };
for (const agent of ['claude', 'codex']) {
  const base = baseOf(agent);
  try { fs.mkdirSync(base, { recursive: true }); } catch (e) { out.conflicts.push({ type: 'skill', agent, name: e.message }); continue; }
  out.base[agent] = base;
  for (const name of (p.previous[agent] || [])) {
    try { fs.rmSync(path.join(base, name), { recursive: true, force: true }); } catch (e) { /* 尽力 */ }
  }
  for (const item of (p.items[agent] || [])) {
    const dest = path.join(base, item.name);
    if (fs.existsSync(dest)) out.existing.push(agent + '/' + item.name);
  }
}
process.stdout.write(JSON.stringify(out));
`;

// 容器内：探测容器里已有的 MCP 名字（只读配置，不连接、不做健康检查）
const MCP_EXISTS_SCRIPT = `
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

function skillItems(homeDir) {
    const all = store.listSkills(homeDir);
    const items = { claude: [], codex: [] };
    all.forEach(skill => {
        if (skill.agent === 'claude') items.claude.push({ name: skill.name, dir: `claude/${skill.name}` });
        else if (skill.agent === 'codex') items.codex.push({ name: skill.name, dir: `codex/${skill.name}` });
        else {
            items.claude.push({ name: skill.name, dir: `common/${skill.name}` });
            items.codex.push({ name: skill.name, dir: `common/${skill.name}` });
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
    if (!options.force && previous && previous.catalogHash === hash) {
        return { applied: false, skipped: true, conflicts: previous.conflicts || [], warnings: [] };
    }
    const mode = options.mode === 'mount' ? 'mount' : 'copy';
    const items = skillItems(homeDir);
    const mcp = mcpItems(homeDir);
    const conflicts = [];
    const skillState = { claude: [], codex: [] };
    const previousSkills = previous && previous.skills ? previous.skills : { claude: [], codex: [] };

    try {
        if (mode === 'mount') {
            const parsed = await run(['node', '-e', SKILL_LINK_SCRIPT, JSON.stringify({ items, previous: previousSkills, workDir: options.workDir || '' })], { timeoutMs: 30000 });
            const result = JSON.parse(String(parsed.stdout || '{}'));
            Object.assign(skillState, result.skills || {});
            (result.conflicts || []).forEach(item => conflicts.push(item));
            (result.warnings || []).forEach(message => warnings.push(message));
        } else {
            const prepared = await run(['node', '-e', SKILL_COPY_PREPARE_SCRIPT, JSON.stringify({ items, previous: previousSkills })], { timeoutMs: 30000 });
            const result = JSON.parse(String(prepared.stdout || '{}'));
            const existing = new Set(result.existing || []);
            for (const agent of ['claude', 'codex']) {
                for (const item of items[agent]) {
                    if (existing.has(`${agent}/${item.name}`)) {
                        // 同名真实目录不覆盖
                        conflicts.push(mode === 'copy' ? { type: 'skill', agent, name: item.name } : { type: 'skill', agent, name: item.name });
                        continue;
                    }
                    const source = item.dir.startsWith('common/')
                        ? path.join(store.paths(homeDir).skills, 'common', item.name)
                        : path.join(store.paths(homeDir).skills, agent, item.name);
                    const destBase = result.base && result.base[agent];
                    if (!destBase || typeof options.copySkill !== 'function') {
                        warnings.push(`跳过 ${agent}/${item.name}：复制模式不可用`);
                        continue;
                    }
                    try {
                        await options.copySkill(source, `${destBase}/${item.name}`);
                        skillState[agent].push(item.name);
                    } catch (e) {
                        warnings.push(`复制 ${agent}/${item.name} 失败: ${e.message}`);
                    }
                }
            }
        }
    } catch (e) {
        warnings.push(`同步共享技能失败: ${e.message}`);
    }

    const mcpState = { claude: [], codex: [] };
    try {
        const existsResult = await run(['node', '-e', MCP_EXISTS_SCRIPT], { timeoutMs: 15000 });
        const exists = JSON.parse(String(existsResult.stdout || '{}'));
        const previousMcp = previous && previous.mcp ? previous.mcp : { claude: [], codex: [] };
        for (const agent of ['claude', 'codex']) {
            const wanted = mcp[agent];
            const had = new Set(previousMcp[agent] || []);
            const present = new Set(exists[agent] || []);
            const conflictsForAgent = wanted.filter(server => present.has(server.name) && !had.has(server.name));
            conflictsForAgent.forEach(server => conflicts.push({ type: 'mcp', agent, name: server.name }));
            const toApply = wanted.filter(server => !conflictsForAgent.some(item => item.name === server.name));
            if (toApply.length) {
                if (agent === 'claude') {
                    const script = buildClaudeMcpScript(toApply);
                    const result = await run(['/bin/bash', '-s'], { stdin: script, timeoutMs: 30000 });
                    if (result.code !== 0) warnings.push(`Claude MCP 下发失败: ${String(result.stderr || '').slice(0, 200)}`);
                } else {
                    const script = buildCodexMcpScript(toApply);
                    const envs = [];
                    toApply.forEach(server => Object.keys(server.env || {}).forEach(key => envs.push(`${key}=${server.env[key]}`)));
                    const result = await run(['/bin/bash', '-s'], { stdin: script, timeoutMs: 30000, extraEnv: envs });
                    if (result.code !== 0) warnings.push(`Codex MCP 下发失败: ${String(result.stderr || '').slice(0, 200)}`);
                }
                mcpState[agent] = toApply.map(server => server.name);
            }
            const removed = (previousMcp[agent] || []).filter(name => !wanted.some(server => server.name === name));
            if (removed.length) {
                await run(['node', '-e', MCP_REMOVE_SCRIPT, JSON.stringify({ items: removed.map(name => ({ agent, name })) })], { timeoutMs: 15000 }).catch(() => {});
            }
        }
    } catch (e) {
        warnings.push(`同步共享 MCP 失败: ${e.message}`);
    }

    writeState(homeDir, containerId, {
        mode,
        catalogHash: hash,
        skills: skillState,
        mcp: mcpState,
        conflicts,
        at: new Date().toISOString()
    });
    return { applied: true, conflicts, warnings };
}

module.exports = {
    SHARED_ROOT,
    SKILL_LINK_SCRIPT,
    SKILL_COPY_PREPARE_SCRIPT,
    MCP_EXISTS_SCRIPT,
    buildClaudeMcpScript,
    buildCodexMcpScript,
    applyExtensions,
    readState,
    writeState,
    skillItems,
    mcpItems
};
