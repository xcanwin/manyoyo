(function () {
    const MARKDOWN_LINK_PROTOCOL_PATTERN = /^(https?:|mailto:|tel:)/i;
    const MARKDOWN_IMAGE_PROTOCOL_PATTERN = /^(https?:)/i;
    const runtime = {
        configured: false,
        available: false,
        linkGuardBound: false,
        linkOpenHandler: null
    };

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeRendererValue(value) {
        if (value && typeof value === 'object') {
            if (typeof value.href === 'string') {
                return value.href;
            }
            if (typeof value.text === 'string') {
                return value.text;
            }
        }
        return String(value == null ? '' : value);
    }

    function sanitizeMarkdownLinkUrl(value) {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) {
            return '';
        }
        if (MARKDOWN_LINK_PROTOCOL_PATTERN.test(raw)) {
            return raw;
        }
        return '';
    }

    function sanitizeMarkdownImageUrl(value) {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) {
            return '';
        }
        if (raw[0] === '/') {
            return raw.startsWith('//') ? '' : raw;
        }
        if (raw.startsWith('./') || raw.startsWith('../')) {
            return raw;
        }
        if (MARKDOWN_IMAGE_PROTOCOL_PATTERN.test(raw)) {
            return raw;
        }
        return '';
    }

    function getRendererToken(value) {
        return value && typeof value === 'object' ? value : null;
    }

    function renderInlineTokens(rendererContext, token, fallbackText) {
        if (
            token
            && Array.isArray(token.tokens)
            && rendererContext
            && rendererContext.parser
            && typeof rendererContext.parser.parseInline === 'function'
        ) {
            try {
                return String(rendererContext.parser.parseInline(token.tokens) || '');
            } catch (e) {
                // ignore and fallback to plain text below
            }
        }
        if (token && typeof token.text === 'string') {
            return escapeHtml(token.text);
        }
        return escapeHtml(fallbackText || '');
    }

    function buildSafeAnchorHtml(href, title, content, extraAttrs) {
        let output = '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer"'
            + ' referrerpolicy="no-referrer" data-safe-external-link="true"'
            + ' data-safe-href="' + escapeHtml(href) + '"';
        if (title) {
            output += ' title="' + escapeHtml(title) + '"';
        }
        if (extraAttrs) {
            output += extraAttrs;
        }
        output += '>' + content + '</a>';
        return output;
    }

    function openExternalLinkWithNoReferrer(href) {
        const url = String(href || '').trim();
        if (!url || typeof document === 'undefined' || !document || typeof document.createElement !== 'function') {
            if (typeof window.open === 'function') {
                const opened = window.open(url, '_blank', 'noopener,noreferrer');
                if (opened) {
                    opened.opener = null;
                }
            }
            return;
        }

        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.referrerPolicy = 'no-referrer';
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        try {
            if (typeof anchor.click === 'function') {
                anchor.click();
            } else if (typeof window.open === 'function') {
                const opened = window.open(url, '_blank', 'noopener,noreferrer');
                if (opened) {
                    opened.opener = null;
                }
            }
        } finally {
            if (anchor.parentNode && typeof anchor.parentNode.removeChild === 'function') {
                anchor.parentNode.removeChild(anchor);
            }
        }
    }

    function requestExternalLinkOpen(href) {
        const url = String(href || '').trim();
        if (!url) {
            return;
        }
        if (typeof runtime.linkOpenHandler === 'function') {
            runtime.linkOpenHandler(url);
            return;
        }

        const shouldOpen = typeof window.confirm === 'function'
            ? window.confirm('即将打开外部链接：\n' + url + '\n\n确认继续打开？')
            : true;
        if (!shouldOpen) {
            return;
        }

        openExternalLinkWithNoReferrer(url);
    }

    function bindDocumentLinkGuard() {
        if (runtime.linkGuardBound || typeof document === 'undefined' || !document || typeof document.addEventListener !== 'function') {
            return;
        }

        document.addEventListener('click', function (event) {
            const target = event && event.target;
            if (!target || typeof target.closest !== 'function') {
                return;
            }
            const link = target.closest('a[data-safe-external-link="true"]');
            if (!link) {
                return;
            }
            if (event.preventDefault) {
                event.preventDefault();
            }
            if (event.stopPropagation) {
                event.stopPropagation();
            }

            const href = String(
                (typeof link.getAttribute === 'function' && (link.getAttribute('data-safe-href') || link.getAttribute('href')))
                || link.href
                || ''
            ).trim();
            if (!href) {
                return;
            }

            requestExternalLinkOpen(href);
        });

        runtime.linkGuardBound = true;
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
                const token = getRendererToken(html);
                return escapeHtml(token ? token.text : html);
            };
            renderer.link = function (href, title, text) {
                const token = getRendererToken(href);
                const rawHref = token ? token.href : normalizeRendererValue(href);
                const rawTitle = token ? token.title : title;
                const safeHref = sanitizeMarkdownLinkUrl(rawHref);
                const safeText = renderInlineTokens(this, token, text)
                    // [P1-02] 移除 marked 已渲染链接文本中的 on* 事件属性，防止内联 HTML 注入 XSS
                    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
                if (!safeHref) {
                    return safeText || escapeHtml(token ? token.text : text || '');
                }
                return buildSafeAnchorHtml(safeHref, rawTitle, safeText || escapeHtml(safeHref));
            };
            // [P1-01] 重写 image 渲染器：
            //   - 外部 http/https 图片转为可点击链接，避免浏览器自动发起外部请求（追踪像素风险）
            //   - 相对路径图片正常渲染为 <img>
            //   - 危险协议（javascript:/data: 等）降级为纯文本
            renderer.image = function (href, title, text) {
                const token = getRendererToken(href);
                const rawHref = token ? token.href : normalizeRendererValue(href);
                const rawTitle = token ? token.title : title;
                const safeHref = sanitizeMarkdownImageUrl(rawHref);
                const safeText = renderInlineTokens(this, token, text)
                    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
                if (!safeHref) {
                    return safeText || escapeHtml(token ? token.text : text || '');
                }
                // 外部绝对 URL：转为链接，用户主动决定是否访问
                if (/^https?:/i.test(safeHref)) {
                    return buildSafeAnchorHtml(
                        safeHref,
                        rawTitle,
                        '[\uD83D\uDDBC\uFE0F点击查看图片:' + (safeText || escapeHtml(safeHref)) + ']'
                    );
                }
                // 相对路径：正常渲染为图片
                let output = '<img src="' + escapeHtml(safeHref) + '" alt="' + escapeHtml(text || '') + '"';
                if (rawTitle) {
                    output += ' title="' + escapeHtml(rawTitle) + '"';
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
        render,
        openExternalLink: openExternalLinkWithNoReferrer,
        setLinkOpenHandler: function (handler) {
            runtime.linkOpenHandler = typeof handler === 'function' ? handler : null;
        }
    };

    bindDocumentLinkGuard();
}());
