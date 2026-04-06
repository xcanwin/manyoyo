'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const JSON5 = require('json5');
const { buildContainerRunArgs } = require('../container-run');
const { extractAgentMessageFromCodexJsonl } = require('../codex-output');
const { findValueRangeByPath, applyTextReplacements } = require('../json5-text-edit');
const { resolveRuntimeConfig } = require('../runtime-resolver');
const {
    normalizeAgentPromptCommandTemplate,
    isAgentPromptCommandEnabled,
    buildWebAgentExecCommand,
    getAgentRuntimeMeta
} = require('./agent-command');
const { createStructuredOutputHelpers } = require('./structured-output');
const { prepareStructuredTraceEvents, extractContentDeltaFromPayload } = require('./structured-trace');
const { createWebContainerExecHelpers } = require('./container-exec');
const { createWebTerminalHelpers } = require('./terminal-session');
const { createApiRouteHelpers, runMatchedRoute } = require('./api-route-helpers');
const { createSystemApiRoutes } = require('./system-api-routes');
const { createSessionApiRoutes } = require('./session-api-routes');
const {
    parseEnvEntry,
    expandHomeAliasPath,
    normalizeVolume
} = require('../runtime-normalizers');
const {
    resolveAgentProgram,
    resolveAgentPromptCommandTemplate,
    buildAgentResumeCommand
} = require('../agent-resume');

const WEB_HISTORY_MAX_MESSAGES = 500;
const WEB_OUTPUT_MAX_CHARS = 16000;
const WEB_TERMINAL_MAX_SESSIONS = 20;
const WEB_TERMINAL_FORCE_KILL_MS = 2000;
const WEB_TERMINAL_DEFAULT_COLS = 120;
const WEB_TERMINAL_DEFAULT_ROWS = 36;
const WEB_TERMINAL_MIN_COLS = 40;
const WEB_TERMINAL_MIN_ROWS = 12;
const WEB_AGENT_CONTEXT_MAX_MESSAGES = 24;
const WEB_AGENT_CONTEXT_MAX_CHARS = 6000;
const WEB_AGENT_CONTEXT_PER_MESSAGE_MAX_CHARS = 600;
const WEB_AUTH_COOKIE_NAME = 'manyoyo_web_auth';
const WEB_AUTH_TTL_SECONDS = 12 * 60 * 60;
const WEB_SESSION_KEY_SEPARATOR = '~';
const WEB_DEFAULT_AGENT_ID = 'default';
const WEB_DEFAULT_AGENT_NAME = 'AGENT 1';
const WEB_CONFIG_KEEP_SECRET_PLACEHOLDER = '***HIDDEN_SECRET***';
const FRONTEND_DIR = path.join(__dirname, 'frontend');
const AUTH_FRONTEND_ASSETS = new Set(['login.css', 'login.js']);
const APP_FRONTEND_ASSETS = new Set(['app.css', 'app.js', 'markdown.css', 'markdown-renderer.js']);
const APP_VENDOR_ASSETS = new Set(['xterm.css', 'xterm.js', 'xterm-addon-fit.js', 'marked.min.js']);
const SAFE_CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const IMAGE_VERSION_TAG_PATTERN = /^(\d+\.\d+\.\d+)-([A-Za-z0-9][A-Za-z0-9_.-]*)$/;
const SENSITIVE_CONFIG_KEY_PATTERN = /(pass(word)?|passwd|secret|token|api(?:_|-)?key|auth(?:_|-)?token|oauth(?:_|-)?token)$/i;
const REDACTED_CONFIG_VALUE = '***';

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

const DEFAULT_WEB_CONFIG_TEMPLATE = `{
    // MANYOYO 全局配置文件（JSON5）
    "containerName": "my-dev",
    "hostPath": "/path/to/your/project",
    "containerPath": "/path/to/your/project",
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.7.4-common",
    "containerMode": "common",
    "shellPrefix": "",
    "shell": "",
    "shellSuffix": "",
    "agentPromptCommand": "",
    "yolo": "",
    "env": {},
    "envFile": [],
    "volumes": [],
    "ports": []
}
`;

let XTERM_JS_FILE = null;
let XTERM_CSS_FILE = null;
let XTERM_ADDON_FIT_JS_FILE = null;
let MARKED_MIN_JS_FILE = null;
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
try {
    const markedPackageDir = path.dirname(require.resolve('marked/package.json'));
    MARKED_MIN_JS_FILE = path.join(markedPackageDir, 'lib', 'marked.umd.js');
} catch (e) {
    MARKED_MIN_JS_FILE = null;
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

function normalizeWebAgentName(agentId, agentName) {
    const name = typeof agentName === 'string' ? agentName.trim() : '';
    if (name) {
        return name;
    }
    if (agentId === WEB_DEFAULT_AGENT_ID) {
        return WEB_DEFAULT_AGENT_NAME;
    }
    const matched = String(agentId || '').match(/^agent-(\d+)$/);
    if (matched) {
        return `AGENT ${matched[1]}`;
    }
    return String(agentId || '').trim() || WEB_DEFAULT_AGENT_NAME;
}

function createEmptyWebAgentSession(agentId, agentName) {
    return {
        agentId,
        agentName: normalizeWebAgentName(agentId, agentName),
        agentPromptCommand: '',
        updatedAt: null,
        messages: [],
        lastResumeAt: null,
        lastResumeOk: null,
        lastResumeError: ''
    };
}

function normalizeWebAgentSessionRecord(agentId, rawAgent) {
    const source = rawAgent && typeof rawAgent === 'object' && !Array.isArray(rawAgent) ? rawAgent : {};
    return {
        agentId,
        agentName: normalizeWebAgentName(agentId, source.agentName),
        agentPromptCommand: typeof source.agentPromptCommand === 'string'
            ? normalizeAgentPromptCommandTemplate(source.agentPromptCommand, `agents.${agentId}.agentPromptCommand`)
            : '',
        updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
        messages: Array.isArray(source.messages) ? source.messages : [],
        lastResumeAt: typeof source.lastResumeAt === 'string' ? source.lastResumeAt : null,
        lastResumeOk: typeof source.lastResumeOk === 'boolean' ? source.lastResumeOk : null,
        lastResumeError: typeof source.lastResumeError === 'string' ? source.lastResumeError : ''
    };
}

function resolveEffectiveAgentPromptCommand(template, applied) {
    const normalizedTemplate = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    if (!normalizedTemplate) {
        return '';
    }

    const program = resolveAgentProgram(normalizedTemplate);
    const defaultCommand = applied && typeof applied === 'object'
        ? String(applied.defaultCommand || '').trim()
        : '';
    if (!program || !defaultCommand) {
        return normalizedTemplate;
    }

    const defaultProgram = resolveAgentProgram(defaultCommand);
    if (!defaultProgram || defaultProgram !== program) {
        return normalizedTemplate;
    }

    const genericTemplate = normalizeAgentPromptCommandTemplate(
        resolveAgentPromptCommandTemplate(program),
        'agentPromptCommand'
    );
    if (normalizedTemplate !== genericTemplate) {
        return normalizedTemplate;
    }

    const inferredTemplate = normalizeAgentPromptCommandTemplate(
        resolveAgentPromptCommandTemplate(defaultCommand),
        'agentPromptCommand'
    );
    if (!inferredTemplate || inferredTemplate === genericTemplate) {
        return normalizedTemplate;
    }

    return inferredTemplate;
}

function normalizeWebHistoryRecord(containerName, rawData) {
    const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData) ? rawData : {};
    const applied = data.applied && typeof data.applied === 'object' && !Array.isArray(data.applied)
        ? data.applied
        : null;
    const history = {
        containerName,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
        agentPromptCommand: resolveEffectiveAgentPromptCommand(
            typeof data.agentPromptCommand === 'string' ? data.agentPromptCommand : '',
            applied
        ),
        applied,
        agents: {}
    };

    if (data.agents && typeof data.agents === 'object' && !Array.isArray(data.agents)) {
        Object.keys(data.agents).forEach(agentId => {
            if (!SAFE_CONTAINER_NAME_PATTERN.test(agentId)) {
                return;
            }
            history.agents[agentId] = normalizeWebAgentSessionRecord(agentId, data.agents[agentId]);
        });
    }

    if (!Object.keys(history.agents).length && Array.isArray(data.messages)) {
        history.agents[WEB_DEFAULT_AGENT_ID] = normalizeWebAgentSessionRecord(WEB_DEFAULT_AGENT_ID, {
            agentName: data.agentName || WEB_DEFAULT_AGENT_NAME,
            updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
            messages: data.messages,
            lastResumeAt: typeof data.lastResumeAt === 'string' ? data.lastResumeAt : null,
            lastResumeOk: typeof data.lastResumeOk === 'boolean' ? data.lastResumeOk : null,
            lastResumeError: typeof data.lastResumeError === 'string' ? data.lastResumeError : ''
        });
    }

    return history;
}

