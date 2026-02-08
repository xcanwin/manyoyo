(function () {
    function preventAccidentalZoom() {
        let lastTouchEnd = 0;

        document.addEventListener('dblclick', function (event) {
            event.preventDefault();
        }, { passive: false });

        document.addEventListener('touchstart', function (event) {
            if (event.touches && event.touches.length > 1) {
                event.preventDefault();
            }
        }, { passive: false });

        document.addEventListener('touchmove', function (event) {
            if (event.touches && event.touches.length > 1) {
                event.preventDefault();
            }
        }, { passive: false });

        document.addEventListener('touchend', function (event) {
            const now = Date.now();
            if (now - lastTouchEnd <= 320) {
                event.preventDefault();
            }
            lastTouchEnd = now;
        }, { passive: false });

        ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (eventName) {
            document.addEventListener(eventName, function (event) {
                event.preventDefault();
            }, { passive: false });
        });
    }

    preventAccidentalZoom();

    const state = {
        sessions: [],
        active: '',
        messages: [],
        mode: 'command',
        sending: false,
        loadingSessions: false,
        loadingMessages: false,
        mobileSidebarOpen: false,
        mobileActionsOpen: false,
        terminal: {
            term: null,
            fitAddon: null,
            socket: null,
            connected: false,
            connecting: false,
            status: '未连接',
            sessionName: '',
            terminalReady: false,
            fitTimer: null,
            lastSentCols: 0,
            lastSentRows: 0
        }
    };

    const sidebarNode = document.querySelector('.sidebar');
    const sessionList = document.getElementById('sessionList');
    const sessionCount = document.getElementById('sessionCount');
    const mobileSessionToggle = document.getElementById('mobileSessionToggle');
    const mobileActionsToggle = document.getElementById('mobileActionsToggle');
    const headerActions = document.getElementById('headerActions');
    const mobileSidebarClose = document.getElementById('mobileSidebarClose');
    const sidebarBackdrop = document.getElementById('sidebarBackdrop');
    const activeTitle = document.getElementById('activeTitle');
    const activeMeta = document.getElementById('activeMeta');
    const modeCommandBtn = document.getElementById('modeCommandBtn');
    const modeTerminalBtn = document.getElementById('modeTerminalBtn');
    const messagesNode = document.getElementById('messages');
    const terminalPanel = document.getElementById('terminalPanel');
    const terminalConnectBtn = document.getElementById('terminalConnectBtn');
    const terminalDisconnectBtn = document.getElementById('terminalDisconnectBtn');
    const terminalStatus = document.getElementById('terminalStatus');
    const terminalScreen = document.getElementById('terminalScreen');
    const newSessionForm = document.getElementById('newSessionForm');
    const newSessionName = document.getElementById('newSessionName');
    const createSessionBtn = newSessionForm.querySelector('button[type="submit"]');
    const composer = document.getElementById('composer');
    const commandInput = document.getElementById('commandInput');
    const sendState = document.getElementById('sendState');
    const sendBtn = document.getElementById('sendBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const removeBtn = document.getElementById('removeBtn');
    const removeAllBtn = document.getElementById('removeAllBtn');
    const MOBILE_LAYOUT_MEDIA = window.matchMedia('(max-width: 980px)');
    const MOBILE_COMPACT_MEDIA = window.matchMedia('(max-width: 640px)');
    const TERMINAL_FIT_DEBOUNCE_MS = 60;
    const TERMINAL_MIN_COLS = 40;
    const TERMINAL_MIN_ROWS = 12;
    const TERMINAL_DEFAULT_COLS = 120;
    const TERMINAL_DEFAULT_ROWS = 36;

    function roleName(role) {
        if (role === 'user') return '你';
        if (role === 'assistant') return '容器输出';
        return '系统';
    }

    function sessionStatusInfo(status) {
        const raw = String(status || 'history');
        const lower = raw.toLowerCase();
        if (lower === 'history') {
            return { tone: 'history', label: '仅历史' };
        }
        if (lower.includes('up') || lower.includes('running')) {
            return { tone: 'running', label: '运行中' };
        }
        if (lower.includes('exited') || lower.includes('created')) {
            return { tone: 'stopped', label: '已停止' };
        }
        return { tone: 'unknown', label: '未知' };
    }

    function safeMessageCount(value) {
        const count = Number(value || 0);
        if (Number.isNaN(count) || count < 0) {
            return 0;
        }
        return Math.floor(count);
    }

    function formatDateTime(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    }

    function getActiveSession() {
        if (!state.active) return null;
        return state.sessions.find(function (session) {
            return session.name === state.active;
        }) || null;
    }

    function buildActiveMeta(session) {
        if (!session) {
            return '会话不可用';
        }
        const status = sessionStatusInfo(session.status);
        const messageCount = safeMessageCount(session.messageCount);
        const updatedAt = formatDateTime(session.updatedAt) || '暂无更新';
        return `${status.label} · ${messageCount} 条对话 · ${updatedAt}`;
    }

    function buildMessageMeta(message) {
        const parts = [roleName(message.role)];
        const timeText = formatDateTime(message.timestamp);
        if (timeText) {
            parts.push(timeText);
        }
        if (typeof message.exitCode === 'number') {
            parts.push(`exit ${message.exitCode}`);
        }
        if (message.pending) {
            parts.push('发送中');
        }
        return parts.join(' · ');
    }

    function writeTerminalLine(text) {
        if (!state.terminal.term) return;
        state.terminal.term.writeln(text);
    }

    function renderTerminalIntro() {
        if (!state.terminal.term) return;
        state.terminal.term.reset();
        writeTerminalLine('MANYOYO Interactive Terminal');
        writeTerminalLine(state.active ? ('当前会话: ' + state.active) : '当前会话: 未选择');
        writeTerminalLine('点击“连接终端”后可运行 codex / claude 等交互式 agent。');
        writeTerminalLine('');
    }

    function resolveFitAddonCtor() {
        if (window.FitAddon && typeof window.FitAddon.FitAddon === 'function') {
            return window.FitAddon.FitAddon;
        }
        if (typeof window.FitAddon === 'function') {
            return window.FitAddon;
        }
        return null;
    }

    function normalizeTerminalSize(cols, rows) {
        const parsedCols = Number.parseInt(cols, 10);
        const parsedRows = Number.parseInt(rows, 10);
        const safeCols = Number.isFinite(parsedCols) && parsedCols > 0 ? parsedCols : TERMINAL_DEFAULT_COLS;
        const safeRows = Number.isFinite(parsedRows) && parsedRows > 0 ? parsedRows : TERMINAL_DEFAULT_ROWS;
        return {
            cols: Math.max(TERMINAL_MIN_COLS, safeCols),
            rows: Math.max(TERMINAL_MIN_ROWS, safeRows)
        };
    }

    function notifyTerminalResize(force) {
        if (!state.terminal.term) return;
        if (!state.terminal.socket || state.terminal.socket.readyState !== window.WebSocket.OPEN) return;
        const size = normalizeTerminalSize(
            state.terminal.term.cols,
            state.terminal.term.rows
        );
        const cols = size.cols;
        const rows = size.rows;
        if (!force && cols === state.terminal.lastSentCols && rows === state.terminal.lastSentRows) {
            return;
        }
        state.terminal.lastSentCols = cols;
        state.terminal.lastSentRows = rows;
        state.terminal.socket.send(JSON.stringify({
            type: 'resize',
            cols: cols,
            rows: rows
        }));
    }

    function fitTerminalNow(forceNotify) {
        if (!state.terminal.term || !state.terminal.fitAddon) {
            return;
        }
        if (!terminalScreen || terminalScreen.clientWidth <= 0 || terminalScreen.clientHeight <= 0) {
            return;
        }
        try {
            state.terminal.fitAddon.fit();
        } catch (e) {
            return;
        }
        notifyTerminalResize(Boolean(forceNotify));
    }

    function scheduleTerminalFit(forceNotify) {
        if (!state.terminal.term || !state.terminal.fitAddon) {
            return;
        }
        if (state.terminal.fitTimer) {
            window.clearTimeout(state.terminal.fitTimer);
            state.terminal.fitTimer = null;
        }
        state.terminal.fitTimer = window.setTimeout(function () {
            state.terminal.fitTimer = null;
            fitTerminalNow(forceNotify);
        }, TERMINAL_FIT_DEBOUNCE_MS);
    }

    function ensureTerminalReady() {
        if (state.terminal.terminalReady) {
            return true;
        }
        if (!window.Terminal) {
            state.terminal.status = '终端组件加载失败';
            return false;
        }
        const FitAddonCtor = resolveFitAddonCtor();
        if (!FitAddonCtor) {
            state.terminal.status = '终端组件加载失败';
            return false;
        }
        state.terminal.term = new window.Terminal({
            cursorBlink: true,
            convertEol: false,
            fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, Menlo, monospace',
            fontSize: 13,
            scrollback: 5000,
            theme: {
                background: '#0c131a',
                foreground: '#dde8f3',
                cursor: '#6fe7b5'
            }
        });
        state.terminal.fitAddon = new FitAddonCtor();
        state.terminal.term.loadAddon(state.terminal.fitAddon);
        state.terminal.term.open(terminalScreen);
        scheduleTerminalFit(false);
        state.terminal.term.onData(function (data) {
            if (!data || !state.terminal.socket || state.terminal.socket.readyState !== window.WebSocket.OPEN) {
                return;
            }
            state.terminal.socket.send(JSON.stringify({
                type: 'input',
                data: data
            }));
        });
        state.terminal.term.onResize(function (size) {
            if (!size || !size.cols || !size.rows) {
                return;
            }
            notifyTerminalResize(false);
        });
        state.terminal.terminalReady = true;
        renderTerminalIntro();
        return true;
    }

    function buildTerminalWsUrl(sessionName) {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const url = new URL(
            '/api/sessions/' + encodeURIComponent(sessionName) + '/terminal/ws',
            protocol + '://' + window.location.host
        );
        const size = normalizeTerminalSize(
            state.terminal.term ? state.terminal.term.cols : TERMINAL_DEFAULT_COLS,
            state.terminal.term ? state.terminal.term.rows : TERMINAL_DEFAULT_ROWS
        );
        url.searchParams.set('cols', String(size.cols));
        url.searchParams.set('rows', String(size.rows));
        return url.toString();
    }

    function disconnectTerminal(reason, silent) {
        const socket = state.terminal.socket;
        state.terminal.socket = null;
        state.terminal.connected = false;
        state.terminal.connecting = false;
        state.terminal.sessionName = '';
        state.terminal.lastSentCols = 0;
        state.terminal.lastSentRows = 0;
        if (state.terminal.fitTimer) {
            window.clearTimeout(state.terminal.fitTimer);
            state.terminal.fitTimer = null;
        }
        if (socket && (socket.readyState === window.WebSocket.OPEN || socket.readyState === window.WebSocket.CONNECTING)) {
            try {
                socket.close();
            } catch (e) {
                // noop
            }
        }
        if (typeof reason === 'string' && reason) {
            state.terminal.status = reason;
            if (!silent && state.terminal.term) {
                writeTerminalLine('[system] ' + reason);
            }
        }
    }

    function connectTerminal() {
        if (!state.active) {
            return;
        }
        if (!ensureTerminalReady()) {
            syncUi();
            return;
        }
        if (state.terminal.connected && state.terminal.sessionName === state.active) {
            return;
        }
        if (state.terminal.connected || state.terminal.connecting) {
            disconnectTerminal('终端会话已重置', true);
        }

        const sessionName = state.active;
        fitTerminalNow(false);
        const socket = new window.WebSocket(buildTerminalWsUrl(sessionName));
        state.terminal.socket = socket;
        state.terminal.connecting = true;
        state.terminal.connected = false;
        state.terminal.status = '连接中...';
        state.terminal.sessionName = sessionName;
        state.terminal.lastSentCols = 0;
        state.terminal.lastSentRows = 0;
        writeTerminalLine('[system] 正在连接终端...');
        syncUi();

        socket.addEventListener('open', function () {
            if (state.terminal.socket !== socket) {
                return;
            }
            state.terminal.connecting = false;
            state.terminal.connected = true;
            state.terminal.status = '已连接';
            if (state.terminal.term) {
                state.terminal.term.focus();
                scheduleTerminalFit(true);
            }
            syncUi();
        });

        socket.addEventListener('message', function (event) {
            if (!state.terminal.term) return;
            let payload = null;
            try {
                payload = JSON.parse(event.data);
            } catch (e) {
                payload = { type: 'output', data: String(event.data || '') };
            }

            if (!payload || typeof payload !== 'object') return;
            if (payload.type === 'output' && typeof payload.data === 'string') {
                state.terminal.term.write(payload.data);
                return;
            }
            if (payload.type === 'status') {
                if (payload.phase === 'ready') {
                    state.terminal.status = '已连接';
                } else if (payload.phase === 'closed') {
                    state.terminal.status = '终端已关闭';
                    writeTerminalLine('[system] 终端会话已结束');
                }
                syncUi();
                return;
            }
            if (payload.type === 'error' && typeof payload.error === 'string') {
                state.terminal.status = '终端异常';
                writeTerminalLine('[error] ' + payload.error);
                syncUi();
            }
        });

        socket.addEventListener('error', function () {
            if (state.terminal.socket !== socket) {
                return;
            }
            state.terminal.status = '终端连接异常';
            syncUi();
        });

        socket.addEventListener('close', function () {
            if (state.terminal.socket !== socket) {
                return;
            }
            state.terminal.socket = null;
            state.terminal.connecting = false;
            state.terminal.connected = false;
            state.terminal.sessionName = '';
            if (state.terminal.status === '连接中...' || state.terminal.status === '已连接') {
                state.terminal.status = '终端已断开';
            }
            syncUi();
        });
    }

    function isMobileLayout() {
        return MOBILE_LAYOUT_MEDIA.matches;
    }

    function isMobileCompactLayout() {
        return MOBILE_COMPACT_MEDIA.matches;
    }

    function setMobileSessionPanel(open) {
        state.mobileSidebarOpen = Boolean(open);
        const mobileLayout = isMobileLayout();
        if (!mobileLayout) {
            state.mobileSidebarOpen = false;
        }
        const shouldOpen = state.mobileSidebarOpen && mobileLayout;
        document.body.classList.toggle('mobile-sessions-open', shouldOpen);
        if (sidebarBackdrop) {
            sidebarBackdrop.hidden = !shouldOpen;
        }
        if (mobileSessionToggle) {
            mobileSessionToggle.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
        }
        if (sidebarNode) {
            sidebarNode.setAttribute('aria-hidden', mobileLayout && !shouldOpen ? 'true' : 'false');
        }
    }

    function closeMobileSessionPanel() {
        setMobileSessionPanel(false);
    }

    function setMobileActionsMenu(open) {
        state.mobileActionsOpen = Boolean(open);
        const compactLayout = isMobileCompactLayout();
        if (!compactLayout) {
            state.mobileActionsOpen = false;
        }
        const shouldOpen = state.mobileActionsOpen && compactLayout;
        document.body.classList.toggle('mobile-actions-open', shouldOpen);
        if (mobileActionsToggle) {
            mobileActionsToggle.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
        }
    }

    function closeMobileActionsMenu() {
        setMobileActionsMenu(false);
    }

    function syncUi() {
        if (!state.active) {
            activeTitle.textContent = '未选择会话';
            activeMeta.textContent = '请选择左侧会话';
            if (state.mode === 'command') {
                commandInput.value = '';
            }
        } else {
            activeTitle.textContent = state.active;
            activeMeta.textContent = buildActiveMeta(getActiveSession());
        }

        const commandMode = state.mode !== 'terminal';
        document.body.classList.toggle('command-mode', commandMode);
        document.body.classList.toggle('terminal-mode', !commandMode);
        if (modeCommandBtn) {
            modeCommandBtn.classList.toggle('is-active', commandMode);
            modeCommandBtn.setAttribute('aria-pressed', commandMode ? 'true' : 'false');
        }
        if (modeTerminalBtn) {
            modeTerminalBtn.classList.toggle('is-active', !commandMode);
            modeTerminalBtn.setAttribute('aria-pressed', !commandMode ? 'true' : 'false');
        }
        if (terminalPanel) {
            terminalPanel.hidden = commandMode;
        }
        if (!commandMode && state.terminal.terminalReady) {
            scheduleTerminalFit(false);
        }

        const busy = state.loadingSessions || state.loadingMessages || state.sending;
        refreshBtn.disabled = busy;
        removeBtn.disabled = !state.active || busy;
        removeAllBtn.disabled = !state.active || busy;
        sendBtn.disabled = !commandMode || !state.active || busy;
        commandInput.disabled = !commandMode || !state.active || state.sending;
        createSessionBtn.disabled = state.loadingSessions || state.sending;
        if (terminalConnectBtn) {
            terminalConnectBtn.disabled = !state.active || busy || state.terminal.connecting || state.terminal.connected;
        }
        if (terminalDisconnectBtn) {
            terminalDisconnectBtn.disabled = !(state.terminal.connecting || state.terminal.connected);
        }
        if (terminalStatus) {
            terminalStatus.textContent = state.terminal.status;
        }

        if (!state.active) {
            sendState.textContent = '未选择会话';
        } else if (state.sending) {
            sendState.textContent = '发送中...';
        } else if (state.loadingSessions || state.loadingMessages) {
            sendState.textContent = '加载中...';
        } else {
            sendState.textContent = '就绪';
        }
        sendState.classList.toggle('is-active', state.sending);
        setMobileSessionPanel(state.mobileSidebarOpen);
        setMobileActionsMenu(state.mobileActionsOpen);
    }

    async function api(url, options) {
        const requestOptions = Object.assign(
            { headers: { 'Content-Type': 'application/json' } },
            options || {}
        );
        const response = await fetch(url, requestOptions);
        if (response.status === 401) {
            window.location.href = '/';
            throw new Error('未登录或登录已过期');
        }
        let data = {};
        try {
            data = await response.json();
        } catch (e) {
            data = {};
        }
        if (!response.ok) {
            throw new Error(data.error || '请求失败');
        }
        return data;
    }

    function renderSessionsLoading() {
        sessionList.innerHTML = '';
        for (let i = 0; i < 3; i++) {
            const skeleton = document.createElement('div');
            skeleton.className = 'skeleton session';
            sessionList.appendChild(skeleton);
        }
    }

    function renderSessions() {
        sessionCount.textContent = state.loadingSessions ? '加载中...' : `${state.sessions.length} 个`;
        sessionList.innerHTML = '';

        if (state.loadingSessions) {
            renderSessionsLoading();
            return;
        }

        if (!state.sessions.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '暂无 manyoyo 会话';
            sessionList.appendChild(empty);
            return;
        }

        state.sessions.forEach(function (session, index) {
            const status = sessionStatusInfo(session.status);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'session-item' + (state.active === session.name ? ' active' : '');
            btn.style.setProperty('--item-index', String(index));

            const sessionName = document.createElement('div');
            sessionName.className = 'session-name';
            sessionName.textContent = session.name;

            const meta = document.createElement('div');
            meta.className = 'session-meta';

            const statusBadge = document.createElement('span');
            statusBadge.className = `session-status ${status.tone}`;
            statusBadge.textContent = status.label;

            const messageCount = document.createElement('span');
            messageCount.className = 'session-count';
            messageCount.textContent = `${safeMessageCount(session.messageCount)} 条`;

            meta.appendChild(statusBadge);
            meta.appendChild(messageCount);

            const time = document.createElement('div');
            time.className = 'session-time';
            time.textContent = formatDateTime(session.updatedAt) || '暂无更新';

            btn.appendChild(sessionName);
            btn.appendChild(meta);
            btn.appendChild(time);

            btn.addEventListener('click', function () {
                if (state.loadingMessages || state.sending) return;
                if ((state.terminal.connected || state.terminal.connecting) && state.terminal.sessionName && state.terminal.sessionName !== session.name) {
                    disconnectTerminal('会话切换，终端已断开', true);
                }
                state.active = session.name;
                if (isMobileLayout()) {
                    closeMobileSessionPanel();
                }
                if (state.mode === 'terminal' && ensureTerminalReady()) {
                    renderTerminalIntro();
                    scheduleTerminalFit(false);
                }
                syncUi();
                renderSessions();
                loadMessages().catch(function (e) {
                    alert(e.message);
                });
            });
            sessionList.appendChild(btn);
        });
    }

    function renderMessagesLoading() {
        messagesNode.innerHTML = '';
        for (let i = 0; i < 2; i++) {
            const skeleton = document.createElement('div');
            skeleton.className = 'skeleton message';
            messagesNode.appendChild(skeleton);
        }
    }

    function renderMessages(messages) {
        messagesNode.innerHTML = '';

        if (state.loadingMessages) {
            renderMessagesLoading();
            return;
        }

        if (!messages.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '输入命令后，容器输出会显示在这里。';
            messagesNode.appendChild(empty);
            return;
        }

        messages.forEach(function (msg, index) {
            const row = document.createElement('article');
            row.className = 'msg ' + (msg.role || 'system') + (msg.pending ? ' pending' : '');
            row.style.setProperty('--msg-index', String(index));

            const meta = document.createElement('div');
            meta.className = 'msg-meta';
            meta.textContent = buildMessageMeta(msg);

            const bubble = document.createElement('div');
            bubble.className = 'bubble';

            const pre = document.createElement('pre');
            pre.textContent = msg.content || '';
            bubble.appendChild(pre);

            row.appendChild(meta);
            row.appendChild(bubble);
            messagesNode.appendChild(row);
        });

        messagesNode.scrollTop = messagesNode.scrollHeight;
    }

    async function loadSessions(preferredName) {
        state.loadingSessions = true;
        renderSessions();
        syncUi();

        let requestError = null;
        try {
            const data = await api('/api/sessions');
            state.sessions = Array.isArray(data.sessions) ? data.sessions : [];

            if (typeof preferredName === 'string') {
                state.active = preferredName;
            }

            if (state.active && !state.sessions.some(function (session) { return session.name === state.active; })) {
                state.active = '';
            }

            if (!state.active && state.sessions.length) {
                state.active = state.sessions[0].name;
            }

            if (state.terminal.sessionName && state.terminal.sessionName !== state.active) {
                disconnectTerminal('会话已变化，终端已断开', true);
            }
        } catch (e) {
            requestError = e;
        } finally {
            state.loadingSessions = false;
            renderSessions();
            syncUi();
        }

        if (requestError) {
            throw requestError;
        }

        if (state.mode === 'terminal' && ensureTerminalReady() && !state.terminal.connected && !state.terminal.connecting) {
            renderTerminalIntro();
            scheduleTerminalFit(false);
        }

        await loadMessages();
    }

    async function loadMessages() {
        if (!state.active) {
            state.messages = [];
            renderMessages(state.messages);
            syncUi();
            return;
        }

        state.loadingMessages = true;
        renderMessages(state.messages);
        syncUi();

        let requestError = null;
        try {
            const data = await api('/api/sessions/' + encodeURIComponent(state.active) + '/messages');
            state.messages = Array.isArray(data.messages) ? data.messages : [];
        } catch (e) {
            requestError = e;
        } finally {
            state.loadingMessages = false;
            renderMessages(state.messages);
            syncUi();
        }

        if (requestError) {
            throw requestError;
        }
    }

    newSessionForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (state.loadingSessions || state.sending) return;
        const previousText = createSessionBtn.textContent;
        createSessionBtn.textContent = '创建中...';
        createSessionBtn.disabled = true;
        try {
            const name = (newSessionName.value || '').trim();
            const data = await api('/api/sessions', {
                method: 'POST',
                body: JSON.stringify({ name: name })
            });
            newSessionName.value = '';
            await loadSessions(data.name);
            if (isMobileLayout()) {
                closeMobileSessionPanel();
            }
        } catch (e) {
            alert(e.message);
        } finally {
            createSessionBtn.textContent = previousText;
            syncUi();
        }
    });

    composer.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (!state.active) return;
        if (state.sending) return;
        if (state.loadingSessions || state.loadingMessages) return;
        const command = (commandInput.value || '').trim();
        if (!command) return;

        const submitSession = state.active;
        const previousMessages = state.messages.slice();
        state.messages = state.messages.concat([{
            role: 'user',
            content: command,
            timestamp: new Date().toISOString(),
            pending: true
        }]);
        renderMessages(state.messages);

        state.sending = true;
        syncUi();
        try {
            commandInput.value = '';
            commandInput.focus();
            await api('/api/sessions/' + encodeURIComponent(submitSession) + '/run', {
                method: 'POST',
                body: JSON.stringify({ command: command })
            });
            await loadSessions(submitSession);
        } catch (e) {
            if (state.active === submitSession) {
                state.messages = previousMessages;
                renderMessages(state.messages);
            }
            alert(e.message);
        } finally {
            state.sending = false;
            syncUi();
            commandInput.focus();
        }
    });

    commandInput.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' || event.isComposing) {
            return;
        }

        // Shift+Enter / Option(Alt)+Enter: 换行
        if (event.shiftKey || event.altKey) {
            return;
        }

        // Enter / Ctrl+Enter: 发送
        event.preventDefault();
        if (!state.active || state.sending) {
            return;
        }
        composer.requestSubmit();
    });

    if (modeCommandBtn) {
        modeCommandBtn.addEventListener('click', function () {
            state.mode = 'command';
            syncUi();
            commandInput.focus();
        });
    }

    if (modeTerminalBtn) {
        modeTerminalBtn.addEventListener('click', function () {
            state.mode = 'terminal';
            syncUi();
            if (ensureTerminalReady()) {
                if (!state.terminal.connected && !state.terminal.connecting) {
                    renderTerminalIntro();
                }
                scheduleTerminalFit(false);
                state.terminal.term.focus();
            }
        });
    }

    if (terminalConnectBtn) {
        terminalConnectBtn.addEventListener('click', function () {
            connectTerminal();
        });
    }

    if (terminalDisconnectBtn) {
        terminalDisconnectBtn.addEventListener('click', function () {
            disconnectTerminal('终端已手动断开');
            syncUi();
        });
    }

    refreshBtn.addEventListener('click', function () {
        closeMobileActionsMenu();
        loadSessions(state.active).catch(function (e) { alert(e.message); });
    });

    if (mobileSessionToggle) {
        mobileSessionToggle.addEventListener('click', function () {
            setMobileSessionPanel(!state.mobileSidebarOpen);
        });
    }

    if (mobileActionsToggle) {
        mobileActionsToggle.addEventListener('click', function () {
            setMobileActionsMenu(!state.mobileActionsOpen);
        });
    }

    if (mobileSidebarClose) {
        mobileSidebarClose.addEventListener('click', function () {
            closeMobileSessionPanel();
        });
    }

    if (sidebarBackdrop) {
        sidebarBackdrop.addEventListener('click', function () {
            closeMobileSessionPanel();
        });
    }

    window.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && state.mobileSidebarOpen) {
            closeMobileSessionPanel();
        }
        if (event.key === 'Escape' && state.mobileActionsOpen) {
            closeMobileActionsMenu();
        }
    });

    function onLayoutMediaChange() {
        setMobileSessionPanel(state.mobileSidebarOpen);
        setMobileActionsMenu(state.mobileActionsOpen);
        if (state.mode === 'terminal' && state.terminal.terminalReady) {
            scheduleTerminalFit(false);
        }
    }

    window.addEventListener('resize', function () {
        if (state.mode === 'terminal' && state.terminal.terminalReady) {
            scheduleTerminalFit(false);
        }
    });

    if (typeof MOBILE_LAYOUT_MEDIA.addEventListener === 'function') {
        MOBILE_LAYOUT_MEDIA.addEventListener('change', onLayoutMediaChange);
    } else if (typeof MOBILE_LAYOUT_MEDIA.addListener === 'function') {
        MOBILE_LAYOUT_MEDIA.addListener(onLayoutMediaChange);
    }

    if (typeof MOBILE_COMPACT_MEDIA.addEventListener === 'function') {
        MOBILE_COMPACT_MEDIA.addEventListener('change', onLayoutMediaChange);
    } else if (typeof MOBILE_COMPACT_MEDIA.addListener === 'function') {
        MOBILE_COMPACT_MEDIA.addListener(onLayoutMediaChange);
    }

    document.addEventListener('click', function (event) {
        if (!state.mobileActionsOpen) return;
        if (!isMobileCompactLayout()) return;
        const target = event.target;
        if (mobileActionsToggle && mobileActionsToggle.contains(target)) return;
        if (headerActions && headerActions.contains(target)) return;
        closeMobileActionsMenu();
    });

    removeBtn.addEventListener('click', async function () {
        if (!state.active) return;
        closeMobileActionsMenu();
        const yes = confirm('确认删除容器 ' + state.active + ' ?');
        if (!yes) return;
        try {
            const current = state.active;
            if (state.terminal.sessionName === current && (state.terminal.connected || state.terminal.connecting)) {
                disconnectTerminal('容器删除，终端已断开', true);
            }
            await api('/api/sessions/' + encodeURIComponent(current) + '/remove', {
                method: 'POST'
            });
            await loadSessions(current);
        } catch (e) {
            alert(e.message);
        }
    });

    removeAllBtn.addEventListener('click', async function () {
        if (!state.active) return;
        closeMobileActionsMenu();
        const yes = confirm('确认删除对话 ' + state.active + ' ?');
        if (!yes) return;
        try {
            const current = state.active;
            await api('/api/sessions/' + encodeURIComponent(current) + '/remove-with-history', {
                method: 'POST'
            });
            await loadSessions(current);
        } catch (e) {
            alert(e.message);
        }
    });

    window.addEventListener('beforeunload', function () {
        disconnectTerminal('', true);
    });

    renderSessions();
    renderMessages(state.messages);
    setMobileSessionPanel(false);
    document.body.classList.add('command-mode');
    syncUi();
    loadSessions().catch(function (e) {
        alert(e.message);
    });
})();
