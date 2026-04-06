'use strict';

function createApiRouteHelpers(deps) {
    const {
        req,
        res,
        ctx,
        state,
        sendJson,
        readJsonBody,
        getValidSessionRef,
        prepareWebAgentExecution
    } = deps;

    const withSessionRef = handler => async match => {
        const sessionRef = getValidSessionRef(ctx, res, match[1]);
        if (!sessionRef) {
            return;
        }
        await handler(sessionRef, match);
    };

    const withJsonBody = handler => async (...args) => {
        const payload = await readJsonBody(req);
        await handler(payload, ...args);
    };

    const withSessionJsonBody = (handler, fallbackError = '') => withSessionRef(async (sessionRef, match) => {
        let payload = null;
        if (fallbackError) {
            try {
                payload = await readJsonBody(req);
            } catch (e) {
                sendJson(res, 400, { error: e.message || fallbackError });
                return;
            }
        } else {
            payload = await readJsonBody(req);
        }
        await handler(sessionRef, payload, match);
    });

    const getRequiredBodyText = (payload, key, emptyMessage) => {
        const value = String(payload && payload[key] || '').trim();
        if (!value) {
            sendJson(res, 400, { error: emptyMessage });
            return null;
        }
        return value;
    };

    const prepareAgentRequest = async (sessionRef, prompt) => {
        try {
            return await prepareWebAgentExecution(ctx, state, sessionRef, prompt);
        } catch (e) {
            sendJson(res, 400, { error: e && e.message ? e.message : 'Agent 执行准备失败' });
            return null;
        }
    };

    return {
        withSessionRef,
        withJsonBody,
        withSessionJsonBody,
        getRequiredBodyText,
        prepareAgentRequest
    };
}

async function runMatchedRoute(routes, method, pathname) {
    for (const route of routes) {
        if (route.method !== method) {
            continue;
        }
        const matched = route.match(pathname);
        if (!matched) {
            continue;
        }
        await route.handler(matched);
        return true;
    }
    return false;
}

module.exports = {
    createApiRouteHelpers,
    runMatchedRoute
};