function loadWebSessionHistory(webHistoryDir, containerName) {
    ensureWebHistoryDir(webHistoryDir);
    const filePath = getWebHistoryFile(webHistoryDir, containerName);
    if (!fs.existsSync(filePath)) {
        return normalizeWebHistoryRecord(containerName, {});
    }

    try {
        return normalizeWebHistoryRecord(containerName, JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    } catch (e) {
        return normalizeWebHistoryRecord(containerName, {});
    }
}

function saveWebSessionHistory(webHistoryDir, containerName, history) {
    ensureWebHistoryDir(webHistoryDir);
    const filePath = getWebHistoryFile(webHistoryDir, containerName);
    const normalized = normalizeWebHistoryRecord(containerName, history);
    const runtimeMeta = getAgentRuntimeMeta(normalized.agentPromptCommand || '');
    const defaultAgent = getWebAgentSession(normalized, WEB_DEFAULT_AGENT_ID) || createEmptyWebAgentSession(WEB_DEFAULT_AGENT_ID);
    const legacyCompatible = {
        ...normalized,
        messages: Array.isArray(defaultAgent.messages) ? defaultAgent.messages : [],
        agentProgram: runtimeMeta.agentProgram || '',
        resumeSupported: runtimeMeta.resumeSupported === true,
        lastResumeAt: defaultAgent.lastResumeAt || null,
        lastResumeOk: typeof defaultAgent.lastResumeOk === 'boolean' ? defaultAgent.lastResumeOk : null,
        lastResumeError: defaultAgent.lastResumeError || ''
    };
    fs.writeFileSync(filePath, JSON.stringify(legacyCompatible, null, 4));
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

function buildWebSessionKey(containerName, agentId = WEB_DEFAULT_AGENT_ID) {
    if (agentId === WEB_DEFAULT_AGENT_ID) {
        return containerName;
    }
    return `${containerName}${WEB_SESSION_KEY_SEPARATOR}${agentId}`;
}

function parseWebSessionKey(sessionKey) {
    const decoded = String(sessionKey || '').trim();
    if (!decoded) {
        return {
            key: '',
            containerName: '',
            agentId: WEB_DEFAULT_AGENT_ID
        };
    }
    const separatorIndex = decoded.indexOf(WEB_SESSION_KEY_SEPARATOR);
    if (separatorIndex === -1) {
        return {
            key: decoded,
            containerName: decoded,
            agentId: WEB_DEFAULT_AGENT_ID
        };
    }
    return {
        key: decoded,
        containerName: decoded.slice(0, separatorIndex),
        agentId: decoded.slice(separatorIndex + 1) || WEB_DEFAULT_AGENT_ID
    };
}

function getWebAgentSession(history, agentId, options = {}) {
    const sessionHistory = history && typeof history === 'object' ? history : { agents: {} };
    if (!sessionHistory.agents || typeof sessionHistory.agents !== 'object' || Array.isArray(sessionHistory.agents)) {
        sessionHistory.agents = {};
    }
    const requestedAgentId = String(agentId || WEB_DEFAULT_AGENT_ID).trim() || WEB_DEFAULT_AGENT_ID;
    if (sessionHistory.agents[requestedAgentId]) {
        return sessionHistory.agents[requestedAgentId];
    }
    if (options.create === true) {
        const agentSession = createEmptyWebAgentSession(requestedAgentId);
        sessionHistory.agents[requestedAgentId] = agentSession;
        return agentSession;
    }
    return null;
}

function listWebAgentSessions(history, options = {}) {
    const sessionHistory = history && typeof history === 'object' ? history : {};
    const agents = sessionHistory.agents && typeof sessionHistory.agents === 'object' && !Array.isArray(sessionHistory.agents)
        ? sessionHistory.agents
        : {};
    const agentIds = Object.keys(agents);
    if (!agentIds.length && options.includeSyntheticDefault === true) {
        return [createEmptyWebAgentSession(WEB_DEFAULT_AGENT_ID)];
    }
    return agentIds
        .map(agentId => agents[agentId])
        .filter(Boolean)
        .sort((a, b) => {
            const orderA = a.agentId === WEB_DEFAULT_AGENT_ID ? 0 : 1;
            const orderB = b.agentId === WEB_DEFAULT_AGENT_ID ? 0 : 1;
            if (orderA !== orderB) {
                return orderA - orderB;
            }
            return String(a.agentName || '').localeCompare(String(b.agentName || ''), 'zh-CN');
        });
}

function appendWebSessionMessage(webHistoryDir, sessionRefOrContainerName, role, content, extra = {}) {
    const sessionRef = typeof sessionRefOrContainerName === 'string'
        ? { containerName: sessionRefOrContainerName, agentId: WEB_DEFAULT_AGENT_ID }
        : sessionRefOrContainerName;
    const history = loadWebSessionHistory(webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true });
    const timestamp = new Date().toISOString();
    agentSession.messages.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        role,
        content,
        timestamp,
        ...extra
    });

    if (agentSession.messages.length > WEB_HISTORY_MAX_MESSAGES) {
        agentSession.messages = agentSession.messages.slice(-WEB_HISTORY_MAX_MESSAGES);
    }

    agentSession.updatedAt = timestamp;
    history.updatedAt = timestamp;
    saveWebSessionHistory(webHistoryDir, sessionRef.containerName, history);
}

function setWebSessionAgentPromptCommand(webHistoryDir, containerName, agentPromptCommand) {
    const history = loadWebSessionHistory(webHistoryDir, containerName);
    history.agentPromptCommand = normalizeAgentPromptCommandTemplate(agentPromptCommand, 'agentPromptCommand');
    saveWebSessionHistory(webHistoryDir, containerName, history);
}

function setWebAgentSessionPromptCommand(webHistoryDir, sessionRefOrContainerName, agentPromptCommand) {
    const sessionRef = typeof sessionRefOrContainerName === 'string'
        ? { containerName: sessionRefOrContainerName, agentId: WEB_DEFAULT_AGENT_ID }
        : sessionRefOrContainerName;
    if (sessionRef.agentId === WEB_DEFAULT_AGENT_ID) {
        throw new Error('默认 AGENT 请直接修改容器级 agentPromptCommand');
    }
    const history = loadWebSessionHistory(webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true });
    agentSession.agentPromptCommand = normalizeAgentPromptCommandTemplate(
        agentPromptCommand,
        `agents.${sessionRef.agentId}.agentPromptCommand`
    );
    saveWebSessionHistory(webHistoryDir, sessionRef.containerName, history);
}

function deriveAgentPromptCommandFromDefaultCommand(defaultCommand) {
    const normalizedCommand = String(defaultCommand || '').trim();
    if (!normalizedCommand) {
        return '';
    }
    try {
        return normalizeAgentPromptCommandTemplate(
            resolveAgentPromptCommandTemplate(normalizedCommand),
            'agentPromptCommand'
        );
    } catch (e) {
        return '';
    }
}

function resolveEffectiveSessionAgentPromptCommand(history, defaultCommand) {
    return resolveEffectiveAgentPromptCommandForSession(history, WEB_DEFAULT_AGENT_ID, defaultCommand);
}

function resolveEffectiveAgentPromptCommandForSession(history, agentId, defaultCommand) {
    const sessionHistory = history && typeof history === 'object' ? history : {};
    const requestedAgentId = String(agentId || WEB_DEFAULT_AGENT_ID).trim() || WEB_DEFAULT_AGENT_ID;
    const agentSession = getWebAgentSession(sessionHistory, requestedAgentId);
    const agentTemplate = agentSession && typeof agentSession.agentPromptCommand === 'string'
        ? normalizeAgentPromptCommandTemplate(agentSession.agentPromptCommand, `agents.${requestedAgentId}.agentPromptCommand`)
        : '';
    if (isAgentPromptCommandEnabled(agentTemplate)) {
        return agentTemplate;
    }
    const historyTemplate = typeof sessionHistory.agentPromptCommand === 'string'
        ? normalizeAgentPromptCommandTemplate(sessionHistory.agentPromptCommand, 'agentPromptCommand')
        : '';
    if (isAgentPromptCommandEnabled(historyTemplate)) {
        return historyTemplate;
    }
    return deriveAgentPromptCommandFromDefaultCommand(defaultCommand);
}

function getEffectiveAgentPromptCommandSource(history, agentId, defaultCommand) {
    const sessionHistory = history && typeof history === 'object' ? history : {};
    const requestedAgentId = String(agentId || WEB_DEFAULT_AGENT_ID).trim() || WEB_DEFAULT_AGENT_ID;
    const agentSession = getWebAgentSession(sessionHistory, requestedAgentId);
    const agentTemplate = agentSession && typeof agentSession.agentPromptCommand === 'string'
        ? normalizeAgentPromptCommandTemplate(agentSession.agentPromptCommand, `agents.${requestedAgentId}.agentPromptCommand`)
        : '';
    if (isAgentPromptCommandEnabled(agentTemplate)) {
        return 'agent';
    }
    const historyTemplate = typeof sessionHistory.agentPromptCommand === 'string'
        ? normalizeAgentPromptCommandTemplate(sessionHistory.agentPromptCommand, 'agentPromptCommand')
        : '';
    if (isAgentPromptCommandEnabled(historyTemplate)) {
        return 'container';
    }
    return isAgentPromptCommandEnabled(deriveAgentPromptCommandFromDefaultCommand(defaultCommand))
        ? 'inferred'
        : 'none';
}

