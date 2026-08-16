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

    window.ManyoyoChatBehavior = {
        isNearBottom,
        summarizeTraceFlow
    };
}());
