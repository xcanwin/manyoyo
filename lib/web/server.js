'use strict';

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

const WEB_HISTORY_MAX_MESSAGES = 500;
const WEB_OUTPUT_MAX_CHARS = 16000;
const WEB_TERMINAL_MAX_SESSIONS = 20;
const WEB_TERMINAL_FORCE_KILL_MS = 2000;
const WEB_TERMINAL_DEFAULT_COLS = 120;
const WEB_TERMINAL_DEFAULT_ROWS = 36;
const WEB_TERMINAL_MIN_COLS = 40;
const WEB_TERMINAL_MIN_ROWS = 12;
const WEB_AUTH_COOKIE_NAME = 'manyoyo_web_auth';
const WEB_AUTH_TTL_SECONDS = 12 * 60 * 60;
const FRONTEND_DIR = path.join(__dirname, 'frontend');

let XTERM_JS_FILE = null;
let XTERM_CSS_FILE = null;
let XTERM_ADDON_FIT_JS_FILE = null;
try {
    const xtermPackageDir = path.dirname(require.resolve('@xterm/xterm/package.json'));
    XTERM_JS_FILE = path.join(xtermPackageDir, 'lib', 'xterm.js');
    XTERM_CSS_FILE = path.join(xtermPackageDir, 'css', 'xterm.css');
} catch (e) {
    XTERM_JS_FILE = null;
    XTERM_CSS_FILE = null;
}
try {
    const xtermAddonFitPackageDir = path.dirname(require.resolve('@xterm/addon-fit/package.json'));
    XTERM_ADDON_FIT_JS_FILE = path.join(xtermAddonFitPackageDir, 'lib', 'addon-fit.js');
} catch (e) {
    XTERM_ADDON_FIT_JS_FILE = null;
}

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.html': 'text/html; charset=utf-8'
};

function formatUrlHost(host) {
    if (typeof host !== 'string' || !host) return '127.0.0.1';
    if (host.includes(':') && !host.startsWith('[')) {
        return `[${host}]`;
    }
    return host;
}

function ensureWebHistoryDir(webHistoryDir) {
    fs.mkdirSync(webHistoryDir, { recursive: true });
}

function getWebHistoryFile(webHistoryDir, containerName) {
    return path.join(webHistoryDir, `${containerName}.json`);
}

function loadWebSessionHistory(webHistoryDir, containerName) {
    ensureWebHistoryDir(webHistoryDir);
    const filePath = getWebHistoryFile(webHistoryDir, containerName);
    if (!fs.existsSync(filePath)) {
        return { containerName, updatedAt: null, messages: [] };
    }

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return {
            containerName,
            updatedAt: data.updatedAt || null,
            messages: Array.isArray(data.messages) ? data.messages : []
        };
    } catch (e) {
        return { containerName, updatedAt: null, messages: [] };
    }
}

function saveWebSessionHistory(webHistoryDir, containerName, history) {
    ensureWebHistoryDir(webHistoryDir);
    const filePath = getWebHistoryFile(webHistoryDir, containerName);
    fs.writeFileSync(filePath, JSON.stringify(history, null, 4));
}

function removeWebSessionHistory(webHistoryDir, containerName) {
    ensureWebHistoryDir(webHistoryDir);
    const filePath = getWebHistoryFile(webHistoryDir, containerName);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

function listWebHistorySessionNames(webHistoryDir, isValidContainerName) {
    ensureWebHistoryDir(webHistoryDir);
    return fs.readdirSync(webHistoryDir)
        .filter(file => file.endsWith('.json'))
        .map(file => path.basename(file, '.json'))
        .filter(name => isValidContainerName(name));
}

function appendWebSessionMessage(webHistoryDir, containerName, role, content, extra = {}) {
    const history = loadWebSessionHistory(webHistoryDir, containerName);
    const timestamp = new Date().toISOString();
    history.messages.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        role,
        content,
        timestamp,
        ...extra
    });

    if (history.messages.length > WEB_HISTORY_MAX_MESSAGES) {
        history.messages = history.messages.slice(-WEB_HISTORY_MAX_MESSAGES);
    }

    history.updatedAt = timestamp;
    saveWebSessionHistory(webHistoryDir, containerName, history);
}