function patchWebSessionHistory(webHistoryDir, containerName, patch) {
    const history = loadWebSessionHistory(webHistoryDir, containerName);
    if (!patch || typeof patch !== 'object') {
        return history;
    }
    Object.keys(patch).forEach(key => {
        history[key] = patch[key];
    });
    saveWebSessionHistory(webHistoryDir, containerName, history);
    return history;
}

function patchWebAgentSessionState(webHistoryDir, sessionRefOrContainerName, patch) {
    const sessionRef = typeof sessionRefOrContainerName === 'string'
        ? { containerName: sessionRefOrContainerName, agentId: WEB_DEFAULT_AGENT_ID }
        : sessionRefOrContainerName;
    const history = loadWebSessionHistory(webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true });
    if (!patch || typeof patch !== 'object') {
        return agentSession;
    }
    Object.keys(patch).forEach(key => {
        agentSession[key] = patch[key];
    });
    saveWebSessionHistory(webHistoryDir, sessionRef.containerName, history);
    return agentSession;
}

function createWebAgentSession(history) {
    const sessionHistory = history && typeof history === 'object' ? history : { agents: {} };
    if (!sessionHistory.agents || typeof sessionHistory.agents !== 'object' || Array.isArray(sessionHistory.agents)) {
        sessionHistory.agents = {};
    }
    let agentIndex = 2;
    while (sessionHistory.agents[`agent-${agentIndex}`]) {
        agentIndex += 1;
    }
    const agentId = `agent-${agentIndex}`;
    const agentSession = createEmptyWebAgentSession(agentId, `AGENT ${agentIndex}`);
    sessionHistory.agents[agentId] = agentSession;
    return agentSession;
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

const {
    parseJsonObjectLine,
    collectStructuredText,
    extractAgentMessageFromStructuredOutput
} = createStructuredOutputHelpers({
    pickFirstString,
    toPlainObject,
    extractAgentMessageFromCodexJsonl
});

const STRUCTURED_TRACE_DEPS = {
    pickFirstString,
    toPlainObject,
    collectStructuredText,
    clipText,
    stripAnsi
};

const {
    execCommandInWebContainer,
    execAgentInWebContainerStream
} = createWebContainerExecHelpers({
    buildWebSessionKey,
    defaultAgentId: WEB_DEFAULT_AGENT_ID,
    extractAgentMessageFromStructuredOutput,
    parseJsonObjectLine,
    prepareStructuredTraceEvents,
    extractContentDeltaFromPayload,
    structuredTraceDeps: STRUCTURED_TRACE_DEPS,
    clipText,
    stripAnsi
});

const {
    normalizeTerminalSize,
    sendWebSocketUpgradeError,
    bindTerminalWebSocket,
    cleanupWebRuntimeState
} = createWebTerminalHelpers({
    WebSocket,
    spawn,
    forceKillMs: WEB_TERMINAL_FORCE_KILL_MS,
    defaultCols: WEB_TERMINAL_DEFAULT_COLS,
    defaultRows: WEB_TERMINAL_DEFAULT_ROWS,
    minCols: WEB_TERMINAL_MIN_COLS,
    minRows: WEB_TERMINAL_MIN_ROWS
});

function hasAgentConversationHistory(history) {
    const messages = history && Array.isArray(history.messages) ? history.messages : [];
    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        if (message.mode !== 'agent') continue;
        if (message.streamTrace === true) continue;
        if (message.role === 'user' || message.role === 'assistant') {
            return true;
        }
    }
    return false;
}

function clipAgentContextMessageText(text) {
    const raw = clipText(stripAnsi(String(text || '')), WEB_AGENT_CONTEXT_PER_MESSAGE_MAX_CHARS);
    return raw
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function buildAgentPromptWithHistory(history, prompt) {
    const sessionHistory = history && Array.isArray(history.messages) ? history.messages : [];
    const relevantMessages = sessionHistory
        .filter(message => (
            message
            && message.mode === 'agent'
            && message.streamTrace !== true
            && (message.role === 'user' || message.role === 'assistant')
        ))
        .slice(-WEB_AGENT_CONTEXT_MAX_MESSAGES);
    if (!relevantMessages.length) {
        return String(prompt || '');
    }

    const lines = [];
    for (const message of relevantMessages) {
        const roleName = message.role === 'user' ? '用户' : '助手';
        const content = clipAgentContextMessageText(message.content);
        if (!content) continue;
        lines.push(`${roleName}: ${content}`);
    }
    if (!lines.length) {
        return String(prompt || '');
    }

    let historyText = lines.join('\n\n');
    if (historyText.length > WEB_AGENT_CONTEXT_MAX_CHARS) {
        historyText = historyText.slice(historyText.length - WEB_AGENT_CONTEXT_MAX_CHARS);
    }

    return [
        '以下是当前会话最近对话历史（按时间顺序）：',
        historyText,
        '---',
        '请基于以上历史回答当前问题。',
        `当前问题: ${String(prompt || '').trim()}`
    ].join('\n');
}

async function prepareWebAgentExecution(ctx, state, sessionRef, prompt) {
    const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true });
    const containerMap = listWebManyoyoContainers(ctx);
    const containerInfo = containerMap[sessionRef.containerName] || {};
    const normalizedContainerTemplate = normalizeAgentPromptCommandTemplate(history.agentPromptCommand, 'agentPromptCommand');
    if (normalizedContainerTemplate !== history.agentPromptCommand) {
        history.agentPromptCommand = normalizedContainerTemplate;
        saveWebSessionHistory(state.webHistoryDir, sessionRef.containerName, history);
    }
    if (agentSession && typeof agentSession.agentPromptCommand === 'string') {
        const normalizedAgentTemplate = normalizeAgentPromptCommandTemplate(
            agentSession.agentPromptCommand,
            `agents.${sessionRef.agentId}.agentPromptCommand`
        );
        if (normalizedAgentTemplate !== agentSession.agentPromptCommand) {
            agentSession.agentPromptCommand = normalizedAgentTemplate;
            saveWebSessionHistory(state.webHistoryDir, sessionRef.containerName, history);
        }
    }
    const effectiveTemplate = resolveEffectiveAgentPromptCommandForSession(
        history,
        sessionRef.agentId,
        containerInfo.defaultCommand
    );
    if (!isAgentPromptCommandEnabled(effectiveTemplate)) {
        throw new Error('当前会话未配置 agentPromptCommand');
    }

    await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
    const agentMeta = getAgentRuntimeMeta(effectiveTemplate);
    const hasPriorConversation = hasAgentConversationHistory(agentSession);
    let resumeAttempted = false;
    let resumeSucceeded = false;
    let resumeError = '';

    if (hasPriorConversation && agentMeta.resumeSupported && agentMeta.resumeCommand) {
        resumeAttempted = true;
        const resumeResult = await execCommandInWebContainer(ctx, sessionRef.containerName, agentMeta.resumeCommand);
        if (resumeResult.exitCode === 0) {
            resumeSucceeded = true;
        } else {
            resumeError = clipText(String(resumeResult.output || '(无输出)'), 1200);
        }
    }

    const effectivePrompt = resumeSucceeded
        ? prompt
        : buildAgentPromptWithHistory(agentSession, prompt);
    const command = buildWebAgentExecCommand(effectiveTemplate, effectivePrompt, agentMeta.agentProgram);
    const contextMode = resumeSucceeded ? 'resume' : (hasPriorConversation ? 'history-injected' : 'first-turn');

    return {
        history,
        agentSession,
        agentMeta,
        command,
        contextMode,
        resumeAttempted,
        resumeSucceeded,
        resumeError
    };
}

function finalizeWebAgentExecution(state, sessionRef, agentSession, agentMeta, meta, result) {
    appendWebSessionMessage(state.webHistoryDir, sessionRef, 'assistant', result.output, {
        exitCode: result.exitCode,
        mode: 'agent',
        contextMode: meta.contextMode,
        resumeAttempted: meta.resumeAttempted,
        resumeSucceeded: meta.resumeSucceeded,
        interrupted: result.interrupted === true
    });
    patchWebAgentSessionState(state.webHistoryDir, sessionRef, {
        lastResumeAt: meta.resumeAttempted ? new Date().toISOString() : (agentSession.lastResumeAt || null),
        lastResumeOk: meta.resumeAttempted ? meta.resumeSucceeded : agentSession.lastResumeOk,
        lastResumeError: meta.resumeAttempted ? (meta.resumeSucceeded ? '' : meta.resumeError) : (agentSession.lastResumeError || '')
    });
}

