(function () {
    const platform = window.ManyoyoPlatform || {
        fetch: function (input, init) {
            return window.fetch(input, init);
        },
        navigate: function (url) {
            window.location.href = url;
        },
        createTextDecoder: function (label) {
            return new window.TextDecoder(label);
        }
    };

    function buildRequestOptions(options) {
        const source = options && typeof options === 'object' ? options : {};
        const headers = Object.assign(
            { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            source.headers && typeof source.headers === 'object' ? source.headers : {}
        );
        return Object.assign({}, source, { headers });
    }

    async function parseJsonResponse(response) {
        try {
            return await response.json();
        } catch (e) {
            return {};
        }
    }

    async function json(url, options) {
        const response = await platform.fetch(url, buildRequestOptions(options));
        if (response.status === 401) {
            platform.navigate('/');
            throw new Error('未登录或登录已过期');
        }

        const data = await parseJsonResponse(response);
        if (!response.ok) {
            const errorText = data && data.detail ? `${data.error || '请求失败'}: ${data.detail}` : (data.error || '请求失败');
            throw new Error(errorText);
        }
        return data;
    }

    async function stream(url, options, handlers) {
        const response = await platform.fetch(url, buildRequestOptions(options));
        if (response.status === 401) {
            platform.navigate('/');
            throw new Error('未登录或登录已过期');
        }
        if (!response.ok) {
            const data = await parseJsonResponse(response);
            const errorText = data && data.detail ? `${data.error || '请求失败'}: ${data.detail}` : (data.error || '请求失败');
            throw new Error(errorText);
        }
        if (!response.body || typeof response.body.getReader !== 'function') {
            throw new Error('当前浏览器不支持流式读取');
        }

        const streamHandlers = handlers && typeof handlers === 'object' ? handlers : {};
        const decoder = platform.createTextDecoder('utf-8');
        const reader = response.body.getReader();
        let pending = '';

        while (true) {
            const result = await reader.read();
            if (result.done) {
                break;
            }
            pending += decoder.decode(result.value, { stream: true });
            const lines = pending.split('\n');
            pending = lines.pop() || '';
            lines.forEach(function (line) {
                const text = String(line || '').trim();
                if (!text) {
                    return;
                }
                let payload = null;
                try {
                    payload = JSON.parse(text);
                } catch (e) {
                    payload = null;
                }
                if (!payload) {
                    if (typeof streamHandlers.onErrorLine === 'function') {
                        streamHandlers.onErrorLine(text);
                    }
                    return;
                }
                if (typeof streamHandlers.onEvent === 'function') {
                    streamHandlers.onEvent(payload);
                }
            });
        }

        const rest = decoder.decode();
        if (rest) {
            pending += rest;
        }
        const finalText = String(pending || '').trim();
        if (finalText) {
            try {
                const payload = JSON.parse(finalText);
                if (typeof streamHandlers.onEvent === 'function') {
                    streamHandlers.onEvent(payload);
                }
            } catch (e) {
                if (typeof streamHandlers.onErrorLine === 'function') {
                    streamHandlers.onErrorLine(finalText);
                }
            }
        }
    }

    window.ManyoyoApiClient = {
        json,
        stream
    };
})();
