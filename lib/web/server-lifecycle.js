'use strict';

function createWebServerLifecycleHelpers(options = {}) {
    const http = options.http;
    const WebSocket = options.WebSocket;
    const formatUrlHost = options.formatUrlHost || (host => host);
    const normalizeTerminalSize = options.normalizeTerminalSize || ((cols, rows) => ({ cols, rows }));
    const bindTerminalWebSocket = options.bindTerminalWebSocket || (() => {});
    const handleWebUpgradeRequest = options.handleWebUpgradeRequest || (() => {});
    const sendJson = options.sendJson || (() => {});
    const sendHtml = options.sendHtml || (() => {});
    const cleanupWebRuntimeState = options.cleanupWebRuntimeState || (() => {});

    return {
        createWsServer(ctx, state) {
            const wsServer = new WebSocket.Server({
                noServer: true,
                maxPayload: 1024 * 1024
            });
            wsServer.on('error', err => {
                ctx.logger.error('ws server error', err);
            });

            wsServer.on('connection', (ws, req, meta = {}) => {
                const containerName = meta.containerName;
                if (!containerName || !ctx.isValidContainerName(containerName)) {
                    ws.close();
                    return;
                }
                const { cols, rows } = normalizeTerminalSize(meta.cols, meta.rows);
                bindTerminalWebSocket(ctx, state, ws, containerName, cols, rows);
            });

            return wsServer;
        },
        createHttpServer(ctx, state, wsServer, handleWebHttpRequest) {
            const server = http.createServer(async (req, res) => {
                try {
                    const fallbackHost = `${formatUrlHost(ctx.serverHost)}:${ctx.serverPort}`;
                    const url = new URL(req.url, `http://${req.headers.host || fallbackHost}`);
                    const pathname = url.pathname;
                    await handleWebHttpRequest(req, res, pathname, ctx, state);
                } catch (error) {
                    ctx.logger.error('http request error', {
                        method: req && req.method ? req.method : '',
                        url: req && req.url ? req.url : '',
                        message: error && error.message ? error.message : 'Server Error'
                    });
                    if ((req.url || '').startsWith('/api/')) {
                        sendJson(res, 500, { error: error.message || 'Server Error' });
                    } else {
                        sendHtml(res, 500, '<h1>500 Server Error</h1>');
                    }
                }
            });
            server.on('error', err => {
                ctx.logger.error('http server error', err);
            });
            server.on('close', () => {
                ctx.logger.warn('http server closed');
            });
            server.on('upgrade', (req, socket, head) => {
                handleWebUpgradeRequest(req, socket, head, wsServer, ctx, state, server.__manyoyoListenPort || ctx.serverPort);
            });
            return server;
        },
        async listenWebServer(server, ctx) {
            let listenPort = ctx.serverPort;
            await new Promise((resolve, reject) => {
                server.once('error', err => {
                    ctx.logger.error('http server listen failed', err);
                    reject(err);
                });
                server.listen(ctx.serverPort, ctx.serverHost, () => {
                    const address = server.address();
                    if (address && typeof address === 'object' && typeof address.port === 'number') {
                        listenPort = address.port;
                    }
                    server.__manyoyoListenPort = listenPort;
                    const { GREEN, CYAN, YELLOW, NC } = ctx.colors;
                    const listenHost = formatUrlHost(ctx.serverHost);
                    console.log(`${GREEN}✅ MANYOYO Web 服务已启动: http://${listenHost}:${listenPort}${NC}`);
                    console.log(`${CYAN}提示: 左侧是 manyoyo 容器会话列表，中间是活动/终端/配置/检查工作台，右侧显示当前会话上下文。${NC}`);
                    if (ctx.serverHost === '0.0.0.0') {
                        console.log(`${CYAN}提示: 当前监听全部网卡，请用本机局域网 IP 访问。${NC}`);
                    }
                    console.log(`${CYAN}🔐 登录用户名: ${YELLOW}${ctx.authUser}${NC}`);
                    if (ctx.authPassAuto) {
                        console.log(`${CYAN}🔐 登录密码(本次随机): ${YELLOW}${ctx.authPass}${NC}`);
                    } else {
                        console.log(`${CYAN}🔐 登录密码: 使用你配置的 serve -P / serverPass / MANYOYO_SERVER_PASS${NC}`);
                    }
                    ctx.logger.info('web server started', {
                        host: ctx.serverHost,
                        port: listenPort,
                        authUser: ctx.authUser,
                        authPassAuto: Boolean(ctx.authPassAuto)
                    });
                    resolve();
                });
            });
            return listenPort;
        },
        closeWebServer(server, wsServer, ctx, state) {
            return new Promise(resolve => {
                ctx.logger.info('web server closing');
                cleanupWebRuntimeState(state);

                const closeHttp = () => {
                    if (!server.listening) {
                        resolve();
                        return;
                    }
                    server.close(() => resolve());
                };

                try {
                    wsServer.close(() => closeHttp());
                } catch {
                    closeHttp();
                }
            });
        }
    };
}

module.exports = {
    createWebServerLifecycleHelpers
};
