'use strict';

function createWebHttpHandlers(deps) {
    const {
        loadTemplate,
        sendHtml,
        sendJson,
        sendRedirect,
        sendStaticAsset,
        sendVendorAsset,
        readJsonBody,
        secureStringEqual,
        createWebAuthSession,
        clearWebAuthSession,
        getWebAuthCookie,
        getWebAuthClearCookie,
        getWebAuthSession,
        AUTH_FRONTEND_ASSETS,
        APP_FRONTEND_ASSETS,
        APP_VENDOR_ASSETS,
        handleWebApi
    } = deps;

    function serveAllowedStaticAsset(req, res, pathname, pattern, allowedAssets, sendAsset) {
        const matched = req.method === 'GET' ? pathname.match(pattern) : null;
        if (!matched) {
            return false;
        }
        const assetName = matched[1];
        if (!allowedAssets.has(assetName)) {
            sendHtml(res, 404, '<h1>404 Not Found</h1>');
            return true;
        }
        sendAsset(res, assetName);
        return true;
    }

    async function handleWebAuthRoutes(req, res, pathname, ctx, state) {
        if (req.method === 'GET' && pathname === '/favicon.ico') {
            res.writeHead(204, { 'Cache-Control': 'no-store' });
            res.end();
            return true;
        }

        if (req.method === 'GET' && pathname === '/auth/login') {
            sendHtml(res, 200, loadTemplate('login.html'));
            return true;
        }

        if (serveAllowedStaticAsset(req, res, pathname, /^\/auth\/frontend\/([A-Za-z0-9._-]+)$/, AUTH_FRONTEND_ASSETS, sendStaticAsset)) {
            return true;
        }

        if (req.method === 'POST' && pathname === '/auth/login') {
            const payload = await readJsonBody(req);
            const username = String(payload.username || '').trim();
            const password = String(payload.password || '');

            if (!username || !password) {
                sendJson(res, 400, { error: '用户名和密码不能为空' });
                return true;
            }

            const userOk = secureStringEqual(username, ctx.authUser);
            const passOk = secureStringEqual(password, ctx.authPass);
            if (!(userOk && passOk)) {
                sendJson(res, 401, { error: '用户名或密码错误' });
                return true;
            }

            const sessionId = createWebAuthSession(state, username);
            sendJson(
                res,
                200,
                { ok: true, username },
                { 'Set-Cookie': getWebAuthCookie(sessionId) }
            );
            return true;
        }

        if (req.method === 'POST' && pathname === '/auth/logout') {
            clearWebAuthSession(state, req);
            sendJson(
                res,
                200,
                { ok: true },
                { 'Set-Cookie': getWebAuthClearCookie() }
            );
            return true;
        }

        return false;
    }

    function sendWebUnauthorized(res, pathname) {
        if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
            sendJson(res, 401, { error: 'UNAUTHORIZED' });
            return;
        }
        if (pathname === '/' || pathname === '') {
            sendRedirect(res, 302, '/auth/login', { 'Set-Cookie': getWebAuthClearCookie() });
            return;
        }
        sendHtml(
            res,
            401,
            loadTemplate('login.html'),
            { 'Set-Cookie': getWebAuthClearCookie() }
        );
    }

    async function handleWebHttpRequest(req, res, pathname, ctx, state) {
        if (await handleWebAuthRoutes(req, res, pathname, ctx, state)) {
            return true;
        }

        const authSession = getWebAuthSession(state, req);
        if (!authSession) {
            sendWebUnauthorized(res, pathname);
            return true;
        }

        if (req.method === 'GET' && pathname === '/') {
            sendHtml(res, 200, loadTemplate('app.html'));
            return true;
        }

        if (serveAllowedStaticAsset(req, res, pathname, /^\/app\/frontend\/([A-Za-z0-9._-]+)$/, APP_FRONTEND_ASSETS, sendStaticAsset)) {
            return true;
        }

        if (serveAllowedStaticAsset(req, res, pathname, /^\/app\/vendor\/([A-Za-z0-9._-]+)$/, APP_VENDOR_ASSETS, sendVendorAsset)) {
            return true;
        }

        if (pathname === '/healthz') {
            sendJson(res, 200, { ok: true });
            return true;
        }

        if (pathname.startsWith('/api/')) {
            const handled = await handleWebApi(req, res, pathname, ctx, state);
            if (!handled) {
                sendJson(res, 404, { error: 'Not Found' });
            }
            return true;
        }

        sendHtml(res, 404, '<h1>404 Not Found</h1>');
        return true;
    }

    return {
        serveAllowedStaticAsset,
        handleWebAuthRoutes,
        sendWebUnauthorized,
        handleWebHttpRequest
    };
}

module.exports = {
    createWebHttpHandlers
};
