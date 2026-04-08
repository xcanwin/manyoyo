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
const WEB_FILE_PREVIEW_MAX_BYTES = 512 * 1024;
const WEB_FILE_EDIT_MAX_BYTES = 2 * 1024 * 1024;
const WEB_AUTH_COOKIE_NAME = 'manyoyo_web_auth';
const WEB_AUTH_TTL_SECONDS = 12 * 60 * 60;
const WEB_SESSION_KEY_SEPARATOR = '~';
const WEB_DEFAULT_AGENT_ID = 'default';
const WEB_DEFAULT_AGENT_NAME = 'AGENT 1';
const WEB_CONFIG_KEEP_SECRET_PLACEHOLDER = '***HIDDEN_SECRET***';
const FRONTEND_DIR = path.join(__dirname, 'frontend');
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
const FILE_LANGUAGE_MAP = {
    '.cjs': 'javascript',
    '.css': 'css',
    '.htm': 'html',
    '.html': 'html',
    '.java': 'javascript',
    '.js': 'javascript',
    '.json': 'json',
    '.jsx': 'javascript',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.mjs': 'javascript',
    '.py': 'python',
    '.ts': 'javascript',
    '.tsx': 'javascript',
    '.yaml': 'yaml',
    '.yml': 'yaml'
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
        createdAt: null,
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
        createdAt: typeof source.createdAt === 'string' ? source.createdAt : null,
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

function getWebAgentCreationRank(agentId) {
    if (agentId === WEB_DEFAULT_AGENT_ID) {
        return 1;
    }
    const matched = String(agentId || '').match(/^agent-(\d+)$/);
    return matched ? (Number(matched[1]) || 0) : 0;
}

function getWebSessionCreatedTime(sessionSummary) {
    if (sessionSummary && sessionSummary.createdAt) {
        const time = new Date(sessionSummary.createdAt).getTime();
        if (Number.isFinite(time)) {
            return time;
        }
    }
    return 0;
}

function compareWebSessionCreatedDesc(a, b) {
    const timeA = getWebSessionCreatedTime(a);
    const timeB = getWebSessionCreatedTime(b);
    if (timeA !== timeB) {
        return timeB - timeA;
    }
    if (a && b && a.containerName === b.containerName) {
        const rankA = getWebAgentCreationRank(a.agentId);
        const rankB = getWebAgentCreationRank(b.agentId);
        if (rankA !== rankB) {
            return rankB - rankA;
        }
    }
    const updatedA = a && a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const updatedB = b && b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    if (updatedA !== updatedB) {
        return updatedB - updatedA;
    }
    return String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'zh-CN');
}

function createWebSessionMessageId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function appendWebSessionMessage(webHistoryDir, sessionRefOrContainerName, role, content, extra = {}) {
    const sessionRef = typeof sessionRefOrContainerName === 'string'
        ? { containerName: sessionRefOrContainerName, agentId: WEB_DEFAULT_AGENT_ID }
        : sessionRefOrContainerName;
    const history = loadWebSessionHistory(webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true });
    const timestamp = new Date().toISOString();
    const message = {
        id: createWebSessionMessageId(),
        role,
        content,
        timestamp,
        ...extra
    };
    if (!agentSession.createdAt) {
        agentSession.createdAt = timestamp;
    }
    agentSession.messages.push(message);

    if (agentSession.messages.length > WEB_HISTORY_MAX_MESSAGES) {
        agentSession.messages = agentSession.messages.slice(-WEB_HISTORY_MAX_MESSAGES);
    }

    agentSession.updatedAt = timestamp;
    history.updatedAt = timestamp;
    saveWebSessionHistory(webHistoryDir, sessionRef.containerName, history);
    return message;
}

function patchWebSessionMessage(webHistoryDir, sessionRefOrContainerName, messageId, patch) {
    const sessionRef = typeof sessionRefOrContainerName === 'string'
        ? { containerName: sessionRefOrContainerName, agentId: WEB_DEFAULT_AGENT_ID }
        : sessionRefOrContainerName;
    const targetId = String(messageId || '').trim();
    if (!targetId) {
        return null;
    }
    const history = loadWebSessionHistory(webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true });
    const nextPatch = patch && typeof patch === 'object' ? patch : {};
    const message = agentSession.messages.find(item => item && String(item.id || '') === targetId);
    if (!message) {
        return null;
    }
    Object.keys(nextPatch).forEach(key => {
        if (key === 'id') {
            return;
        }
        message[key] = nextPatch[key];
    });
    const timestamp = new Date().toISOString();
    agentSession.updatedAt = timestamp;
    history.updatedAt = timestamp;
    saveWebSessionHistory(webHistoryDir, sessionRef.containerName, history);
    return message;
}

function removeWebSessionMessage(webHistoryDir, sessionRefOrContainerName, messageId) {
    const sessionRef = typeof sessionRefOrContainerName === 'string'
        ? { containerName: sessionRefOrContainerName, agentId: WEB_DEFAULT_AGENT_ID }
        : sessionRefOrContainerName;
    const targetId = String(messageId || '').trim();
    if (!targetId) {
        return null;
    }
    const history = loadWebSessionHistory(webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true });
    const index = agentSession.messages.findIndex(item => item && String(item.id || '') === targetId);
    if (index === -1) {
        return null;
    }
    const removed = agentSession.messages.splice(index, 1)[0] || null;
    const timestamp = new Date().toISOString();
    agentSession.updatedAt = timestamp;
    history.updatedAt = timestamp;
    saveWebSessionHistory(webHistoryDir, sessionRef.containerName, history);
    return removed;
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
    const timestamp = new Date().toISOString();
    agentSession.createdAt = timestamp;
    agentSession.updatedAt = timestamp;
    sessionHistory.agents[agentId] = agentSession;
    sessionHistory.updatedAt = timestamp;
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

function normalizeAgentPromptCommandTemplate(value, sourceLabel = 'agentPromptCommand') {
    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value !== 'string') {
        throw new Error(`${sourceLabel} 必须是字符串`);
    }
    const text = value.trim();
    if (!text) {
        return '';
    }
    if (!text.includes('{prompt}')) {
        throw new Error(`${sourceLabel} 必须包含 {prompt} 占位符`);
    }
    if (/^codex\s+exec(?:\s|$)/.test(text) && !text.includes('--skip-git-repo-check')) {
        return text.replace(/^codex\s+exec\b/, 'codex exec --skip-git-repo-check');
    }
    return text;
}

function isAgentPromptCommandEnabled(value) {
    return typeof value === 'string' && value.includes('{prompt}') && Boolean(value.trim());
}

function quoteBashSingleValue(value) {
    const text = String(value || '');
    return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

function renderAgentPromptCommand(template, prompt) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const safePrompt = quoteBashSingleValue(prompt);
    return templateText.replace(/\{prompt\}/g, safePrompt);
}

function buildCodexAgentExecCommand(template, prompt) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const execMatch = templateText.match(
        /^((?:(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s+)*)codex\s+exec\b/
    );
    let codexTemplate = templateText;
    if (execMatch) {
        const prefix = execMatch[1] || '';
        const suffix = templateText.slice(execMatch[0].length);
        const hasJson = /(?:^|\s)--json(?:\s|$)/.test(suffix);
        const injectedFlags = hasJson ? '' : ' --json';
        codexTemplate = `${prefix}codex exec${injectedFlags}${suffix}`;
    }
    return codexTemplate === templateText
        ? renderAgentPromptCommand(templateText, prompt)
        : renderAgentPromptCommand(codexTemplate, prompt);
}

function prependAgentFlags(commandText, matchPattern, flagSpecs) {
    const matched = String(commandText || '').match(matchPattern);
    if (!matched) {
        return String(commandText || '');
    }
    const prefix = matched[1] || '';
    let suffix = matched[matched.length - 1] || '';
    for (let i = flagSpecs.length - 1; i >= 0; i -= 1) {
        const spec = flagSpecs[i];
        if (!spec || !spec.flag || !(spec.pattern instanceof RegExp) || spec.pattern.test(suffix)) {
            continue;
        }
        suffix = ` ${spec.flag}${suffix}`;
    }
    return `${prefix}${suffix}`;
}

function buildClaudeAgentExecCommand(template, prompt) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const claudeTemplate = prependAgentFlags(
        templateText,
        /^(((?:(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s+)*)claude\b)(.*)$/,
        [
            { flag: '--verbose', pattern: /(?:^|\s)--verbose(?:\s|$)/ },
            { flag: '--output-format stream-json', pattern: /(?:^|\s)--output-format(?:\s|$)/ }
        ]
    );
    return claudeTemplate === templateText
        ? renderAgentPromptCommand(templateText, prompt)
        : renderAgentPromptCommand(claudeTemplate, prompt);
}

function buildGeminiAgentExecCommand(template, prompt) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const geminiTemplate = prependAgentFlags(
        templateText,
        /^(((?:(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s+)*)gemini\b)(.*)$/,
        [
            { flag: '--output-format stream-json', pattern: /(?:^|\s)--output-format(?:\s|$)/ }
        ]
    );
    return geminiTemplate === templateText
        ? renderAgentPromptCommand(templateText, prompt)
        : renderAgentPromptCommand(geminiTemplate, prompt);
}

