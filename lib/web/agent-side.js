'use strict';

// 侧问（/btw）：带着当前对话上下文问一句，答案只显示在浮层里，不进对话记录、不写会话文件，主任务不受影响。
// claude：-r <会话> --fork-session 在内存里分叉，加 --no-session-persistence 不落盘（原会话文件行数不变，实测）；
// codex：exec fork <线程> --ephemeral（实测不新增会话文件，上下文可用）。没有引擎会话时就是不带上下文的一次性提问。

const { isEffortValue } = require('./agent-effort');

const SIDE_QUESTION_MAX_CHARS = 4000;
const SIDE_ANSWER_MAX_CHARS = 20000;
const SIDE_TIMEOUT_MS = 3 * 60 * 1000;
const SESSION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MODEL_PATTERN = /^[A-Za-z0-9._\-[\]/]+$/;

function quote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function normalizeSideQuestion(value) {
    if (typeof value !== 'string') {
        return '';
    }
    const text = value.trim();
    return Array.from(text).length > SIDE_QUESTION_MAX_CHARS ? '' : text;
}

function buildClaudeSideCommand({ sessionId, model, effort, question }) {
    const parts = [];
    if (isEffortValue(effort)) {
        parts.push(`CLAUDE_CODE_EFFORT_LEVEL=${effort}`);
    }
    parts.push('claude -p');
    if (SESSION_ID_PATTERN.test(sessionId || '')) {
        parts.push(`-r ${sessionId} --fork-session`);
    }
    parts.push('--no-session-persistence --output-format json');
    if (typeof model === 'string' && MODEL_PATTERN.test(model)) {
        parts.push(`--model ${quote(model)}`);
    }
    parts.push(quote(question));
    return parts.join(' ');
}

// 带 {prompt} 占位的 codex 模板，交给 withCodexBaseUrl 展开兼容服务的地址 / Key，再渲染提示词
function buildCodexSideTemplate({ threadId, model, effort }) {
    const parts = ['codex exec'];
    if (SESSION_ID_PATTERN.test(threadId || '')) {
        // exec fork 不认 -s（实测报 Usage），沙箱沿用原线程的设置
        parts.push(`fork ${threadId}`);
        parts.push('--json --ephemeral --skip-git-repo-check');
    } else {
        parts.push('--json --ephemeral --skip-git-repo-check -s read-only');
    }
    if (typeof model === 'string' && MODEL_PATTERN.test(model)) {
        parts.push(`--model ${quote(model)}`);
    }
    if (isEffortValue(effort)) {
        parts.push(`-c model_reasoning_effort=${effort}`);
    }
    parts.push('{prompt}');
    return parts.join(' ');
}

function clipAnswer(text) {
    const value = String(text || '').trim();
    const chars = Array.from(value);
    return chars.length > SIDE_ANSWER_MAX_CHARS ? `${chars.slice(0, SIDE_ANSWER_MAX_CHARS).join('')}\n...[truncated]` : value;
}

module.exports = {
    SIDE_QUESTION_MAX_CHARS,
    SIDE_TIMEOUT_MS,
    normalizeSideQuestion,
    buildClaudeSideCommand,
    buildCodexSideTemplate,
    clipAnswer
};
