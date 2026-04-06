'use strict';

function createWebTerminalHelpers(options = {}) {
    const WebSocket = options.WebSocket;
    const spawn = options.spawn;
    const forceKillMs = Number.isInteger(options.forceKillMs) ? options.forceKillMs : 2000;
    const defaultCols = Number.isInteger(options.defaultCols) ? options.defaultCols : 120;
    const defaultRows = Number.isInteger(options.defaultRows) ? options.defaultRows : 36;
    const minCols = Number.isInteger(options.minCols) ? options.minCols : 40;
    const minRows = Number.isInteger(options.minRows) ? options.minRows : 12;

    function toPositiveInt(value, fallback) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return fallback;
        }
        return parsed;
    }

    function getUpgradeStatusText(statusCode) {
        if (statusCode === 400) return 'Bad Request';
        if (statusCode === 401) return 'Unauthorized';
        if (statusCode === 404) return 'Not Found';
        if (statusCode === 429) return 'Too Many Requests';
        if (statusCode === 500) return 'Internal Server Error';
        return 'Error';
    }

    function sendTerminalEvent(ws, type, payload = {}) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return;
        }
        ws.send(JSON.stringify({ type, ...payload }));
    }

    function spawnWebTerminalProcess(ctx, containerName, cols, rows) {
        const terminalBootstrap = [
            'MANYOYO_WEB_BASHRC="$(mktemp /tmp/manyoyo-web-bashrc.XXXXXX 2>/dev/null || mktemp)"',
            'cat > "$MANYOYO_WEB_BASHRC" <<\'EOF_MANYOYO_RC\'',
            'if [ -f /etc/bash.bashrc ]; then',
            '    . /etc/bash.bashrc',
            'fi',
            'if [ -f ~/.bashrc ]; then',
            '    . ~/.bashrc',
            'fi',
            'if [ -n "${MANYOYO_TERM_COLS:-}" ] && [ -n "${MANYOYO_TERM_ROWS:-}" ]; then',
            '    COLUMNS="$MANYOYO_TERM_COLS"',
            '    LINES="$MANYOYO_TERM_ROWS"',
            '    export COLUMNS LINES',
            '    stty cols "$MANYOYO_TERM_COLS" rows "$MANYOYO_TERM_ROWS" >/dev/null 2>&1 || true',
            'fi',
            'EOF_MANYOYO_RC',
            'chmod 600 "$MANYOYO_WEB_BASHRC" >/dev/null 2>&1 || true',
            'if command -v script >/dev/null 2>&1; then',
            '  exec script -qefc "/bin/bash --rcfile $MANYOYO_WEB_BASHRC -i" /dev/null;',
            'fi;',
            'if command -v python3 >/dev/null 2>&1; then',
            '  exec python3 -c \'import os, pty; pty.spawn(["/bin/bash","--rcfile",os.environ.get("MANYOYO_WEB_BASHRC","/dev/null"),"-i"])\';',
            'fi;',
            'if command -v python >/dev/null 2>&1; then',
            '  exec python -c \'import os, pty; pty.spawn(["/bin/bash","--rcfile",os.environ.get("MANYOYO_WEB_BASHRC","/dev/null"),"-i"])\';',
            'fi;',
            'echo "[manyoyo] 容器内未找到 script/python，终端将降级为非 TTY 模式" >&2;',
            'exec /bin/bash --rcfile "$MANYOYO_WEB_BASHRC" -i'
        ].join('\n');

        const termValue = process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color';
        const colorTermValue = process.env.COLORTERM || 'truecolor';
        const dockerExecArgs = [
            'exec',
            '-i',
            '-e', `TERM=${termValue}`,
            '-e', `COLORTERM=${colorTermValue}`,
            '-e', `MANYOYO_TERM_COLS=${String(cols)}`,
            '-e', `MANYOYO_TERM_ROWS=${String(rows)}`,
            containerName,
            '/bin/bash',
            '-lc',
            terminalBootstrap
        ];

        return spawn(ctx.dockerCmd, dockerExecArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    }

    return {
        normalizeTerminalSize(cols, rows) {
            return {
                cols: Math.max(minCols, toPositiveInt(cols, defaultCols)),
                rows: Math.max(minRows, toPositiveInt(rows, defaultRows))
            };
        },
        sendWebSocketUpgradeError(socket, statusCode, message) {
            const body = String(message || getUpgradeStatusText(statusCode));
            const reason = getUpgradeStatusText(statusCode);
            if (!socket.destroyed) {
                socket.write(
                    `HTTP/1.1 ${statusCode} ${reason}\r\n` +
                    'Content-Type: text/plain; charset=utf-8\r\n' +
                    'Connection: close\r\n' +
                    `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n` +
                    '\r\n' +
                    body
                );
            }
            socket.destroy();
        },
        bindTerminalWebSocket(ctx, state, ws, containerName, cols, rows) {
            const sessionId = `${containerName}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
            const ptyProcess = spawnWebTerminalProcess(ctx, containerName, cols, rows);
            const session = {
                id: sessionId,
                containerName,
                ptyProcess,
                closing: false
            };

            state.terminalSessions.set(sessionId, session);
            sendTerminalEvent(ws, 'status', {
                phase: 'ready',
                sessionId,
                containerName,
                cols,
                rows
            });

            const cleanup = () => {
                if (session.closing) {
                    return;
                }
                session.closing = true;
                state.terminalSessions.delete(sessionId);
                if (ptyProcess && !ptyProcess.killed) {
                    ptyProcess.kill('SIGTERM');
                    setTimeout(() => {
                        if (!ptyProcess.killed) {
                            ptyProcess.kill('SIGKILL');
                        }
                    }, forceKillMs);
                }
            };

            ptyProcess.stdout.on('data', chunk => {
                sendTerminalEvent(ws, 'output', { data: chunk.toString('utf-8') });
            });

            ptyProcess.stderr.on('data', chunk => {
                sendTerminalEvent(ws, 'output', { data: chunk.toString('utf-8') });
            });

            ptyProcess.on('error', err => {
                sendTerminalEvent(ws, 'error', {
                    error: err && err.message ? err.message : '终端进程启动失败'
                });
            });

            ptyProcess.on('close', (code, signal) => {
                sendTerminalEvent(ws, 'status', {
                    phase: 'closed',
                    code: typeof code === 'number' ? code : null,
                    signal: signal || null
                });
                cleanup();
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
            });

            ws.on('message', raw => {
                let payload = null;
                try {
                    payload = JSON.parse(raw.toString('utf-8'));
                } catch {
                    payload = {
                        type: 'input',
                        data: raw.toString('utf-8')
                    };
                }
                if (!payload || typeof payload !== 'object') {
                    return;
                }

                if (payload.type === 'input' && typeof payload.data === 'string' && payload.data.length) {
                    ptyProcess.stdin.write(payload.data);
                    return;
                }

                if (payload.type === 'resize') {
                    return;
                }

                if (payload.type === 'close') {
                    ws.close();
                }
            });

            ws.on('close', cleanup);
            ws.on('error', cleanup);
        },
        cleanupWebRuntimeState(state) {
            for (const session of state.terminalSessions.values()) {
                const ptyProcess = session && session.ptyProcess;
                if (ptyProcess && !ptyProcess.killed) {
                    try { ptyProcess.kill('SIGTERM'); } catch {}
                }
            }
            state.terminalSessions.clear();

            for (const runState of state.agentRuns.values()) {
                const child = runState && runState.process;
                if (child && !child.killed) {
                    try { child.kill('SIGTERM'); } catch {}
                }
            }
            state.agentRuns.clear();
        }
    };
}

module.exports = {
    createWebTerminalHelpers
};