function buildOpenCodeAgentExecCommand(template, prompt) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const opencodeTemplate = prependAgentFlags(
        templateText,
        /^(((?:(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s+)*)opencode\s+run\b)(.*)$/,
        [
            { flag: '--format json', pattern: /(?:^|\s)--format(?:\s|$)/ }
        ]
    );
    return opencodeTemplate === templateText
        ? renderAgentPromptCommand(templateText, prompt)
        : renderAgentPromptCommand(opencodeTemplate, prompt);
}

function buildWebAgentExecCommand(template, prompt, agentProgram) {
    switch (agentProgram) {
    case 'claude':
        return buildClaudeAgentExecCommand(template, prompt);
    case 'gemini':
        return buildGeminiAgentExecCommand(template, prompt);
    case 'codex':
        return buildCodexAgentExecCommand(template, prompt);
    case 'opencode':
        return buildOpenCodeAgentExecCommand(template, prompt);
    default:
        break;
    }
    return renderAgentPromptCommand(template, prompt);
}

function parseJsonObjectLine(line) {
    const text = String(line || '').trim();
    if (!text) {
        return null;
    }
    try {
        const payload = JSON.parse(text);
        return payload && typeof payload === 'object' ? payload : null;
    } catch (e) {
        return null;
    }
}

function collectStructuredText(value) {
    if (typeof value === 'string') {
        return value.trim();
    }
    if (Array.isArray(value)) {
        return value.map(item => collectStructuredText(item)).filter(Boolean).join('\n').trim();
    }
    if (!value || typeof value !== 'object') {
        return '';
    }
    if (typeof value.text === 'string' && value.text.trim()) {
        return value.text.trim();
    }
    if (typeof value.content === 'string' && value.content.trim()) {
        return value.content.trim();
    }
    if (Array.isArray(value.content)) {
        return value.content.map(item => collectStructuredText(item)).filter(Boolean).join('\n').trim();
    }
    return '';
}

function extractClaudeAgentMessage(text) {
    let lastMessage = '';
    for (const rawLine of String(text || '').split('\n')) {
        const payload = parseJsonObjectLine(rawLine);
        if (!payload || payload.type !== 'assistant') {
            continue;
        }
        const message = toPlainObject(payload.message);
        const content = Array.isArray(message.content) ? message.content : [];
        const nextMessage = content
            .filter(item => item && typeof item === 'object' && item.type === 'text')
            .map(item => collectStructuredText(item))
            .filter(Boolean)
            .join('\n')
            .trim();
        if (nextMessage) {
            lastMessage = nextMessage;
        }
    }
    return lastMessage.trim();
}

function extractGeminiAgentMessage(text) {
    let lastMessage = '';
    let deltaMessage = '';
    for (const rawLine of String(text || '').split('\n')) {
        const payload = parseJsonObjectLine(rawLine);
        if (!payload || payload.type !== 'message' || payload.role !== 'assistant') {
            continue;
        }
        const content = collectStructuredText(payload.content);
        if (!content) {
            continue;
        }
        if (payload.delta === true) {
            deltaMessage += content;
            lastMessage = deltaMessage.trim();
            continue;
        }
        deltaMessage = '';
        lastMessage = content;
    }
    return lastMessage.trim();
}

function extractOpenCodeAgentMessage(text) {
    let lastMessage = '';
    let deltaMessage = '';
    for (const rawLine of String(text || '').split('\n')) {
        const payload = parseJsonObjectLine(rawLine);
        if (!payload) {
            continue;
        }
        const eventType = pickFirstString(payload.type);
        const message = toPlainObject(payload.message);
        const role = pickFirstString(payload.role, message.role);
        if (eventType !== 'message' && eventType !== 'assistant' && eventType !== 'assistant_message' && eventType !== 'text') {
            continue;
        }
        if (role && role !== 'assistant') {
            continue;
        }
        const content = collectStructuredText(message.content || payload.content || payload.text || payload);
        if (!content) {
            continue;
        }
        if (payload.delta === true) {
            deltaMessage += content;
            lastMessage = deltaMessage.trim();
            continue;
        }
        deltaMessage = '';
        lastMessage = content;
    }
    return lastMessage.trim();
}

function extractAgentMessageFromStructuredOutput(agentProgram, text) {
    if (agentProgram === 'codex') {
        return extractAgentMessageFromCodexJsonl(text);
    }
    if (agentProgram === 'claude') {
        return extractClaudeAgentMessage(text);
    }
    if (agentProgram === 'gemini') {
        return extractGeminiAgentMessage(text);
    }
    if (agentProgram === 'opencode') {
        return extractOpenCodeAgentMessage(text);
    }
    return '';
}

function getAgentRuntimeMeta(template) {
    const normalizedTemplate = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const agentProgram = resolveAgentProgram(normalizedTemplate);
    const resumeCommand = buildAgentResumeCommand(agentProgram);
    return {
        agentProgram: agentProgram || '',
        resumeCommand: resumeCommand || '',
        resumeSupported: Boolean(resumeCommand)
    };
}

function hasAgentConversationHistory(history) {
    const messages = history && Array.isArray(history.messages) ? history.messages : [];
    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        if (message.mode !== 'agent') continue;
        if (message.pending === true) continue;
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
            && message.pending !== true
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

function shortenTraceText(value, maxChars = 140) {
    const raw = clipText(stripAnsi(String(value || '')).replace(/\s+/g, ' ').trim(), maxChars);
    return raw.trim();
}

function summarizeTraceArguments(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return '';
    }
    const parts = [];
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'string') {
            const textValue = value.trim();
            if (!textValue) continue;
            parts.push(`${key}=${shortenTraceText(textValue, 80)}`);
            continue;
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            parts.push(`${key}=${String(value)}`);
        }
    }
    return parts.slice(0, 3).join(', ');
}

function createStructuredTraceEvent(provider, kind, eventType, textValue, extra = {}) {
    const normalizedText = String(textValue || '').trim();
    if (!normalizedText) {
        return null;
    }
    return {
        provider,
        kind,
        eventType,
        text: normalizedText,
        ...extra
    };
}

