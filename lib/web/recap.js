'use strict';

// 回顾（隔了很久回来，用一句话说明刚才做到哪）。只对“最后一条消息是已经完成的最终回复”的 AGENT 生成。

const RECAP_IDLE_MS = 30 * 60 * 1000;

function isFinishedReply(message) {
    return Boolean(message)
        && message.role === 'assistant'
        && message.mode === 'agent'
        && message.pending !== true
        && message.streamTrace !== true
        && message.interrupted !== true
        && typeof message.content === 'string'
        && message.content.trim() !== '';
}

// 返回 { replyId, replyText, promptText, replyAtMs }；最后一条不是已完成的最终回复（执行中、被中断、系统命令输出）就是 null
function findRecapTarget(messages) {
    const list = Array.isArray(messages) ? messages.filter(item => item && item.streamTrace !== true) : [];
    const last = list[list.length - 1];
    if (!isFinishedReply(last)) {
        return null;
    }
    let prompt = null;
    for (let index = list.length - 2; index >= 0; index -= 1) {
        if (list[index].role === 'user' && list[index].mode === 'agent') {
            prompt = list[index];
            break;
        }
    }
    if (!prompt) {
        return null;
    }
    const replyAtMs = Date.parse(last.timestamp);
    return {
        replyId: String(last.id || ''),
        replyText: last.content,
        promptText: typeof prompt.content === 'string' ? prompt.content : '',
        replyAtMs: Number.isFinite(replyAtMs) ? replyAtMs : 0
    };
}

// 是否要生成：没有目标、已经给这条回复生成过（除非 force）、空闲不到 30 分钟（除非 force）都不生成
function shouldGenerateRecap(agentSession, nowMs, force) {
    const target = findRecapTarget(agentSession && agentSession.messages);
    if (!target || !target.replyId) {
        return null;
    }
    if (!force) {
        if (agentSession.recap && agentSession.recap.forMessageId === target.replyId) {
            return null;
        }
        if (!target.replyAtMs || nowMs - target.replyAtMs < RECAP_IDLE_MS) {
            return null;
        }
    }
    return target;
}

function normalizeStoredRecap(value, normalizeText) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const text = normalizeText(value.text);
    const forMessageId = typeof value.forMessageId === 'string' ? value.forMessageId : '';
    if (!text || !forMessageId) {
        return null;
    }
    return {
        forMessageId,
        text,
        createdAt: typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt)) ? value.createdAt : null
    };
}

module.exports = {
    RECAP_IDLE_MS,
    findRecapTarget,
    shouldGenerateRecap,
    normalizeStoredRecap
};
