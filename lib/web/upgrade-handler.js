'use strict';

function createWebUpgradeHandler(options = {}) {
    const formatUrlHost = options.formatUrlHost || (host => host);
    const sendWebSocketUpgradeError = options.sendWebSocketUpgradeError || (() => {});
    const getWebAuthSession = options.getWebAuthSession || (() => null);
    const parseWebSessionKey = options.parseWebSessionKey || (() => ({ containerName: '', agentId: '' }));
    const decodeSessionName = options.decodeSessionName || (value => value);
    const safeContainerNamePattern = options.safeContainerNamePattern || /^[A-Za-z0-9_.-]+$/;
    const normalizeTerminalSize = options.normalizeTerminalSize || ((cols, rows) => ({ cols, rows }));
    const ensureWebContainer = options.ensureWebContainer || (async () => {});
    const maxTerminalSessions = Number.isInteger(options.maxTerminalSessions) ? options.maxTerminalSessions : 20;

    return function handleWebUpgradeRequest(req, socket, head, wsServer, ctx, state, listenPort) {
        const fallbackHost = `${formatUrlHost(ctx.serverHost)}:${ctx.serverPort}`;
        let url;
        try {
            url = new URL(req.url || '/', `http://${req.headers.host || fallbackHost}`);
        } catch {
            sendWebSocketUpgradeError(socket, 400, 'Invalid URL');
            return;
        }

        const terminalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/terminal\/ws$/);
        if (!terminalMatch) {
            socket.destroy();
            return;
        }

        const requestOrigin = req.headers.origin;
        if (requestOrigin) {
            const allowedOrigins = new Set();
            const hostHeader = req.headers.host || '';
            if (hostHeader) {
                allowedOrigins.add(`http://${hostHeader}`);
                allowedOrigins.add(`https://${hostHeader}`);
            }
            if (ctx.serverHost !== '0.0.0.0') {
                allowedOrigins.add(`http://${formatUrlHost(ctx.serverHost)}:${listenPort}`);
                if (ctx.serverHost === '127.0.0.1') {
                    allowedOrigins.add(`http://localhost:${listenPort}`);
                }
            }
            if (allowedOrigins.size > 0 && !allowedOrigins.has(requestOrigin)) {
                sendWebSocketUpgradeError(socket, 403, 'Forbidden');
                return;
            }
        }

        const authSession = getWebAuthSession(state, req);
        if (!authSession) {
            sendWebSocketUpgradeError(socket, 401, 'UNAUTHORIZED');
            return;
        }

        const sessionRef = parseWebSessionKey(decodeSessionName(terminalMatch[1]));
        if (!ctx.isValidContainerName(sessionRef.containerName)) {
            sendWebSocketUpgradeError(socket, 400, `containerName 非法: ${sessionRef.containerName}`);
            return;
        }
        if (!safeContainerNamePattern.test(sessionRef.agentId)) {
            sendWebSocketUpgradeError(socket, 400, `agentId 非法: ${sessionRef.agentId}`);
            return;
        }

        if (state.terminalSessions.size >= maxTerminalSessions) {
            sendWebSocketUpgradeError(socket, 429, 'TERMINAL_LIMIT_REACHED');
            return;
        }

        const { cols, rows } = normalizeTerminalSize(
            url.searchParams.get('cols'),
            url.searchParams.get('rows')
        );

        ensureWebContainer(ctx, state, sessionRef.containerName)
            .then(() => {
                wsServer.handleUpgrade(req, socket, head, ws => {
                    wsServer.emit('connection', ws, req, {
                        containerName: sessionRef.containerName,
                        cols,
                        rows
                    });
                });
            })
            .catch(error => {
                sendWebSocketUpgradeError(socket, 500, error && error.message ? error.message : '终端创建失败');
            });
    };
}

module.exports = {
    createWebUpgradeHandler
};
