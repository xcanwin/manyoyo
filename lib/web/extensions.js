'use strict';

// 技能与 MCP 面板的数据：skill 来自 Agent 的命令目录 / 技能目录，MCP 来自 `<agent> mcp list`。
// 全部来自容器（容器里的代码可以篡改），按不可信文本处理：限长、去控制字符，前端只当纯文本显示。

const { toDisplayText, HEADLESS_BUILTIN_COMMANDS, NON_SKILL_BUILTIN_COMMANDS } = require('./session-meta');

const SKILL_NAME_PATTERN = /^[A-Za-z0-9:_.-]{1,64}$/;
const SKILLS_MAX = 200;
const MCP_MAX = 100;
const DESCRIPTION_MAX_CHARS = 200;
const DETAIL_MAX_CHARS = 160;
const STATUS_MAX_CHARS = 120;

// 目录项里的 skill：用户 / 项目 / 插件 skill（说明末尾带来源），以及 claude 自带的 skill；-p 下可用的内置命令和本地命令不算
function classifyClaudeSkills(catalog) {
    const list = Array.isArray(catalog) ? catalog : [];
    return list
        .filter(item => item.source || (!HEADLESS_BUILTIN_COMMANDS.has(item.name) && !NON_SKILL_BUILTIN_COMMANDS.has(item.name)))
        .slice(0, SKILLS_MAX)
        .map(item => ({
            name: item.name,
            source: item.source || 'builtin',
            description: item.description
        }));
}

// 在容器里跑：读 ~/.codex/skills/*/SKILL.md 的开头 4KB（不解析，原样交回）
const CODEX_SKILLS_SCRIPT = [
    'const fs = require("fs"), path = require("path");',
    'const root = path.join(process.env.CODEX_HOME || path.join(process.env.HOME || "", ".codex"), "skills");',
    'const out = [];',
    'try {',
    '  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {',
    '    if (!entry.isDirectory() || out.length >= 200) continue;',
    '    try {',
    '      const fd = fs.openSync(path.join(root, entry.name, "SKILL.md"), "r");',
    '      const buffer = Buffer.alloc(4096);',
    '      const size = fs.readSync(fd, buffer, 0, 4096, 0);',
    '      fs.closeSync(fd);',
    '      out.push({ dir: entry.name, head: buffer.slice(0, size).toString("utf8") });',
    '    } catch (e) {}',
    '  }',
    '} catch (e) {}',
    'process.stdout.write(JSON.stringify(out));'
].join('\n');

function buildCodexSkillsCommand() {
    return `node -e '${CODEX_SKILLS_SCRIPT}'`;
}

function parseFrontmatter(head) {
    const text = String(head || '').replace(/\r/g, '');
    const matched = text.match(/^---\n([\s\S]*?)\n---/);
    const fields = {};
    if (!matched) {
        return fields;
    }
    for (const line of matched[1].split('\n')) {
        const pair = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
        if (pair && !(pair[1] in fields)) {
            fields[pair[1]] = pair[2].replace(/^["']|["']$/g, '');
        }
    }
    return fields;
}

function parseCodexSkillsOutput(stdout) {
    let list;
    try {
        list = JSON.parse(String(stdout || '').trim());
    } catch (e) {
        return [];
    }
    if (!Array.isArray(list)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const item of list) {
        const fields = parseFrontmatter(item && item.head);
        const name = String(fields.name || (item && item.dir) || '').trim();
        if (!SKILL_NAME_PATTERN.test(name) || seen.has(name)) {
            continue;
        }
        seen.add(name);
        result.push({ name, source: 'user', description: toDisplayText(fields.description, DESCRIPTION_MAX_CHARS) });
        if (result.length >= SKILLS_MAX) {
            break;
        }
    }
    return result;
}

// `claude mcp list` 每行：<名字>: <命令或地址> - <✓|✔|✘|✗|⚠|!> <状态>
const CLAUDE_MCP_LINE = /^(.+?): (.*) - ([✓✔✘✗⚠!])\s*(.*)$/u;

function parseClaudeMcpList(stdout) {
    const result = [];
    for (const raw of String(stdout || '').split('\n')) {
        const matched = raw.trim().match(CLAUDE_MCP_LINE);
        if (!matched) {
            continue;
        }
        const symbol = matched[3];
        const tone = symbol === '✓' || symbol === '✔' ? 'success' : (symbol === '⚠' || symbol === '!' ? 'warning' : 'error');
        result.push({
            name: toDisplayText(matched[1], 64),
            detail: toDisplayText(matched[2], DETAIL_MAX_CHARS),
            status: toDisplayText(matched[4], STATUS_MAX_CHARS) || (tone === 'success' ? '已连接' : '未连接'),
            tone
        });
        if (result.length >= MCP_MAX) {
            break;
        }
    }
    return result;
}

function parseCodexMcpJson(stdout) {
    let list;
    try {
        list = JSON.parse(String(stdout || '').trim());
    } catch (e) {
        return [];
    }
    if (!Array.isArray(list)) {
        return [];
    }
    const result = [];
    for (const item of list) {
        const source = item && typeof item === 'object' ? item : {};
        const transport = source.transport && typeof source.transport === 'object' ? source.transport : {};
        const detail = transport.type === 'stdio'
            ? [transport.command].concat(Array.isArray(transport.args) ? transport.args : []).filter(part => typeof part === 'string').join(' ')
            : (typeof transport.url === 'string' ? transport.url : '');
        const enabled = source.enabled !== false;
        result.push({
            name: toDisplayText(source.name, 64),
            detail: toDisplayText(detail, DETAIL_MAX_CHARS),
            // codex 的 list 不连接服务器，只能说是否启用
            status: enabled ? '已启用' : '已禁用',
            tone: enabled ? 'success' : 'warning'
        });
        if (result.length >= MCP_MAX) {
            break;
        }
    }
    return result.filter(item => item.name);
}

module.exports = {
    classifyClaudeSkills,
    buildCodexSkillsCommand,
    parseCodexSkillsOutput,
    parseClaudeMcpList,
    parseCodexMcpJson
};
