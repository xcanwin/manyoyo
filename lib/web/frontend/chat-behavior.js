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

    function stringifyForNarrative(value) {
        if (value === undefined || value === null || value === '') {
            return '';
        }
        if (typeof value === 'string') {
            return value;
        }
        try {
            return JSON.stringify(value, null, 2);
        } catch (e) {
            return String(value);
        }
    }

    function buildTraceNarrative(event) {
        const e = event && typeof event === 'object' ? event : {};
        const codeBlocks = [];

        function pushBlock(label, value) {
            const text = stringifyForNarrative(value);
            if (text) {
                codeBlocks.push({ label, text });
            }
        }

        if (e.kind === 'command') {
            let sentence = `执行命令 \`${e.command || ''}\``;
            if (e.exitCode !== undefined && e.exitCode !== null) {
                sentence += `，退出码 ${e.exitCode}`;
            } else if (e.status) {
                sentence += `，状态：${e.status}`;
            }
            pushBlock('输出', e.result);
            pushBlock('错误', e.error);
            return { sentence, tone: 'neutral', codeBlocks };
        }

        if (e.kind === 'mcp') {
            let sentence = `调用 MCP 工具 \`${e.server || ''}.${e.tool || ''}\``;
            if (e.argumentSummary) {
                sentence += `（${e.argumentSummary}）`;
            }
            pushBlock('参数', e.arguments);
            pushBlock('结果', e.result);
            pushBlock('错误', e.error);
            return { sentence, tone: 'neutral', codeBlocks };
        }

        if (e.kind === 'tool') {
            let sentence = `调用工具 \`${e.toolName || ''}\``;
            if (e.argumentSummary) {
                sentence += `（${e.argumentSummary}）`;
            }
            pushBlock('参数', e.arguments);
            pushBlock('结果', e.result);
            pushBlock('错误', e.error);
            return { sentence, tone: 'neutral', codeBlocks };
        }

        if (e.kind === 'error') {
            const detail = stringifyForNarrative(e.detail);
            return {
                sentence: detail ? `出现错误：${detail}` : '出现错误',
                tone: 'error',
                codeBlocks: detail ? [{ label: '详情', text: detail }] : []
            };
        }

        if (e.kind === 'agent_message' || e.kind === 'status') {
            return {
                sentence: e.detail ? String(e.detail) : String(e.text || ''),
                tone: 'neutral',
                codeBlocks: []
            };
        }

        return { sentence: String(e.text || ''), tone: 'neutral', codeBlocks: [] };
    }

    window.ManyoyoChatBehavior = {
        isNearBottom,
        summarizeTraceFlow,
        shouldExpandComposer,
        buildDocumentTitle,
        buildTraceNarrative
    };
}());