function stripAnsi(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function clipText(text, maxChars = WEB_OUTPUT_MAX_CHARS) {
    if (typeof text !== 'string') return '';
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function secureStringEqual(a, b) {
    const aStr = String(a || '');
    const bStr = String(b || '');
    const aBuffer = Buffer.from(aStr, 'utf-8');
    const bBuffer = Buffer.from(bStr, 'utf-8');
    if (aBuffer.length !== bBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function parseCookies(req) {
    const cookieHeader = req.headers.cookie || '';
    if (!cookieHeader) {
        return {};
    }

    const cookies = {};
    cookieHeader.split(';').forEach(part => {
        const index = part.indexOf('=');
        if (index <= 0) return;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (!key) return;
        try {
            cookies[key] = decodeURIComponent(value);
        } catch (e) {
            cookies[key] = value;
        }
    });
    return cookies;
}

function pruneExpiredWebAuthSessions(state) {
    const now = Date.now();
    for (const [sessionId, session] of state.authSessions.entries()) {
        if (!session || session.expiresAt <= now) {
            state.authSessions.delete(sessionId);
        }
    }
}

function createWebAuthSession(state, username) {
    pruneExpiredWebAuthSessions(state);
    const sessionId = crypto.randomBytes(24).toString('hex');
    state.authSessions.set(sessionId, {
        username,
        expiresAt: Date.now() + WEB_AUTH_TTL_SECONDS * 1000
    });
    return sessionId;
}

function getWebAuthSession(state, req) {
    pruneExpiredWebAuthSessions(state);
    const cookies = parseCookies(req);
    const sessionId = cookies[WEB_AUTH_COOKIE_NAME];
    if (!sessionId) return null;

    const session = state.authSessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        state.authSessions.delete(sessionId);
        return null;
    }

    // Sliding session expiration
    session.expiresAt = Date.now() + WEB_AUTH_TTL_SECONDS * 1000;
    return { sessionId, username: session.username };
}

function clearWebAuthSession(state, req) {
    const cookies = parseCookies(req);
    const sessionId = cookies[WEB_AUTH_COOKIE_NAME];
    if (sessionId) {
        state.authSessions.delete(sessionId);
    }
}

function getWebAuthCookie(sessionId) {
    return `${WEB_AUTH_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${WEB_AUTH_TTL_SECONDS}`;
}

function getWebAuthClearCookie() {
    return `${WEB_AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function listWebManyoyoContainers(ctx) {
    const output = ctx.dockerExecArgs(
        ['ps', '-a', '--filter', 'label=manyoyo.default_cmd', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}'],
        { ignoreError: true }
    );

    const map = {};
    if (!output.trim()) {
        return map;
    }

    output.trim().split('\n').forEach(line => {
        const [name, status, image] = line.split('\t');
        if (!ctx.isValidContainerName(name)) {
            return;
        }
        map[name] = {
            name,
            status: status || 'unknown',
            image: image || ''
        };
    });

    return map;
}

async function ensureWebContainer(ctx, state, containerName) {
    if (!ctx.containerExists(containerName)) {
        const webDefaultCommand = `${ctx.execCommandPrefix}${ctx.execCommand}${ctx.execCommandSuffix}`.trim() || '/bin/bash';
        const safeLabelCmd = webDefaultCommand.replace(/[\r\n]/g, ' ');
        const args = [
            'run', '-d',
            '--name', containerName,
            '--entrypoint', '',
            ...ctx.contModeArgs,
            ...ctx.containerEnvs,
            ...ctx.containerVolumes,
            '--volume', `${ctx.hostPath}:${ctx.containerPath}`,
            '--workdir', ctx.containerPath,
            '--label', `manyoyo.default_cmd=${safeLabelCmd}`,
            `${ctx.imageName}:${ctx.imageVersion}`,
            'tail', '-f', '/dev/null'
        ];

        try {
            ctx.dockerExecArgs(args, { stdio: 'pipe' });
        } catch (e) {
            ctx.showImagePullHint(e);
            throw e;
        }

        await ctx.waitForContainerReady(containerName);
        appendWebSessionMessage(state.webHistoryDir, containerName, 'system', `容器 ${containerName} 已创建并启动。`);
        return;
    }

    const status = ctx.getContainerStatus(containerName);
    if (status !== 'running') {
        ctx.dockerExecArgs(['start', containerName], { stdio: 'pipe' });
        appendWebSessionMessage(state.webHistoryDir, containerName, 'system', `容器 ${containerName} 已启动。`);
    }
}

function execCommandInWebContainer(ctx, containerName, command) {
    const result = spawnSync(ctx.dockerCmd, ['exec', containerName, '/bin/bash', '-lc', command], {
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024
    });

    if (result.error) {
        throw result.error;
    }

    const exitCode = typeof result.status === 'number' ? result.status : 1;
    const rawOutput = `${result.stdout || ''}${result.stderr || ''}`;
    const output = clipText(stripAnsi(rawOutput).trim() || '(无输出)');

    return { exitCode, output };
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString('utf-8');
            if (body.length > 1024 * 1024) {
                reject(new Error('请求体过大'));
                req.destroy();
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

async function readJsonBody(req) {
    const body = await readRequestBody(req);
    if (!body.trim()) {
        return {};
    }
    try {
        return JSON.parse(body);
    } catch (e) {
        throw new Error('JSON body 格式错误');
    }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders
    });
    res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html, extraHeaders = {}) {
    res.writeHead(statusCode, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders
    });
    res.end(html);
}

function decodeSessionName(encoded) {
    try {
        return decodeURIComponent(encoded);
    } catch (e) {
        return encoded;
    }
}

function buildSessionSummary(ctx, state, containerMap, name) {
    const history = loadWebSessionHistory(state.webHistoryDir, name);
    const latestMessage = history.messages.length ? history.messages[history.messages.length - 1] : null;
    const containerInfo = containerMap[name] || {};
    const updatedAt = history.updatedAt || (latestMessage && latestMessage.timestamp) || null;
    return {
        name,
        status: containerInfo.status || 'history',
        image: containerInfo.image || '',
        updatedAt,
        messageCount: history.messages.length
    };
}

function isSafeStaticAssetName(name) {
    return /^[A-Za-z0-9._-]+$/.test(name);
}

function resolveStaticAsset(name) {
    if (!isSafeStaticAssetName(name)) {
        return null;
    }
    const fullPath = path.join(FRONTEND_DIR, name);
    return fs.existsSync(fullPath) ? fullPath : null;
}

function resolveVendorAsset(name) {
    if (!isSafeStaticAssetName(name)) {
        return null;
    }
    if (name === 'xterm.js') {
        return XTERM_JS_FILE && fs.existsSync(XTERM_JS_FILE) ? XTERM_JS_FILE : null;
    }
    if (name === 'xterm.css') {
        return XTERM_CSS_FILE && fs.existsSync(XTERM_CSS_FILE) ? XTERM_CSS_FILE : null;
    }
    if (name === 'xterm-addon-fit.js') {
        return XTERM_ADDON_FIT_JS_FILE && fs.existsSync(XTERM_ADDON_FIT_JS_FILE) ? XTERM_ADDON_FIT_JS_FILE : null;
    }
    return null;
}

function sendFileAsset(res, filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        sendHtml(res, 404, '<h1>404 Not Found</h1>');
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
    });
    res.end(content);
}

function sendStaticAsset(res, assetName) {
    sendFileAsset(res, resolveStaticAsset(assetName));
}

function sendVendorAsset(res, assetName) {
    sendFileAsset(res, resolveVendorAsset(assetName));
}

function loadTemplate(name) {
    const filePath = resolveStaticAsset(name);
    if (!filePath) {
        return '<h1>Template Not Found</h1>';
    }
    return fs.readFileSync(filePath, 'utf-8');
}

function toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}

function normalizeTerminalSize(cols, rows) {
    return {
        cols: Math.max(WEB_TERMINAL_MIN_COLS, toPositiveInt(cols, WEB_TERMINAL_DEFAULT_COLS)),
        rows: Math.max(WEB_TERMINAL_MIN_ROWS, toPositiveInt(rows, WEB_TERMINAL_DEFAULT_ROWS))
    };
}

function getUpgradeStatusText(statusCode) {
    if (statusCode === 400) return 'Bad Request';
    if (statusCode === 401) return 'Unauthorized';
    if (statusCode === 404) return 'Not Found';
    if (statusCode === 429) return 'Too Many Requests';
    if (statusCode === 500) return 'Internal Server Error';
    return 'Error';
}

function sendWebSocketUpgradeError(socket, statusCode, message) {
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
        '-e', `COLUMNS=${String(cols)}`,
        '-e', `LINES=${String(rows)}`,
        '-e', `MANYOYO_TERM_COLS=${String(cols)}`,
        '-e', `MANYOYO_TERM_ROWS=${String(rows)}`,
        containerName,
        '/bin/bash',
        '-lc',
        terminalBootstrap
    ];

    return spawn(ctx.dockerCmd, dockerExecArgs, {
        env: {
            ...process.env,
            COLUMNS: String(cols),
            LINES: String(rows)
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });
}

function bindTerminalWebSocket(ctx, state, ws, containerName, cols, rows) {
    const sessionId = `${containerName}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const ptyProcess = spawnWebTerminalProcess(ctx, containerName, cols, rows);
    const session = {
        id: sessionId,
        containerName,
        cols,
        rows,
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
            }, WEB_TERMINAL_FORCE_KILL_MS);
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
        } catch (e) {
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
            const normalized = normalizeTerminalSize(payload.cols, payload.rows);
            session.cols = normalized.cols;
            session.rows = normalized.rows;
            return;
        }

        if (payload.type === 'close') {
            ws.close();
        }
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
}

async function handleWebAuthRoutes(req, res, pathname, ctx, state) {
    if (req.method === 'GET' && pathname === '/auth/login') {
        sendHtml(res, 200, loadTemplate('login.html'));
        return true;
    }

    const authFrontendMatch = pathname.match(/^\/auth\/frontend\/([A-Za-z0-9._-]+)$/);
    if (req.method === 'GET' && authFrontendMatch) {
        const assetName = authFrontendMatch[1];
        if (!(assetName === 'login.css' || assetName === 'login.js')) {
            sendHtml(res, 404, '<h1>404 Not Found</h1>');
            return true;
        }
        sendStaticAsset(res, assetName);
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
    sendHtml(
        res,
        401,
        loadTemplate('login.html'),
        { 'Set-Cookie': getWebAuthClearCookie() }
    );
}

async function handleWebApi(req, res, pathname, ctx, state) {
    if (req.method === 'GET' && pathname === '/api/sessions') {
        const containerMap = listWebManyoyoContainers(ctx);
        const names = new Set([
            ...Object.keys(containerMap),
            ...listWebHistorySessionNames(state.webHistoryDir, ctx.isValidContainerName)
        ]);

        const sessions = Array.from(names)
            .map(name => buildSessionSummary(ctx, state, containerMap, name))
            .sort((a, b) => {
                const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                return timeB - timeA;
            });

        sendJson(res, 200, { sessions });
        return true;
    }

    if (req.method === 'POST' && pathname === '/api/sessions') {
        const payload = await readJsonBody(req);
        let containerName = (payload.name || '').trim();
        if (!containerName) {
            containerName = `my-${ctx.formatDate()}`;
        }
        if (!ctx.isValidContainerName(containerName)) {
            sendJson(res, 400, { error: `containerName 非法: ${containerName}` });
            return true;
        }

        await ensureWebContainer(ctx, state, containerName);
        sendJson(res, 200, { name: containerName });
        return true;
    }

    const messagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (req.method === 'GET' && messagesMatch) {
        const containerName = decodeSessionName(messagesMatch[1]);
        if (!ctx.isValidContainerName(containerName)) {
            sendJson(res, 400, { error: `containerName 非法: ${containerName}` });
            return true;
        }

        const history = loadWebSessionHistory(state.webHistoryDir, containerName);
        sendJson(res, 200, { name: containerName, messages: history.messages });
        return true;
    }

    const runMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/run$/);
    if (req.method === 'POST' && runMatch) {
        const containerName = decodeSessionName(runMatch[1]);
        if (!ctx.isValidContainerName(containerName)) {
            sendJson(res, 400, { error: `containerName 非法: ${containerName}` });
            return true;
        }

        const payload = await readJsonBody(req);
        const command = (payload.command || '').trim();
        if (!command) {
            sendJson(res, 400, { error: 'command 不能为空' });
            return true;
        }

        await ensureWebContainer(ctx, state, containerName);
        appendWebSessionMessage(state.webHistoryDir, containerName, 'user', command);
        const result = execCommandInWebContainer(ctx, containerName, command);
        appendWebSessionMessage(
            state.webHistoryDir,
            containerName,
            'assistant',
            `${result.output}\n\n[exit ${result.exitCode}]`,
            { exitCode: result.exitCode }
        );
        sendJson(res, 200, { exitCode: result.exitCode, output: result.output });
        return true;
    }

    const removeMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/remove$/);
    if (req.method === 'POST' && removeMatch) {
        const containerName = decodeSessionName(removeMatch[1]);
        if (!ctx.isValidContainerName(containerName)) {
            sendJson(res, 400, { error: `containerName 非法: ${containerName}` });
            return true;
        }

        if (ctx.containerExists(containerName)) {
            ctx.removeContainer(containerName);
            appendWebSessionMessage(state.webHistoryDir, containerName, 'system', `容器 ${containerName} 已删除。`);
        }

        sendJson(res, 200, { removed: true, name: containerName });
        return true;
    }

    const removeHistoryMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/remove-with-history$/);
    if (req.method === 'POST' && removeHistoryMatch) {
        const containerName = decodeSessionName(removeHistoryMatch[1]);
        if (!ctx.isValidContainerName(containerName)) {
            sendJson(res, 400, { error: `containerName 非法: ${containerName}` });
            return true;
        }

        removeWebSessionHistory(state.webHistoryDir, containerName);

        sendJson(res, 200, { removedHistory: true, name: containerName });
        return true;
    }

    return false;
}

