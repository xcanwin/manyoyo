'use strict';

// 会话的展示信息（标题、首条消息、斜杠命令列表）：来自容器里 Agent 自己写的文件或输出，
// 都按不可信文本处理——只保留可打印字符、限制长度，前端一律当纯文本显示。

const TITLE_MAX_CHARS = 60;
const FIRST_PROMPT_MAX_CHARS = 80;
// 只读会话文件尾部：标题记录在 Claude 每轮结束时追加，读尾部就够了，文件再大也不慢
const TITLE_TAIL_BYTES = 256 * 1024;
const SLASH_COMMAND_PATTERN = /^[A-Za-z0-9:_.-]{1,64}$/;
const SLASH_COMMANDS_MAX = 200;
const CLAUDE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function toDisplayText(value, maxChars) {
    if (typeof value !== 'string') {
        return '';
    }
    const text = value
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return Array.from(text).slice(0, maxChars).join('');
}

function normalizeTitle(value) {
    return toDisplayText(value, TITLE_MAX_CHARS);
}

function normalizeFirstPrompt(value) {
    return toDisplayText(value, FIRST_PROMPT_MAX_CHARS);
}

function normalizeSlashCommands(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const item of value) {
        const name = typeof item === 'string' ? item.replace(/^\//, '') : '';
        if (!SLASH_COMMAND_PATTERN.test(name) || seen.has(name)) {
            continue;
        }
        seen.add(name);
        result.push(name);
        if (result.length >= SLASH_COMMANDS_MAX) {
            break;
        }
    }
    return result;
}

function isClaudeSessionId(value) {
    return typeof value === 'string' && CLAUDE_SESSION_ID_PATTERN.test(value);
}

// 在容器里执行的只读命令：找到这个会话的 jsonl，只读尾部，只留标题类记录。
// ai-title 是 claude 交互模式自动生成的（-p 下实测不生成）；custom-title 是 /rename 写的，优先
// session id 已按 UUID 格式校验，拼进命令前不需要再转义
function buildClaudeTitleReadCommand(sessionId) {
    if (!isClaudeSessionId(sessionId)) {
        return '';
    }
    return [
        `for f in "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${sessionId}.jsonl; do`,
        `[ -f "$f" ] && tail -c ${TITLE_TAIL_BYTES} "$f" | grep -E '"type":"(ai-title|custom-title)"' | tail -n 20;`,
        'break; done'
    ].join(' ');
}

function parseClaudeTitleOutput(output) {
    const lines = String(output || '').split('\n').map(line => line.trim()).filter(Boolean);
    let custom = '';
    let generated = '';
    for (const line of lines) {
        try {
            const record = JSON.parse(line);
            if (record && record.type === 'custom-title') {
                custom = normalizeTitle(record.customTitle) || custom;
            } else if (record && record.type === 'ai-title') {
                generated = normalizeTitle(record.aiTitle) || generated;
            }
        } catch (e) {
            // 尾部第一行可能被截断，跳过
        }
    }
    return custom || generated;
}

// 在 claude -p（Web 端的执行方式）下实测有用的内置命令（2026-10-19，claude 2.1.290）：
// context / usage / recap / mcp / list-agents / rename 都返回了正常结果。不列的：compact（-p 下没有压缩，
// 输出和 usage 一样）、agents（已移除）、insights（报告写在容器里的 file:// 地址，网页打不开）、
// model / effort / goal（只影响这一次进程，网页里换模型用模型菜单）、clear / init 等改状态的没测，宁缺毋滥。
// skill 类命令会展开成提示词，实测可用
const HEADLESS_BUILTIN_COMMANDS = new Set(['context', 'usage', 'recap', 'mcp', 'list-agents', 'rename']);

function listUsableSlashCommands(stored) {
    if (!stored || !Array.isArray(stored.all)) {
        return [];
    }
    const skills = new Set(stored.skills || []);
    const terminal = new Set(stored.terminal || []);
    return stored.all.filter(name => !terminal.has(name) && (skills.has(name) || HEADLESS_BUILTIN_COMMANDS.has(name)));
}

