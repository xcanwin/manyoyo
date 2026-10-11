'use strict';

// /messages 的分页、增量与 trace 精简（纯函数，不碰磁盘）。
// 稳定前缀约定：第一条 pending 消息之前的消息不再被修改；违反约定的写操作必须给该 agent 换新的 epoch。

const crypto = require('crypto');

// 响应里的 firstId：page 模式是本页第一条的 id；tail 模式是整份历史当前保留的第一条（前端据此裁掉服务端已丢弃的开头）
const MESSAGES_DEFAULT_LIMIT = 60;
const MESSAGES_MAX_LIMIT = 200;
// 页起点最多再往前多取这么多条，直到遇到 user 消息
const MESSAGES_ALIGN_LOOKBACK = 20;
// tail 一次最多返回这么多条，更多就让前端整页重置
const MESSAGES_TAIL_MAX = 120;
const TRACE_STRING_MAX = 512;
const TRACE_STRING_KEEP = 200;

const MESSAGE_ID_PATTERN = /^[0-9]+-[0-9a-f]{1,8}$/;
const EPOCH_PATTERN = /^[0-9a-f]{8,32}$/;
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function createEpoch() {
    return crypto.randomBytes(6).toString('hex');
}

/**
 * 解析并校验 /messages 的查询参数。
 * @param {URLSearchParams} params
 * @returns {{ error?: string, limit?: number, after?: string, before?: string, epoch?: string }}
 */
function parseMessagesQuery(params) {
    const result = { limit: MESSAGES_DEFAULT_LIMIT };
    if (params.has('limit')) {
        const raw = params.get('limit');
        if (!/^[0-9]{1,3}$/.test(raw)) {
            return { error: 'limit 必须是 1 到 200 的整数' };
        }
        const limit = Number(raw);
        if (limit < 1 || limit > MESSAGES_MAX_LIMIT) {
            return { error: 'limit 必须是 1 到 200 的整数' };
        }
        result.limit = limit;
    }
    if (params.has('after')) {
        const after = params.get('after');
        if (!MESSAGE_ID_PATTERN.test(after)) {
            return { error: 'after 不是合法的消息 id' };
        }
        result.after = after;
    }
    if (params.has('before')) {
        const before = params.get('before');
        if (!MESSAGE_ID_PATTERN.test(before)) {
            return { error: 'before 不是合法的消息 id' };
        }
        result.before = before;
    }
    if (params.has('epoch')) {
        const epoch = params.get('epoch');
        if (!EPOCH_PATTERN.test(epoch)) {
            return { error: 'epoch 格式不正确' };
        }
        result.epoch = epoch;
    }
    if (result.after && result.before) {
        return { error: 'after 与 before 不能同时使用' };
    }
    if (result.after && !result.epoch) {
        return { error: 'after 需要同时提供 epoch' };
    }
    return result;
}

function truncateString(value) {
    return value.length > TRACE_STRING_MAX ? `${value.slice(0, TRACE_STRING_KEEP)}…` : value;
}

// 递归截断 trace 事件里的长字符串，保留结构（kind、标题、状态、id 等）
function truncateTraceValue(value, state, depth) {
    if (typeof value === 'string') {
        const next = truncateString(value);
        if (next !== value) {
            state.truncated = true;
        }
        return next;
    }
    if (depth > 6 || !value || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(item => truncateTraceValue(item, state, depth + 1));
    }
    const out = {};
    Object.keys(value).forEach(key => {
        out[key] = truncateTraceValue(value[key], state, depth + 1);
    });
    return out;
}

/** 列表里的 trace 消息精简版；非 trace 消息或没有需要截断的内容原样返回 */
function toListMessage(message) {
    if (!message || message.streamTrace !== true) {
        return message;
    }
    const state = { truncated: false };
    const content = typeof message.content === 'string' ? truncateString(message.content) : message.content;
    if (content !== message.content) {
        state.truncated = true;
    }
    const traceEvents = Array.isArray(message.traceEvents)
        ? message.traceEvents.map(event => truncateTraceValue(event, state, 0))
        : message.traceEvents;
    if (!state.truncated) {
        return message;
    }
    return { ...message, content, traceEvents, traceTruncated: true };
}

function alignPageStart(messages, start) {
    if (start <= 0 || (messages[start] && messages[start].role === 'user')) {
        return Math.max(0, start);
    }
    const floor = Math.max(0, start - MESSAGES_ALIGN_LOOKBACK);
    for (let i = start - 1; i >= floor; i--) {
        if (messages[i] && messages[i].role === 'user') {
            return i;
        }
    }
    return start;
}

function buildPage(messages, end, limit) {
    const start = alignPageStart(messages, Math.max(0, end - limit));
    const page = messages.slice(start, end);
    return {
        messages: page.map(toListMessage),
        // 页的第一条 id，同时是继续往前翻（before）的游标
        firstId: page.length ? String(page[0].id || '') : '',
        hasMore: start > 0
    };
}

/**
 * @param {Array} messages 某个 agent 的完整消息
 * @param {string} epoch
 * @param {{ limit: number, after?: string, before?: string, epoch?: string }} query
 */
function buildMessagesResponse(messages, epoch, query) {
    const list = Array.isArray(messages) ? messages : [];
    if (query.after) {
        const anchorIndex = query.epoch === epoch
            ? list.findIndex(item => item && item.id === query.after)
            : -1;
        if (anchorIndex !== -1 && list.length - anchorIndex - 1 <= MESSAGES_TAIL_MAX) {
            return {
                messages: list.slice(anchorIndex + 1).map(toListMessage),
                epoch,
                firstId: list.length ? String(list[0].id || '') : '',
                hasMore: false,
                mode: 'tail'
            };
        }
        return { ...buildPage(list, list.length, query.limit), epoch, mode: 'reset' };
    }
    if (query.before) {
        const index = list.findIndex(item => item && item.id === query.before);
        if (index === -1) {
            return { messages: [], epoch, firstId: '', hasMore: false, mode: 'page' };
        }
        return { ...buildPage(list, index, query.limit), epoch, mode: 'page' };
    }
    return { ...buildPage(list, list.length, query.limit), epoch, mode: 'page' };
}

module.exports = {
    MESSAGE_ID_PATTERN,
    CLIENT_MESSAGE_ID_PATTERN,
    createEpoch,
    parseMessagesQuery,
    toListMessage,
    buildMessagesResponse
};
