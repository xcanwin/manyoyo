(function () {
    const MARKDOWN_URL_PROTOCOL_PATTERN = /^(https?:|mailto:|tel:)/i;
    const runtime = {
        configured: false,
        available: false
    };

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function sanitizeMarkdownUrl(value) {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) {
            return '';
        }
        if (raw[0] === '#') {
            return raw;
        }
        if (raw[0] === '/') {
            return raw.startsWith('//') ? '' : raw;
        }
        if (raw.startsWith('./') || raw.startsWith('../')) {
            return raw;
        }
        if (MARKDOWN_URL_PROTOCOL_PATTERN.test(raw)) {
            return raw;
        }
        return '';
    }

    function getMarkedApi() {
        const api = window.marked;
        if (!api || typeof api.parse !== 'function') {
            return null;
        }
        return api;
    }

    function ensureRendererConfigured() {
        if (runtime.configured) {
            return runtime.available;
        }

        const markedApi = getMarkedApi();
        if (!markedApi || typeof markedApi.Renderer !== 'function' || typeof markedApi.use !== 'function') {
            runtime.configured = true;
            runtime.available = false;
            return false;
        }

        try {
            const renderer = new markedApi.Renderer();
            renderer.html = function (html) {
                return escapeHtml(html);
            };
            renderer.link = function (href, title, text) {
                const safeHref = sanitizeMarkdownUrl(href);
                if (!safeHref) {
                    return text || '';
                }
                let output = '<a href="' + escapeHtml(safeHref) + '" target="_blank" rel="noopener noreferrer"';
                if (title) {
                    output += ' title="' + escapeHtml(title) + '"';
                }
                output += '>' + (text || '') + '</a>';
                return output;
            };

            markedApi.use({
                gfm: true,
                breaks: true,
                renderer
            });
            runtime.available = true;
        } catch (e) {
            runtime.available = false;
        }
        runtime.configured = true;
        return runtime.available;
    }

    function shouldRenderMessage(msg) {
        return Boolean(msg && msg.mode === 'agent' && msg.role === 'assistant');
    }

    function render(content) {
        const source = String(content == null ? '' : content);
        if (!source) {
            return '';
        }
        if (!ensureRendererConfigured()) {
            return '';
        }
        const markedApi = getMarkedApi();
        if (!markedApi) {
            return '';
        }
        try {
            return String(markedApi.parse(source) || '');
        } catch (e) {
            return '';
        }
    }

    window.ManyoyoMarkdown = {
        shouldRenderMessage,
        render
    };
}());