// 目录（initialize 响应的 commands）里不该给用户看的内部命令
const INTERNAL_SLASH_COMMANDS = new Set(['workflow-launch-exec', 'heapdump']);
// 目录里标了 builtin 的不一定是命令：自带 skill（code-review、loop …）也标 builtin。
// 没跑过任何一轮、拿不到 init 的 skills 列表时，靠这张表排除“不是 skill 也不在 -p 下可用”的内置命令（claude 2.1.310 实测）
const NON_SKILL_BUILTIN_COMMANDS = new Set([
    'agents', 'auto-mode-setup', 'autocompact', 'clear', 'color', 'compact', 'config', 'output-style', 'effort', 'fast',
    'focus', 'model', 'reload-plugins', 'reload-skills', 'insights', 'goal', 'team-onboarding'
]);
const SOURCE_SUFFIX_PATTERN = /\s*\((user|project|plugin[^)]*)\)\s*$/;
const COMMAND_DESCRIPTION_MAX_CHARS = 160;
const COMMAND_HINT_MAX_CHARS = 60;

// 把 initialize 响应里的 commands 整理成 [{ name, description, argumentHint, source, builtin }]；
// 全部来自容器，按不可信文本处理
function normalizeCommandCatalog(commands) {
    if (!Array.isArray(commands)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const item of commands) {
        const raw = item && typeof item === 'object' ? item : {};
        const name = typeof raw.name === 'string' ? raw.name.replace(/^\//, '') : '';
        if (!SLASH_COMMAND_PATTERN.test(name) || name.startsWith('__') || INTERNAL_SLASH_COMMANDS.has(name) || seen.has(name)) {
            continue;
        }
        seen.add(name);
        const description = toDisplayText(raw.description, COMMAND_DESCRIPTION_MAX_CHARS + 20);
        const matched = description.match(SOURCE_SUFFIX_PATTERN);
        result.push({
            name,
            description: Array.from(description.replace(SOURCE_SUFFIX_PATTERN, '')).slice(0, COMMAND_DESCRIPTION_MAX_CHARS).join(''),
            argumentHint: toDisplayText(raw.argumentHint, COMMAND_HINT_MAX_CHARS),
            source: matched ? matched[1].replace(/\s.*$/, '') : '',
            builtin: raw.builtin === true
        });
        if (result.length >= SLASH_COMMANDS_MAX * 2) {
            break;
        }
    }
    return result;
}

// 候选命令（带说明）。跑过一轮有 init 记录就以它为准（skill + -p 下可用的内置命令）；
// 还没跑过时只能看目录：用户 / 项目 / 插件 skill、自带 skill、-p 下可用的内置命令
function listSlashCommandEntries(stored, catalog) {
    const entries = Array.isArray(catalog) ? catalog : [];
    const byName = new Map(entries.map(entry => [entry.name, entry]));
    const view = name => {
        const entry = byName.get(name);
        return { name, description: entry ? entry.description : '', argumentHint: entry ? entry.argumentHint : '', source: entry ? entry.source : '' };
    };
    if (stored && Array.isArray(stored.all)) {
        return listUsableSlashCommands(stored).filter(name => !name.startsWith('__') && !INTERNAL_SLASH_COMMANDS.has(name)).map(view);
    }
    return entries
        .filter(entry => HEADLESS_BUILTIN_COMMANDS.has(entry.name) || !NON_SKILL_BUILTIN_COMMANDS.has(entry.name))
        .map(entry => view(entry.name));
}

module.exports = {
    HEADLESS_BUILTIN_COMMANDS,
    INTERNAL_SLASH_COMMANDS,
    NON_SKILL_BUILTIN_COMMANDS,
    normalizeCommandCatalog,
    listSlashCommandEntries,
    listUsableSlashCommands,
    TITLE_MAX_CHARS,
    FIRST_PROMPT_MAX_CHARS,
    normalizeTitle,
    normalizeFirstPrompt,
    normalizeSlashCommands,
    isClaudeSessionId,
    buildClaudeTitleReadCommand,
    parseClaudeTitleOutput
};