function appendWebAgentTraceMessage(webHistoryDir, sessionRefOrContainerName, content, extra = {}) {
    const text = String(content || '').trim();
    if (!text) {
        return;
    }
    appendWebSessionMessage(webHistoryDir, sessionRefOrContainerName, 'assistant', text, {
        mode: 'agent',
        streamTrace: true,
        ...extra
    });
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
    return `${WEB_AUTH_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${WEB_AUTH_TTL_SECONDS}`;
}

function getWebAuthClearCookie() {
    return `${WEB_AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function getDefaultWebConfigPath() {
    return path.join(os.homedir(), '.manyoyo', 'manyoyo.json');
}

function hasOwn(obj, key) {
    return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function toPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value;
}

function isSensitiveConfigKey(key) {
    const normalized = String(key || '').trim();
    return Boolean(normalized) && SENSITIVE_CONFIG_KEY_PATTERN.test(normalized);
}

function collectSensitiveConfigPaths(value, pathParts = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return [];
    }
    const result = [];
    Object.entries(toPlainObject(value)).forEach(([key, item]) => {
        const nextPath = pathParts.concat(key);
        if (isSensitiveConfigKey(key)) {
            result.push(nextPath);
            return;
        }
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            result.push(...collectSensitiveConfigPaths(item, nextPath));
        }
    });
    return result;
}

function collectSensitivePlaceholderPaths(value, pathParts = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return [];
    }
    const result = [];
    Object.entries(toPlainObject(value)).forEach(([key, item]) => {
        const nextPath = pathParts.concat(key);
        if (isSensitiveConfigKey(key)) {
            if (item === WEB_CONFIG_KEEP_SECRET_PLACEHOLDER) {
                result.push(nextPath);
            }
            return;
        }
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            result.push(...collectSensitivePlaceholderPaths(item, nextPath));
        }
    });
    return result;
}

function buildConfigPathLabel(pathParts) {
    return (Array.isArray(pathParts) ? pathParts : []).join('.');
}

function maskWebConfigRaw(raw, parsed) {
    const text = String(raw || '');
    const replacements = collectSensitiveConfigPaths(parsed).map(pathParts => {
        const range = findValueRangeByPath(text, pathParts);
        if (!range) {
            throw new Error(`敏感字段定位失败: ${buildConfigPathLabel(pathParts)}`);
        }
        return {
            start: range.start,
            end: range.end,
            text: JSON.stringify(WEB_CONFIG_KEEP_SECRET_PLACEHOLDER)
        };
    });
    return applyTextReplacements(text, replacements);
}

function parseConfigRawObject(raw) {
    const parsed = JSON5.parse(String(raw || ''));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('配置根节点必须是对象(map)');
    }
    return toPlainObject(parsed);
}

function restoreWebConfigSecrets(raw, snapshot) {
    const text = String(raw || '');
    if (!text.includes(WEB_CONFIG_KEEP_SECRET_PLACEHOLDER)) {
        return text;
    }
    if (!snapshot || snapshot.parseError) {
        throw new Error('当前配置存在解析错误，无法回填敏感值');
    }

    const editedConfig = parseConfigRawObject(text);
    const placeholderPaths = collectSensitivePlaceholderPaths(editedConfig);
    if (!placeholderPaths.length) {
        return text;
    }

    const currentRaw = String(snapshot.raw || '');
    const replacements = placeholderPaths.map(pathParts => {
        const editedRange = findValueRangeByPath(text, pathParts);
        const currentRange = findValueRangeByPath(currentRaw, pathParts);
        if (!editedRange) {
            throw new Error(`敏感字段定位失败: ${buildConfigPathLabel(pathParts)}`);
        }
        if (!currentRange) {
            throw new Error(`敏感字段缺少可保留的旧值: ${buildConfigPathLabel(pathParts)}`);
        }
        return {
            start: editedRange.start,
            end: editedRange.end,
            text: currentRaw.slice(currentRange.start, currentRange.end)
        };
    });

    return applyTextReplacements(text, replacements);
}

function redactConfigValue(value) {
    if (Array.isArray(value)) {
        return value.map(item => redactConfigValue(item));
    }
    if (!value || typeof value !== 'object') {
        return REDACTED_CONFIG_VALUE;
    }
    return redactConfigObject(value);
}

function redactConfigObject(value) {
    if (Array.isArray(value)) {
        return value.map(item => redactConfigValue(item));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    const result = {};
    Object.entries(toPlainObject(value)).forEach(([key, item]) => {
        if (isSensitiveConfigKey(key)) {
            result[key] = redactConfigValue(item);
            return;
        }
        if (Array.isArray(item)) {
            result[key] = item.map(entry => redactConfigValue(entry));
            return;
        }
        if (item && typeof item === 'object') {
            result[key] = redactConfigObject(item);
            return;
        }
        result[key] = item;
    });
    return result;
}

function buildSafeWebConfigSnapshot(snapshot, ctx) {
    const parsed = snapshot && snapshot.parseError ? {} : toPlainObject(snapshot && snapshot.parsed);
    let raw = '';
    let editable = false;
    let notice = 'Web 端显示原文 JSON5；敏感值以 ***HIDDEN_SECRET*** 占位，保存时会保留原值。';
    if (snapshot && !snapshot.parseError) {
        try {
            raw = maskWebConfigRaw(snapshot.raw || '', parsed);
            editable = true;
        } catch (e) {
            raw = '';
            editable = false;
            notice = '当前配置无法安全脱敏显示，请在本地 manyoyo.json 中维护。';
        }
    } else if (snapshot && snapshot.parseError) {
        notice = '当前配置解析失败，Web 端暂不提供安全编辑；请先在本地修复 manyoyo.json。';
    }
    return {
        path: snapshot && snapshot.path ? snapshot.path : path.resolve(getDefaultWebConfigPath()),
        raw,
        parsed: redactConfigObject(parsed),
        defaults: redactConfigObject(buildConfigDefaults(ctx, parsed)),
        parseError: snapshot && snapshot.parseError ? snapshot.parseError : null,
        editable,
        notice
    };
}

function pickFirstString() {
    for (let i = 0; i < arguments.length; i += 1) {
        const value = arguments[i];
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed) {
                return trimmed;
            }
        }
    }
    return '';
}

function resolveNowTemplate(value, formatDate) {
    if (typeof value !== 'string') {
        return value;
    }
    const nowText = typeof formatDate === 'function' ? formatDate() : '';
    return value.replace(/\{now\}|\$\{now\}/g, nowText);
}

function validateContainerNameStrict(containerName) {
    if (!SAFE_CONTAINER_NAME_PATTERN.test(containerName)) {
        throw new Error(`containerName 非法: ${containerName}`);
    }
}

function validateImageVersionStrict(imageVersion) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(imageVersion)) {
        throw new Error(`imageVersion 非法: ${imageVersion}`);
    }
    if (!IMAGE_VERSION_TAG_PATTERN.test(imageVersion)) {
        throw new Error(`imageVersion 格式必须为 <x.y.z-后缀>，例如 1.7.4-common。当前值: ${imageVersion}`);
    }
}

function validateWebHostPath(hostPath) {
    if (typeof hostPath !== 'string' || !hostPath.trim()) {
        throw new Error('hostPath 不能为空');
    }
    if (!fs.existsSync(hostPath)) {
        throw new Error(`宿主机路径不存在: ${hostPath}`);
    }
    const realHostPath = fs.realpathSync(hostPath);
    const homeDir = process.env.HOME || os.homedir() || '/home';
    if (realHostPath === '/' || realHostPath === '/home' || realHostPath === homeDir) {
        throw new Error('不允许挂载根目录或home目录。');
    }
}

function normalizeEnvMap(envConfig, sourceLabel) {
    if (envConfig === undefined || envConfig === null) {
        return {};
    }
    if (typeof envConfig !== 'object' || Array.isArray(envConfig)) {
        throw new Error(`${sourceLabel} 必须是对象(map)`);
    }
    const result = {};
    for (const [key, rawValue] of Object.entries(envConfig)) {
        if (rawValue !== null && !['string', 'number', 'boolean'].includes(typeof rawValue)) {
            throw new Error(`${sourceLabel}.${key} 必须是 string/number/boolean/null`);
        }
        const parsed = parseEnvEntry(`${key}=${rawValue === null ? '' : String(rawValue)}`);
        result[parsed.key] = parsed.value;
    }
    return result;
}

function normalizeCliEnvMap(envList) {
    const result = {};
    for (const envText of (envList || [])) {
        const parsed = parseEnvEntry(envText);
        result[parsed.key] = parsed.value;
    }
    return result;
}

function normalizeStringArray(value, sourceLabel) {
    if (value === undefined || value === null) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error(`${sourceLabel} 必须是数组`);
    }
    return value
        .map(item => String(item || '').trim())
        .filter(Boolean);
}

function parseEnvFileToArgs(filePath) {
    const resolvedPath = expandHomeAliasPath(filePath);
    if (!path.isAbsolute(resolvedPath)) {
        throw new Error(`envFile 仅支持绝对路径: ${filePath}`);
    }
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`未找到环境文件: ${resolvedPath}`);
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const args = [];
    const lines = content.split('\n');

    for (let line of lines) {
        const match = line.match(/^(?:export\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/);
        if (!match) {
            continue;
        }

        const key = match[1];
        let value = match[2].trim();
        if (/[\r\n\0]/.test(value)) continue;
        if (/[\$\(\)\`\|\&\*\{\};<>]/.test(value)) continue;
        if (/^\(/.test(value)) continue;

        if (/^"(.*)"$/.test(value)) {
            value = value.slice(1, -1);
        } else if (/^'(.*)'$/.test(value)) {
            value = value.slice(1, -1);
        }
        args.push('--env', `${key}=${value}`);
    }

    return args;
}

function resolveContainerModeArgs(mode) {
    const modeAliasMap = {
        common: 'common',
        'docker-in-docker': 'dind',
        dind: 'dind',
        d: 'dind',
        'mount-docker-socket': 'sock',
        sock: 'sock',
        s: 'sock'
    };
    const normalized = modeAliasMap[String(mode || '').trim().toLowerCase()];
    if (!normalized) {
        throw new Error(`未知 containerMode: ${mode}`);
    }
    if (normalized === 'common') {
        return { mode: 'common', args: [] };
    }
    if (normalized === 'dind') {
        return { mode: 'dind', args: ['--privileged'] };
    }
    return {
        mode: 'sock',
        args: [
            '--privileged',
            '--volume', '/var/run/docker.sock:/var/run/docker.sock',
            '--env', 'DOCKER_HOST=unix:///var/run/docker.sock',
            '--env', 'CONTAINER_HOST=unix:///var/run/docker.sock'
        ]
    };
}

function resolveYoloCommand(yolo) {
    const key = String(yolo || '').trim().toLowerCase();
    if (!key) {
        return '';
    }
    const mapped = YOLO_COMMAND_MAP[key];
    if (!mapped) {
        throw new Error(`未知 yolo 值: ${yolo}`);
    }
    return mapped;
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

function validateWebConfigShape(configObject) {
    const config = toPlainObject(configObject);

    if (hasOwn(config, 'containerName') && String(config.containerName || '').trim()) {
        validateContainerNameStrict(resolveNowTemplate(String(config.containerName), () => '0101-0000'));
    }
    if (hasOwn(config, 'imageVersion') && String(config.imageVersion || '').trim()) {
        validateImageVersionStrict(String(config.imageVersion).trim());
    }
    if (hasOwn(config, 'env')) {
        normalizeEnvMap(config.env, 'env');
    }
    if (hasOwn(config, 'envFile')) {
        normalizeStringArray(config.envFile, 'envFile');
    }
    if (hasOwn(config, 'volumes')) {
        normalizeStringArray(config.volumes, 'volumes');
    }
    if (hasOwn(config, 'ports')) {
        normalizeStringArray(config.ports, 'ports');
    }
    if (hasOwn(config, 'agentPromptCommand')) {
        normalizeAgentPromptCommandTemplate(config.agentPromptCommand, 'agentPromptCommand');
    }
    if (hasOwn(config, 'runs')) {
        const runs = config.runs;
        if (runs !== undefined && (typeof runs !== 'object' || runs === null || Array.isArray(runs))) {
            throw new Error('runs 必须是对象(map)');
        }
        Object.entries(toPlainObject(runs)).forEach(([runName, runConfig]) => {
            const normalizedRun = toPlainObject(runConfig);
            if (hasOwn(normalizedRun, 'agentPromptCommand')) {
                normalizeAgentPromptCommandTemplate(normalizedRun.agentPromptCommand, `runs.${runName}.agentPromptCommand`);
            }
        });
    }
}

function readWebConfigSnapshot(configPath) {
    const resolvedPath = path.resolve(configPath || getDefaultWebConfigPath());
    if (!fs.existsSync(resolvedPath)) {
        return {
            path: resolvedPath,
            raw: DEFAULT_WEB_CONFIG_TEMPLATE,
            parsed: {},
            parseError: null,
            exists: false
        };
    }

    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    if (!String(raw || '').trim()) {
        return {
            path: resolvedPath,
            raw,
            parsed: {},
            parseError: null,
            exists: true
        };
    }

    try {
        const parsed = JSON5.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('配置根节点必须是对象(map)');
        }
        const config = toPlainObject(parsed);
        validateWebConfigShape(config);
        return {
            path: resolvedPath,
            raw,
            parsed: config,
            parseError: null,
            exists: true
        };
    } catch (e) {
        return {
            path: resolvedPath,
            raw,
            parsed: {},
            parseError: e && e.message ? e.message : '配置解析失败',
            exists: true
        };
    }
}

function parseAndValidateConfigRaw(raw) {
    const config = parseConfigRawObject(raw);
    validateWebConfigShape(config);
    return config;
}

function buildConfigDefaults(ctx, config) {
    const parsed = toPlainObject(config);
    const defaults = {
        containerName: hasOwn(parsed, 'containerName') ? String(parsed.containerName || '') : '',
        hostPath: pickFirstString(parsed.hostPath, ctx.hostPath),
        containerPath: pickFirstString(parsed.containerPath, ctx.containerPath),
        imageName: pickFirstString(parsed.imageName, ctx.imageName),
        imageVersion: pickFirstString(parsed.imageVersion, ctx.imageVersion),
        containerMode: hasOwn(parsed, 'containerMode') ? String(parsed.containerMode || '') : '',
        shellPrefix: hasOwn(parsed, 'shellPrefix') ? String(parsed.shellPrefix || '') : '',
        shell: hasOwn(parsed, 'shell') ? String(parsed.shell || '') : '',
        shellSuffix: hasOwn(parsed, 'shellSuffix') ? String(parsed.shellSuffix || '') : '',
        agentPromptCommand: '',
        yolo: hasOwn(parsed, 'yolo') ? String(parsed.yolo || '') : '',
        env: {},
        envFile: [],
        volumes: [],
        ports: []
    };

    try {
        defaults.env = normalizeEnvMap(parsed.env, 'env');
    } catch (e) {
        defaults.env = {};
    }
    try {
        defaults.envFile = normalizeStringArray(parsed.envFile, 'envFile');
    } catch (e) {
        defaults.envFile = [];
    }
    try {
        defaults.volumes = normalizeStringArray(parsed.volumes, 'volumes');
    } catch (e) {
        defaults.volumes = [];
    }
    try {
        defaults.ports = normalizeStringArray(parsed.ports, 'ports');
    } catch (e) {
        defaults.ports = [];
    }
    try {
        defaults.agentPromptCommand = normalizeAgentPromptCommandTemplate(parsed.agentPromptCommand, 'agentPromptCommand');
    } catch (e) {
        defaults.agentPromptCommand = '';
    }

    return defaults;
}

function buildStaticContainerRuntime(ctx, containerName) {
    return {
        containerName,
        hostPath: ctx.hostPath,
        containerPath: ctx.containerPath,
        imageName: ctx.imageName,
        imageVersion: ctx.imageVersion,
        contModeArgs: Array.isArray(ctx.contModeArgs) ? ctx.contModeArgs.slice() : [],
        containerExtraArgs: Array.isArray(ctx.containerExtraArgs) ? ctx.containerExtraArgs.slice() : [],
        containerEnvs: Array.isArray(ctx.containerEnvs) ? ctx.containerEnvs.slice() : [],
        containerVolumes: Array.isArray(ctx.containerVolumes) ? ctx.containerVolumes.slice() : [],
        containerPorts: Array.isArray(ctx.containerPorts) ? ctx.containerPorts.slice() : [],
        defaultCommand: buildDefaultCommand(ctx.execCommandPrefix, ctx.execCommand, ctx.execCommandSuffix) || '/bin/bash'
    };
}

function buildCreateRuntime(ctx, state, payload) {
    const body = toPlainObject(payload);
    const requestOptions = toPlainObject(body.createOptions);
    const snapshot = readWebConfigSnapshot(state.webConfigPath);
    const config = snapshot.parseError ? {} : snapshot.parsed;
    const runs = toPlainObject(config.runs);
    const runName = pickFirstString(body.run);
    const runConfig = runName && hasOwn(runs, runName) ? toPlainObject(runs[runName]) : {};

    const hasRequestEnv = hasOwn(requestOptions, 'env');
    const hasRequestEnvFile = hasOwn(requestOptions, 'envFile');
    const hasRequestVolumes = hasOwn(requestOptions, 'volumes');
    const hasRequestPorts = hasOwn(requestOptions, 'ports');
    const hasConfigEnv = hasOwn(config, 'env');
    const hasConfigEnvFile = hasOwn(config, 'envFile');
    const hasConfigVolumes = hasOwn(config, 'volumes');
    const hasConfigPorts = hasOwn(config, 'ports');

    const requestEnvMap = hasRequestEnv ? normalizeEnvMap(requestOptions.env, 'createOptions.env') : {};
    const requestEnvList = Object.entries(requestEnvMap).map(([key, value]) => `${key}=${value}`);
    const requestEnvFileList = hasRequestEnvFile ? normalizeStringArray(requestOptions.envFile, 'createOptions.envFile') : [];
    const requestVolumeList = hasRequestVolumes ? normalizeStringArray(requestOptions.volumes, 'createOptions.volumes') : [];
    const requestPortList = hasRequestPorts ? normalizeStringArray(requestOptions.ports, 'createOptions.ports') : [];
    const requestName = pickFirstString(requestOptions.containerName, body.name);

    const resolvedBase = resolveRuntimeConfig({
        cliOptions: {
            hostPath: requestOptions.hostPath,
            contName: requestName,
            contPath: requestOptions.containerPath,
            imageName: requestOptions.imageName,
            imageVer: requestOptions.imageVersion,
            env: requestEnvList,
            envFile: requestEnvFileList,
            volume: requestVolumeList,
            port: requestPortList
        },
        globalConfig: config,
        runConfig,
        globalFirstConfig: {},
        runFirstConfig: {},
        defaults: {
            hostPath: ctx.hostPath,
            containerName: `my-${ctx.formatDate()}`,
            containerPath: ctx.containerPath,
            imageName: ctx.imageName,
            imageVersion: ctx.imageVersion
        },
        envVars: {},
        argv: [],
        isServerMode: false,
        isServerStopMode: false,
        pickConfigValue: pickFirstString,
        resolveContainerNameTemplate: value => resolveNowTemplate(value, ctx.formatDate),
        normalizeCommandSuffix: value => {
            const text = String(value || '').trim();
            return text ? ` ${text}` : '';
        },
        normalizeJsonEnvMap: normalizeEnvMap,
        normalizeCliEnvMap,
        mergeArrayConfig: (globalValue, runValue, cliValue) => [...(globalValue || []), ...(runValue || []), ...(cliValue || [])],
        normalizeVolume,
        parseServerListen: () => ({ host: '', port: 0 })
    });

    const containerName = resolvedBase.containerName;
    validateContainerNameStrict(containerName);

    const hostPath = resolvedBase.hostPath;
    if (typeof ctx.validateHostPath === 'function') {
        ctx.validateHostPath(hostPath);
    } else {
        validateWebHostPath(hostPath);
    }

    const containerPath = resolvedBase.containerPath || hostPath;
    const imageName = resolvedBase.imageName;
    const imageVersion = resolvedBase.imageVersion;

    if (!/^[A-Za-z0-9][A-Za-z0-9._/:-]*$/.test(imageName)) {
        throw new Error(`imageName 非法: ${imageName}`);
    }
    validateImageVersionStrict(imageVersion);

    let contModeArgs = Array.isArray(ctx.contModeArgs) ? ctx.contModeArgs.slice() : [];
    let containerMode = '';
    const modeValue = pickFirstString(requestOptions.containerMode, runConfig.containerMode, config.containerMode);
    if (modeValue) {
        const mode = resolveContainerModeArgs(modeValue);
        containerMode = mode.mode;
        contModeArgs = mode.args;
    }

    const shellPrefix = hasOwn(requestOptions, 'shellPrefix')
        ? String(requestOptions.shellPrefix || '')
        : (hasOwn(runConfig, 'shellPrefix')
            ? String(runConfig.shellPrefix || '')
            : (hasOwn(config, 'shellPrefix') ? String(config.shellPrefix || '') : String(ctx.execCommandPrefix || '')));
    let shell = hasOwn(requestOptions, 'shell')
        ? String(requestOptions.shell || '')
        : (hasOwn(runConfig, 'shell')
            ? String(runConfig.shell || '')
            : (hasOwn(config, 'shell') ? String(config.shell || '') : String(ctx.execCommand || '')));
    const shellSuffix = hasOwn(requestOptions, 'shellSuffix')
        ? String(requestOptions.shellSuffix || '')
        : (hasOwn(runConfig, 'shellSuffix')
            ? String(runConfig.shellSuffix || '')
            : (hasOwn(config, 'shellSuffix') ? String(config.shellSuffix || '') : String(ctx.execCommandSuffix || '')));
    const yolo = hasOwn(requestOptions, 'yolo')
        ? String(requestOptions.yolo || '')
        : (hasOwn(runConfig, 'yolo')
            ? String(runConfig.yolo || '')
            : (hasOwn(config, 'yolo') ? String(config.yolo || '') : ''));
    const yoloCommand = resolveYoloCommand(yolo);
    if (yoloCommand) {
        shell = yoloCommand;
    }

    const configuredAgentPromptCommand = normalizeAgentPromptCommandTemplate(
        hasOwn(requestOptions, 'agentPromptCommand')
            ? requestOptions.agentPromptCommand
            : (hasOwn(runConfig, 'agentPromptCommand') ? runConfig.agentPromptCommand : config.agentPromptCommand),
        'agentPromptCommand'
    );
    const inferredAgentPromptCommand = normalizeAgentPromptCommandTemplate(
        resolveAgentPromptCommandTemplate(buildDefaultCommand(shellPrefix, shell, shellSuffix)),
        'agentPromptCommand'
    );
    const agentPromptCommand = configuredAgentPromptCommand || inferredAgentPromptCommand;
    const agentProgram = resolveAgentProgram(agentPromptCommand);
    const resumeSupported = Boolean(buildAgentResumeCommand(agentProgram));

    let containerEnvs = Array.isArray(ctx.containerEnvs) ? ctx.containerEnvs.slice() : [];
    const hasRunEnv = hasOwn(runConfig, 'env');
    const hasRunEnvFile = hasOwn(runConfig, 'envFile');
    if (hasRequestEnv || hasRequestEnvFile || hasRunEnv || hasRunEnvFile || hasConfigEnv || hasConfigEnvFile) {
        const envArgs = [];
        Object.entries(resolvedBase.env).forEach(([key, value]) => {
            const parsed = parseEnvEntry(`${key}=${value}`);
            envArgs.push('--env', `${parsed.key}=${parsed.value}`);
        });

        const envFileArgs = [];
        resolvedBase.envFile.forEach(filePath => {
            envFileArgs.push(...parseEnvFileToArgs(filePath));
        });

        containerEnvs = [...envArgs, ...envFileArgs];
    }

    let containerVolumes = Array.isArray(ctx.containerVolumes) ? ctx.containerVolumes.slice() : [];
    const hasRunVolumes = hasOwn(runConfig, 'volumes');
    if (hasRequestVolumes || hasRunVolumes || hasConfigVolumes) {
        containerVolumes = [];
        resolvedBase.volumes.forEach(volume => {
            containerVolumes.push('--volume', normalizeVolume(volume));
        });
    }

    let containerPorts = Array.isArray(ctx.containerPorts) ? ctx.containerPorts.slice() : [];
    const hasRunPorts = hasOwn(runConfig, 'ports');
    if (hasRequestPorts || hasRunPorts || hasConfigPorts) {
        containerPorts = [];
        resolvedBase.ports.forEach(port => {
            containerPorts.push('--publish', port);
        });
    }

    return {
        containerName,
        hostPath,
        containerPath,
        imageName,
        imageVersion,
        contModeArgs,
        containerExtraArgs: Array.isArray(ctx.containerExtraArgs) ? ctx.containerExtraArgs.slice() : [],
        containerEnvs,
        containerVolumes,
        containerPorts,
        agentPromptCommand,
        defaultCommand: buildDefaultCommand(shellPrefix, shell, shellSuffix) || '/bin/bash',
        applied: {
            containerName,
            hostPath,
            containerPath,
            imageName,
            imageVersion,
            containerMode,
            shellPrefix: shellPrefix || '',
            shell: shell || '',
            shellSuffix: shellSuffix || '',
            defaultCommand: buildDefaultCommand(shellPrefix, shell, shellSuffix) || '/bin/bash',
            agentEnabled: isAgentPromptCommandEnabled(agentPromptCommand),
            agentProgram: agentProgram || '',
            resumeSupported,
            yolo: yolo || '',
            envCount: Math.floor(containerEnvs.length / 2),
            volumeCount: Math.floor(containerVolumes.length / 2),
            portCount: Math.floor(containerPorts.length / 2)
        }
    };
}

// Estimate container start time from "Up X hours/minutes/seconds" status string.
// Uses relative time to avoid Podman Machine VM clock drift issues.
function estimateStartTimeFromStatus(status) {
    if (!status) return null;
    const s = status.trim().toLowerCase();
    if (!s.startsWith('up ')) return null;
    const rest = s.slice(3).trim();
    const now = Date.now();

    const units = [
        { re: /^(\d+)\s+week/, ms: 7 * 24 * 3600 * 1000 },
        { re: /^(\d+)\s+day/, ms: 24 * 3600 * 1000 },
        { re: /^(\d+)\s+hour/, ms: 3600 * 1000 },
        { re: /^(\d+)\s+min/, ms: 60 * 1000 },
        { re: /^(\d+)\s+second/, ms: 1000 },
    ];
    for (const { re, ms } of units) {
        const m = rest.match(re);
        if (m) return new Date(now - parseInt(m[1]) * ms).toISOString();
    }
    // "about a minute", "a minute", "about an hour", "an hour", "less than a second"
    if (/\bminute\b/.test(rest)) return new Date(now - 60 * 1000).toISOString();
    if (/\bhour\b/.test(rest)) return new Date(now - 3600 * 1000).toISOString();
    if (/\bsecond\b/.test(rest)) return new Date(now).toISOString();
    return null;
}

function listWebManyoyoContainers(ctx) {
    const output = ctx.dockerExecArgs(
        ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}'],
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
        const imageName = image || '';
        if (!imageName.includes('manyoyo') && !name.startsWith('manyoyo-') && !name.startsWith('my-')) {
            return;
        }
        let defaultCommand = '';
        try {
            defaultCommand = String(
                ctx.dockerExecArgs(
                    ['inspect', '-f', '{{index .Config.Labels "manyoyo.default_cmd"}}', name],
                    { ignoreError: true }
                ) || ''
            ).trim();
        } catch (e) {
            defaultCommand = '';
        }
        map[name] = {
            name,
            status: status || 'unknown',
            image: imageName,
            createdAt: estimateStartTimeFromStatus(status),
            defaultCommand
        };
    });

    return map;
}

async function ensureWebContainer(ctx, state, containerInput, messageSessionRef = null) {
    const runtime = typeof containerInput === 'string'
        ? buildStaticContainerRuntime(ctx, containerInput)
        : containerInput;

    if (!runtime || !runtime.containerName) {
        throw new Error('containerName 不能为空');
    }

    if (!ctx.containerExists(runtime.containerName)) {
        const args = buildContainerRunArgs({
            containerName: runtime.containerName,
            hostPath: runtime.hostPath,
            containerPath: runtime.containerPath,
            imageName: runtime.imageName,
            imageVersion: runtime.imageVersion,
            contModeArgs: runtime.contModeArgs,
            containerExtraArgs: runtime.containerExtraArgs,
            containerEnvs: runtime.containerEnvs,
            containerVolumes: runtime.containerVolumes,
            containerPorts: runtime.containerPorts,
            defaultCommand: runtime.defaultCommand
        });

        try {
            ctx.dockerExecArgs(args, { stdio: 'pipe' });
        } catch (e) {
            ctx.showImagePullHint(e);
            throw e;
        }

        await ctx.waitForContainerReady(runtime.containerName);
        appendWebSessionMessage(
            state.webHistoryDir,
            messageSessionRef || runtime.containerName,
            'system',
            `容器 ${runtime.containerName} 已创建并启动。`
        );
        return;
    }

    const status = ctx.getContainerStatus(runtime.containerName);
    if (status !== 'running') {
        ctx.dockerExecArgs(['start', runtime.containerName], { stdio: 'pipe' });
        appendWebSessionMessage(
            state.webHistoryDir,
            messageSessionRef || runtime.containerName,
            'system',
            `容器 ${runtime.containerName} 已启动。`
        );
    }
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

function sendNdjson(res, payload) {
    res.write(`${JSON.stringify(payload)}\n`);
}

function stopWebAgentRun(state, containerName) {
    const runState = state.agentRuns.get(containerName);
    if (!runState || !runState.process || runState.process.killed) {
        return false;
    }
    runState.stopping = true;
    try {
        runState.process.kill('SIGTERM');
    } catch (e) {
        return false;
    }
    return true;
}

function sendHtml(res, statusCode, html, extraHeaders = {}) {
    res.writeHead(statusCode, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders
    });
    res.end(html);
}

function sendRedirect(res, statusCode, location, extraHeaders = {}) {
    res.writeHead(statusCode, {
        Location: location,
        'Cache-Control': 'no-store',
        ...extraHeaders
    });
    res.end('');
}

function decodeSessionName(encoded) {
    try {
        return decodeURIComponent(encoded);
    } catch (e) {
        return encoded;
    }
}

function getValidSessionRef(ctx, res, encodedName) {
    const parsed = parseWebSessionKey(decodeSessionName(encodedName));
    if (!ctx.isValidContainerName(parsed.containerName)) {
        sendJson(res, 400, { error: `containerName 非法: ${parsed.containerName}` });
        return null;
    }
    if (!SAFE_CONTAINER_NAME_PATTERN.test(parsed.agentId)) {
        sendJson(res, 400, { error: `agentId 非法: ${parsed.agentId}` });
        return null;
    }
    return parsed;
}

function buildSessionSummary(ctx, state, containerMap, sessionRef) {
    const containerName = sessionRef && sessionRef.containerName ? sessionRef.containerName : '';
    const agentId = sessionRef && sessionRef.agentId ? sessionRef.agentId : WEB_DEFAULT_AGENT_ID;
    const history = loadWebSessionHistory(state.webHistoryDir, containerName);
    const agentSession = getWebAgentSession(history, agentId)
        || (agentId === WEB_DEFAULT_AGENT_ID ? createEmptyWebAgentSession(WEB_DEFAULT_AGENT_ID) : null);
    if (!agentSession) {
        return null;
    }
    const latestMessage = agentSession.messages.length ? agentSession.messages[agentSession.messages.length - 1] : null;
    const containerInfo = containerMap[containerName] || {};
    const effectiveAgentPromptCommand = resolveEffectiveAgentPromptCommandForSession(history, agentId, containerInfo.defaultCommand);
    const agentMeta = getAgentRuntimeMeta(effectiveAgentPromptCommand);
    const effectiveAgentProgram = agentMeta.agentProgram || resolveAgentProgram(effectiveAgentPromptCommand);
    const effectiveResumeSupported = agentMeta.resumeSupported || Boolean(buildAgentResumeCommand(effectiveAgentProgram));
    const applied = history.applied && typeof history.applied === 'object' && !Array.isArray(history.applied)
        ? history.applied
        : buildSessionFallbackApplied(ctx, state, containerName, history, {
            status: containerInfo.status || 'history',
            defaultCommand: containerInfo.defaultCommand || ''
        });
    const updatedAt = agentSession.updatedAt || history.updatedAt || (latestMessage && latestMessage.timestamp) || containerInfo.createdAt || null;
    return {
        name: buildWebSessionKey(containerName, agentId),
        containerName,
        agentId,
        agentName: agentSession.agentName,
        status: containerInfo.status || 'history',
        image: containerInfo.image || '',
        updatedAt,
        messageCount: agentSession.messages.length,
        agentEnabled: isAgentPromptCommandEnabled(effectiveAgentPromptCommand),
        agentProgram: effectiveAgentProgram || '',
        resumeSupported: effectiveResumeSupported,
        hostPath: applied.hostPath || '',
        containerPath: applied.containerPath || ''
    };
}

function buildSessionFallbackApplied(ctx, state, name, history, summary) {
    const snapshot = readWebConfigSnapshot(state.webConfigPath);
    const defaults = buildConfigDefaults(ctx, snapshot.parseError ? {} : snapshot.parsed);
    const configuredDefaultCommand = buildDefaultCommand(
        defaults.shellPrefix,
        defaults.shell,
        defaults.shellSuffix
    ) || buildStaticContainerRuntime(ctx, name).defaultCommand;
    const defaultCommand = pickFirstString(
        summary && summary.defaultCommand,
        configuredDefaultCommand
    );
    const effectiveAgentPromptCommand = resolveEffectiveSessionAgentPromptCommand(history, defaultCommand);
    const effectiveAgentProgram = resolveAgentProgram(effectiveAgentPromptCommand) || '';
    const effectiveResumeSupported = Boolean(buildAgentResumeCommand(effectiveAgentProgram));

    return {
        containerName: name,
        hostPath: defaults.hostPath || ctx.hostPath || '',
        containerPath: defaults.containerPath || ctx.containerPath || '',
        imageName: defaults.imageName || ctx.imageName || '',
        imageVersion: defaults.imageVersion || ctx.imageVersion || '',
        containerMode: defaults.containerMode || '',
        shellPrefix: defaults.shellPrefix || '',
        shell: defaults.shell || '',
        shellSuffix: defaults.shellSuffix || '',
        defaultCommand,
        agentEnabled: isAgentPromptCommandEnabled(effectiveAgentPromptCommand),
        agentProgram: effectiveAgentProgram,
        resumeSupported: effectiveResumeSupported,
        yolo: defaults.yolo || '',
        envCount: Object.keys(defaults.env || {}).length,
        volumeCount: Array.isArray(defaults.volumes) ? defaults.volumes.length : 0,
        portCount: Array.isArray(defaults.ports) ? defaults.ports.length : 0,
        status: summary.status || 'history'
    };
}

function buildSessionDetail(ctx, state, containerMap, name) {
    const sessionRef = typeof name === 'string' ? parseWebSessionKey(name) : name;
    const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
    const containerInfo = containerMap[sessionRef.containerName] || {};
    const normalizedTemplate = resolveEffectiveAgentPromptCommandForSession(
        history,
        sessionRef.agentId,
        containerInfo.defaultCommand
    );
    const summary = buildSessionSummary(ctx, state, containerMap, sessionRef);
    const agentSession = getWebAgentSession(history, sessionRef.agentId)
        || (sessionRef.agentId === WEB_DEFAULT_AGENT_ID ? createEmptyWebAgentSession(WEB_DEFAULT_AGENT_ID) : null);
    const latestMessage = agentSession && agentSession.messages.length
        ? agentSession.messages[agentSession.messages.length - 1]
        : null;
    const applied = history.applied && typeof history.applied === 'object' && !Array.isArray(history.applied)
        ? history.applied
        : buildSessionFallbackApplied(ctx, state, sessionRef.containerName, history, summary || {});

    if (!summary || !agentSession) {
        return null;
    }

    return {
        ...summary,
        agentName: agentSession.agentName,
        latestRole: latestMessage && latestMessage.role ? String(latestMessage.role) : '',
        latestTimestamp: latestMessage && latestMessage.timestamp ? latestMessage.timestamp : summary.updatedAt,
        agentPromptCommand: normalizedTemplate || '',
        containerAgentPromptCommand: typeof history.agentPromptCommand === 'string'
            ? normalizeAgentPromptCommandTemplate(history.agentPromptCommand, 'agentPromptCommand')
            : '',
        agentPromptCommandOverride: agentSession && typeof agentSession.agentPromptCommand === 'string'
            ? normalizeAgentPromptCommandTemplate(agentSession.agentPromptCommand, `agents.${sessionRef.agentId}.agentPromptCommand`)
            : '',
        inferredAgentPromptCommand: deriveAgentPromptCommandFromDefaultCommand(containerInfo.defaultCommand),
        agentPromptSource: getEffectiveAgentPromptCommandSource(history, sessionRef.agentId, containerInfo.defaultCommand),
        agentProgram: summary.agentProgram || '',
        resumeSupported: summary.resumeSupported === true,
        lastResumeAt: agentSession.lastResumeAt || null,
        lastResumeOk: typeof agentSession.lastResumeOk === 'boolean' ? agentSession.lastResumeOk : null,
        lastResumeError: agentSession.lastResumeError || '',
        applied
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
    if (name === 'marked.min.js') {
        return MARKED_MIN_JS_FILE && fs.existsSync(MARKED_MIN_JS_FILE) ? MARKED_MIN_JS_FILE : null;
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

async function handleWebApi(req, res, pathname, ctx, state) {
    // [P2-03] 对非只读请求校验自定义头，防止 CSRF 攻击
    // 跨站请求无法设置自定义头（浏览器同源策略），合法前端请求统一携带此头
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
            sendJson(res, 403, { error: 'CSRF check failed' });
            return true;
        }
    }

    const {
        withSessionRef,
        withJsonBody,
        withSessionJsonBody,
        getRequiredBodyText,
        prepareAgentRequest
    } = createApiRouteHelpers({
        req,
        res,
        ctx,
        state,
        sendJson,
        readJsonBody,
        getValidSessionRef,
        prepareWebAgentExecution
    });

    const routes = [
        ...createSystemApiRoutes({
            req,
            res,
            ctx,
            state,
            fs,
            os,
            path,
            withJsonBody,
            sendJson,
            expandHomeAliasPath,
            readWebConfigSnapshot,
            buildSafeWebConfigSnapshot,
            restoreWebConfigSecrets,
            parseAndValidateConfigRaw,
            buildConfigDefaults
        }),
        ...createSessionApiRoutes({
            req,
            res,
            ctx,
            state,
            WEB_DEFAULT_AGENT_ID,
            withSessionRef,
            withJsonBody,
            withSessionJsonBody,
            getRequiredBodyText,
            prepareAgentRequest,
            sendJson,
            sendNdjson,
            buildCreateRuntime,
            ensureWebContainer,
            setWebSessionAgentPromptCommand,
            patchWebSessionHistory,
            listWebManyoyoContainers,
            listWebHistorySessionNames,
            loadWebSessionHistory,
            listWebAgentSessions,
            buildSessionSummary,
            createWebAgentSession,
            saveWebSessionHistory,
            buildWebSessionKey,
            getWebAgentSession,
            createEmptyWebAgentSession,
            buildSessionDetail,
            hasOwn,
            setWebAgentSessionPromptCommand,
            appendWebSessionMessage,
            execCommandInWebContainer,
            finalizeWebAgentExecution,
            execAgentInWebContainerStream,
            appendWebAgentTraceMessage,
            stopWebAgentRun,
            removeWebSessionHistory
        })
    ];
    return await runMatchedRoute(routes, req.method, pathname);
}

async function handleWebHttpRequest(req, res, pathname, ctx, state) {
    // 全局认证入口：除登录路由外，默认全部请求都要求认证
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

function handleWebUpgradeRequest(req, socket, head, wsServer, ctx, state, listenPort) {
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

    // [P1-03] Origin 校验，防止跨站 WebSocket 劫持（CSWSH）
    // 浏览器发起的 WebSocket 请求必须携带 Origin 头，非浏览器客户端（如 curl）不携带则放行
    const requestOrigin = req.headers.origin;
    if (requestOrigin) {
        const allowedOrigins = new Set();
        // 始终以请求的 Host 头构造允许来源，兼容 nginx 等反向代理场景
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
    if (!SAFE_CONTAINER_NAME_PATTERN.test(sessionRef.agentId)) {
        sendWebSocketUpgradeError(socket, 400, `agentId 非法: ${sessionRef.agentId}`);
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
        .catch(e => {
            sendWebSocketUpgradeError(socket, 500, e && e.message ? e.message : '终端创建失败');
        });
}

async function startWebServer(options) {
    const fallbackLogger = {
        info: () => {},
        warn: () => {},
        error: () => {}
    };
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
        containerExtraArgs: options.containerExtraArgs,
        containerEnvs: options.containerEnvs,
        containerVolumes: options.containerVolumes,
        containerPorts: options.containerPorts,
        validateHostPath: options.validateHostPath,
        formatDate: options.formatDate,
        isValidContainerName: options.isValidContainerName,
        containerExists: options.containerExists,
        getContainerStatus: options.getContainerStatus,
        waitForContainerReady: options.waitForContainerReady,
        dockerExecArgs: options.dockerExecArgs,
        showImagePullHint: options.showImagePullHint,
        removeContainer: options.removeContainer,
        logger: options.logger && typeof options.logger.info === 'function' ? options.logger : fallbackLogger,
        colors: options.colors || {
            GREEN: '',
            CYAN: '',
            YELLOW: '',
            NC: ''
        }
    };

    if (!ctx.authUser || !ctx.authPass) {
        throw new Error('Web 认证配置缺失，请设置 serve -U / serve -P');
    }

    const state = {
        webHistoryDir: options.webHistoryDir || path.join(os.homedir(), '.manyoyo', 'web-history'),
        webConfigPath: options.webConfigPath || getDefaultWebConfigPath(),
        authSessions: new Map(),
        terminalSessions: new Map(),
        agentRuns: new Map()
    };

    ensureWebHistoryDir(state.webHistoryDir);

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

    const server = http.createServer(async (req, res) => {
        try {
            const fallbackHost = `${formatUrlHost(ctx.serverHost)}:${ctx.serverPort}`;
            const url = new URL(req.url, `http://${req.headers.host || fallbackHost}`);
            const pathname = url.pathname;
            await handleWebHttpRequest(req, res, pathname, ctx, state);
        } catch (e) {
            ctx.logger.error('http request error', {
                method: req && req.method ? req.method : '',
                url: req && req.url ? req.url : '',
                message: e && e.message ? e.message : 'Server Error'
            });
            if ((req.url || '').startsWith('/api/')) {
                sendJson(res, 500, { error: e.message || 'Server Error' });
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
        handleWebUpgradeRequest(req, socket, head, wsServer, ctx, state, listenPort);
    });

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

    return {
        server,
        wsServer,
        host: ctx.serverHost,
        port: listenPort,
        close: () => new Promise(resolve => {
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
            } catch (e) {
                closeHttp();
            }
        })
    };
}

module.exports = {
    startWebServer
};