function prepareClaudeTraceEvents(payload, state) {
    const eventType = pickFirstString(payload.type);
    const subtype = pickFirstString(payload.subtype);
    const message = toPlainObject(payload.message);
    const content = Array.isArray(message.content) ? message.content : [];
    const toolNamesById = state.toolNamesById;
    const events = [];

    if (eventType === 'system' && subtype === 'init') {
        events.push(createStructuredTraceEvent('claude', 'thread', eventType, '[会话] Claude 已开始处理', {
            phase: 'started',
            status: 'started',
            subtype
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'assistant') {
        content.forEach(item => {
            if (!item || typeof item !== 'object') {
                return;
            }
            if (item.type === 'text') {
                const detail = collectStructuredText(item);
                if (detail) {
                    events.push(createStructuredTraceEvent('claude', 'agent_message', eventType, `[说明] ${detail}`, {
                        phase: 'completed',
                        status: 'completed',
                        detail
                    }));
                }
                return;
            }
            if (item.type === 'tool_use') {
                const toolName = pickFirstString(item.name, item.id, 'tool');
                const toolId = pickFirstString(item.id);
                if (toolId) {
                    toolNamesById.set(toolId, toolName);
                }
                const summary = summarizeTraceArguments(toPlainObject(item.input));
                events.push(createStructuredTraceEvent(
                    'claude',
                    'tool',
                    eventType,
                    summary ? `[工具开始] ${toolName} (${summary})` : `[工具开始] ${toolName}`,
                    {
                        phase: 'started',
                        status: 'in_progress',
                        toolName,
                        toolId,
                        arguments: toPlainObject(item.input),
                        argumentSummary: summary
                    }
                ));
            }
        });
        return events.filter(Boolean);
    }
    if (eventType === 'user') {
        content.forEach(item => {
            if (!item || typeof item !== 'object' || item.type !== 'tool_result') {
                return;
            }
            const toolId = pickFirstString(item.tool_use_id);
            const toolName = pickFirstString(toolNamesById.get(toolId), toolId, 'tool');
            const status = item.is_error === true ? 'error' : 'success';
            events.push(createStructuredTraceEvent('claude', 'tool', eventType, `[工具完成] ${toolName} (${status})`, {
                phase: 'completed',
                status,
                toolName,
                toolId,
                result: collectStructuredText(item.content),
                error: item.is_error === true ? collectStructuredText(item.content) : ''
            }));
        });
        return events.filter(Boolean);
    }
    if (eventType === 'result') {
        events.push(createStructuredTraceEvent('claude', 'turn', eventType, '[回合] 响应完成', {
            phase: 'completed',
            status: pickFirstString(subtype, 'completed'),
            subtype
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'error') {
        const detail = pickFirstString(payload.message, payload.error);
        events.push(createStructuredTraceEvent('claude', 'error', eventType, detail ? `[错误] ${detail}` : '[错误] Claude 返回了错误事件', {
            status: 'error',
            detail
        }));
        return events.filter(Boolean);
    }
    return [];
}

function prepareGeminiTraceEvents(payload, state) {
    const eventType = pickFirstString(payload.type);
    const toolNamesById = state.toolNamesById;
    const events = [];

    if (eventType === 'init') {
        events.push(createStructuredTraceEvent('gemini', 'thread', eventType, '[会话] Gemini 已开始处理', {
            phase: 'started',
            status: 'started',
            sessionId: pickFirstString(payload.session_id),
            model: pickFirstString(payload.model)
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'message' && payload.role === 'assistant') {
        if (payload.delta === true) {
            return [];
        }
        const detail = collectStructuredText(payload.content);
        if (!detail) {
            return [];
        }
        events.push(createStructuredTraceEvent('gemini', 'agent_message', eventType, `[说明] ${detail}`, {
            phase: 'completed',
            status: 'completed',
            detail
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'tool_use') {
        const toolName = pickFirstString(payload.tool_name, payload.tool_id, 'tool');
        const toolId = pickFirstString(payload.tool_id);
        if (toolId) {
            toolNamesById.set(toolId, toolName);
        }
        const summary = summarizeTraceArguments(toPlainObject(payload.parameters));
        events.push(createStructuredTraceEvent(
            'gemini',
            'tool',
            eventType,
            summary ? `[工具开始] ${toolName} (${summary})` : `[工具开始] ${toolName}`,
            {
                phase: 'started',
                status: 'in_progress',
                toolName,
                toolId,
                arguments: toPlainObject(payload.parameters),
                argumentSummary: summary
            }
        ));
        return events.filter(Boolean);
    }
    if (eventType === 'tool_result') {
        const toolId = pickFirstString(payload.tool_id);
        const toolName = pickFirstString(toolNamesById.get(toolId), toolId, 'tool');
        const status = pickFirstString(payload.status, 'completed');
        events.push(createStructuredTraceEvent('gemini', 'tool', eventType, `[工具完成] ${toolName} (${status})`, {
            phase: 'completed',
            status,
            toolName,
            toolId,
            result: collectStructuredText(payload.output),
            error: toPlainObject(payload.error)
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'result') {
        events.push(createStructuredTraceEvent('gemini', 'turn', eventType, '[回合] 响应完成', {
            phase: 'completed',
            status: pickFirstString(payload.status, 'completed')
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'error') {
        const detail = pickFirstString(payload.message);
        events.push(createStructuredTraceEvent('gemini', 'error', eventType, detail ? `[错误] ${detail}` : '[错误] Gemini 返回了错误事件', {
            status: pickFirstString(payload.severity, 'error'),
            detail
        }));
        return events.filter(Boolean);
    }
    return [];
}

function prepareOpenCodeTraceEvents(payload, state) {
    const eventType = pickFirstString(payload.type);
    const message = toPlainObject(payload.message);
    const role = pickFirstString(payload.role, message.role);
    const toolNamesById = state.toolNamesById;
    const events = [];

    if (eventType === 'session.start' || eventType === 'init') {
        events.push(createStructuredTraceEvent('opencode', 'thread', eventType, '[会话] OpenCode 已开始处理', {
            phase: 'started',
            status: 'started',
            sessionId: pickFirstString(payload.session_id, payload.sessionID)
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'message' || eventType === 'assistant' || eventType === 'assistant_message' || eventType === 'text') {
        if (role && role !== 'assistant') {
            return [];
        }
        if (payload.delta === true) {
            return [];
        }
        const detail = collectStructuredText(message.content || payload.content || payload.text || payload);
        if (!detail) {
            return [];
        }
        events.push(createStructuredTraceEvent('opencode', 'agent_message', eventType, `[说明] ${detail}`, {
            phase: 'completed',
            status: 'completed',
            detail
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'tool_use' || eventType === 'step_start') {
        const toolName = pickFirstString(payload.tool_name, payload.name, payload.tool, payload.step, payload.tool_id, 'tool');
        const toolId = pickFirstString(payload.tool_id, payload.id);
        if (toolId) {
            toolNamesById.set(toolId, toolName);
        }
        const argumentsValue = toPlainObject(payload.parameters || payload.input || payload.arguments);
        const summary = summarizeTraceArguments(argumentsValue);
        events.push(createStructuredTraceEvent(
            'opencode',
            'tool',
            eventType,
            summary ? `[工具开始] ${toolName} (${summary})` : `[工具开始] ${toolName}`,
            {
                phase: 'started',
                status: pickFirstString(payload.status, 'in_progress'),
                toolName,
                toolId,
                arguments: argumentsValue,
                argumentSummary: summary
            }
        ));
        return events.filter(Boolean);
    }
    if (eventType === 'tool_result' || eventType === 'step_finish') {
        const toolId = pickFirstString(payload.tool_id, payload.id);
        const toolName = pickFirstString(toolNamesById.get(toolId), payload.tool_name, payload.name, payload.tool, toolId, 'tool');
        const status = pickFirstString(payload.status, payload.state, 'completed');
        events.push(createStructuredTraceEvent('opencode', 'tool', eventType, `[工具完成] ${toolName} (${status})`, {
            phase: 'completed',
            status,
            toolName,
            toolId,
            result: collectStructuredText(payload.output || payload.result),
            error: toPlainObject(payload.error)
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'result') {
        events.push(createStructuredTraceEvent('opencode', 'turn', eventType, '[回合] 响应完成', {
            phase: 'completed',
            status: pickFirstString(payload.status, 'completed')
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'error') {
        const detail = pickFirstString(payload.message, payload.error && payload.error.message);
        events.push(createStructuredTraceEvent('opencode', 'error', eventType, detail ? `[错误] ${detail}` : '[错误] OpenCode 返回了错误事件', {
            status: 'error',
            detail
        }));
        return events.filter(Boolean);
    }
    return [];
}

function prepareStructuredTraceEvents(agentProgram, payload, state) {
    if (!payload || typeof payload !== 'object') {
        return [];
    }
    if (agentProgram === 'codex') {
        const traceEvent = prepareCodexTraceEvent(payload);
        return traceEvent ? [traceEvent] : [];
    }
    if (agentProgram === 'claude') {
        return prepareClaudeTraceEvents(payload, state);
    }
    if (agentProgram === 'gemini') {
        return prepareGeminiTraceEvents(payload, state);
    }
    if (agentProgram === 'opencode') {
        return prepareOpenCodeTraceEvents(payload, state);
    }
    return [];
}

function extractContentDeltaFromPayload(agentProgram, payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    if (agentProgram === 'claude') {
        if (pickFirstString(payload.type) !== 'assistant') {
            return null;
        }
        const message = toPlainObject(payload.message);
        const content = Array.isArray(message.content) ? message.content : [];
        const text = content
            .filter(item => item && typeof item === 'object' && item.type === 'text')
            .map(item => collectStructuredText(item))
            .filter(Boolean)
            .join('\n')
            .trim();
        if (!text) {
            return null;
        }
        return { text, reset: true };
    }
    if (agentProgram === 'gemini' || agentProgram === 'opencode') {
        const eventType = pickFirstString(payload.type);
        if (eventType !== 'message') {
            return null;
        }
        const role = pickFirstString(payload.role);
        if (role !== 'assistant') {
            return null;
        }
        const text = collectStructuredText(payload.content);
        if (!text) {
            return null;
        }
        if (payload.delta === true) {
            return { text, reset: false };
        }
        return { text, reset: true };
    }
    return null;
}

function prepareCodexTraceEvent(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const eventType = typeof payload.type === 'string' ? payload.type : '';
    const item = payload.item && typeof payload.item === 'object' && !Array.isArray(payload.item)
        ? payload.item
        : {};
    const itemType = typeof item.type === 'string' ? item.type : '';
    const text = pickFirstString(
        item.title,
        item.summary,
        item.text,
        item.name,
        item.command,
        payload.message,
        payload.text
    );
    const toolName = pickFirstString(
        item.name,
        item.tool_name,
        item.tool,
        item.command
    );
    const commandText = pickFirstString(item.command);
    const mcpServer = pickFirstString(item.server);
    const mcpTool = pickFirstString(item.tool);
    const itemStatus = pickFirstString(item.status);

    function shortenText(value, maxChars = 140) {
        const raw = clipText(stripAnsi(String(value || '')).replace(/\s+/g, ' ').trim(), maxChars);
        return raw.trim();
    }

    function summarizeArguments(args) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return '';
        }
        const parts = [];
        for (const [key, value] of Object.entries(args)) {
            if (value === undefined || value === null) continue;
            if (typeof value === 'string') {
                const textValue = value.trim();
                if (!textValue) continue;
                parts.push(`${key}=${shortenText(textValue, 80)}`);
                continue;
            }
            if (typeof value === 'number' || typeof value === 'boolean') {
                parts.push(`${key}=${String(value)}`);
            }
        }
        return parts.slice(0, 3).join(', ');
    }

    function pickDisplayStatus(defaultStatus) {
        const status = String(itemStatus || defaultStatus || '').trim();
        return status || '';
    }

    function createTraceEvent(kind, textValue, extra = {}) {
        const normalizedText = String(textValue || '').trim();
        if (!normalizedText) {
            return null;
        }
        return {
            provider: 'codex',
            kind,
            eventType,
            itemType: itemType || '',
            text: normalizedText,
            ...extra
        };
    }

    if (eventType === 'thread.started') {
        return createTraceEvent('thread', '[会话] Codex 已开始处理', {
            phase: 'started',
            status: 'started'
        });
    }
    if (eventType === 'thread.completed') {
        return createTraceEvent('thread', '[会话] Codex 已完成当前任务', {
            phase: 'completed',
            status: 'completed'
        });
    }
    if (eventType === 'turn.started') {
        return createTraceEvent('turn', '[回合] 开始生成响应', {
            phase: 'started',
            status: 'started'
        });
    }
    if (eventType === 'turn.completed') {
        return createTraceEvent('turn', '[回合] 响应完成', {
            phase: 'completed',
            status: 'completed'
        });
    }
    if (eventType === 'item.started') {
        if (itemType === 'tool_call') {
            return createTraceEvent('tool', `[工具开始] ${toolName || 'tool_call'}`, {
                phase: 'started',
                status: pickDisplayStatus('in_progress'),
                toolName: toolName || 'tool_call'
            });
        }
        if (itemType === 'command_execution') {
            return createTraceEvent('command', `[命令开始] ${commandText || 'command_execution'}`, {
                phase: 'started',
                status: pickDisplayStatus('in_progress'),
                command: commandText || 'command_execution'
            });
        }
        if (itemType === 'mcp_tool_call') {
            const summary = summarizeArguments(item.arguments);
            return createTraceEvent(
                'mcp',
                summary
                    ? `[MCP开始] ${mcpServer || 'mcp'}.${mcpTool || 'tool'} (${summary})`
                    : `[MCP开始] ${mcpServer || 'mcp'}.${mcpTool || 'tool'}`,
                {
                    phase: 'started',
                    status: pickDisplayStatus('in_progress'),
                    server: mcpServer || 'mcp',
                    tool: mcpTool || 'tool',
                    arguments: item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
                        ? item.arguments
                        : null,
                    argumentSummary: summary
                }
            );
        }
        if (itemType === 'reasoning') {
            return createTraceEvent('status', text ? `[状态] ${text}` : '[状态] Codex 正在分析', {
                phase: 'started',
                status: pickDisplayStatus('in_progress'),
                detail: text || 'Codex 正在分析'
            });
        }
        if (itemType === 'agent_message') {
            return createTraceEvent('agent_message', text ? `[说明] ${text}` : '[回复] 正在生成最终答复', {
                phase: 'started',
                status: pickDisplayStatus('in_progress'),
                detail: text || '正在生成最终答复'
            });
        }
        return createTraceEvent('event', text ? `[事件开始] ${text}` : `[事件开始] ${itemType || eventType}`, {
            phase: 'started',
            status: pickDisplayStatus('in_progress'),
            detail: text || itemType || eventType
        });
    }
    if (eventType === 'item.completed') {
        if (itemType === 'tool_call') {
            return createTraceEvent('tool', `[工具完成] ${toolName || 'tool_call'}`, {
                phase: 'completed',
                status: pickDisplayStatus('completed'),
                toolName: toolName || 'tool_call'
            });
        }
        if (itemType === 'command_execution') {
            const suffix = itemStatus || (typeof item.exit_code === 'number' ? `exit=${item.exit_code}` : 'completed');
            return createTraceEvent('command', `[命令完成] ${commandText || 'command_execution'} (${suffix})`, {
                phase: 'completed',
                status: pickDisplayStatus(suffix),
                command: commandText || 'command_execution',
                exitCode: typeof item.exit_code === 'number' ? item.exit_code : null
            });
        }
        if (itemType === 'mcp_tool_call') {
            const summary = summarizeArguments(item.arguments);
            return createTraceEvent(
                'mcp',
                summary
                    ? `[MCP完成] ${mcpServer || 'mcp'}.${mcpTool || 'tool'} (${summary})`
                    : `[MCP完成] ${mcpServer || 'mcp'}.${mcpTool || 'tool'}`,
                {
                    phase: 'completed',
                    status: pickDisplayStatus('completed'),
                    server: mcpServer || 'mcp',
                    tool: mcpTool || 'tool',
                    arguments: item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
                        ? item.arguments
                        : null,
                    argumentSummary: summary,
                    result: item.result !== undefined ? item.result : null,
                    error: item.error !== undefined ? item.error : null
                }
            );
        }
        if (itemType === 'reasoning') {
            return createTraceEvent('status', text ? `[状态] ${text}` : '', {
                phase: 'completed',
                status: pickDisplayStatus('completed'),
                detail: text || ''
            });
        }
        if (itemType === 'agent_message') {
            return createTraceEvent('agent_message', text ? `[说明] ${text}` : '[回复] 已生成', {
                phase: 'completed',
                status: pickDisplayStatus('completed'),
                detail: text || '已生成'
            });
        }
        return createTraceEvent('event', text ? `[事件完成] ${text}` : `[事件完成] ${itemType || eventType}`, {
            phase: 'completed',
            status: pickDisplayStatus('completed'),
            detail: text || itemType || eventType
        });
    }
    if (eventType === 'error') {
        return createTraceEvent('error', text ? `[错误] ${text}` : '[错误] Codex 返回了错误事件', {
            status: 'error',
            detail: text || 'Codex 返回了错误事件'
        });
    }

    return createTraceEvent('event', `[事件] ${eventType}`, {
        status: itemStatus || '',
        detail: eventType
    });
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
        return null;
    }
    return appendWebSessionMessage(webHistoryDir, sessionRefOrContainerName, 'assistant', text, {
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

    const requestName = pickFirstString(requestOptions.containerName, body.name);
    const requestEnvMap = hasRequestEnv ? normalizeEnvMap(requestOptions.env, 'createOptions.env') : {};
    const requestEnvList = Object.entries(requestEnvMap).map(([key, value]) => `${key}=${value}`);
    const requestEnvFileList = hasRequestEnvFile ? normalizeStringArray(requestOptions.envFile, 'createOptions.envFile') : [];
    const requestVolumeList = hasRequestVolumes ? normalizeStringArray(requestOptions.volumes, 'createOptions.volumes') : [];
    const requestPortList = hasRequestPorts ? normalizeStringArray(requestOptions.ports, 'createOptions.ports') : [];

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
        const mergedEnv = resolvedBase.env;
        const envArgs = [];
        Object.entries(mergedEnv).forEach(([key, value]) => {
            const parsed = parseEnvEntry(`${key}=${value}`);
            envArgs.push('--env', `${parsed.key}=${parsed.value}`);
        });

        const envFileList = resolvedBase.envFile;
        const envFileArgs = [];
        envFileList.forEach(filePath => {
            envFileArgs.push(...parseEnvFileToArgs(filePath));
        });

        containerEnvs = [...envArgs, ...envFileArgs];
    }

    let containerVolumes = Array.isArray(ctx.containerVolumes) ? ctx.containerVolumes.slice() : [];
    const hasRunVolumes = hasOwn(runConfig, 'volumes');
    if (hasRequestVolumes || hasRunVolumes || hasConfigVolumes) {
        const volumeList = resolvedBase.volumes;
        containerVolumes = [];
        volumeList.forEach(volume => {
            containerVolumes.push('--volume', normalizeVolume(volume));
        });
    }

    let containerPorts = Array.isArray(ctx.containerPorts) ? ctx.containerPorts.slice() : [];
    const hasRunPorts = hasOwn(runConfig, 'ports');
    if (hasRequestPorts || hasRunPorts || hasConfigPorts) {
        const portList = resolvedBase.ports;
        containerPorts = [];
        portList.forEach(port => {
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

async function execCommandInWebContainer(ctx, containerName, command, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const agentProgram = typeof opts.agentProgram === 'string' ? opts.agentProgram : '';
    return await new Promise((resolve, reject) => {
        const process = spawn(
            ctx.dockerCmd,
            ['exec', containerName, '/bin/bash', '-lc', command],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        const MAX_RAW_OUTPUT_CHARS = 32 * 1024 * 1024;
        let stdoutOutput = '';
        let stderrOutput = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;

        function appendChunk(chunk, target) {
            if (!chunk) return;
            const text = chunk.toString('utf-8');
            if (!text) return;
            if (target.value.length >= MAX_RAW_OUTPUT_CHARS) {
                target.truncated = true;
                return;
            }
            const remain = MAX_RAW_OUTPUT_CHARS - target.value.length;
            if (text.length > remain) {
                target.value += text.slice(0, remain);
                target.truncated = true;
                return;
            }
            target.value += text;
        }

        process.stdout.on('data', chunk => appendChunk(chunk, {
            get value() { return stdoutOutput; },
            set value(nextValue) { stdoutOutput = nextValue; },
            get truncated() { return stdoutTruncated; },
            set truncated(nextValue) { stdoutTruncated = nextValue; }
        }));
        process.stderr.on('data', chunk => appendChunk(chunk, {
            get value() { return stderrOutput; },
            set value(nextValue) { stderrOutput = nextValue; },
            get truncated() { return stderrTruncated; },
            set truncated(nextValue) { stderrTruncated = nextValue; }
        }));

        process.on('error', reject);
        process.on('close', code => {
            const exitCode = typeof code === 'number' ? code : 1;
            const clippedStdout = stdoutTruncated ? `${stdoutOutput}\n...[stdout-truncated]` : stdoutOutput;
            const clippedStderr = stderrTruncated ? `${stderrOutput}\n...[stderr-truncated]` : stderrOutput;
            const clippedRaw = `${clippedStdout}${clippedStdout && clippedStderr ? '\n' : ''}${clippedStderr}`;
            const extractedAgentMessage = extractAgentMessageFromStructuredOutput(agentProgram, clippedStdout);
            const cleanOutputSource = extractedAgentMessage || clippedRaw;
            const output = clipText(stripAnsi(cleanOutputSource).trim() || '(无输出)');
            resolve({
                exitCode,
                output,
                stdout: clippedStdout,
                stderr: clippedStderr
            });
        });
    });
}

function buildWebContainerNodeCommand(scriptSource) {
    return `node <<'__MANYOYO_NODE__'
${scriptSource}
__MANYOYO_NODE__`;
}

function inferFileLanguage(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    return FILE_LANGUAGE_MAP[ext] || 'text';
}

async function execJsonCommandInWebContainer(ctx, containerName, command) {
    const result = await execCommandInWebContainer(ctx, containerName, command);
    if (result.exitCode !== 0) {
        throw new Error(result.output || '容器命令执行失败');
    }
    try {
        return JSON.parse(String(result.stdout || '{}'));
    } catch (e) {
        throw new Error('容器返回了无法解析的 JSON');
    }
}

function buildContainerFileListCommand(requestedPath) {
    return buildWebContainerNodeCommand(`
// __MANYOYO_FS_LIST__
const fs = require('fs');
const path = require('path');

const requestedPath = ${JSON.stringify(String(requestedPath || '/'))};

try {
    const realPath = fs.realpathSync(requestedPath);
    const stat = fs.statSync(realPath);
    if (!stat.isDirectory()) {
        throw new Error('目标不是目录: ' + realPath);
    }

    const root = path.parse(realPath).root;
    const parentPath = realPath === root ? '' : path.dirname(realPath);
    const entries = fs.readdirSync(realPath, { withFileTypes: true })
        .map(entry => {
            const fullPath = path.join(realPath, entry.name);
            let itemStat = null;
            try {
                itemStat = fs.lstatSync(fullPath);
            } catch (e) {
                itemStat = null;
            }
            let kind = 'other';
            if (entry.isDirectory()) {
                kind = 'directory';
            } else if (entry.isFile()) {
                kind = 'file';
            } else if (entry.isSymbolicLink()) {
                kind = 'symlink';
            }
            return {
                name: entry.name,
                path: fullPath,
                kind,
                size: itemStat && typeof itemStat.size === 'number' ? itemStat.size : 0,
                mtimeMs: itemStat && typeof itemStat.mtimeMs === 'number' ? Math.floor(itemStat.mtimeMs) : 0
            };
        })
        .sort((a, b) => {
            if (a.kind !== b.kind) {
                if (a.kind === 'directory') return -1;
                if (b.kind === 'directory') return 1;
            }
            return a.name.localeCompare(b.name, 'zh-CN');
        });

    process.stdout.write(JSON.stringify({
        path: realPath,
        parentPath,
        entries
    }));
} catch (e) {
    process.stdout.write(JSON.stringify({
        error: e && e.message ? e.message : '读取目录失败'
    }));
}
`);
}

function buildContainerFileReadCommand(requestedPath, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
        ? Math.floor(opts.maxBytes)
        : 0;
    return buildWebContainerNodeCommand(`
// __MANYOYO_FS_READ__
const fs = require('fs');

const requestedPath = ${JSON.stringify(String(requestedPath || ''))};
const maxBytes = ${String(maxBytes)};

function looksBinary(buffer) {
    const length = Math.min(buffer.length, 4096);
    let suspicious = 0;
    for (let i = 0; i < length; i += 1) {
        const byte = buffer[i];
        if (byte === 0) {
            return true;
        }
        if (byte < 7 || (byte > 13 && byte < 32)) {
            suspicious += 1;
        }
    }
    return length > 0 && (suspicious / length) > 0.12;
}

try {
    const realPath = fs.realpathSync(requestedPath);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
        throw new Error('目标不是文件: ' + realPath);
    }

    const size = stat.size;
    const readBytes = maxBytes > 0 ? Math.min(size, maxBytes) : size;
    const buffer = Buffer.alloc(readBytes);
    const fd = fs.openSync(realPath, 'r');
    try {
        fs.readSync(fd, buffer, 0, readBytes, 0);
    } finally {
        fs.closeSync(fd);
    }

    if (looksBinary(buffer)) {
        process.stdout.write(JSON.stringify({
            path: realPath,
            kind: 'binary',
            size,
            truncated: maxBytes > 0 && size > maxBytes
        }));
    } else {
        process.stdout.write(JSON.stringify({
            path: realPath,
            kind: 'text',
            size,
            truncated: maxBytes > 0 && size > maxBytes,
            content: buffer.toString('utf8')
        }));
    }
} catch (e) {
    process.stdout.write(JSON.stringify({
        error: e && e.message ? e.message : '读取文件失败'
    }));
}
`);
}

function buildContainerFileWriteCommand(requestedPath, content) {
    return buildWebContainerNodeCommand(`
// __MANYOYO_FS_WRITE__
const fs = require('fs');

const requestedPath = ${JSON.stringify(String(requestedPath || ''))};
const nextContent = ${JSON.stringify(String(content == null ? '' : content))};

try {
    const realPath = fs.realpathSync(requestedPath);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
        throw new Error('目标不是文件: ' + realPath);
    }

    fs.writeFileSync(realPath, nextContent, 'utf8');
    const savedStat = fs.statSync(realPath);
    process.stdout.write(JSON.stringify({
        path: realPath,
        saved: true,
        size: savedStat.size
    }));
} catch (e) {
    process.stdout.write(JSON.stringify({
        error: e && e.message ? e.message : '保存文件失败'
    }));
}
`);
}

function buildContainerFileMkdirCommand(requestedPath) {
    return buildWebContainerNodeCommand(`
// __MANYOYO_FS_MKDIR__
const fs = require('fs');
const path = require('path');

const requestedPath = ${JSON.stringify(String(requestedPath || ''))};

try {
    const resolvedPath = path.resolve(requestedPath);
    const parentPath = path.dirname(resolvedPath);
    const realParentPath = fs.realpathSync(parentPath);
    const targetPath = path.join(realParentPath, path.basename(resolvedPath));
    if (fs.existsSync(targetPath)) {
        throw new Error('目录已存在: ' + targetPath);
    }

    fs.mkdirSync(targetPath, { recursive: true });
    const stat = fs.statSync(targetPath);
    process.stdout.write(JSON.stringify({
        path: targetPath,
        name: path.basename(targetPath),
        kind: 'directory',
        size: 0,
        mtimeMs: stat.mtimeMs,
        created: true
    }));
} catch (e) {
    process.stdout.write(JSON.stringify({
        error: e && e.message ? e.message : '创建目录失败'
    }));
}
`);
}

async function execAgentInWebContainerStream(ctx, state, sessionRefOrContainerName, command, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const sessionRef = typeof sessionRefOrContainerName === 'string'
        ? { containerName: sessionRefOrContainerName, agentId: WEB_DEFAULT_AGENT_ID }
        : sessionRefOrContainerName;
    const sessionKey = buildWebSessionKey(sessionRef.containerName, sessionRef.agentId);
    const agentProgram = typeof opts.agentProgram === 'string' ? opts.agentProgram : '';
    const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
    const process = spawn(
        ctx.dockerCmd,
        ['exec', sessionRef.containerName, '/bin/bash', '-lc', command],
        { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const runState = {
        containerName: sessionRef.containerName,
        sessionKey,
        process,
        command,
        startedAt: new Date().toISOString(),
        stopping: false
    };
    state.agentRuns.set(sessionRef.containerName, runState);

    return await new Promise((resolve, reject) => {
        const MAX_RAW_OUTPUT_CHARS = 32 * 1024 * 1024;
        let stdoutOutput = '';
        let stderrOutput = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let stdoutPending = '';
        let stderrPending = '';
        const structuredTraceState = {
            toolNamesById: new Map()
        };
        let contentDeltaAccumulator = '';
        function appendChunk(chunk, target) {
            if (!chunk) return;
            const text = chunk.toString('utf-8');
            if (!text) return;
            if (target.value.length >= MAX_RAW_OUTPUT_CHARS) {
                target.truncated = true;
                return;
            }
            const remain = MAX_RAW_OUTPUT_CHARS - target.value.length;
            if (text.length > remain) {
                target.value += text.slice(0, remain);
                target.truncated = true;
                return;
            }
            target.value += text;
        }

        function emitStdoutTraceLine(line) {
            const rawLine = String(line || '').trim();
            if (!rawLine) {
                return;
            }
            if (agentProgram === 'claude' || agentProgram === 'gemini' || agentProgram === 'codex' || agentProgram === 'opencode') {
                const payload = parseJsonObjectLine(rawLine);
                if (payload) {
                    const traceEvents = prepareStructuredTraceEvents(agentProgram, payload, structuredTraceState);
                    traceEvents.forEach(traceEvent => {
                        if (!traceEvent || !traceEvent.text) {
                            return;
                        }
                        onEvent({
                            type: 'trace',
                            stream: 'stdout',
                            text: traceEvent.text,
                            traceEvent
                        });
                    });
                    const deltaContent = extractContentDeltaFromPayload(agentProgram, payload, structuredTraceState);
                    if (deltaContent !== null) {
                        if (deltaContent.reset) {
                            contentDeltaAccumulator = deltaContent.text;
                        } else {
                            contentDeltaAccumulator += deltaContent.text;
                        }
                        onEvent({
                            type: 'content_delta',
                            content: contentDeltaAccumulator
                        });
                    }
                    return;
                }
                if (agentProgram === 'codex' && (/^OpenAI Codex\b/.test(rawLine) || /^tokens used\b/i.test(rawLine))) {
                    return;
                }
            }
            onEvent({ type: 'trace', stream: 'stdout', text: rawLine });
        }

        function emitStderrTraceLine(line) {
            const rawLine = String(line || '').trim();
            if (!rawLine) {
                return;
            }
            onEvent({ type: 'trace', stream: 'stderr', text: `[stderr] ${rawLine}` });
        }

        function drainLines(text, carry, handleLine) {
            let pending = carry + String(text || '');
            let newlineIndex = pending.indexOf('\n');
            while (newlineIndex !== -1) {
                const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
                handleLine(line);
                pending = pending.slice(newlineIndex + 1);
                newlineIndex = pending.indexOf('\n');
            }
            return pending;
        }

        process.stdout.on('data', chunk => {
            appendChunk(chunk, {
                get value() { return stdoutOutput; },
                set value(nextValue) { stdoutOutput = nextValue; },
                get truncated() { return stdoutTruncated; },
                set truncated(nextValue) { stdoutTruncated = nextValue; }
            });
            stdoutPending = drainLines(chunk.toString('utf-8'), stdoutPending, emitStdoutTraceLine);
        });
        process.stderr.on('data', chunk => {
            appendChunk(chunk, {
                get value() { return stderrOutput; },
                set value(nextValue) { stderrOutput = nextValue; },
                get truncated() { return stderrTruncated; },
                set truncated(nextValue) { stderrTruncated = nextValue; }
            });
            stderrPending = drainLines(chunk.toString('utf-8'), stderrPending, emitStderrTraceLine);
        });

        process.on('error', error => {
            state.agentRuns.delete(sessionRef.containerName);
            reject(error);
        });
        process.on('close', code => {
            state.agentRuns.delete(sessionRef.containerName);
            if (stdoutPending) {
                emitStdoutTraceLine(stdoutPending);
                stdoutPending = '';
            }
            if (stderrPending) {
                emitStderrTraceLine(stderrPending);
                stderrPending = '';
            }
            const exitCode = typeof code === 'number' ? code : 1;
            const clippedStdout = stdoutTruncated ? `${stdoutOutput}\n...[stdout-truncated]` : stdoutOutput;
            const clippedStderr = stderrTruncated ? `${stderrOutput}\n...[stderr-truncated]` : stderrOutput;
            const clippedRaw = `${clippedStdout}${clippedStdout && clippedStderr ? '\n' : ''}${clippedStderr}`;
            const extractedAgentMessage = extractAgentMessageFromStructuredOutput(agentProgram, clippedStdout);
            const cleanOutputSource = extractedAgentMessage || clippedRaw;
            const output = clipText(stripAnsi(cleanOutputSource).trim() || '(无输出)');
            resolve({
                exitCode,
                output,
                interrupted: exitCode !== 0 && runState.stopping === true
            });
        });
    });
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
    const createdAt = agentSession.createdAt || containerInfo.createdAt || null;
    const updatedAt = agentSession.updatedAt || history.updatedAt || (latestMessage && latestMessage.timestamp) || containerInfo.createdAt || null;
    return {
        name: buildWebSessionKey(containerName, agentId),
        containerName,
        agentId,
        agentName: agentSession.agentName,
        status: containerInfo.status || 'history',
        image: containerInfo.image || '',
        createdAt,
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
        '-e', `MANYOYO_TERM_COLS=${String(cols)}`,
        '-e', `MANYOYO_TERM_ROWS=${String(rows)}`,
        containerName,
        '/bin/bash',
        '-lc',
        terminalBootstrap
    ];

    return spawn(ctx.dockerCmd, dockerExecArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
}

function bindTerminalWebSocket(ctx, state, ws, containerName, cols, rows) {
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
            // 当前后端不直接驱动 docker exec 的 TTY 动态 resize，保留事件以便后续扩展。
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
    if (req.method === 'GET' && pathname === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return true;
    }

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

async function handleWebApi(req, res, pathname, ctx, state) {
    // [P2-03] 对非只读请求校验自定义头，防止 CSRF 攻击
    // 跨站请求无法设置自定义头（浏览器同源策略），合法前端请求统一携带此头
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
            sendJson(res, 403, { error: 'CSRF check failed' });
            return true;
        }
    }
    const routes = [
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/fs/directories' ? [] : null,
            handler: async () => {
                const requestUrl = new URL(req.url || '/api/fs/directories', 'http://localhost');
                const requestedPath = expandHomeAliasPath(String(requestUrl.searchParams.get('path') || '').trim() || os.homedir());
                const requestedBasePath = expandHomeAliasPath(String(requestUrl.searchParams.get('basePath') || '').trim());
                const realPath = fs.realpathSync(requestedPath);
                if (!fs.statSync(realPath).isDirectory()) {
                    sendJson(res, 400, { error: `目录不存在: ${realPath}` });
                    return;
                }

                let realBasePath = '';
                if (requestedBasePath) {
                    realBasePath = fs.realpathSync(requestedBasePath);
                    if (!fs.statSync(realBasePath).isDirectory()) {
                        sendJson(res, 400, { error: `basePath 不是目录: ${realBasePath}` });
                        return;
                    }
                    const relativeToBase = path.relative(realBasePath, realPath);
                    if (relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) {
                        sendJson(res, 400, { error: '目录超出 basePath 范围' });
                        return;
                    }
                }

                const parentPath = realBasePath
                    ? (realPath === realBasePath ? '' : path.dirname(realPath))
                    : (realPath === path.parse(realPath).root ? '' : path.dirname(realPath));
                const entries = fs.readdirSync(realPath, { withFileTypes: true })
                    .filter(entry => entry && entry.isDirectory())
                    .map(entry => ({
                        name: entry.name,
                        path: path.join(realPath, entry.name)
                    }))
                    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

                sendJson(res, 200, {
                    currentPath: realPath,
                    basePath: realBasePath || '',
                    parentPath,
                    entries
                });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath === '/api/fs/directories/mkdir' ? [] : null,
            handler: async () => {
                const payload = await readJsonBody(req);
                const requestedPath = expandHomeAliasPath(String(payload && payload.path ? payload.path : '').trim());
                if (!requestedPath) {
                    sendJson(res, 400, { error: 'path 不能为空' });
                    return;
                }

                const targetPath = path.resolve(requestedPath);
                fs.mkdirSync(targetPath, { recursive: true });
                sendJson(res, 200, {
                    path: targetPath,
                    created: true
                });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/config' ? [] : null,
            handler: async () => {
                const snapshot = readWebConfigSnapshot(state.webConfigPath);
                sendJson(res, 200, buildSafeWebConfigSnapshot(snapshot, ctx));
            }
        },
        {
            method: 'PUT',
            match: currentPath => currentPath === '/api/config' ? [] : null,
            handler: async () => {
                const payload = await readJsonBody(req);
                const raw = typeof payload.raw === 'string' ? payload.raw : '';
                if (!raw.trim()) {
                    sendJson(res, 400, { error: '配置内容不能为空' });
                    return;
                }

                const currentSnapshot = readWebConfigSnapshot(state.webConfigPath);
                let finalRaw = raw;
                let parsed = null;
                try {
                    finalRaw = restoreWebConfigSecrets(raw, currentSnapshot);
                    parsed = parseAndValidateConfigRaw(finalRaw);
                } catch (e) {
                    sendJson(res, 400, { error: '配置格式错误', detail: e.message || '解析失败' });
                    return;
                }

                const savePath = path.resolve(state.webConfigPath);
                fs.mkdirSync(path.dirname(savePath), { recursive: true });
                fs.writeFileSync(savePath, finalRaw, 'utf-8');

                sendJson(res, 200, {
                    saved: true,
                    path: savePath,
                    defaults: buildConfigDefaults(ctx, parsed)
                });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/sessions' ? [] : null,
            handler: async () => {
                const containerMap = listWebManyoyoContainers(ctx);
                const names = new Set([
                    ...Object.keys(containerMap),
                    ...listWebHistorySessionNames(state.webHistoryDir, ctx.isValidContainerName)
                ]);

                const sessions = Array.from(names)
                    .flatMap(name => {
                        const history = loadWebSessionHistory(state.webHistoryDir, name);
                        return listWebAgentSessions(history, { includeSyntheticDefault: true })
                            .map(agentSession => buildSessionSummary(ctx, state, containerMap, {
                                containerName: name,
                                agentId: agentSession.agentId
                            }))
                            .filter(Boolean);
                    })
                    .sort(compareWebSessionCreatedDesc);

                sendJson(res, 200, { sessions });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath === '/api/sessions' ? [] : null,
            handler: async () => {
                const payload = await readJsonBody(req);
                let runtime = null;
                try {
                    runtime = buildCreateRuntime(ctx, state, payload);
                } catch (e) {
                    sendJson(res, 400, { error: e.message || '创建参数错误' });
                    return;
                }

                await ensureWebContainer(ctx, state, runtime);
                setWebSessionAgentPromptCommand(state.webHistoryDir, runtime.containerName, runtime.agentPromptCommand);
                patchWebSessionHistory(state.webHistoryDir, runtime.containerName, {
                    applied: runtime.applied
                });
                sendJson(res, 200, { name: runtime.containerName, applied: runtime.applied });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agents$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                const agentSession = createWebAgentSession(history);
                saveWebSessionHistory(state.webHistoryDir, sessionRef.containerName, history);
                sendJson(res, 200, {
                    name: buildWebSessionKey(sessionRef.containerName, agentSession.agentId),
                    containerName: sessionRef.containerName,
                    agentId: agentSession.agentId,
                    agentName: agentSession.agentName
                });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/messages$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                const agentSession = getWebAgentSession(history, sessionRef.agentId)
                    || createEmptyWebAgentSession(sessionRef.agentId);
                sendJson(res, 200, {
                    name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
                    containerName: sessionRef.containerName,
                    agentId: sessionRef.agentId,
                    messages: agentSession.messages
                });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/fs\/list$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const requestUrl = new URL(req.url || '/api/sessions/x/fs/list', 'http://localhost');
                const targetPath = String(requestUrl.searchParams.get('path') || '/').trim() || '/';

                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                const payload = await execJsonCommandInWebContainer(
                    ctx,
                    sessionRef.containerName,
                    buildContainerFileListCommand(targetPath)
                );
                if (payload && payload.error) {
                    sendJson(res, 400, { error: payload.error });
                    return;
                }
                sendJson(res, 200, payload);
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/fs\/read$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const requestUrl = new URL(req.url || '/api/sessions/x/fs/read', 'http://localhost');
                const targetPath = String(requestUrl.searchParams.get('path') || '').trim();
                const fullRequested = ['1', 'true', 'yes'].includes(String(requestUrl.searchParams.get('full') || '').toLowerCase());
                if (!targetPath) {
                    sendJson(res, 400, { error: 'path 不能为空' });
                    return;
                }

                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                const payload = await execJsonCommandInWebContainer(
                    ctx,
                    sessionRef.containerName,
                    buildContainerFileReadCommand(targetPath, {
                        maxBytes: fullRequested ? 0 : WEB_FILE_PREVIEW_MAX_BYTES
                    })
                );
                if (payload && payload.error) {
                    sendJson(res, 400, { error: payload.error });
                    return;
                }
                if (payload && payload.kind === 'text') {
                    payload.language = inferFileLanguage(payload.path);
                    payload.editable = payload.truncated !== true
                        && Number(payload.size || 0) < WEB_FILE_EDIT_MAX_BYTES;
                }
                sendJson(res, 200, payload);
            }
        },
        {
            method: 'PUT',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/fs\/write$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const payload = await readJsonBody(req);
                const targetPath = String(payload && payload.path ? payload.path : '').trim();
                const content = typeof payload.content === 'string' ? payload.content : null;
                if (!targetPath) {
                    sendJson(res, 400, { error: 'path 不能为空' });
                    return;
                }
                if (content === null) {
                    sendJson(res, 400, { error: 'content 必须是字符串' });
                    return;
                }
                if (Buffer.byteLength(content, 'utf8') >= WEB_FILE_EDIT_MAX_BYTES) {
                    sendJson(res, 400, { error: '文件过大，当前仅支持编辑小于 2MB 的文本文件' });
                    return;
                }

                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                const result = await execJsonCommandInWebContainer(
                    ctx,
                    sessionRef.containerName,
                    buildContainerFileWriteCommand(targetPath, content)
                );
                if (result && result.error) {
                    sendJson(res, 400, { error: result.error });
                    return;
                }
                sendJson(res, 200, result);
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/fs\/mkdir$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const payload = await readJsonBody(req);
                const targetPath = String(payload && payload.path ? payload.path : '').trim();
                if (!targetPath) {
                    sendJson(res, 400, { error: 'path 不能为空' });
                    return;
                }

                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                const result = await execJsonCommandInWebContainer(
                    ctx,
                    sessionRef.containerName,
                    buildContainerFileMkdirCommand(targetPath)
                );
                if (result && result.error) {
                    sendJson(res, 400, { error: result.error });
                    return;
                }
                sendJson(res, 200, result);
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/detail$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }

                const containerMap = listWebManyoyoContainers(ctx);
                const detail = buildSessionDetail(ctx, state, containerMap, sessionRef);
                sendJson(res, 200, { name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId), detail });
            }
        },
        {
            method: 'PUT',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agent-template$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }

                let payload = null;
                try {
                    payload = await readJsonBody(req);
                } catch (e) {
                    sendJson(res, 400, { error: e.message || '请求参数错误' });
                    return;
                }
                const normalizedPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
                const hasContainerTemplate = hasOwn(normalizedPayload, 'containerAgentPromptCommand');
                const hasAgentOverride = hasOwn(normalizedPayload, 'agentPromptCommandOverride');
                if (!hasContainerTemplate && !hasAgentOverride) {
                    sendJson(res, 400, { error: '至少提供一个模板字段' });
                    return;
                }
                if (hasAgentOverride && sessionRef.agentId === WEB_DEFAULT_AGENT_ID) {
                    sendJson(res, 400, { error: '默认 AGENT 不支持单独覆盖模板，请直接修改容器模板' });
                    return;
                }

                try {
                    if (hasContainerTemplate) {
                        setWebSessionAgentPromptCommand(
                            state.webHistoryDir,
                            sessionRef.containerName,
                            normalizedPayload.containerAgentPromptCommand
                        );
                    }
                    if (hasAgentOverride) {
                        setWebAgentSessionPromptCommand(
                            state.webHistoryDir,
                            sessionRef,
                            normalizedPayload.agentPromptCommandOverride
                        );
                    }
                } catch (e) {
                    sendJson(res, 400, { error: e.message || '保存 Agent 模板失败' });
                    return;
                }

                const containerMap = listWebManyoyoContainers(ctx);
                const detail = buildSessionDetail(ctx, state, containerMap, sessionRef);
                sendJson(res, 200, {
                    saved: true,
                    name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
                    detail
                });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/run$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }

                const payload = await readJsonBody(req);
                const command = (payload.command || '').trim();
                if (!command) {
                    sendJson(res, 400, { error: 'command 不能为空' });
                    return;
                }

                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                appendWebSessionMessage(state.webHistoryDir, sessionRef, 'user', command);
                const result = await execCommandInWebContainer(ctx, sessionRef.containerName, command);
                appendWebSessionMessage(
                    state.webHistoryDir,
                    sessionRef,
                    'assistant',
                    result.output,
                    { exitCode: result.exitCode }
                );
                sendJson(res, 200, { exitCode: result.exitCode, output: result.output });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agent$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }

                const payload = await readJsonBody(req);
                const prompt = (payload.prompt || '').trim();
                if (!prompt) {
                    sendJson(res, 400, { error: 'prompt 不能为空' });
                    return;
                }

                let prepared = null;
                try {
                    prepared = await prepareWebAgentExecution(ctx, state, sessionRef, prompt);
                } catch (e) {
                    sendJson(res, 400, { error: e && e.message ? e.message : 'Agent 执行准备失败' });
                    return;
                }

                const { agentSession, agentMeta, command, contextMode, resumeAttempted, resumeSucceeded, resumeError } = prepared;
                appendWebSessionMessage(state.webHistoryDir, sessionRef, 'user', prompt, {
                    mode: 'agent',
                    contextMode
                });
                const result = await execCommandInWebContainer(ctx, sessionRef.containerName, command, {
                    agentProgram: agentMeta.agentProgram
                });
                finalizeWebAgentExecution(state, sessionRef, agentSession, agentMeta, {
                    contextMode,
                    resumeAttempted,
                    resumeSucceeded,
                    resumeError
                }, result);
                sendJson(res, 200, {
                    exitCode: result.exitCode,
                    output: result.output,
                    contextMode,
                    resumeAttempted,
                    resumeSucceeded,
                    interrupted: result.interrupted === true
                });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agent\/stream$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }

                const payload = await readJsonBody(req);
                const prompt = (payload.prompt || '').trim();
                if (!prompt) {
                    sendJson(res, 400, { error: 'prompt 不能为空' });
                    return;
                }
                if (state.agentRuns.has(sessionRef.containerName)) {
                    sendJson(res, 409, { error: '当前会话已有运行中的 agent 任务' });
                    return;
                }

                const userMessage = appendWebSessionMessage(state.webHistoryDir, sessionRef, 'user', prompt, {
                    mode: 'agent',
                    pending: true
                });
                const traceMessage = appendWebAgentTraceMessage(
                    state.webHistoryDir,
                    sessionRef,
                    '[执行过程]\n等待 Agent 启动…',
                    {
                        traceEvents: [],
                        pending: true
                    }
                );

                let prepared = null;
                try {
                    prepared = await prepareWebAgentExecution(ctx, state, sessionRef, prompt);
                } catch (e) {
                    removeWebSessionMessage(state.webHistoryDir, sessionRef, traceMessage && traceMessage.id);
                    removeWebSessionMessage(state.webHistoryDir, sessionRef, userMessage && userMessage.id);
                    sendJson(res, 400, { error: e && e.message ? e.message : 'Agent 执行准备失败' });
                    return;
                }

                const { agentSession, agentMeta, command, contextMode, resumeAttempted, resumeSucceeded, resumeError } = prepared;
                const traceLines = ['[执行过程]'];
                const traceEvents = [];
                let streamingReplyMessageId = '';
                patchWebSessionMessage(state.webHistoryDir, sessionRef, userMessage && userMessage.id, {
                    pending: true,
                    contextMode
                });

                res.writeHead(200, {
                    'Content-Type': 'application/x-ndjson; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'X-Accel-Buffering': 'no'
                });
                sendNdjson(res, {
                    type: 'meta',
                    containerName: sessionRef.containerName,
                    sessionName: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
                    contextMode,
                    resumeAttempted,
                    resumeSucceeded,
                    agentProgram: agentMeta.agentProgram
                });
                if (contextMode) {
                    traceLines.push(`上下文模式: ${contextMode}`);
                }
                if (resumeAttempted) {
                    traceLines.push(resumeSucceeded ? '会话恢复成功' : '会话恢复失败，已回退到历史注入');
                }
                patchWebSessionMessage(state.webHistoryDir, sessionRef, traceMessage && traceMessage.id, {
                    content: traceLines.join('\n'),
                    traceEvents: traceEvents.slice(),
                    contextMode,
                    resumeAttempted,
                    resumeSucceeded,
                    pending: true
                });

                try {
                    const result = await execAgentInWebContainerStream(ctx, state, sessionRef, command, {
                        agentProgram: agentMeta.agentProgram,
                        onEvent: event => {
                            if (event && event.type === 'trace' && event.text) {
                                traceLines.push(String(event.text));
                                if (event.traceEvent && typeof event.traceEvent === 'object') {
                                    traceEvents.push(event.traceEvent);
                                }
                                patchWebSessionMessage(state.webHistoryDir, sessionRef, traceMessage && traceMessage.id, {
                                    content: traceLines.join('\n'),
                                    traceEvents: traceEvents.slice(),
                                    pending: true
                                });
                            }
                            if (event && event.type === 'content_delta' && typeof event.content === 'string') {
                                if (!streamingReplyMessageId) {
                                    const streamingReplyMessage = appendWebSessionMessage(
                                        state.webHistoryDir,
                                        sessionRef,
                                        'assistant',
                                        event.content,
                                        {
                                            mode: 'agent',
                                            streamingReply: true,
                                            pending: true
                                        }
                                    );
                                    streamingReplyMessageId = streamingReplyMessage && streamingReplyMessage.id
                                        ? streamingReplyMessage.id
                                        : '';
                                } else {
                                    patchWebSessionMessage(state.webHistoryDir, sessionRef, streamingReplyMessageId, {
                                        content: event.content,
                                        pending: true
                                    });
                                }
                            }
                            sendNdjson(res, event);
                        }
                    });
                    traceLines.push(result.interrupted === true ? '[任务] 已停止' : '[任务] 已完成');
                    patchWebSessionMessage(state.webHistoryDir, sessionRef, userMessage && userMessage.id, {
                        pending: false,
                        contextMode,
                        resumeAttempted,
                        resumeSucceeded
                    });
                    patchWebSessionMessage(state.webHistoryDir, sessionRef, traceMessage && traceMessage.id, {
                        content: traceLines.join('\n'),
                        traceEvents,
                        contextMode,
                        resumeAttempted,
                        resumeSucceeded,
                        interrupted: result.interrupted === true,
                        pending: false
                    });
                    if (streamingReplyMessageId) {
                        removeWebSessionMessage(state.webHistoryDir, sessionRef, streamingReplyMessageId);
                    }
                    finalizeWebAgentExecution(state, sessionRef, agentSession, agentMeta, {
                        contextMode,
                        resumeAttempted,
                        resumeSucceeded,
                        resumeError
                    }, result);
                    sendNdjson(res, {
                        type: 'result',
                        exitCode: result.exitCode,
                        output: result.output,
                        contextMode,
                        resumeAttempted,
                        resumeSucceeded,
                        interrupted: result.interrupted === true
                    });
                } catch (e) {
                    traceLines.push(`[错误] ${e && e.message ? e.message : 'Agent 执行失败'}`);
                    patchWebSessionMessage(state.webHistoryDir, sessionRef, userMessage && userMessage.id, {
                        pending: false,
                        contextMode,
                        resumeAttempted,
                        resumeSucceeded
                    });
                    patchWebSessionMessage(state.webHistoryDir, sessionRef, traceMessage && traceMessage.id, {
                        content: traceLines.join('\n'),
                        traceEvents,
                        contextMode,
                        resumeAttempted,
                        resumeSucceeded,
                        interrupted: true,
                        pending: false
                    });
                    if (streamingReplyMessageId) {
                        removeWebSessionMessage(state.webHistoryDir, sessionRef, streamingReplyMessageId);
                    }
                    sendNdjson(res, {
                        type: 'error',
                        error: e && e.message ? e.message : 'Agent 执行失败'
                    });
                } finally {
                    res.end();
                }
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agent\/stop$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const stopped = stopWebAgentRun(state, sessionRef.containerName);
                if (!stopped) {
                    sendJson(res, 404, { error: '当前会话没有运行中的 agent 任务' });
                    return;
                }
                sendJson(res, 200, { ok: true, stopping: true });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/remove$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }

                if (ctx.containerExists(sessionRef.containerName)) {
                    ctx.removeContainer(sessionRef.containerName);
                    appendWebSessionMessage(state.webHistoryDir, sessionRef, 'system', `容器 ${sessionRef.containerName} 已删除。`);
                }

                sendJson(res, 200, { removed: true, name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId) });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/remove-with-history$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }

                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                if (history.agents && typeof history.agents === 'object') {
                    if (sessionRef.agentId === WEB_DEFAULT_AGENT_ID) {
                        delete history.agents[WEB_DEFAULT_AGENT_ID];
                    } else {
                        delete history.agents[sessionRef.agentId];
                    }
                }
                if (!Object.keys(history.agents || {}).length && !ctx.containerExists(sessionRef.containerName)) {
                    removeWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                } else {
                    saveWebSessionHistory(state.webHistoryDir, sessionRef.containerName, history);
                }
                sendJson(res, 200, {
                    removedHistory: true,
                    name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId)
                });
            }
        }
    ];

    for (const route of routes) {
        if (route.method !== req.method) {
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
                if (!(assetName === 'app.css'
                    || assetName === 'app.js'
                    || assetName === 'markdown.css'
                    || assetName === 'markdown-renderer.js'
                    || assetName === 'file-browser.js'
                    || assetName === 'codemirror.bundle.js')) {
                    sendHtml(res, 404, '<h1>404 Not Found</h1>');
                    return;
                }
                sendStaticAsset(res, assetName);
                return;
            }

            const appVendorMatch = pathname.match(/^\/app\/vendor\/([A-Za-z0-9._-]+)$/);
            if (req.method === 'GET' && appVendorMatch) {
                const assetName = appVendorMatch[1];
                if (!(assetName === 'xterm.css' || assetName === 'xterm.js' || assetName === 'xterm-addon-fit.js' || assetName === 'marked.min.js')) {
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
            for (const session of state.terminalSessions.values()) {
                const ptyProcess = session && session.ptyProcess;
                if (ptyProcess && !ptyProcess.killed) {
                    try { ptyProcess.kill('SIGTERM'); } catch (e) {}
                }
            }
            state.terminalSessions.clear();
            for (const runState of state.agentRuns.values()) {
                const child = runState && runState.process;
                if (child && !child.killed) {
                    try { child.kill('SIGTERM'); } catch (e) {}
                }
            }
            state.agentRuns.clear();

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
