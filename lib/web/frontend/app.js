(function () {
    const state = {
        sessions: [],
        active: '',
        messages: [],
        sending: false
    };

    const sessionList = document.getElementById('sessionList');
    const activeTitle = document.getElementById('activeTitle');
    const messagesNode = document.getElementById('messages');
    const newSessionForm = document.getElementById('newSessionForm');
    const newSessionName = document.getElementById('newSessionName');
    const composer = document.getElementById('composer');
    const commandInput = document.getElementById('commandInput');
    const sendBtn = document.getElementById('sendBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const removeBtn = document.getElementById('removeBtn');
    const removeAllBtn = document.getElementById('removeAllBtn');

    function roleName(role) {
        if (role === 'user') return '你';
        if (role === 'assistant') return '容器输出';
        return '系统';
    }

    function formatStatus(status) {
        if (!status) return 'history';
        return status;
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

    function setSending(value) {
        state.sending = value;
        sendBtn.disabled = value || !state.active;
        commandInput.disabled = !state.active;
    }

    function updateHeader() {
        if (!state.active) {
            activeTitle.textContent = '未选择会话';
            removeBtn.disabled = true;
            removeAllBtn.disabled = true;
            setSending(false);
            commandInput.value = '';
            return;
        }
        activeTitle.textContent = state.active;
        removeBtn.disabled = false;
        removeAllBtn.disabled = false;
        setSending(state.sending);
    }

    function renderSessions() {
        sessionList.innerHTML = '';
        if (!state.sessions.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '暂无 manyoyo 会话';
            sessionList.appendChild(empty);
            return;
        }

        state.sessions.forEach(function (session) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'session-item' + (state.active === session.name ? ' active' : '');
            btn.innerHTML =
                '<div class="session-name">' + session.name + '</div>' +
                '<div class="session-meta">' + formatStatus(session.status) + '</div>';
            btn.addEventListener('click', function () {
                state.active = session.name;
                updateHeader();
                renderSessions();
                loadMessages();
            });
            sessionList.appendChild(btn);
        });
    }

    function renderMessages(messages) {
        messagesNode.innerHTML = '';
        if (!messages.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '输入命令后，容器输出会显示在这里。';
            messagesNode.appendChild(empty);
            return;
        }

        messages.forEach(function (msg) {
            const row = document.createElement('article');
            row.className = 'msg ' + (msg.role || 'system');

            const role = document.createElement('div');
            role.className = 'role';
            role.textContent = roleName(msg.role);

            const bubble = document.createElement('div');
            bubble.className = 'bubble';

            const pre = document.createElement('pre');
            pre.textContent = msg.content || '';
            bubble.appendChild(pre);

            row.appendChild(role);
            row.appendChild(bubble);
            messagesNode.appendChild(row);
        });

        messagesNode.scrollTop = messagesNode.scrollHeight;
    }

    async function loadSessions(preferredName) {
        const data = await api('/api/sessions');
        state.sessions = Array.isArray(data.sessions) ? data.sessions : [];

        if (preferredName) {
            state.active = preferredName;
        }

        if (state.active && !state.sessions.some(function (s) { return s.name === state.active; })) {
            state.active = '';
        }

        if (!state.active && state.sessions.length) {
            state.active = state.sessions[0].name;
        }

        updateHeader();
        renderSessions();
        await loadMessages();
    }

    async function loadMessages() {
        if (!state.active) {
            state.messages = [];
            renderMessages(state.messages);
            return;
        }
        const data = await api('/api/sessions/' + encodeURIComponent(state.active) + '/messages');
        state.messages = Array.isArray(data.messages) ? data.messages : [];
        renderMessages(state.messages);
    }

    newSessionForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        try {
            const name = (newSessionName.value || '').trim();
            const data = await api('/api/sessions', {
                method: 'POST',
                body: JSON.stringify({ name: name })
            });
            newSessionName.value = '';
            await loadSessions(data.name);
        } catch (e) {
            alert(e.message);
        }
    });

    composer.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (!state.active) return;
        if (state.sending) return;
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

        setSending(true);
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
            setSending(false);
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

    refreshBtn.addEventListener('click', function () {
        loadSessions(state.active).catch(function (e) { alert(e.message); });
    });

    removeBtn.addEventListener('click', async function () {
        if (!state.active) return;
        const yes = confirm('确认删除容器 ' + state.active + ' ? 仅删除容器，历史消息仍保留。');
        if (!yes) return;
        try {
            const current = state.active;
            await api('/api/sessions/' + encodeURIComponent(current) + '/remove', {
                method: 'POST'
            });
            await loadSessions('');
        } catch (e) {
            alert(e.message);
        }
    });

    removeAllBtn.addEventListener('click', async function () {
        if (!state.active) return;
        const yes = confirm('确认删除容器和聊天记录 ' + state.active + ' ? 删除后无法恢复。');
        if (!yes) return;
        try {
            const current = state.active;
            await api('/api/sessions/' + encodeURIComponent(current) + '/remove-with-history', {
                method: 'POST'
            });
            await loadSessions('');
        } catch (e) {
            alert(e.message);
        }
    });

    setSending(false);
    loadSessions().catch(function (e) {
        alert(e.message);
    });
})();
