'use strict';

// claude 的上下文占用（仅 claude）：开了 --include-partial-messages 的流里，每次模型请求有一对 stream_event：
// message_start.usage 在第三方服务下常常全是 0，message_delta.usage 才有真实值。
// 最后一次请求的 输入 + 缓存读 + 缓存写 + 输出 之和 ≈ 当前上下文；result.usage 是整轮多次请求的累加、不能用。
// result.modelUsage 里的 contextWindow 当分母。只看主 Agent（带 parent_tool_use_id 的是子 Agent）。

function toCount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function readUsage(usage) {
    const source = usage && typeof usage === 'object' ? usage : {};
    return {
        inputTokens: toCount(source.input_tokens),
        cacheReadTokens: toCount(source.cache_read_input_tokens),
        cacheCreationTokens: toCount(source.cache_creation_input_tokens),
        outputTokens: toCount(source.output_tokens)
    };
}

function mergeMax(base, next) {
    const result = { ...base };
    for (const key of Object.keys(next)) {
        result[key] = Math.max(base[key] || 0, next[key]);
    }
    return result;
}

function sumOf(usage) {
    return usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + usage.outputTokens;
}

function parseLine(line) {
    const text = line.trim();
    if (!text || text[0] !== '{') {
        return null;
    }
    try {
        const payload = JSON.parse(text);
        return payload && typeof payload === 'object' ? payload : null;
    } catch (e) {
        return null;
    }
}

// 返回 { usedTokens, window, inputTokens, cacheReadTokens, cacheCreationTokens } 或 null（没有可用数据）
function extractClaudeContextUsage(text, options = {}) {
    let current = null;
    let last = null;
    let initModel = '';
    let modelUsage = null;
    for (const line of String(text || '').split('\n')) {
        const payload = parseLine(line);
        if (!payload) {
            continue;
        }
        if (payload.type === 'system' && payload.subtype === 'init' && typeof payload.model === 'string') {
            initModel = payload.model;
        } else if (payload.type === 'stream_event' && !payload.parent_tool_use_id && payload.event) {
            const event = payload.event;
            if (event.type === 'message_start') {
                current = readUsage(event.message && event.message.usage);
            } else if (event.type === 'message_delta') {
                current = mergeMax(current || readUsage(null), readUsage(event.usage));
                if (sumOf(current) > 0) {
                    last = current;
                }
            }
        } else if (payload.type === 'result' && payload.modelUsage && typeof payload.modelUsage === 'object') {
            modelUsage = payload.modelUsage;
        }
    }
    if (!last) {
        return null;
    }
    let window = 0;
    if (modelUsage) {
        const model = options.model || initModel;
        const pick = model && modelUsage[model] ? modelUsage[model] : null;
        window = toCount(pick && pick.contextWindow);
        if (!window) {
            window = Math.max(0, ...Object.values(modelUsage).map(item => toCount(item && item.contextWindow)));
        }
    }
    return {
        usedTokens: sumOf(last),
        window,
        inputTokens: last.inputTokens,
        cacheReadTokens: last.cacheReadTokens,
        cacheCreationTokens: last.cacheCreationTokens
    };
}

// 落盘用的规整：只留这几个数字字段和时间
function normalizeStoredContextUsage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const usedTokens = toCount(value.usedTokens);
    if (!usedTokens) {
        return null;
    }
    return {
        usedTokens,
        window: toCount(value.window),
        inputTokens: toCount(value.inputTokens),
        cacheReadTokens: toCount(value.cacheReadTokens),
        cacheCreationTokens: toCount(value.cacheCreationTokens),
        updatedAt: typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt)) ? value.updatedAt : null
    };
}

module.exports = {
    extractClaudeContextUsage,
    normalizeStoredContextUsage
};