async function startWebServer(options) {
    const ctx = {
        serverHost: options.serverHost || '127.0.0.1',
        serverPort: options.serverPort,
        authUser: options.authUser,
        authPass: options.authPass,
        authPassAuto: options.authPassAuto,
        dockerCmd: options.dockerCmd,
        hostPath: options.hostPath,
        containerPath: options.containerPath,
        imageName: options.imageName,
        imageVersion: options.imageVersion,
        execCommandPrefix: options.execCommandPrefix,
        execCommand: options.execCommand,
        execCommandSuffix: options.execCommandSuffix,
        contModeArgs: options.contModeArgs,
        containerEnvs: options.containerEnvs,
        containerVolumes: options.containerVolumes,
        validateHostPath: options.validateHostPath,
        formatDate: options.formatDate,
        isValidContainerName: options.isValidContainerName,
        containerExists: options.containerExists,
        getContainerStatus: options.getContainerStatus,
        waitForContainerReady: options.waitForContainerReady,
        dockerExecArgs: options.dockerExecArgs,
        showImagePullHint: options.showImagePullHint,
        removeContainer: options.removeContainer,
        colors: options.colors || {
            GREEN: '',
            CYAN: '',
            YELLOW: '',
            NC: ''
        }
    };

    if (!ctx.authUser || !ctx.authPass) {
        throw new Error('Web 认证配置缺失，请设置 --server-user / --server-pass');
    }

    const state = {
        webHistoryDir: options.webHistoryDir || path.join(os.homedir(), '.manyoyo', 'web-history'),
        authSessions: new Map(),
        terminalSessions: new Map()
    };

    ctx.validateHostPath();
    ensureWebHistoryDir(state.webHistoryDir);

    const wsServer = new WebSocket.Server({
        noServer: true,
        maxPayload: 1024 * 1024
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

    const server = http.createServer(async (req, res) => {
        try {
            const fallbackHost = `${formatUrlHost(ctx.serverHost)}:${ctx.serverPort}`;
            const url = new URL(req.url, `http://${req.headers.host || fallbackHost}`);
            const pathname = url.pathname;

            // 全局认证入口：除登录路由外，默认全部请求都要求认证
            if (await handleWebAuthRoutes(req, res, pathname, ctx, state)) {
                return;
            }

            const authSession = getWebAuthSession(state, req);
            if (!authSession) {
                sendWebUnauthorized(res, pathname);
                return;
            }

            if (req.method === 'GET' && pathname === '/') {
                sendHtml(res, 200, loadTemplate('app.html'));
                return;
            }

            const appFrontendMatch = pathname.match(/^\/app\/frontend\/([A-Za-z0-9._-]+)$/);
            if (req.method === 'GET' && appFrontendMatch) {
                const assetName = appFrontendMatch[1];
                if (!(assetName === 'app.css' || assetName === 'app.js')) {
                    sendHtml(res, 404, '<h1>404 Not Found</h1>');
                    return;
                }
                sendStaticAsset(res, assetName);
                return;
            }

            const appVendorMatch = pathname.match(/^\/app\/vendor\/([A-Za-z0-9._-]+)$/);
            if (req.method === 'GET' && appVendorMatch) {
                const assetName = appVendorMatch[1];
                if (!(assetName === 'xterm.css' || assetName === 'xterm.js' || assetName === 'xterm-addon-fit.js')) {
                    sendHtml(res, 404, '<h1>404 Not Found</h1>');
                    return;
                }
                sendVendorAsset(res, assetName);
                return;
            }

            if (pathname === '/healthz') {
                sendJson(res, 200, { ok: true });
                return;
            }

            if (pathname.startsWith('/api/')) {
                const handled = await handleWebApi(req, res, pathname, ctx, state);
                if (!handled) {
                    sendJson(res, 404, { error: 'Not Found' });
                }
                return;
            }

            sendHtml(res, 404, '<h1>404 Not Found</h1>');
        } catch (e) {
            if ((req.url || '').startsWith('/api/')) {
                sendJson(res, 500, { error: e.message || 'Server Error' });
            } else {
                sendHtml(res, 500, '<h1>500 Server Error</h1>');
            }
        }
    });

    server.on('upgrade', (req, socket, head) => {
        const fallbackHost = `${formatUrlHost(ctx.serverHost)}:${ctx.serverPort}`;
        let url;
        try {
            url = new URL(req.url || '/', `http://${req.headers.host || fallbackHost}`);
        } catch (e) {
            sendWebSocketUpgradeError(socket, 400, 'Invalid URL');
            return;
        }

        const terminalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/terminal\/ws$/);
        if (!terminalMatch) {
            socket.destroy();
            return;
        }

        const authSession = getWebAuthSession(state, req);
        if (!authSession) {
            sendWebSocketUpgradeError(socket, 401, 'UNAUTHORIZED');
            return;
        }

        const containerName = decodeSessionName(terminalMatch[1]);
        if (!ctx.isValidContainerName(containerName)) {
            sendWebSocketUpgradeError(socket, 400, `containerName 非法: ${containerName}`);
            return;
        }

        if (state.terminalSessions.size >= WEB_TERMINAL_MAX_SESSIONS) {
            sendWebSocketUpgradeError(socket, 429, 'TERMINAL_LIMIT_REACHED');
            return;
        }

        const { cols, rows } = normalizeTerminalSize(
            url.searchParams.get('cols'),
            url.searchParams.get('rows')
        );

        ensureWebContainer(ctx, state, containerName)
            .then(() => {
                wsServer.handleUpgrade(req, socket, head, ws => {
                    wsServer.emit('connection', ws, req, {
                        containerName,
                        cols,
                        rows
                    });
                });
            })
            .catch(e => {
                sendWebSocketUpgradeError(socket, 500, e && e.message ? e.message : '终端创建失败');
            });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(ctx.serverPort, ctx.serverHost, () => {
            const { GREEN, CYAN, YELLOW, NC } = ctx.colors;
            const listenHost = formatUrlHost(ctx.serverHost);
            console.log(`${GREEN}✅ MANYOYO Web 服务已启动: http://${listenHost}:${ctx.serverPort}${NC}`);
            console.log(`${CYAN}提示: 左侧是 manyoyo 容器会话列表，右侧支持命令模式与交互式终端模式。${NC}`);
            if (ctx.serverHost === '0.0.0.0') {
                console.log(`${CYAN}提示: 当前监听全部网卡，请用本机局域网 IP 访问。${NC}`);
            }
            console.log(`${CYAN}🔐 登录用户名: ${YELLOW}${ctx.authUser}${NC}`);
            if (ctx.authPassAuto) {
                console.log(`${CYAN}🔐 登录密码(本次随机): ${YELLOW}${ctx.authPass}${NC}`);
            } else {
                console.log(`${CYAN}🔐 登录密码: 使用你配置的 --server-pass / serverPass / MANYOYO_SERVER_PASS${NC}`);
            }
            resolve();
        });
    });
}

module.exports = {
    startWebServer
};
