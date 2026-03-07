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
                    return escapeHtml(text || '');
                }
                // [P1-02] 移除 marked 已渲染链接文本中的 on* 事件属性，防止内联 HTML 注入 XSS
                const safeText = String(text || '').replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
                let output = '<a href="' + escapeHtml(safeHref) + '" target="_blank" rel="noopener noreferrer"';
                if (title) {
                    output += ' title="' + escapeHtml(title) + '"';
                }
                output += '>' + safeText + '</a>';
                return output;
            };
            // [P1-01] 重写 image 渲染器：
            //   - 外部 http/https 图片转为可点击链接，避免浏览器自动发起外部请求（追踪像素风险）
            //   - 相对路径图片正常渲染为 <img>
            //   - 危险协议（javascript:/data: 等）降级为纯文本
            renderer.image = function (href, title, text) {
                const safeHref = sanitizeMarkdownUrl(href);
                if (!safeHref) {
                    return escapeHtml(text || '');
                }
                // 外部绝对 URL：转为链接，用户主动决定是否访问
                if (/^https?:/i.test(safeHref)) {
                    const safeText = String(text || '').replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
                        || escapeHtml(safeHref);
                    let output = '<a href="' + escapeHtml(safeHref) + '" target="_blank" rel="noopener noreferrer"';
                    if (title) {
                        output += ' title="' + escapeHtml(title) + '"';
                    }
                    return output + '>[\uD83D\uDDBC\uFE0F点击查看图片:' + safeText + ']</a>';
                }
                // 相对路径：正常渲染为图片
                let output = '<img src="' + escapeHtml(safeHref) + '" alt="' + escapeHtml(text || '') + '"';
                if (title) {
                    output += ' title="' + escapeHtml(title) + '"';
                }
                return output + '>';
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
