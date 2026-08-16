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

    function shouldExpandComposer(state) {
        const opts = state && typeof state === 'object' ? state : {};
        return Boolean(opts.focused || opts.hasDraft);
    }

    function buildDocumentTitle(agentName) {
        const trimmed = String(agentName || '').trim();
        return trimmed ? `${trimmed} · MANYOYO Web` : 'MANYOYO Web';
    }

    function reorderMessagesForDisplay(messages) {
        const list = Array.isArray(messages) ? messages : [];
        const result = [];
        for (let i = 0; i < list.length; i += 1) {
            const msg = list[i];
            if (msg && msg.streamTrace) {
                const next = list[i + 1];
                if (next && next.role === 'assistant' && !next.streamTrace) {
                    result.push(next, msg);
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
        shouldExpandComposer,
        buildDocumentTitle,
        reorderMessagesForDisplay
    };
}());
