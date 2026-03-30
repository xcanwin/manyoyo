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
        messageRenderKeys: [],
        activeTab: 'activity',
        mode: 'agent',
        sending: false,
        loadingSessions: false,
        loadingMessages: false,
        loadingSessionDetail: false,
        mobileSidebarOpen: false,
        mobileActionsOpen: false,
        configModalOpen: false,
        createModalOpen: false,
        configLoading: false,
        configSaving: false,
        createLoading: false,
        createSubmitting: false,
        configSnapshot: null,
        sessionDetail: null,
        sessionDetailError: '',
        sessionDetailRequestId: 0,
        createAgentPromptAuto: false,
        createDefaults: null,
        createRuns: {},
        sessionNodeMap: new Map(),
        sessionRenderMode: 'empty',
        messageRequestId: 0,
        agentRun: {
            active: false,
            sessionName: '',
            stopping: false,
            controller: null,
            traceMessageId: ''
        },
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
            lastSentRows: 0,
            ctrlMode: false,
            altMode: false
        }
    };

    const sidebarNode = document.querySelector('.sidebar');
    const sessionList = document.getElementById('sessionList');
    const sessionCount = document.getElementById('sessionCount');
    const mobileSessionToggle = document.getElementById('mobileSessionToggle');
    const mobileActionsToggle = document.getElementById('mobileActionsToggle');
    const headerActions = document.getElementById('headerActions');
    const viewActivityBtn = document.getElementById('viewActivityBtn');
    const viewTerminalBtn = document.getElementById('viewTerminalBtn');
    const viewDetailBtn = document.getElementById('viewDetailBtn');
    const viewConfigBtn = document.getElementById('viewConfigBtn');
    const viewCheckBtn = document.getElementById('viewCheckBtn');
    const mobileSidebarClose = document.getElementById('mobileSidebarClose');
    const sidebarBackdrop = document.getElementById('sidebarBackdrop');
    const openConfigBtn = document.getElementById('openConfigBtn');
    const openCreateBtn = document.getElementById('openCreateBtn');
    const configModal = document.getElementById('configModal');
    const configPath = document.getElementById('configPath');
    const configEditor = document.getElementById('configEditor');
    const configError = document.getElementById('configError');
    const configReloadBtn = document.getElementById('configReloadBtn');
    const configSaveBtn = document.getElementById('configSaveBtn');
    const configCancelBtn = document.getElementById('configCancelBtn');
    const createModal = document.getElementById('createModal');
    const createForm = document.getElementById('createSessionForm');
    const createCancelBtn = document.getElementById('createCancelBtn');
    const createResetBtn = document.getElementById('createResetBtn');
    const createSubmitBtn = document.getElementById('createSubmitBtn');
    const createError = document.getElementById('createError');
    const createRun = document.getElementById('createRun');
    const createContainerName = document.getElementById('createContainerName');
    const createHostPath = document.getElementById('createHostPath');
    const createContainerPath = document.getElementById('createContainerPath');
    const createImageName = document.getElementById('createImageName');
    const createImageVersion = document.getElementById('createImageVersion');
    const createContainerMode = document.getElementById('createContainerMode');
    const createShellPrefix = document.getElementById('createShellPrefix');
    const createShell = document.getElementById('createShell');
    const createShellSuffix = document.getElementById('createShellSuffix');
    const createAgentPromptCommand = document.getElementById('createAgentPromptCommand');
    const createYolo = document.getElementById('createYolo');
    const createEnv = document.getElementById('createEnv');
    const createEnvFile = document.getElementById('createEnvFile');
    const createVolumes = document.getElementById('createVolumes');
    const activeTitle = document.getElementById('activeTitle');
    const activeMeta = document.getElementById('activeMeta');
    const activityCommandBtn = document.getElementById('activityCommandBtn');
    const activityAgentBtn = document.getElementById('activityAgentBtn');
    const messagesNode = document.getElementById('messages');
    const terminalPanel = document.getElementById('terminalPanel');
    const detailPanel = document.getElementById('detailPanel');
    const configPanel = document.getElementById('configPanel');
    const checkPanel = document.getElementById('checkPanel');
    const detailSummary = document.getElementById('detailSummary');
    const configSummary = document.getElementById('configSummary');
    const checkSummary = document.getElementById('checkSummary');
    const terminalScreen = document.getElementById('terminalScreen');
    const composer = document.getElementById('composer');
    const commandInput = document.getElementById('commandInput');
    const composerHint = document.getElementById('composerHint');
    const sendState = document.getElementById('sendState');
    const sendBtn = document.getElementById('sendBtn');
    const stopBtn = document.getElementById('stopBtn');
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
    const YOLO_COMMAND_MAP = {
        claude: 'IS_SANDBOX=1 claude --dangerously-skip-permissions',
        cc: 'IS_SANDBOX=1 claude --dangerously-skip-permissions',
        c: 'IS_SANDBOX=1 claude --dangerously-skip-permissions',
        gemini: 'gemini --yolo',
        gm: 'gemini --yolo',
        g: 'gemini --yolo',
        codex: 'codex --dangerously-bypass-approvals-and-sandbox',
        cx: 'codex --dangerously-bypass-approvals-and-sandbox',
        opencode: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode',
        oc: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode'
    };
    const AGENT_PROMPT_TEMPLATE_MAP = {
        claude: 'claude -p {prompt}',
        gemini: 'gemini -p {prompt}',
        codex: 'codex exec --skip-git-repo-check {prompt}',
        opencode: 'opencode run {prompt}'
    };
    const CLAUDE_DANGEROUS_FLAG = '--dangerously-skip-permissions';
    const GEMINI_YOLO_FLAG = '--yolo';
    const CODEX_DANGEROUS_FLAG = '--dangerously-bypass-approvals-and-sandbox';
    const OPENCODE_PERMISSION_KEY = 'OPENCODE_PERMISSION=';
    const markdownRenderer = window.ManyoyoMarkdown
        && typeof window.ManyoyoMarkdown.shouldRenderMessage === 'function'
        && typeof window.ManyoyoMarkdown.render === 'function'
        ? window.ManyoyoMarkdown
        : null;

    function appendPlainMessageContent(bubble, content) {
        const pre = document.createElement('pre');
        pre.textContent = content == null ? '' : String(content);
        bubble.appendChild(pre);
    }

    function stringifyPrettyJson(value) {
        if (value === undefined || value === null) {
            return '';
        }
        if (typeof value === 'string') {
            return value;
        }
        try {
            return JSON.stringify(value, null, 2);
        } catch (e) {
            return String(value);
        }
    }

    function humanizeTraceKind(traceEvent) {
        const kind = traceEvent && traceEvent.kind ? String(traceEvent.kind) : '';
        if (kind === 'thread') return '会话';
        if (kind === 'turn') return '回合';
        if (kind === 'status') return '状态';
        if (kind === 'agent_message') return '说明';
        if (kind === 'command') return '命令';
        if (kind === 'mcp') return 'MCP';
        if (kind === 'tool') return '工具';
        if (kind === 'error') return '错误';
        return '事件';
    }

    function humanizeTracePhase(traceEvent) {
        const phase = traceEvent && traceEvent.phase ? String(traceEvent.phase) : '';
        if (phase === 'started') return '开始';
        if (phase === 'completed') return '完成';
        const status = traceEvent && traceEvent.status ? String(traceEvent.status).trim() : '';
        return status;
    }

    function buildStructuredTraceResidualLines(message) {
        const lines = String(message && message.content ? message.content : '')
            .split('\n')
            .map(function (line) {
                return String(line || '').trim();
            })
            .filter(Boolean);
        const traceEvents = Array.isArray(message && message.traceEvents) ? message.traceEvents : [];
        const consumed = new Map();
        traceEvents.forEach(function (traceEvent) {
            const key = traceEvent && traceEvent.text ? String(traceEvent.text).trim() : '';
            if (!key) {
                return;
            }
            consumed.set(key, (consumed.get(key) || 0) + 1);
        });
        return lines.filter(function (line) {
            if (!line || line === '[执行过程]') {
                return false;
            }
            const remaining = consumed.get(line) || 0;
            if (remaining > 0) {
                consumed.set(line, remaining - 1);
                return false;
            }
            return true;
        });
    }

    function resolveTraceTone(traceEvent) {
        const kind = traceEvent && traceEvent.kind ? String(traceEvent.kind) : '';
        if (kind === 'command') return 'command';
        if (kind === 'mcp') return 'mcp';
        if (kind === 'error') return 'error';
        if (kind === 'agent_message') return 'note';
        if (kind === 'status') return 'status';
        return 'neutral';
    }

    function appendTraceCardBody(cardBody, label, value) {
        const text = stringifyPrettyJson(value).trim();
        if (!text) {
            return;
        }
        const section = document.createElement('div');
        section.className = 'trace-card-body-section';

        const title = document.createElement('div');
        title.className = 'trace-card-body-label';
        title.textContent = label;
        section.appendChild(title);

        const pre = document.createElement('pre');
        pre.className = 'trace-card-body-pre';
        pre.textContent = text;
        section.appendChild(pre);

        cardBody.appendChild(section);
    }

    function createTraceEventCard(traceEvent) {
        const event = traceEvent && typeof traceEvent === 'object' ? traceEvent : {};
        const bodyParts = [];
        if (event.kind === 'command' && event.command) {
            bodyParts.push({ label: '命令', value: event.command });
        }
        if (event.kind === 'mcp') {
            if (event.argumentSummary) {
                bodyParts.push({ label: '参数摘要', value: event.argumentSummary });
            }
            if (event.arguments) {
                bodyParts.push({ label: '参数', value: event.arguments });
            }
            if (event.result) {
                bodyParts.push({ label: '结果', value: event.result });
            }
            if (event.error) {
                bodyParts.push({ label: '错误', value: event.error });
            }
        }
        if (event.kind === 'tool' && event.toolName) {
            bodyParts.push({ label: '工具', value: event.toolName });
        }
        if ((event.kind === 'agent_message' || event.kind === 'status' || event.kind === 'error') && event.detail) {
            bodyParts.push({ label: '详情', value: event.detail });
        }

        const hasBody = bodyParts.length > 0;
        const card = document.createElement(hasBody ? 'details' : 'div');
        card.className = 'trace-card trace-tone-' + resolveTraceTone(event);
        if (hasBody && event.kind === 'error') {
            card.open = true;
        }

        const header = document.createElement(hasBody ? 'summary' : 'div');
        header.className = 'trace-card-summary';

        const badge = document.createElement('span');
        badge.className = 'trace-card-badge';
        badge.textContent = humanizeTraceKind(event);
        header.appendChild(badge);

        const title = document.createElement('span');
        title.className = 'trace-card-title';
        title.textContent = event && event.text ? String(event.text) : '事件';
        header.appendChild(title);

        const phaseText = humanizeTracePhase(event);
        if (phaseText) {
            const phase = document.createElement('span');
            phase.className = 'trace-card-phase';
            phase.textContent = phaseText;
            header.appendChild(phase);
        }

        card.appendChild(header);

        if (hasBody) {
            const body = document.createElement('div');
            body.className = 'trace-card-body';
            bodyParts.forEach(function (part) {
                appendTraceCardBody(body, part.label, part.value);
            });
            card.appendChild(body);
        }

        return card;
    }

    function appendStructuredTraceContent(bubble, message) {
        bubble.classList.add('trace-bubble');
        const container = document.createElement('div');
        container.className = 'trace-structured';

        const residualLines = buildStructuredTraceResidualLines(message);
        if (residualLines.length) {
            const summary = document.createElement('div');
            summary.className = 'trace-summary';
            residualLines.forEach(function (line) {
                const item = document.createElement('div');
                item.className = 'trace-summary-line';
                item.textContent = line;
                summary.appendChild(item);
            });
            container.appendChild(summary);
        }

        const flow = document.createElement('div');
        flow.className = 'trace-flow';
        (Array.isArray(message && message.traceEvents) ? message.traceEvents : []).forEach(function (traceEvent) {
            flow.appendChild(createTraceEventCard(traceEvent));
        });
        container.appendChild(flow);

        bubble.appendChild(container);
    }

    function roleName(role, message) {
        if (role === 'user') return '我';
        if (role === 'assistant') {
            if (message && message.streamTrace) {
                return 'AGENT 过程';
            }
            if (message && message.mode === 'agent') {
                return 'AGENT 回复';
            }
            return '命令执行结果';
        }
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

    function setModalVisible(modalNode, visible) {
        if (!modalNode) return;
        modalNode.hidden = !visible;
        document.body.classList.toggle('modal-open', Boolean(visible));
    }

    function showCreateError(message) {
        if (!createError) return;
        const text = String(message || '').trim();
        if (!text) {
            createError.hidden = true;
            createError.textContent = '';
            return;
        }
        createError.hidden = false;
        createError.textContent = text;
    }

    function showConfigError(message) {
        if (!configError) return;
        const text = String(message || '').trim();
        if (!text) {
            configError.hidden = true;
            configError.textContent = '';
            return;
        }
        configError.hidden = false;
        configError.textContent = text;
    }

    function envMapToText(envMap) {
        if (!envMap || typeof envMap !== 'object') {
            return '';
        }
        return Object.entries(envMap)
            .map(function (entry) {
                return entry[0] + '=' + String(entry[1] == null ? '' : entry[1]);
            })
            .join('\n');
    }

    function textToLineArray(text) {
        return String(text || '')
            .split('\n')
            .map(function (line) { return line.trim(); })
            .filter(Boolean);
    }

    function textToEnvMap(text) {
        const envMap = {};
        const lines = textToLineArray(text);
        lines.forEach(function (line) {
            const idx = line.indexOf('=');
            if (idx <= 0) {
                throw new Error('env 每行必须是 KEY=VALUE');
            }
            const key = line.slice(0, idx).trim();
            const value = line.slice(idx + 1);
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                throw new Error('env key 非法: ' + key);
            }
            envMap[key] = value;
        });
        return envMap;
    }

    function buildDefaultCommand(shellPrefix, shell, shellSuffix) {
        const parts = [];
        if (shellPrefix && String(shellPrefix).trim()) {
            parts.push(String(shellPrefix).trim());
        }
        if (shell && String(shell).trim()) {
            parts.push(String(shell).trim());
        }
        if (shellSuffix && String(shellSuffix).trim()) {
            parts.push(String(shellSuffix).trim());
        }
        return parts.join(' ').trim();
    }

    function resolveYoloCommand(yolo) {
        const key = String(yolo || '').trim().toLowerCase();
        if (!key) return '';
        return YOLO_COMMAND_MAP[key] || '';
    }

    function stripLeadingAssignments(commandText) {
        let rest = String(commandText || '').trim();
        const assignmentPattern = /^(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)(?:\s+|$)/;
        while (rest) {
            const matched = rest.match(assignmentPattern);
            if (!matched) break;
            rest = rest.slice(matched[0].length).trim();
        }
        return rest;
    }

    function readLeadingToken(commandText) {
        const text = String(commandText || '').trim();
        if (!text) return { token: '', rest: '' };
        const tokenMatch = text.match(/^(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s]+))(?:\s+|$)/);
        if (!tokenMatch) return { token: '', rest: '' };
        return {
            token: tokenMatch[1] || tokenMatch[2] || tokenMatch[3] || '',
            rest: text.slice(tokenMatch[0].length).trim()
        };
    }

    function normalizeProgramName(token) {
        const text = String(token || '').trim();
        if (!text) return '';
        return text.replace(/\\/g, '/').split('/').pop().toLowerCase();
    }

    function resolveAgentProgram(commandText) {
        let rest = stripLeadingAssignments(commandText);
        let leading = readLeadingToken(rest);
        let program = normalizeProgramName(leading.token);
        if (program === 'env') {
            rest = stripLeadingAssignments(leading.rest);
            leading = readLeadingToken(rest);
            program = normalizeProgramName(leading.token);
        }
        return program;
    }

    function resolveAgentPromptTemplate(commandText) {
        const normalizedCommand = String(commandText || '').trim();
        const program = resolveAgentProgram(commandText);
        const template = AGENT_PROMPT_TEMPLATE_MAP[program] || '';
        if (program === 'claude' && normalizedCommand.includes(CLAUDE_DANGEROUS_FLAG)) {
            return `${normalizedCommand} -p {prompt}`;
        }
        if (program === 'gemini' && normalizedCommand.includes(GEMINI_YOLO_FLAG)) {
            return `${normalizedCommand} -p {prompt}`;
        }
        if (program === 'codex' && normalizedCommand.includes(CODEX_DANGEROUS_FLAG)) {
            return 'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check {prompt}';
        }
        if (program === 'opencode' && normalizedCommand.includes(OPENCODE_PERMISSION_KEY)) {
            return `${normalizedCommand} run {prompt}`;
        }
        return template;
    }

    function inferCreateAgentPromptCommand() {
        let shell = (createShell.value || '').trim();
        const yoloCommand = resolveYoloCommand(createYolo.value || '');
        if (yoloCommand) {
            shell = yoloCommand;
        }
        const fullCommand = buildDefaultCommand(
            (createShellPrefix.value || '').trim(),
            shell,
            (createShellSuffix.value || '').trim()
        );
        return resolveAgentPromptTemplate(fullCommand);
    }

    function updateCreateAgentPromptCommandFromCommand() {
        if (!createAgentPromptCommand) return;
        const current = String(createAgentPromptCommand.value || '').trim();
        const inferred = inferCreateAgentPromptCommand();
        const canAutoReplace = state.createAgentPromptAuto || !current;
        if (!canAutoReplace) {
            return;
        }
        createAgentPromptCommand.value = inferred;
        state.createAgentPromptAuto = Boolean(inferred);
    }

    function fillCreateForm(defaults) {
        const value = defaults && typeof defaults === 'object' ? defaults : {};
        createContainerName.value = value.containerName || '';
        createHostPath.value = value.hostPath || '';
        createContainerPath.value = value.containerPath || '';
        createImageName.value = value.imageName || '';
        createImageVersion.value = value.imageVersion || '';
        createContainerMode.value = value.containerMode || '';
        createShellPrefix.value = value.shellPrefix || '';
        createShell.value = value.shell || '';
        createShellSuffix.value = value.shellSuffix || '';
        createAgentPromptCommand.value = value.agentPromptCommand || '';
        state.createAgentPromptAuto = false;
        createYolo.value = value.yolo || '';
        createEnv.value = envMapToText(value.env);
        createEnvFile.value = Array.isArray(value.envFile) ? value.envFile.join('\n') : '';
        createVolumes.value = Array.isArray(value.volumes) ? value.volumes.join('\n') : '';
        updateCreateAgentPromptCommandFromCommand();
    }

    function mergeCreateDefaults(baseDefaults, runConfig) {
        const base = baseDefaults && typeof baseDefaults === 'object' ? baseDefaults : {};
        const run = runConfig && typeof runConfig === 'object' ? runConfig : {};
        const merged = {
            containerName: run.containerName != null ? String(run.containerName) : (base.containerName || ''),
            hostPath: run.hostPath != null ? String(run.hostPath) : (base.hostPath || ''),
            containerPath: run.containerPath != null ? String(run.containerPath) : (base.containerPath || ''),
            imageName: run.imageName != null ? String(run.imageName) : (base.imageName || ''),
            imageVersion: run.imageVersion != null ? String(run.imageVersion) : (base.imageVersion || ''),
            containerMode: run.containerMode != null ? String(run.containerMode) : (base.containerMode || ''),
            shellPrefix: run.shellPrefix != null ? String(run.shellPrefix) : (base.shellPrefix || ''),
            shell: run.shell != null ? String(run.shell) : (base.shell || ''),
            shellSuffix: run.shellSuffix != null ? String(run.shellSuffix) : (base.shellSuffix || ''),
            agentPromptCommand: run.agentPromptCommand != null ? String(run.agentPromptCommand) : (base.agentPromptCommand || ''),
            yolo: run.yolo != null ? String(run.yolo) : (base.yolo || ''),
            env: {},
            envFile: [],
            volumes: []
        };

        const baseEnv = base.env && typeof base.env === 'object' ? base.env : {};
        const runEnv = run.env && typeof run.env === 'object' ? run.env : {};
        merged.env = Object.assign({}, baseEnv, runEnv);

        const baseEnvFile = Array.isArray(base.envFile) ? base.envFile : [];
        const runEnvFile = Array.isArray(run.envFile) ? run.envFile : [];
        merged.envFile = baseEnvFile.concat(runEnvFile).map(function (item) {
            return String(item || '').trim();
        }).filter(Boolean);

        const baseVolumes = Array.isArray(base.volumes) ? base.volumes : [];
        const runVolumes = Array.isArray(run.volumes) ? run.volumes : [];
        merged.volumes = baseVolumes.concat(runVolumes).map(function (item) {
            return String(item || '').trim();
        }).filter(Boolean);

        return merged;
    }

    function normalizeRunProfiles(parsedConfig) {
        const config = parsedConfig && typeof parsedConfig === 'object' ? parsedConfig : {};
        if (!config.runs || typeof config.runs !== 'object' || Array.isArray(config.runs)) {
            return {};
        }
        const result = {};
        Object.entries(config.runs).forEach(function (entry) {
            const key = String(entry[0] || '').trim();
            const value = entry[1];
            if (!key || !value || typeof value !== 'object' || Array.isArray(value)) {
                return;
            }
            result[key] = value;
        });
        return result;
    }

    function renderRunOptions(runs) {
        if (!createRun) return;
        const current = createRun.value || '';
        createRun.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '(不使用 run)';
        createRun.appendChild(placeholder);

        Object.keys(runs || {}).sort().forEach(function (runName) {
            const option = document.createElement('option');
            option.value = runName;
            option.textContent = runName;
            createRun.appendChild(option);
        });

        if (current && runs && Object.prototype.hasOwnProperty.call(runs, current)) {
            createRun.value = current;
        } else {
            createRun.value = '';
        }
    }

    function applyCurrentRunDefaults() {
        const selectedRun = createRun ? String(createRun.value || '').trim() : '';
        if (!selectedRun) {
            fillCreateForm(state.createDefaults || {});
            return;
        }
        const runConfig = state.createRuns && state.createRuns[selectedRun] ? state.createRuns[selectedRun] : {};
        fillCreateForm(mergeCreateDefaults(state.createDefaults || {}, runConfig));
    }

    function collectCreateOptions() {
        const options = {
            containerName: (createContainerName.value || '').trim(),
            hostPath: (createHostPath.value || '').trim(),
            containerPath: (createContainerPath.value || '').trim(),
            imageName: (createImageName.value || '').trim(),
            imageVersion: (createImageVersion.value || '').trim(),
            containerMode: (createContainerMode.value || '').trim(),
            shellPrefix: (createShellPrefix.value || '').trim(),
            shell: (createShell.value || '').trim(),
            shellSuffix: (createShellSuffix.value || '').trim(),
            agentPromptCommand: (createAgentPromptCommand.value || '').trim(),
            yolo: (createYolo.value || '').trim(),
            env: textToEnvMap(createEnv.value),
            envFile: textToLineArray(createEnvFile.value),
            volumes: textToLineArray(createVolumes.value)
        };

        Object.keys(options).forEach(function (key) {
            if (Array.isArray(options[key])) {
                if (!options[key].length) {
                    delete options[key];
                }
                return;
            }
            if (typeof options[key] === 'object') {
                if (!options[key] || !Object.keys(options[key]).length) {
                    delete options[key];
                }
                return;
            }
            if (!options[key]) {
                delete options[key];
            }
        });

        return options;
    }

    function getActiveSession() {
        if (!state.active) return null;
        return state.sessions.find(function (session) {
            return session.name === state.active;
        }) || null;
    }

    function isAgentRunActiveForSession(sessionName) {
        return Boolean(
            state.agentRun
            && state.agentRun.active
            && state.agentRun.sessionName
            && state.agentRun.sessionName === String(sessionName || '').trim()
        );
    }

    function isActiveSessionHistoryOnly() {
        const session = getActiveSession();
        return sessionStatusInfo(session && session.status).tone === 'history';
    }

    function isComposerMode() {
        return state.activeTab === 'activity';
    }

    function isActiveAgentEnabled() {
        const active = getActiveSession();
        return Boolean(active && active.agentEnabled);
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

    function buildMessageMetaLines(message) {
        const lines = [];
        const timeText = formatDateTime(message && message.timestamp);
        if (timeText) {
            lines.push({ className: 'msg-meta-time', text: timeText });
        }

        lines.push({
            className: 'msg-meta-role',
            text: roleName(message && message.role, message)
        });

        return lines;
    }

    function writeTerminalLine(text) {
        if (!state.terminal.term) return;
        state.terminal.term.writeln(text);
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

    function readCssVar(name, fallbackValue) {
        if (!name || !window.getComputedStyle) {
            return fallbackValue;
        }
        const root = document.documentElement;
        if (!root) {
            return fallbackValue;
        }
        const value = window.getComputedStyle(root).getPropertyValue(name);
        if (!value) {
            return fallbackValue;
        }
        const trimmed = value.trim();
        return trimmed || fallbackValue;
    }

    function resolveTerminalTheme() {
        return {
            background: readCssVar('--terminal-bg', '#11161d'),
            foreground: readCssVar('--terminal-fg', '#e8edf5'),
            cursor: readCssVar('--terminal-cursor', '#ffd166')
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
            fontFamily: readCssVar('--font-mono', '"IBM Plex Mono", "SFMono-Regular", Consolas, Menlo, monospace'),
            fontSize: 13,
            scrollback: 5000,
            theme: resolveTerminalTheme()
        });
        state.terminal.fitAddon = new FitAddonCtor();
        state.terminal.term.loadAddon(state.terminal.fitAddon);
        state.terminal.term.open(terminalScreen);
        scheduleTerminalFit(false);
        state.terminal.term.onData(function (data) {
            if (!data || !state.terminal.socket || state.terminal.socket.readyState !== window.WebSocket.OPEN) {
                return;
            }
            let send = data;
            if (state.terminal.ctrlMode && data.length === 1) {
                const code = data.charCodeAt(0);
                if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
                    send = String.fromCharCode(code & 0x1f);
                }
            } else if (state.terminal.altMode && data.length === 1) {
                send = '\x1b' + data;
            }
            state.terminal.socket.send(JSON.stringify({
                type: 'input',
                data: send
            }));
        });
        state.terminal.term.onResize(function (size) {
            if (!size || !size.cols || !size.rows) {
                return;
            }
            notifyTerminalResize(false);
        });
        state.terminal.terminalReady = true;
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
        state.terminal.term.reset();
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
        document.body.classList.toggle('mobile-actions-open', state.mobileActionsOpen);
        if (mobileActionsToggle) {
            mobileActionsToggle.setAttribute('aria-expanded', state.mobileActionsOpen ? 'true' : 'false');
        }
    }

    function closeMobileActionsMenu() {
        setMobileActionsMenu(false);
    }

    const VIEW_LABELS = {
        activity: '活动',
        terminal: '终端',
        detail: '详情',
        config: '配置',
        check: '检查'
    };

    function setActiveTab(tab) {
        const next = String(tab || '').trim();
        if (!VIEW_LABELS[next]) {
            return;
        }
        state.activeTab = next;
        syncUi();
        if (next === 'terminal' && state.active && ensureTerminalReady()) {
            scheduleTerminalFit(false);
            if (!state.terminal.connected && !state.terminal.connecting && !isActiveSessionHistoryOnly()) {
                connectTerminal();
            }
            if (state.terminal.term) {
                state.terminal.term.focus();
            }
        }
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderEmptyInspector(container, title, description) {
        if (!container) return;
        container.innerHTML = `
            <section class="info-card empty-card">
                <div class="card-title">${escapeHtml(title)}</div>
                <div class="card-desc">${escapeHtml(description)}</div>
            </section>
        `;
    }

    function renderKeyValueCard(container, title, entries, options) {
        if (!container) return;
        const opts = options && typeof options === 'object' ? options : {};
        const actionHtml = opts.actionLabel && opts.actionId
            ? `<button type="button" class="secondary inline-action" id="${escapeHtml(opts.actionId)}">${escapeHtml(opts.actionLabel)}</button>`
            : '';
        const rowsHtml = (entries || []).map(function (entry) {
            const tone = entry && entry.tone ? ` tone-${entry.tone}` : '';
            return `
                <div class="kv-row${tone}">
                    <span class="kv-label">${escapeHtml(entry.label || '')}</span>
                    <span class="kv-value">${escapeHtml(entry.value || '—')}</span>
                </div>
            `;
        }).join('');
        container.insertAdjacentHTML('beforeend', `
            <section class="info-card">
                <div class="card-head">
                    <div class="card-title">${escapeHtml(title)}</div>
                    ${actionHtml}
                </div>
                <div class="kv-list">${rowsHtml}</div>
            </section>
        `);
    }

    function renderCheckCard(container, title, checks) {
        if (!container) return;
        const itemsHtml = (checks || []).map(function (item) {
            return `
                <div class="check-item tone-${escapeHtml(item.tone || 'info')}">
                    <div class="check-main">
                        <span class="check-label">${escapeHtml(item.label || '')}</span>
                        <span class="check-value">${escapeHtml(item.value || '')}</span>
                    </div>
                    <div class="check-detail">${escapeHtml(item.detail || '')}</div>
                </div>
            `;
        }).join('');
        container.insertAdjacentHTML('beforeend', `
            <section class="info-card">
                <div class="card-title">${escapeHtml(title)}</div>
                <div class="check-list">${itemsHtml}</div>
            </section>
        `);
    }

    function renderSessionDetailPanels() {
        const detail = state.sessionDetail;
        if (!state.active) {
            renderEmptyInspector(detailSummary, '详情视图', '选择左侧会话后，这里会显示会话概览、Agent 状态与运行参数。');
            renderEmptyInspector(configSummary, '配置视图', '选择会话后可查看当前容器会话的运行参数摘要。');
            renderEmptyInspector(checkSummary, '检查视图', '选择会话后可查看当前会话的基础健康检查。');
            return;
        }
        if (state.loadingSessionDetail) {
            renderEmptyInspector(detailSummary, '详情视图', '正在加载会话详情...');
            renderEmptyInspector(configSummary, '配置视图', '正在加载会话详情...');
            renderEmptyInspector(checkSummary, '检查视图', '正在加载会话详情...');
            return;
        }
        if (!detail) {
            const message = state.sessionDetailError || '当前会话详情暂时不可用。';
            renderEmptyInspector(detailSummary, '详情视图', message);
            renderEmptyInspector(configSummary, '配置视图', message);
            renderEmptyInspector(checkSummary, '检查视图', message);
            return;
        }

        const applied = detail.applied || {};
        const status = sessionStatusInfo(detail.status);
        const updatedText = formatDateTime(detail.updatedAt) || '暂无更新';

        if (detailSummary) {
            detailSummary.innerHTML = '';
            renderKeyValueCard(detailSummary, '会话概览', [
                { label: '会话', value: detail.name || state.active },
                { label: '状态', value: status.label, tone: status.tone },
                { label: '镜像', value: detail.image || applied.imageName || '—' },
                { label: '最近更新', value: updatedText },
                { label: '消息数', value: String(safeMessageCount(detail.messageCount)) }
            ]);
            renderKeyValueCard(detailSummary, 'Agent 上下文', [
                { label: '已启用', value: detail.agentEnabled ? '是' : '否', tone: detail.agentEnabled ? 'ok' : 'warn' },
                { label: '程序', value: detail.agentProgram || '—' },
                { label: '支持 resume', value: detail.resumeSupported ? '是' : '否', tone: detail.resumeSupported ? 'ok' : 'warn' },
                { label: '最近 resume', value: detail.lastResumeAt ? formatDateTime(detail.lastResumeAt) : '暂无' },
                { label: '最近结果', value: detail.lastResumeOk == null ? '暂无' : (detail.lastResumeOk ? '成功' : '失败'), tone: detail.lastResumeOk == null ? 'info' : (detail.lastResumeOk ? 'ok' : 'danger') }
            ]);
            renderKeyValueCard(detailSummary, '运行参数', [
                { label: 'hostPath', value: applied.hostPath || '—' },
                { label: 'containerPath', value: applied.containerPath || '—' },
                { label: 'imageVersion', value: applied.imageVersion || '—' },
                { label: 'containerMode', value: applied.containerMode || 'default' },
                { label: 'env/vol/ports', value: `${applied.envCount || 0} / ${applied.volumeCount || 0} / ${applied.portCount || 0}` }
            ]);
        }

        if (configSummary) {
            configSummary.innerHTML = '';
            renderKeyValueCard(configSummary, '配置摘要', [
                { label: 'containerName', value: applied.containerName || detail.name || state.active },
                { label: 'hostPath', value: applied.hostPath || '—' },
                { label: 'containerPath', value: applied.containerPath || '—' },
                { label: 'imageName', value: applied.imageName || detail.image || '—' },
                { label: 'imageVersion', value: applied.imageVersion || '—' },
                { label: 'containerMode', value: applied.containerMode || 'default' }
            ], { actionLabel: '打开配置', actionId: 'configSummaryOpenBtn' });
            renderKeyValueCard(configSummary, '命令与 Agent', [
                { label: 'shellPrefix', value: applied.shellPrefix || '—' },
                { label: 'shell', value: applied.shell || '—' },
                { label: 'shellSuffix', value: applied.shellSuffix || '—' },
                { label: '默认命令', value: applied.defaultCommand || '—' },
                { label: 'Agent 模板', value: detail.agentPromptCommand || '—' },
                { label: 'yolo', value: applied.yolo || '—' }
            ]);
        }

        if (checkSummary) {
            checkSummary.innerHTML = '';
            renderCheckCard(checkSummary, '基础检查', [
                {
                    label: '容器状态',
                    value: status.label,
                    tone: status.tone === 'running' ? 'ok' : (status.tone === 'history' ? 'warn' : 'danger'),
                    detail: status.tone === 'running' ? '容器处于可交互状态。' : '当前不是活跃运行态，部分功能可能受限。'
                },
                {
                    label: 'Agent 模板',
                    value: detail.agentEnabled ? '已配置' : '未配置',
                    tone: detail.agentEnabled ? 'ok' : 'warn',
                    detail: detail.agentEnabled ? '活动页可直接发送 Agent 提示词。' : '当前会话不支持 Agent 模式。'
                },
                {
                    label: 'Resume 能力',
                    value: detail.resumeSupported ? '支持' : '不支持',
                    tone: detail.resumeSupported ? 'ok' : 'warn',
                    detail: detail.resumeSupported ? '可以尝试基于历史继续 Agent 会话。' : '当前 Agent 程序或模板不支持 resume。'
                },
                {
                    label: '镜像版本格式',
                    value: applied.imageVersion || '缺失',
                    tone: /^\d+\.\d+\.\d+-[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(String(applied.imageVersion || '')) ? 'ok' : 'danger',
                    detail: '建议保持 x.y.z-后缀 格式，便于 manyoyo 的版本校验。'
                },
                {
                    label: '工作目录',
                    value: applied.hostPath && applied.containerPath ? '完整' : '缺失',
                    tone: applied.hostPath && applied.containerPath ? 'ok' : 'danger',
                    detail: 'hostPath / containerPath 是容器会话最关键的上下文。'
                }
            ]);
            if (detail.lastResumeError) {
                renderCheckCard(checkSummary, '最近问题', [
                    {
                        label: 'Resume 错误',
                        value: '有错误输出',
                        tone: 'danger',
                        detail: detail.lastResumeError
                    }
                ]);
            }
        }

        const configSummaryOpenBtn = document.getElementById('configSummaryOpenBtn');
        if (configSummaryOpenBtn) {
            configSummaryOpenBtn.addEventListener('click', function () {
                openConfigModal();
            });
        }
    }

    function syncUi() {
        if (!state.active) {
            activeTitle.textContent = '未选择会话';
            activeMeta.textContent = '请选择左侧会话';
            if (isComposerMode()) {
                commandInput.value = '';
            }
        } else {
            activeTitle.textContent = state.active;
            activeMeta.textContent = buildActiveMeta(getActiveSession());
        }

        const activityTab = state.activeTab === 'activity';
        const terminalTab = state.activeTab === 'terminal';
        const detailTab = state.activeTab === 'detail';
        const configTab = state.activeTab === 'config';
        const checkTab = state.activeTab === 'check';
        const commandMode = state.mode === 'command';
        const agentMode = state.mode === 'agent';
        const agentEnabled = isActiveAgentEnabled();

        document.body.classList.toggle('command-mode', commandMode);
        document.body.classList.toggle('agent-mode', agentMode);
        document.body.classList.toggle('terminal-mode', terminalTab);
        document.body.classList.toggle('detail-tab', detailTab);
        document.body.classList.toggle('config-tab', configTab);
        document.body.classList.toggle('check-tab', checkTab);
        if (activityCommandBtn) {
            activityCommandBtn.classList.toggle('is-active', commandMode);
            activityCommandBtn.setAttribute('aria-pressed', commandMode ? 'true' : 'false');
        }
        if (activityAgentBtn) {
            activityAgentBtn.classList.toggle('is-active', agentMode);
            activityAgentBtn.setAttribute('aria-pressed', agentMode ? 'true' : 'false');
        }
        if (viewActivityBtn) viewActivityBtn.classList.toggle('is-active', activityTab);
        if (viewTerminalBtn) viewTerminalBtn.classList.toggle('is-active', terminalTab);
        if (viewDetailBtn) viewDetailBtn.classList.toggle('is-active', detailTab);
        if (viewConfigBtn) viewConfigBtn.classList.toggle('is-active', configTab);
        if (viewCheckBtn) viewCheckBtn.classList.toggle('is-active', checkTab);
        if (messagesNode) {
            messagesNode.hidden = !activityTab;
        }
        if (terminalPanel) {
            terminalPanel.hidden = !terminalTab;
        }
        if (detailPanel) {
            detailPanel.hidden = !detailTab;
        }
        if (configPanel) {
            configPanel.hidden = !configTab;
        }
        if (checkPanel) {
            checkPanel.hidden = !checkTab;
        }
        if (terminalTab && state.terminal.terminalReady) {
            scheduleTerminalFit(false);
        }

        const activeAgentRunning = isAgentRunActiveForSession(state.active);
        const busy = state.loadingSessions || state.loadingMessages || state.sending;
        refreshBtn.disabled = busy;
        removeBtn.disabled = !state.active || busy;
        removeAllBtn.disabled = !state.active || busy;
        sendBtn.disabled = !activityTab || !state.active || busy || (agentMode && !agentEnabled);
        if (stopBtn) {
            stopBtn.disabled = !activityTab || !agentMode || !activeAgentRunning || state.agentRun.stopping;
        }
        commandInput.disabled = !activityTab || !state.active || (agentMode && !agentEnabled);
        if (commandInput) {
            commandInput.placeholder = agentMode
                ? '输入提示词，例如：请帮我分析当前项目结构并给出重构建议'
                : '输入容器命令，例如: ls -la';
        }
        if (composerHint) {
            composerHint.textContent = agentMode
                ? 'Enter 发送提示词 · Shift/Alt + Enter 换行 · 执行中可停止'
                : 'Enter 发送 · Shift/Alt + Enter 换行';
        }
        if (openCreateBtn) {
            openCreateBtn.disabled = state.createLoading || state.createSubmitting;
        }
        if (openConfigBtn) {
            openConfigBtn.disabled = state.configLoading || state.configSaving;
        }
        if (configSaveBtn) {
            configSaveBtn.disabled = state.configLoading || state.configSaving;
        }
        if (configReloadBtn) {
            configReloadBtn.disabled = state.configLoading || state.configSaving;
        }
        if (configCancelBtn) {
            configCancelBtn.disabled = state.configSaving;
        }
        if (createSubmitBtn) {
            createSubmitBtn.disabled = state.createLoading || state.createSubmitting;
        }
        if (createResetBtn) {
            createResetBtn.disabled = state.createSubmitting;
        }
        if (createCancelBtn) {
            createCancelBtn.disabled = state.createSubmitting;
        }
        if (sendState) {
            if (!state.active) {
                sendState.textContent = '未选择会话';
                sendState.classList.remove('is-active');
            } else if (activeAgentRunning && agentMode) {
                sendState.textContent = state.agentRun.stopping ? '正在停止 Agent…' : 'Agent 执行中';
                sendState.classList.add('is-active');
            } else if (busy) {
                sendState.textContent = '处理中';
                sendState.classList.add('is-active');
            } else {
                sendState.textContent = agentMode ? 'Agent 就绪' : '命令就绪';
                sendState.classList.remove('is-active');
            }
        }
        if (configModal) {
            configModal.hidden = !state.configModalOpen;
        }
        if (createModal) {
            createModal.hidden = !state.createModalOpen;
        }
        if (!state.active) {
            sendState.textContent = '未选择会话';
        } else if (agentMode && !agentEnabled) {
            sendState.textContent = '当前会话未配置 AGENT 模板';
        } else if (state.sending) {
            sendState.textContent = '发送中...';
        } else if (state.loadingSessions || state.loadingMessages) {
            sendState.textContent = '加载中...';
        } else {
            sendState.textContent = '就绪';
        }
        sendState.classList.toggle('is-active', state.sending);
        if (composer) {
            composer.hidden = !activityTab;
        }
        setMobileSessionPanel(state.mobileSidebarOpen);
        setMobileActionsMenu(state.mobileActionsOpen);
        renderSessionDetailPanels();
    }

    async function api(url, options) {
        const requestOptions = Object.assign(
            { headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } },
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
            const errorText = data && data.detail ? `${data.error || '请求失败'}: ${data.detail}` : (data.error || '请求失败');
            throw new Error(errorText);
        }
        return data;
    }

    async function apiStream(url, options, handlers) {
        const requestOptions = Object.assign(
            { headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } },
            options || {}
        );
        const streamHandlers = handlers && typeof handlers === 'object' ? handlers : {};
        const response = await fetch(url, requestOptions);
        if (response.status === 401) {
            window.location.href = '/';
            throw new Error('未登录或登录已过期');
        }
        if (!response.ok) {
            let errorText = '请求失败';
            try {
                const data = await response.json();
                errorText = data && data.detail ? `${data.error || '请求失败'}: ${data.detail}` : (data.error || '请求失败');
            } catch (e) {
                errorText = '请求失败';
            }
            throw new Error(errorText);
        }
        if (!response.body || typeof response.body.getReader !== 'function') {
            throw new Error('当前浏览器不支持流式读取');
        }

        const decoder = new window.TextDecoder();
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
                // ignore trailing non-json fragments
            }
        }
    }

    async function fetchConfigSnapshot() {
        const snapshot = await api('/api/config');
        state.configSnapshot = snapshot;
        return snapshot;
    }

    async function openConfigModal() {
        closeCreateModal();
        state.configLoading = true;
        showConfigError('');
        syncUi();
        try {
            const config = await fetchConfigSnapshot();
            if (configPath) {
                configPath.textContent = config.path || '';
            }
            if (configEditor) {
                configEditor.value = typeof config.raw === 'string' ? config.raw : '';
            }
            if (config.parseError) {
                showConfigError('当前文件存在解析错误：' + config.parseError);
            }
            state.configModalOpen = true;
            setModalVisible(configModal, true);
        } catch (e) {
            alert(e.message);
        } finally {
            state.configLoading = false;
            syncUi();
        }
    }

    function closeConfigModal() {
        state.configModalOpen = false;
        setModalVisible(configModal, false);
    }

    async function saveConfig() {
        state.configSaving = true;
        showConfigError('');
        syncUi();
        try {
            await api('/api/config', {
                method: 'PUT',
                body: JSON.stringify({ raw: configEditor ? configEditor.value : '' })
            });
            await fetchConfigSnapshot();
            showConfigError('');
            alert('配置已保存。后续新建会读取最新配置。');
        } catch (e) {
            showConfigError(e.message);
        } finally {
            state.configSaving = false;
            syncUi();
        }
    }

    async function openCreateModal() {
        closeConfigModal();
        state.createLoading = true;
        showCreateError('');
        syncUi();
        try {
            const config = await fetchConfigSnapshot();
            state.createDefaults = config.defaults || {};
            state.createRuns = normalizeRunProfiles(config.parsed || {});
            renderRunOptions(state.createRuns);
            applyCurrentRunDefaults();
            if (config.parseError) {
                showCreateError('配置文件解析失败，已使用安全默认值。建议先修复配置：' + config.parseError);
            }
            state.createModalOpen = true;
            setModalVisible(createModal, true);
        } catch (e) {
            alert(e.message);
        } finally {
            state.createLoading = false;
            syncUi();
        }
    }

    function closeCreateModal() {
        state.createModalOpen = false;
        setModalVisible(createModal, false);
        showCreateError('');
    }

    function resetCreateModal() {
        applyCurrentRunDefaults();
        showCreateError('');
    }

    function renderSessionsLoading() {
        state.sessionNodeMap.clear();
        state.sessionRenderMode = 'loading';
        sessionList.innerHTML = '';
        for (let i = 0; i < 3; i++) {
            const skeleton = document.createElement('div');
            skeleton.className = 'skeleton session';
            sessionList.appendChild(skeleton);
        }
    }

    function getSessionRenderKey(session) {
        return [
            String(session && session.name ? session.name : ''),
            String(session && session.status ? session.status : ''),
            String(safeMessageCount(session && session.messageCount)),
            String(session && session.updatedAt ? session.updatedAt : ''),
            String(session && session.image ? session.image : '')
        ].join('|');
    }

    function renderSessionActiveState() {
        for (const [name, node] of state.sessionNodeMap.entries()) {
            node.classList.toggle('active', state.active === name);
        }
    }

    function updateSessionRow(row, session, index) {
        if (!row || !session) return;
        const status = sessionStatusInfo(session.status);
        row.style.setProperty('--item-index', String(index));
        row.classList.toggle('active', state.active === session.name);
        row.classList.toggle('history-only', status.tone === 'history');
        row.classList.toggle('status-running', status.tone === 'running');
        row.classList.toggle('status-stopped', status.tone === 'stopped');
        row.classList.toggle('status-history', status.tone === 'history');
        row.classList.toggle('status-unknown', status.tone === 'unknown');
        if (row.__sessionNameNode) {
            row.__sessionNameNode.textContent = session.name;
        }
        if (row.__statusBadgeNode) {
            row.__statusBadgeNode.className = `session-status ${status.tone}`;
            row.__statusBadgeNode.textContent = status.label;
        }
        if (row.__messageCountNode) {
            row.__messageCountNode.textContent = `${safeMessageCount(session.messageCount)} 条`;
        }
        if (row.__timeNode) {
            row.__timeNode.textContent = formatDateTime(session.updatedAt) || '暂无更新';
        }
        row.__renderKey = getSessionRenderKey(session);
    }

    function handleSessionItemClick(sessionName) {
        if (state.loadingMessages) return;
        if (!sessionName) return;
        if (state.active === sessionName) {
            if (isMobileLayout()) {
                closeMobileSessionPanel();
            }
            return;
        }
        if ((state.terminal.connected || state.terminal.connecting) && state.terminal.sessionName && state.terminal.sessionName !== sessionName) {
            disconnectTerminal('会话切换，终端已断开', true);
        }
        state.active = sessionName;
        state.sessionDetail = null;
        state.sessionDetailError = '';
        if (isMobileLayout()) {
            closeMobileSessionPanel();
        }
        if (state.activeTab === 'terminal' && ensureTerminalReady()) {
            scheduleTerminalFit(false);
            if (!state.terminal.connected && !state.terminal.connecting) {
                if (isActiveSessionHistoryOnly()) {
                    state.terminal.term.reset();
                } else {
                    connectTerminal();
                }
            }
        }
        renderSessionActiveState();
        syncUi();
        Promise.all([
            loadMessagesForSession(sessionName),
            loadSessionDetailForSession(sessionName)
        ]).catch(function (e) {
            alert(e.message);
        });
    }

    function createSessionRow(session, index) {
        const status = sessionStatusInfo(session.status);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'session-item';
        btn.dataset.sessionName = session.name;

        const sessionName = document.createElement('div');
        sessionName.className = 'session-name';

        const meta = document.createElement('div');
        meta.className = 'session-meta';

        const statusBadge = document.createElement('span');
        statusBadge.className = `session-status ${status.tone}`;

        const messageCount = document.createElement('span');
        messageCount.className = 'session-count';

        meta.appendChild(statusBadge);
        meta.appendChild(messageCount);

        const time = document.createElement('div');
        time.className = 'session-time';

        btn.appendChild(sessionName);
        btn.appendChild(meta);
        btn.appendChild(time);
        btn.__sessionNameNode = sessionName;
        btn.__statusBadgeNode = statusBadge;
        btn.__messageCountNode = messageCount;
        btn.__timeNode = time;

        btn.addEventListener('click', function () {
            handleSessionItemClick(btn.dataset.sessionName || '');
        });

        updateSessionRow(btn, session, index);
        return btn;
    }

    function renderSessions() {
        sessionCount.textContent = state.loadingSessions ? '加载中...' : `${state.sessions.length} 个`;

        if (state.loadingSessions) {
            renderSessionsLoading();
            return;
        }

        if (!state.sessions.length) {
            state.sessionNodeMap.clear();
            state.sessionRenderMode = 'empty';
            sessionList.innerHTML = '';
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '暂无 manyoyo 会话';
            sessionList.appendChild(empty);
            return;
        }

        if (state.sessionRenderMode !== 'list') {
            sessionList.innerHTML = '';
            state.sessionNodeMap.clear();
            state.sessionRenderMode = 'list';
        }

        const nextNameSet = new Set();
        state.sessions.forEach(function (session, index) {
            nextNameSet.add(session.name);
            let row = state.sessionNodeMap.get(session.name);
            if (!row) {
                row = createSessionRow(session, index);
                state.sessionNodeMap.set(session.name, row);
            } else if (row.__renderKey !== getSessionRenderKey(session)) {
                updateSessionRow(row, session, index);
            } else {
                row.style.setProperty('--item-index', String(index));
            }

            const currentAtIndex = sessionList.children[index];
            if (currentAtIndex !== row) {
                sessionList.insertBefore(row, currentAtIndex || null);
            }
        });

        const removeNames = [];
        for (const existingName of state.sessionNodeMap.keys()) {
            if (!nextNameSet.has(existingName)) {
                removeNames.push(existingName);
            }
        }
        removeNames.forEach(function (name) {
            const row = state.sessionNodeMap.get(name);
            if (row && row.parentNode === sessionList) {
                sessionList.removeChild(row);
            }
            state.sessionNodeMap.delete(name);
        });

        while (sessionList.children.length > state.sessions.length) {
            sessionList.removeChild(sessionList.lastChild);
        }
        renderSessionActiveState();
    }

    function renderMessagesLoading() {
        messagesNode.innerHTML = '';
        state.messageRenderKeys = [];
        for (let i = 0; i < 2; i++) {
            const skeleton = document.createElement('div');
            skeleton.className = 'skeleton message';
            messagesNode.appendChild(skeleton);
        }
    }

    function isMessagesNearBottom(thresholdPx) {
        const threshold = Number.isFinite(thresholdPx) ? thresholdPx : 40;
        if (!messagesNode) return true;
        return (messagesNode.scrollHeight - (messagesNode.scrollTop + messagesNode.clientHeight)) <= threshold;
    }

    function scrollMessagesToBottomImmediate() {
        if (!messagesNode) return;
        const previousBehavior = messagesNode.style.scrollBehavior;
        messagesNode.style.scrollBehavior = 'auto';
        messagesNode.scrollTop = messagesNode.scrollHeight;
        messagesNode.style.scrollBehavior = previousBehavior;
    }

    function createLocalMessageId(prefix) {
        const head = String(prefix || 'local');
        const tail = Math.random().toString(16).slice(2, 8);
        return `${head}-${Date.now()}-${tail}`;
    }

    function getMessageRenderKey(msg, index) {
        if (msg && msg.id && msg.streamTrace) {
            const content = msg.content ? String(msg.content) : '';
            const timestamp = msg.timestamp ? String(msg.timestamp) : '';
            return `id:${msg.id}|trace|${timestamp}|${content}`;
        }
        if (msg && msg.id) {
            return `id:${msg.id}`;
        }
        const role = msg && msg.role ? String(msg.role) : '';
        const mode = msg && msg.mode ? String(msg.mode) : '';
        const timestamp = msg && msg.timestamp ? String(msg.timestamp) : '';
        const exitCode = msg && typeof msg.exitCode === 'number' ? String(msg.exitCode) : '';
        const pending = msg && msg.pending ? '1' : '0';
        const content = msg && msg.content ? String(msg.content) : '';
        return `idx:${index}|${role}|${mode}|${timestamp}|${exitCode}|${pending}|${content}`;
    }

    function resolveMessageOrigin(msg) {
        const role = msg && msg.role ? String(msg.role) : '';
        if (!(role === 'user' || role === 'assistant')) {
            return '';
        }
        const mode = msg && msg.mode ? String(msg.mode) : '';
        if (mode === 'agent') {
            return 'agent';
        }
        return 'command';
    }

    function createMessageRow(msg, index) {
        const row = document.createElement('article');
        row.className = 'msg ' + (msg.role || 'system') + (msg.pending ? ' pending' : '');
        const origin = resolveMessageOrigin(msg);
        if (origin) {
            row.classList.add('origin-' + origin);
        }
        row.style.setProperty('--msg-index', String(index));

        const meta = document.createElement('div');
        meta.className = 'msg-meta';
        const metaLines = buildMessageMetaLines(msg);
        metaLines.forEach(function (line) {
            const lineNode = document.createElement('div');
            lineNode.className = 'msg-meta-line ' + line.className;
            lineNode.textContent = line.text;
            meta.appendChild(lineNode);
        });

        const bubble = document.createElement('div');
        bubble.className = 'bubble';

        const shouldRenderStructuredTrace = Boolean(
            msg
            && msg.streamTrace
            && Array.isArray(msg.traceEvents)
            && msg.traceEvents.length
        );
        const shouldRenderMarkdown = Boolean(!msg.streamTrace && markdownRenderer && markdownRenderer.shouldRenderMessage(msg));
        if (shouldRenderStructuredTrace) {
            appendStructuredTraceContent(bubble, msg);
        } else if (shouldRenderMarkdown) {
            const markdownNode = document.createElement('div');
            markdownNode.className = 'md-content';
            let renderedMarkdown = '';
            try {
                renderedMarkdown = String(markdownRenderer.render(msg.content) || '');
            } catch (e) {
                renderedMarkdown = '';
            }
            if (renderedMarkdown) {
                markdownNode.innerHTML = renderedMarkdown;
                bubble.appendChild(markdownNode);
            } else {
                appendPlainMessageContent(bubble, msg.content);
            }
        } else {
            appendPlainMessageContent(bubble, msg.content);
        }

        row.appendChild(meta);
        row.appendChild(bubble);
        return row;
    }

    function renderMessages(messages, options) {
        const renderOptions = options && typeof options === 'object' ? options : {};
        const stickToBottom = renderOptions.stickToBottom === true || isMessagesNearBottom(40);

        if (state.loadingMessages && !messages.length) {
            renderMessagesLoading();
            return;
        }

        if (!messages.length) {
            messagesNode.innerHTML = '';
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = state.mode === 'agent'
                ? '输入提示词后，AGENT 回复会显示在这里。'
                : '输入命令后，容器输出会显示在这里。';
            messagesNode.appendChild(empty);
            state.messageRenderKeys = [];
            return;
        }

        const nextKeys = messages.map(function (msg, index) {
            return getMessageRenderKey(msg, index);
        });
        const prevKeys = Array.isArray(state.messageRenderKeys) ? state.messageRenderKeys : [];
        const hasRenderedMessages = messagesNode.children.length === prevKeys.length && prevKeys.length > 0;
        let updated = false;

        if (!renderOptions.forceFullRender && hasRenderedMessages) {
            let prefix = 0;
            while (
                prefix < prevKeys.length &&
                prefix < nextKeys.length &&
                prevKeys[prefix] === nextKeys[prefix]
            ) {
                prefix += 1;
            }

            if (prefix === prevKeys.length && prefix === nextKeys.length) {
                updated = true;
            } else if (prefix > 0) {
                while (messagesNode.children.length > prefix) {
                    messagesNode.removeChild(messagesNode.lastChild);
                }
                for (let i = prefix; i < messages.length; i++) {
                    messagesNode.appendChild(createMessageRow(messages[i], i));
                }
                updated = true;
            }
        }

        if (!updated) {
            messagesNode.innerHTML = '';
            messages.forEach(function (msg, index) {
                messagesNode.appendChild(createMessageRow(msg, index));
            });
        }
        state.messageRenderKeys = nextKeys;

        if (stickToBottom) {
            scrollMessagesToBottomImmediate();
        }
    }

    function applySessionsSnapshot(rawSessions, preferredName) {
        state.sessions = Array.isArray(rawSessions) ? rawSessions : [];

        if (typeof preferredName === 'string' && preferredName.trim()) {
            state.active = preferredName.trim();
        }

        if (state.active && !state.sessions.some(function (session) { return session.name === state.active; })) {
            state.active = '';
            state.sessionDetail = null;
            state.sessionDetailError = '';
        }
        if (!state.active && state.sessions.length) {
            state.active = state.sessions[0].name;
        }
        if (state.terminal.sessionName && state.terminal.sessionName !== state.active) {
            disconnectTerminal('会话已变化，终端已断开', true);
        }
    }

    async function refreshSessions(options) {
        const opts = options && typeof options === 'object' ? options : {};
        const withLoading = opts.withLoading !== false;

        if (withLoading) {
            state.loadingSessions = true;
            renderSessions();
            syncUi();
        }

        let requestError = null;
        try {
            const data = await api('/api/sessions');
            applySessionsSnapshot(data.sessions, opts.preferredName);
        } catch (e) {
            requestError = e;
        } finally {
            if (withLoading) {
                state.loadingSessions = false;
            }
            renderSessions();
            syncUi();
        }

        if (requestError) {
            throw requestError;
        }

        if (state.activeTab === 'terminal' && ensureTerminalReady() && !state.terminal.connected && !state.terminal.connecting && !isActiveSessionHistoryOnly()) {
            scheduleTerminalFit(false);
            connectTerminal();
        }

        if (opts.reloadMessages) {
            await Promise.all([
                loadMessagesForSession(state.active, { silent: false }),
                loadSessionDetailForSession(state.active)
            ]);
        } else if (state.active) {
            loadSessionDetailForSession(state.active).catch(function () {
                // 静默失败不打断主流程
            });
        }
    }

    async function loadSessions(preferredName) {
        await refreshSessions({
            preferredName: preferredName,
            withLoading: true,
            reloadMessages: true
        });
    }

    async function refreshSessionsSilent(options) {
        const opts = options && typeof options === 'object' ? options : {};
        await refreshSessions({
            preferredName: opts.preferredName,
            withLoading: false,
            reloadMessages: false
        });
    }

    async function loadMessagesForSession(sessionName, options) {
        const opts = options && typeof options === 'object' ? options : {};
        const targetSession = typeof sessionName === 'string' ? sessionName.trim() : '';

        if (!targetSession) {
            state.messageRequestId += 1;
            state.messages = [];
            state.loadingMessages = false;
            renderMessages(state.messages);
            syncUi();
            return;
        }

        const requestId = state.messageRequestId + 1;
        state.messageRequestId = requestId;
        const silent = opts.silent === true;

        if (!silent) {
            state.loadingMessages = true;
            if (!state.messages.length) {
                renderMessages(state.messages);
            }
            syncUi();
        }

        let requestError = null;
        let data = null;
        try {
            data = await api('/api/sessions/' + encodeURIComponent(targetSession) + '/messages');
        } catch (e) {
            requestError = e;
        } finally {
            if (requestId !== state.messageRequestId) {
                return;
            }
            state.loadingMessages = false;
            if (!requestError && targetSession === state.active) {
                state.messages = Array.isArray(data && data.messages) ? data.messages : [];
            }
            if (!requestError || targetSession === state.active) {
                renderMessages(state.messages);
                syncUi();
            } else {
                syncUi();
            }
        }

        if (requestId !== state.messageRequestId) {
            return;
        }
        if (requestError) {
            throw requestError;
        }
    }

    async function loadMessages() {
        await loadMessagesForSession(state.active, { silent: false });
    }

    async function loadSessionDetailForSession(sessionName) {
        const targetSession = typeof sessionName === 'string' ? sessionName.trim() : '';
        const requestId = state.sessionDetailRequestId + 1;
        state.sessionDetailRequestId = requestId;

        if (!targetSession) {
            state.sessionDetail = null;
            state.sessionDetailError = '';
            state.loadingSessionDetail = false;
            renderSessionDetailPanels();
            return;
        }

        state.loadingSessionDetail = true;
        state.sessionDetailError = '';
        renderSessionDetailPanels();
        try {
            const data = await api('/api/sessions/' + encodeURIComponent(targetSession) + '/detail');
            if (requestId !== state.sessionDetailRequestId) {
                return;
            }
            state.sessionDetail = data && data.detail ? data.detail : null;
        } catch (e) {
            if (requestId !== state.sessionDetailRequestId) {
                return;
            }
            state.sessionDetail = null;
            state.sessionDetailError = e && e.message ? e.message : '加载会话详情失败';
        } finally {
            if (requestId !== state.sessionDetailRequestId) {
                return;
            }
            state.loadingSessionDetail = false;
            renderSessionDetailPanels();
        }
    }

    function bumpSessionMetaAfterSend(sessionName) {
        if (!sessionName) return;
        const session = state.sessions.find(function (item) {
            return item && item.name === sessionName;
        });
        if (!session) return;
        session.messageCount = safeMessageCount(session.messageCount) + 2;
        session.updatedAt = new Date().toISOString();
        renderSessions();
        syncUi();
    }

    function confirmPendingUserMessage(sessionName, pendingMessageId) {
        if (state.active !== sessionName) {
            return -1;
        }
        for (let i = state.messages.length - 1; i >= 0; i -= 1) {
            const message = state.messages[i];
            if (!message || message.role !== 'user') {
                continue;
            }
            if (!message.pending) {
                continue;
            }
            if (String(message.id || '') !== String(pendingMessageId || '')) {
                continue;
            }
            message.pending = false;
            return i;
        }
        return -1;
    }

    function appendAgentTraceMessageLocal(sessionName) {
        const traceMessage = {
            id: createLocalMessageId('local-agent-trace'),
            role: 'assistant',
            content: '[执行过程]\n等待 Agent 启动…',
            timestamp: new Date().toISOString(),
            mode: 'agent',
            streamTrace: true,
            traceEvents: []
        };
        if (state.active === sessionName) {
            state.messages.push(traceMessage);
        }
        return traceMessage.id;
    }

    function updateAgentTraceMessageLocal(sessionName, traceMessageId, content, traceEvent) {
        if (state.active !== sessionName) {
            return;
        }
        for (let i = state.messages.length - 1; i >= 0; i -= 1) {
            const message = state.messages[i];
            if (!message || String(message.id || '') !== String(traceMessageId || '')) {
                continue;
            }
            message.content = String(content || '');
            message.timestamp = new Date().toISOString();
            if (traceEvent && typeof traceEvent === 'object') {
                if (!Array.isArray(message.traceEvents)) {
                    message.traceEvents = [];
                }
                message.traceEvents.push(traceEvent);
            }
            return;
        }
    }

    function finalizeAgentRunState() {
        if (state.agentRun && state.agentRun.controller) {
            state.agentRun.controller = null;
        }
        state.agentRun.active = false;
        state.agentRun.stopping = false;
        state.agentRun.sessionName = '';
        state.agentRun.traceMessageId = '';
    }

    function appendAssistantMessageLocal(sessionName, result, mode) {
        if (state.active !== sessionName) {
            return;
        }
        const exitCode = typeof (result && result.exitCode) === 'number' ? result.exitCode : 1;
        const outputText = String(result && result.output ? result.output : '(无输出)');
        state.messages.push({
            id: createLocalMessageId('local-assistant'),
            role: 'assistant',
            content: outputText,
            timestamp: new Date().toISOString(),
            exitCode: exitCode,
            mode: mode || 'command'
        });
    }

    async function sendAgentPromptStream(sessionName, inputText, pendingMessage) {
        const traceMessageId = appendAgentTraceMessageLocal(sessionName);
        const traceLines = ['[执行过程]', '等待 Agent 启动…'];
        let finalResult = null;
        let streamError = null;

        state.agentRun.active = true;
        state.agentRun.sessionName = sessionName;
        state.agentRun.stopping = false;
        state.agentRun.controller = new window.AbortController();
        state.agentRun.traceMessageId = traceMessageId;
        renderMessages(state.messages, { stickToBottom: true });
        syncUi();

        function pushTraceLine(text, traceEvent) {
            const line = String(text || '').trim();
            if (!line) {
                return;
            }
            if (traceLines[traceLines.length - 1] === line) {
                return;
            }
            traceLines.push(line);
            updateAgentTraceMessageLocal(sessionName, traceMessageId, traceLines.join('\n'), traceEvent);
            if (state.active === sessionName) {
                renderMessages(state.messages, { stickToBottom: true });
            }
        }

        try {
            await apiStream('/api/sessions/' + encodeURIComponent(sessionName) + '/agent/stream', {
                method: 'POST',
                body: JSON.stringify({ prompt: inputText }),
                signal: state.agentRun.controller.signal
            }, {
                onEvent: function (event) {
                    if (!event || typeof event !== 'object') {
                        return;
                    }
                    if (event.type === 'meta') {
                        const contextMode = String(event.contextMode || '').trim();
                        const modeLabel = contextMode ? '上下文模式: ' + contextMode : '';
                        if (modeLabel) {
                            pushTraceLine(modeLabel);
                        }
                        if (event.resumeAttempted) {
                            pushTraceLine(event.resumeSucceeded ? '会话恢复成功' : '会话恢复失败，已回退到历史注入');
                        }
                        return;
                    }
                    if (event.type === 'trace') {
                        pushTraceLine(event.text || '', event.traceEvent || null);
                        return;
                    }
                    if (event.type === 'result') {
                        finalResult = event;
                        if (event.interrupted) {
                            pushTraceLine('[任务] 已停止');
                        } else {
                            pushTraceLine('[任务] 已完成');
                        }
                        return;
                    }
                    if (event.type === 'error') {
                        streamError = new Error(event.error || 'Agent 执行失败');
                    }
                }
            });
        } catch (e) {
            if (!(e && e.name === 'AbortError')) {
                streamError = e;
            }
        } finally {
            const pendingIndex = confirmPendingUserMessage(sessionName, pendingMessage.id);
            if (pendingIndex >= 0 && pendingIndex < state.messageRenderKeys.length) {
                if (pendingIndex < messagesNode.children.length) {
                    const pendingRow = messagesNode.children[pendingIndex];
                    if (pendingRow && pendingRow.classList.contains('pending')) {
                        pendingRow.classList.remove('pending');
                    }
                }
            }
            finalizeAgentRunState();
            syncUi();
        }

        if (streamError) {
            throw streamError;
        }
        if (!finalResult) {
            throw new Error('Agent 流式响应未返回结果');
        }

        appendAssistantMessageLocal(sessionName, finalResult, 'agent');
        if (state.active === sessionName) {
            renderMessages(state.messages, { stickToBottom: true });
        }
        bumpSessionMetaAfterSend(sessionName);
        refreshSessionsSilent({ preferredName: sessionName }).catch(function () {
            // 静默同步失败不打断当前交互
        });
    }

    if (openConfigBtn) {
        openConfigBtn.addEventListener('click', function () {
            openConfigModal();
        });
    }

    if (openCreateBtn) {
        openCreateBtn.addEventListener('click', function () {
            openCreateModal();
        });
    }

    if (configCancelBtn) {
        configCancelBtn.addEventListener('click', function () {
            closeConfigModal();
            syncUi();
        });
    }

    if (configReloadBtn) {
        configReloadBtn.addEventListener('click', function () {
            openConfigModal();
        });
    }

    if (configSaveBtn) {
        configSaveBtn.addEventListener('click', function () {
            saveConfig();
        });
    }

    if (createCancelBtn) {
        createCancelBtn.addEventListener('click', function () {
            closeCreateModal();
            syncUi();
        });
    }

    if (createResetBtn) {
        createResetBtn.addEventListener('click', function () {
            resetCreateModal();
        });
    }

    if (createRun) {
        createRun.addEventListener('change', function () {
            applyCurrentRunDefaults();
            showCreateError('');
        });
    }

    [createShellPrefix, createShell, createShellSuffix, createYolo].forEach(function (inputNode) {
        if (!inputNode) return;
        inputNode.addEventListener('input', function () {
            updateCreateAgentPromptCommandFromCommand();
        });
    });

    if (createAgentPromptCommand) {
        createAgentPromptCommand.addEventListener('input', function () {
            const current = String(createAgentPromptCommand.value || '').trim();
            if (!current) {
                state.createAgentPromptAuto = true;
                updateCreateAgentPromptCommandFromCommand();
                return;
            }
            const inferred = inferCreateAgentPromptCommand();
            state.createAgentPromptAuto = Boolean(inferred) && inferred === current;
        });
    }

    if (createForm) {
        createForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            if (state.createSubmitting || state.createLoading) return;
            state.createSubmitting = true;
            showCreateError('');
            syncUi();
            try {
                const createOptions = collectCreateOptions();
                const runName = createRun ? String(createRun.value || '').trim() : '';
                const data = await api('/api/sessions', {
                    method: 'POST',
                    body: JSON.stringify({
                        run: runName || undefined,
                        createOptions: createOptions
                    })
                });
                closeCreateModal();
                state.activeTab = 'activity';
                state.mode = 'agent';
                await loadSessions(data.name);
                if (isMobileLayout()) {
                    closeMobileSessionPanel();
                }
            } catch (e) {
                showCreateError(e.message);
            } finally {
                state.createSubmitting = false;
                syncUi();
            }
        });
    }

    composer.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (!state.active) return;
        if (state.sending) return;
        if (state.loadingSessions || state.loadingMessages) return;
        if (state.activeTab !== 'activity') return;
        const mode = state.mode === 'agent' ? 'agent' : 'command';
        if (mode === 'agent' && !isActiveAgentEnabled()) {
            syncUi();
            return;
        }
        const inputText = (commandInput.value || '').trim();
        if (!inputText) return;

        const submitSession = state.active;
        const pendingMessage = {
            id: createLocalMessageId('local-user'),
            role: 'user',
            content: inputText,
            timestamp: new Date().toISOString(),
            pending: true,
            mode: mode
        };
        state.messages.push(pendingMessage);
        renderMessages(state.messages, { stickToBottom: true });

        state.sending = true;
        syncUi();
        try {
            commandInput.value = '';
            commandInput.focus();
            if (mode === 'agent') {
                await sendAgentPromptStream(submitSession, inputText, pendingMessage);
            } else {
                const runResult = await api('/api/sessions/' + encodeURIComponent(submitSession) + '/run', {
                    method: 'POST',
                    body: JSON.stringify({ command: inputText })
                });
                const pendingIndex = confirmPendingUserMessage(submitSession, pendingMessage.id);
                if (pendingIndex >= 0 && pendingIndex < state.messageRenderKeys.length) {
                    if (pendingIndex < messagesNode.children.length) {
                        const pendingRow = messagesNode.children[pendingIndex];
                        if (pendingRow && pendingRow.classList.contains('pending')) {
                            pendingRow.classList.remove('pending');
                        }
                    }
                }
                appendAssistantMessageLocal(submitSession, runResult, mode);
                if (state.active === submitSession) {
                    renderMessages(state.messages, { stickToBottom: true });
                }
                bumpSessionMetaAfterSend(submitSession);
                refreshSessionsSilent({ preferredName: submitSession }).catch(function () {
                    // 静默同步失败不打断当前交互
                });
            }
        } catch (e) {
            if (state.active === submitSession) {
                state.messages = state.messages.filter(function (message) {
                    return !(message && message.id === pendingMessage.id);
                });
                renderMessages(state.messages, { stickToBottom: true });
            }
            alert(e.message);
        } finally {
            state.sending = false;
            syncUi();
            commandInput.focus();
        }
    });

    if (stopBtn) {
        stopBtn.addEventListener('click', async function () {
            if (!state.active || !isAgentRunActiveForSession(state.active) || state.agentRun.stopping) {
                return;
            }
            state.agentRun.stopping = true;
            syncUi();
            try {
                await api('/api/sessions/' + encodeURIComponent(state.active) + '/agent/stop', {
                    method: 'POST',
                    body: JSON.stringify({})
                });
            } catch (e) {
                alert(e.message);
                state.agentRun.stopping = false;
                syncUi();
            }
        });
    }

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
        if (!state.active || state.sending || state.activeTab !== 'activity') {
            return;
        }
        composer.requestSubmit();
    });

    if (activityCommandBtn) {
        activityCommandBtn.addEventListener('click', function () {
            state.mode = 'command';
            renderMessages(state.messages, { forceFullRender: true });
            syncUi();
            commandInput.focus();
        });
    }

    if (activityAgentBtn) {
        activityAgentBtn.addEventListener('click', function () {
            state.mode = 'agent';
            renderMessages(state.messages, { forceFullRender: true });
            syncUi();
            commandInput.focus();
        });
    }

    if (viewActivityBtn) {
        viewActivityBtn.addEventListener('click', function () {
            setActiveTab('activity');
            commandInput.focus();
        });
    }

    if (viewTerminalBtn) {
        viewTerminalBtn.addEventListener('click', function () {
            setActiveTab('terminal');
        });
    }

    if (viewDetailBtn) {
        viewDetailBtn.addEventListener('click', function () {
            setActiveTab('detail');
        });
    }

    if (viewConfigBtn) {
        viewConfigBtn.addEventListener('click', function () {
            setActiveTab('config');
        });
    }

    if (viewCheckBtn) {
        viewCheckBtn.addEventListener('click', function () {
            setActiveTab('check');
        });
    }

    refreshBtn.addEventListener('click', function () {
        closeMobileActionsMenu();
        loadSessions(state.active).catch(function (e) { alert(e.message); });
    });

    const TERM_KEY_SEQUENCES = {
        esc: '\x1b',
        tab: '\x09',
        up: '\x1b[A',
        down: '\x1b[B',
        left: '\x1b[D',
        right: '\x1b[C'
    };
    const termKeybar = document.getElementById('terminalKeybar');
    if (termKeybar) {
        termKeybar.addEventListener('click', function (e) {
            const btn = e.target.closest('[data-key]');
            if (!btn) return;
            const key = btn.dataset.key;
            if (key === 'ctrl') {
                state.terminal.ctrlMode = !state.terminal.ctrlMode;
                btn.classList.toggle('is-active', state.terminal.ctrlMode);
                if (state.terminal.term) state.terminal.term.focus();
                return;
            }
            if (key === 'alt') {
                state.terminal.altMode = !state.terminal.altMode;
                btn.classList.toggle('is-active', state.terminal.altMode);
                if (state.terminal.term) state.terminal.term.focus();
                return;
            }
            const seq = TERM_KEY_SEQUENCES[key];
            if (!seq) return;
            if (state.terminal.socket && state.terminal.socket.readyState === window.WebSocket.OPEN) {
                state.terminal.socket.send(JSON.stringify({ type: 'input', data: seq }));
            }
            if (state.terminal.term) state.terminal.term.focus();
        });
    }

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

    if (configModal) {
        configModal.addEventListener('click', function (event) {
            if (event.target === configModal && !state.configSaving) {
                closeConfigModal();
                syncUi();
            }
        });
    }

    if (createModal) {
        createModal.addEventListener('click', function (event) {
            if (event.target === createModal && !state.createSubmitting) {
                closeCreateModal();
                syncUi();
            }
        });
    }

    window.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && state.configModalOpen) {
            closeConfigModal();
            syncUi();
        }
        if (event.key === 'Escape' && state.createModalOpen) {
            closeCreateModal();
            syncUi();
        }
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
        if (state.activeTab === 'terminal' && state.terminal.terminalReady) {
            scheduleTerminalFit(false);
        }
    }

    window.addEventListener('resize', function () {
        if (state.activeTab === 'terminal' && state.terminal.terminalReady) {
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
        const target = event.target;
        if (state.mobileActionsOpen) {
            if (mobileActionsToggle && mobileActionsToggle.contains(target)) return;
            if (headerActions && headerActions.contains(target)) return;
            closeMobileActionsMenu();
        }
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
    document.body.classList.add('agent-mode');
    syncUi();
    loadSessions().catch(function (e) {
        alert(e.message);
    });
})();
