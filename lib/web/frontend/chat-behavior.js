(function () {
    function isNearBottom(scrollTop, scrollHeight, clientHeight, thresholdPx) {
        const threshold = Number.isFinite(thresholdPx) ? thresholdPx : 40;
        const distance = scrollHeight - (scrollTop + clientHeight);
        return distance <= threshold;
    }

    function summarizeTraceFlow(traceEvents, options) {
        const events = Array.isArray(traceEvents) ? traceEvents : [];
        const count = events.length;
        if (count === 0) {
            return { count: 0, label: '暂无步骤' };
        }
        const opts = options && typeof options === 'object' ? options : {};
        const hasError = events.some(event => event && event.kind === 'error');
        const status = hasError ? '有错误' : (opts.pending === true ? '进行中' : '已完成');
        return { count, label: `${count} 步 · ${status}` };
    }

    function buildDocumentTitle(agentName) {
        const trimmed = String(agentName || '').trim();
        return trimmed ? `${trimmed} · MANYOYO Web` : 'MANYOYO Web';
    }

    function buildStructuredTraceResidualLines(message) {
        const lines = String(message && message.content ? message.content : '')
            .split('\n')
            .map(line => String(line || '').trim())
            .filter(Boolean);
        const traceEvents = Array.isArray(message && message.traceEvents) ? message.traceEvents : [];
        const consumed = new Map();
        traceEvents.forEach(traceEvent => {
            const text = traceEvent && traceEvent.text ? String(traceEvent.text) : '';
            if (!text) {
                return;
            }
            text.split('\n').forEach(subLine => {
                const key = String(subLine || '').trim();
                if (!key) {
                    return;
                }
                consumed.set(key, (consumed.get(key) || 0) + 1);
            });
        });
        return lines.filter(line => {
            if (!line || line === '[执行过程]') {
                return false;
            }
            const remaining = consumed.get(line) || 0;
            if (remaining > 0) {
                consumed.set(line, remaining - 1);
                return false;
            }
            return true;
        });
    }

    const MERGEABLE_TRACE_KINDS = new Set(['tool', 'command', 'mcp']);

    function mergeToolTraceEvents(traceEvents) {
        const events = Array.isArray(traceEvents) ? traceEvents : [];
        const result = [];
        const indexByKey = new Map();
        events.forEach(event => {
            const kind = event && event.kind ? String(event.kind) : '';
            const toolId = event && event.toolId ? String(event.toolId) : '';
            if (MERGEABLE_TRACE_KINDS.has(kind) && toolId) {
                const key = `${kind}:${toolId}`;
                if (indexByKey.has(key)) {
                    const index = indexByKey.get(key);
                    result[index] = Object.assign({}, result[index], event);
                    return;
                }
                indexByKey.set(key, result.length);
            }
            result.push(event);
        });
        return result;
    }

    function mergeTraceIntoReply(messages) {
        const list = Array.isArray(messages) ? messages : [];
        const result = [];
        for (let i = 0; i < list.length; i += 1) {
            const msg = list[i];
            if (msg && msg.streamTrace) {
                const next = list[i + 1];
                if (next && next.role === 'assistant' && !next.streamTrace) {
                    result.push(Object.assign({}, next, { timestamp: msg.timestamp, pairedTrace: msg }));
                    i += 1;
                    continue;
                }
            }
            result.push(msg);
        }
        return result;
    }

    window.ManyoyoChatBehavior = {
        isNearBottom,
        summarizeTraceFlow,
        buildDocumentTitle,
        mergeTraceIntoReply,
        mergeToolTraceEvents,
        buildStructuredTraceResidualLines
    };
}());
