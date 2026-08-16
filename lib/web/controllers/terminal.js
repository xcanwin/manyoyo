'use strict';

function sendTerminalEvent(ws, WebSocket, type, payload = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }
    ws.send(JSON.stringify({ type, ...payload }));
}

function bindTerminalWebSocket(ctx, state, ws, containerName, cols, rows, dependencies) {
    const { WebSocket, normalizeTerminalSize } = dependencies;
    const sessionId = `${containerName}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const ptyProcess = ctx.createTerminalProcess({
        dockerCmd: ctx.dockerCmd,
        containerName,
        cols,
        rows,
        env: process.env
    });
    const session = {
        id: sessionId,
        containerName,
        ptyProcess,
        closing: false
    };

    state.terminalSessions.set(sessionId, session);
    sendTerminalEvent(ws, WebSocket, 'status', { phase: 'ready', sessionId, containerName, cols, rows });

    const cleanup = () => {
        if (session.closing) return;
        session.closing = true;
        state.terminalSessions.delete(sessionId);
        try {
            ptyProcess.kill();
        } catch (error) {
            // 终端已退出时无需额外处理。
        }
    };

    ptyProcess.onData(data => sendTerminalEvent(ws, WebSocket, 'output', { data: String(data || '') }));
    ptyProcess.onExit((code, signal) => {
        sendTerminalEvent(ws, WebSocket, 'status', {
            phase: 'closed',
            code: typeof code === 'number' ? code : null,
            signal: signal || null
        });
        cleanup();
        if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    ws.on('message', raw => {
        let payload;
        try {
            payload = JSON.parse(raw.toString('utf-8'));
        } catch (error) {
            payload = { type: 'input', data: raw.toString('utf-8') };
        }
        if (!payload || typeof payload !== 'object') return;
        if (payload.type === 'input' && typeof payload.data === 'string' && payload.data.length) {
            ptyProcess.write(payload.data);
            return;
        }
        if (payload.type === 'resize') {
            const size = normalizeTerminalSize(payload.cols, payload.rows);
            ptyProcess.resize(size.cols, size.rows);
            sendTerminalEvent(ws, WebSocket, 'status', { phase: 'resized', ...size });
            return;
        }
        if (payload.type === 'close') ws.close();
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
}

module.exports = {
    bindTerminalWebSocket
};
