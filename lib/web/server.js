'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { consumeLoginToken, isLoopbackHost } = require('../login-token');
const http = require('http');
const WebSocket = require('ws');
const JSON5 = require('json5');
const { buildContainerRunArgs, hasNetworkArg } = require('../container-run');
const { buildContainerIntegration, mergeIntegration } = require('../plugin');
const { applyAptMirror } = require('../mirrors');
const { BUILTIN_AGENT_INSTRUCTIONS, buildAgentInstructions, composeSystemPrompt, SYSTEM_PROMPT_MAX_CHARS, toTomlBasicString } = require('../agent-instructions');
const containerState = require('../container-state');
const sessionMeta = require('./session-meta');
const gitChanges = require('./git-changes');
const { buildExecArgs, resolveContainerId, readMergedEnv } = require('../container-exec');
const { createNetworkManager, NETWORK_NAME } = require('../container-network');
const { normalizePolicy, isUnrestricted: isUnrestrictedPolicy } = require('../network-policy');
const { withEnvEndpoints, modelDomains, agentModelDomains } = require('../network-endpoints');
const { egressPaths, isSidecarName } = require('../egress-sidecar');
const { read: readDenied } = require('../egress-denied');
const { isBrowserBackground } = require('../browser-background');
const { createDeniedNotifier } = require('./denied-notify');
const { domainRuleAllows } = require('../network-policy');
const { createPortForwarder } = require('../port-forward');
const { createContainerManageRoutes, pendingRisks, STALE_PAGE_MESSAGE } = require('./container-manage');
const { resolveManageOptions } = require('../container-manage-options');
const { defaultPolicy, usesProxy } = require('../network-policy');
const { normalizeMirrors } = require('../runtime-normalizers');
const { estimateContainerCapacity } = require('../capacity');
const { extractAgentMessageFromCodexJsonl } = require('../codex-output');
const { findValueRangeByPath, applyTextReplacements, upsertValueByPath } = require('../json5-text-edit');
const { resolveRuntimeConfig } = require('../runtime-resolver');
const { AGENT_ENV_SCHEMA } = require('../init-config');
const { ensureImagePresent, pullImageProcess } = require('../image-pull');
const { waitForImport } = require('../offline-import');
const { baseRawOf, buildAgentConfigRaw, buildPasswordConfigRaw, shouldWriteMirrors, buildMirrorsConfigRaw, buildAgentInstructionsConfigRaw, buildBooleanConfigRaw } = require('../setup-config');
const { createImageAgentProbe } = require('../image-agents');
const { createAuthStore } = require('./auth-store');
const webUploads = require('./uploads');
const webSnapshots = require('./snapshots');
const webRewind = require('./rewind');
const { listSetupAgents, getConfiguredAgents, buildAgentRunProfile, classifyConnectionResult, redactSecrets, validateSetupPassword, listMirrorPresets } = require('../setup');
const { applyDoctorFixes } = require('../doctor');
const { writeConfigFileSecure } = require('../secure-file');
const { sanitizeSensitiveData, sanitizeServeLogText } = require('../serve-log');
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
const { resolveYoloCommand: resolveYoloCommandFromAdapters } = require('../agent-adapters');
const {
    createControlEvent,
    validateControlEvent,
    projectSessionEvents
} = require('../core/events');
const { FileEventStore } = require('../core/event-store');
const historyStore = require('./history-store');
const messagesView = require('./messages-view');
const agentRunControl = require('./agent-run-control');
const agentQueue = require('./agent-queue');
const { EventEmitter } = require('events');
const zlib = require('zlib');
const { buildManyoyoLogPath, getLocalDateTag } = require('../log-path');
const { isValidLogDateTag, readServeLogEntries } = require('../serve-log-reader');


const WEB_HISTORY_MAX_MESSAGES = 500;
const WEB_OUTPUT_MAX_CHARS = 16000;
const WEB_TERMINAL_MAX_SESSIONS = 20;
const WEB_TERMINAL_FORCE_KILL_MS = 2000;
const WEB_TERMINAL_DEFAULT_COLS = 120;
const WEB_TERMINAL_DEFAULT_ROWS = 36;
const WEB_TERMINAL_MIN_COLS = 40;
const WEB_TERMINAL_MIN_ROWS = 12;
// resize 的下限比建连时的 40×12 低：手机竖屏的真实列数可以小于 40，夹到 40 容器就会比网页宽、行尾被切
const WEB_TERMINAL_RESIZE_MIN_COLS = 10;
const WEB_TERMINAL_RESIZE_MIN_ROWS = 4;
const WEB_TERMINAL_MAX_COLS = 500;
const WEB_TERMINAL_MAX_ROWS = 200;
// resize 节流：窗口拖动时前端虽有防抖，服务端仍保证两次容器内 stty 之间至少隔这么久
const WEB_TERMINAL_RESIZE_MIN_INTERVAL_MS = 150;
const WEB_TERMINAL_ID_PATTERN = /^[0-9a-f]{16}$/;
// 终端 WebSocket 空闲心跳：纯交互式终端可能长时间没有任何数据，
// 反向代理 / 移动网络的空闲超时（常见 60s）会悄悄掐断连接，这里定期发 ping
// 帧制造流量。判死放宽到连续 3 次没回 pong（约 90s），手机切后台导致连接被
// 系统短暂挂起时不至于被误杀——误杀意味着容器里的 shell 直接没了
const WEB_TERMINAL_PING_INTERVAL_MS = 30000;
const WEB_TERMINAL_MAX_MISSED_PONGS = 3;
const WEB_AGENT_CONTEXT_MAX_MESSAGES = 24;
const WEB_AGENT_CONTEXT_MAX_CHARS = 6000;
const WEB_AGENT_CONTEXT_PER_MESSAGE_MAX_CHARS = 600;
// 支持按 Web Agent 保存的引擎会话 ID 原生续接，避免历史文本被截断。
const NATIVE_SESSION_RESUME_PROGRAMS = new Set(['claude', 'codex', 'opencode']);
const WEB_FILE_PREVIEW_MAX_BYTES = 512 * 1024;
const WEB_FILE_EDIT_MAX_BYTES = 2 * 1024 * 1024;
const WEB_FILE_RAW_MAX_CONCURRENT_PER_CONTAINER = 4;
const WEB_FS_LIST_MAX_LIMIT = 200;
const IMAGE_EXTENSION_CONTENT_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon'
};
const WEB_AUTH_COOKIE_NAME = 'manyoyo_web_auth';
const WEB_AUTH_TTL_SECONDS = 12 * 60 * 60;
const WEB_SESSION_KEY_SEPARATOR = '~';
const WEB_DEFAULT_AGENT_ID = 'default';
const WEB_DEFAULT_AGENT_NAME = 'AGENT 1';
const WEB_CONFIG_KEEP_SECRET_PLACEHOLDER = '***HIDDEN_SECRET***';
// 取 15s 是为了在 nginx proxy_read_timeout 默认 60s 下留足余量（即便某次心跳
// 因事件循环繁忙被推迟，也还有三次机会），同时不至于把 NDJSON 流刷得太碎
const DEFAULT_AGENT_STREAM_HEARTBEAT_MS = 15 * 1000;
// token 级增量的历史落盘节流：写盘只为断线/刷新后能对账恢复，不需要逐 token 持久化
const AGENT_STREAM_PARTIAL_PERSIST_INTERVAL_MS = 1000;
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const SAFE_CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const IMAGE_VERSION_TAG_PATTERN = /^(\d+\.\d+\.\d+)-([A-Za-z0-9][A-Za-z0-9_.-]*)$/;
const SENSITIVE_CONFIG_KEY_PATTERN = /(pass(word)?|passwd|secret|token|api(?:_|-)?key|auth(?:_|-)?token|oauth(?:_|-)?token)$/i;
const REDACTED_CONFIG_VALUE = '***';

const DEFAULT_WEB_CONFIG_TEMPLATE = `{
    // MANYOYO 全局配置文件（JSON5）
    "containerName": "my-dev",
    "hostPath": "/path/to/your/project",
    "containerPath": "/path/to/your/project",
    "imageName": "ghcr.io/xcanwin/manyoyo",
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

const WEB_REMARK_MAX_LENGTH = 200;

function normalizeRemarkText(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.trim().slice(0, WEB_REMARK_MAX_LENGTH);
}

function createEmptyWebAgentSession(agentId, agentName) {
    return {
        agentId,
        agentName: normalizeWebAgentName(agentId, agentName),
        agentPromptCommand: '',
        remark: '',
        archived: false,
        createdAt: null,
        updatedAt: null,
        messages: [],
        // 稳定前缀被改动时（删除非 pending 消息、克隆）必须换新值，增量同步据此让前端整页重置
        epoch: messagesView.createEpoch(),
        events: [],
        lastResumeAt: null,
        lastResumeOk: null,
        lastResumeError: '',
        engineSessionId: '',
        usageTotal: null,
        model: '',
        queue: [],
        queuePaused: false,
        title: '',
        firstPrompt: '',
        pinned: false,
        slashCommands: null,
        // 回退对话后，下一轮 Claude 命令带 --resume-session-at <uuid>（只用一次）
        rewindToUuid: ''
    };
}

function normalizeWebAgentUsageTotal(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    if (typeof value.inputTokens !== 'number' || typeof value.outputTokens !== 'number') {
        return null;
    }
    if (typeof value.costUsd !== 'number' && value.costUsd !== null) {
        return null;
    }
    return {
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        costUsd: typeof value.costUsd === 'number' ? value.costUsd : null
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
        remark: normalizeRemarkText(source.remark),
        archived: source.archived === true,
        createdAt: typeof source.createdAt === 'string' ? source.createdAt : null,
        updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
        messages: Array.isArray(source.messages) ? source.messages : [],
        epoch: typeof source.epoch === 'string' && /^[0-9a-f]{8,32}$/.test(source.epoch)
            ? source.epoch
            : messagesView.createEpoch(),
        events: Array.isArray(source.events)
            ? source.events.filter(event => {
                try {
                    validateControlEvent(event);
                    return true;
                } catch (e) {
                    return false;
                }
            })
            : [],
        lastResumeAt: typeof source.lastResumeAt === 'string' ? source.lastResumeAt : null,
        lastResumeOk: typeof source.lastResumeOk === 'boolean' ? source.lastResumeOk : null,
        lastResumeError: typeof source.lastResumeError === 'string' ? source.lastResumeError : '',
        engineSessionId: typeof source.engineSessionId === 'string' ? source.engineSessionId : '',
        usageTotal: normalizeWebAgentUsageTotal(source.usageTotal),
        model: normalizeStoredAgentModelValue(source.model),
        queue: agentQueue.normalizeStoredQueue(source.queue),
        queuePaused: source.queuePaused === true,
        title: sessionMeta.normalizeTitle(source.title),
        firstPrompt: sessionMeta.normalizeFirstPrompt(source.firstPrompt),
        pinned: source.pinned === true,
        slashCommands: normalizeStoredSlashCommands(source.slashCommands),
        rewindToUuid: typeof source.rewindToUuid === 'string' && webRewind.UUID_PATTERN.test(source.rewindToUuid) ? source.rewindToUuid : ''
    };
}

// claude 每次运行开头的 init 事件里带的命令列表：all 是全部，skills 是其中的 skill，terminal 是只在终端里可用的
function normalizeStoredSlashCommands(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return {
        all: sessionMeta.normalizeSlashCommands(value.all),
        skills: sessionMeta.normalizeSlashCommands(value.skills),
        terminal: sessionMeta.normalizeSlashCommands(value.terminal)
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
    const runtimeSnapshot = data.runtimeSnapshot && typeof data.runtimeSnapshot === 'object' && !Array.isArray(data.runtimeSnapshot)
        ? data.runtimeSnapshot
        : null;
    const history = {
        containerName,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
        agentPromptCommand: resolveEffectiveAgentPromptCommand(
            typeof data.agentPromptCommand === 'string' ? data.agentPromptCommand : '',
            applied
        ),
        remark: normalizeRemarkText(data.remark),
        applied,
        // 服务端内部字段，绝不能被 buildSessionSummary/buildSessionDetail/buildSessionAudit 引用或透传给前端。
        runtimeSnapshot,
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

    if (!Object.keys(history.agents).length && Array.isArray(data.messages) && data.messages.length > 0) {
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
    const cached = historyStore.read(filePath, raw => normalizeWebHistoryRecord(containerName, raw));
    return cached ? cached.value : normalizeWebHistoryRecord(containerName, {});
}

// 同一历史的内存版本号，/messages 的 ETag 用它（不用 mtime：同一毫秒内的两次写入会撞）
function getWebSessionHistoryVersion(webHistoryDir, containerName) {
    return historyStore.getVersion(getWebHistoryFile(webHistoryDir, containerName));
}

function serializeWebHistory(history) {
    const runtimeMeta = getAgentRuntimeMeta(history.agentPromptCommand || '');
    return JSON.stringify({
        ...history,
        agentProgram: runtimeMeta.agentProgram || '',
        resumeSupported: runtimeMeta.resumeSupported === true
    });
}

// defer: 只改内存缓存，最迟 1 秒后落盘（流式过程中的 trace 快照用）；不传则立即原子写
function saveWebSessionHistory(webHistoryDir, containerName, history, options = {}) {
    ensureWebHistoryDir(webHistoryDir);
    const filePath = getWebHistoryFile(webHistoryDir, containerName);
    const value = options.defer === true ? history : normalizeWebHistoryRecord(containerName, history);
    historyStore.write(filePath, value, serializeWebHistory, { defer: options.defer === true });
}

function flushWebSessionHistories() {
    historyStore.flushAll();
}

function removeWebSessionHistory(webHistoryDir, containerName) {
    ensureWebHistoryDir(webHistoryDir);
    const filePath = getWebHistoryFile(webHistoryDir, containerName);
    historyStore.remove(filePath);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

// 容器可能已经被删过一次（例如并发请求、或用户对着一条"仅历史"幽灵条目重复点删除），
// containerExists 和真正执行删除之间存在竞态，因此仍需 try/catch 兜底，
// 吞掉"已经不存在"这一类错误，让操作保持幂等。
function removeContainerIdempotent(ctx, containerName) {
    if (!ctx.containerExists(containerName)) {
        return { removedContainer: false };
    }
    try {
        ctx.removeContainer(containerName);
        return { removedContainer: true };
    } catch (e) {
        return { removedContainer: false, error: e };
    }
}

function removeAllAgentHistoryArtifacts(webHistoryDir, containerName, agentIds) {
    const eventStore = new FileEventStore(webHistoryDir);
    (Array.isArray(agentIds) ? agentIds : []).forEach(agentId => {
        const aggregateId = buildWebSessionKey(containerName, agentId);
        controlEventSeqCache.delete(`${path.resolve(webHistoryDir)}|${aggregateId}`);
        eventStore.remove(aggregateId);
    });
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

function isVisibleWebAgentSession(agentSession) {
    return Boolean(agentSession) && agentSession.archived !== true;
}

function getWebAgentSession(history, agentId, options = {}) {
    const sessionHistory = history && typeof history === 'object' ? history : { agents: {} };
    if (!sessionHistory.agents || typeof sessionHistory.agents !== 'object' || Array.isArray(sessionHistory.agents)) {
        sessionHistory.agents = {};
    }
    const requestedAgentId = String(agentId || WEB_DEFAULT_AGENT_ID).trim() || WEB_DEFAULT_AGENT_ID;
    const existing = sessionHistory.agents[requestedAgentId];
    if (isVisibleWebAgentSession(existing) || (options.includeArchived === true && Boolean(existing))) {
        return existing;
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
    const visibleSessions = Object.keys(agents)
        .map(agentId => agents[agentId])
        .filter(agentSession => isVisibleWebAgentSession(agentSession) || (options.includeArchived === true && Boolean(agentSession)));
    if (!visibleSessions.length && options.includeSyntheticDefault === true) {
        return [{ ...createEmptyWebAgentSession(WEB_DEFAULT_AGENT_ID), synthetic: true }];
    }
    return visibleSessions.sort((a, b) => {
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
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true, includeArchived: true });
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
    // 首条 Agent 对话消息只记一次，作为没有标题时的会话名（消息会被裁剪，不能现算）
    if (role === 'user' && extra.mode !== 'command' && !agentSession.firstPrompt) {
        agentSession.firstPrompt = sessionMeta.normalizeFirstPrompt(content);
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

// 事件日志（FileEventStore）每条事件立即追加，而历史快照里的 events 是合并写盘的（强杀后可能落后）。
// seq 必须以日志为准：进程内记住每个 aggregate 最后追加的 seq，第一次用时从日志读一次。
const controlEventSeqCache = new Map();

function resolveNextControlSeq(eventStore, cacheKey, aggregateId, snapshotEvents, refresh) {
    let last = refresh ? undefined : controlEventSeqCache.get(cacheKey);
    if (last === undefined) {
        const logged = eventStore.read(aggregateId);
        if (logged.length) {
            last = logged[logged.length - 1].seq;
        } else {
            // 日志为空：只有旧版本留下的历史快照里有事件，沿用它的 seq
            const lastSnapshot = snapshotEvents.length ? snapshotEvents[snapshotEvents.length - 1] : null;
            last = lastSnapshot ? lastSnapshot.seq : 0;
        }
    }
    return last + 1;
}

function appendWebSessionControlEvent(webHistoryDir, sessionRef, type, data = {}, options = {}) {
    const history = loadWebSessionHistory(webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true, includeArchived: true });
    const events = Array.isArray(agentSession.events) ? agentSession.events : [];
    const aggregateId = buildWebSessionKey(sessionRef.containerName, sessionRef.agentId);
    const cacheKey = `${path.resolve(webHistoryDir)}|${aggregateId}`;
    const eventStore = new FileEventStore(webHistoryDir);
    let event = null;
    for (let attempt = 0; attempt < 2 && !event; attempt += 1) {
        const candidate = createControlEvent({
            type,
            aggregateId,
            seq: resolveNextControlSeq(eventStore, cacheKey, aggregateId, events, attempt > 0),
            data
        });
        try {
            eventStore.append(candidate);
            event = candidate;
        } catch (error) {
            // 缓存的 seq 与日志对不上（日志被别处改过）：丢掉缓存按日志重算一次
            controlEventSeqCache.delete(cacheKey);
            if (attempt > 0) {
                throw error;
            }
        }
    }
    controlEventSeqCache.set(cacheKey, event.seq);
    agentSession.events = [...events, event].slice(-WEB_HISTORY_MAX_MESSAGES);
    agentSession.updatedAt = event.timestamp;
    history.updatedAt = event.timestamp;
    saveWebSessionHistory(webHistoryDir, sessionRef.containerName, history, { defer: options.defer === true });
    return event;
}

function loadWebSessionControlEvents(webHistoryDir, sessionRef, fallbackEvents = []) {
    try {
        const events = new FileEventStore(webHistoryDir).read(
            buildWebSessionKey(sessionRef.containerName, sessionRef.agentId)
        );
        if (events.length) {
            return events;
        }
    } catch (error) {
        // 旧 history 快照仍可作为只读恢复源；写入路径始终以日志为准。
    }
    return Array.isArray(fallbackEvents) ? fallbackEvents : [];
}

function patchWebSessionMessage(webHistoryDir, sessionRefOrContainerName, messageId, patch, options = {}) {
    const sessionRef = typeof sessionRefOrContainerName === 'string'
        ? { containerName: sessionRefOrContainerName, agentId: WEB_DEFAULT_AGENT_ID }
        : sessionRefOrContainerName;
    const targetId = String(messageId || '').trim();
    if (!targetId) {
        return null;
    }
    const history = loadWebSessionHistory(webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true, includeArchived: true });
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
    saveWebSessionHistory(webHistoryDir, sessionRef.containerName, history, { defer: options.defer === true });
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
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true, includeArchived: true });
    const index = agentSession.messages.findIndex(item => item && String(item.id || '') === targetId);
    if (index === -1) {
        return null;
    }
    const removed = agentSession.messages.splice(index, 1)[0] || null;
    if (removed && removed.pending !== true) {
        agentSession.epoch = messagesView.createEpoch();
    }
    const timestamp = new Date().toISOString();
    agentSession.updatedAt = timestamp;
    history.updatedAt = timestamp;
    saveWebSessionHistory(webHistoryDir, sessionRef.containerName, history);
    return removed;
}

// 删掉某条消息及之后的所有消息（回退对话）。改动的是稳定前缀，必须换新 epoch，增量同步据此让前端整页重置
function removeWebSessionMessagesFrom(webHistoryDir, sessionRef, messageId) {
    const history = loadWebSessionHistory(webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true });
    if (!agentSession) {
        return [];
    }
    const index = agentSession.messages.findIndex(item => item && String(item.id || '') === String(messageId));
    if (index === -1) {
        return [];
    }
    const removed = agentSession.messages.splice(index);
    agentSession.epoch = messagesView.createEpoch();
    const timestamp = new Date().toISOString();
    agentSession.updatedAt = timestamp;
    history.updatedAt = timestamp;
    saveWebSessionHistory(webHistoryDir, sessionRef.containerName, history);
    return removed;
}

// 从页面隐藏 / 取消隐藏某一组（用户消息 + 它的执行过程 + 回复）：只改展示，agent 仍记得
function setWebSessionTurnHidden(webHistoryDir, sessionRef, userMessageId, hidden) {
    const history = loadWebSessionHistory(webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true });
    if (!agentSession) {
        return 0;
    }
    const start = agentSession.messages.findIndex(item => item && String(item.id || '') === String(userMessageId) && item.role === 'user');
    if (start === -1) {
        return 0;
    }
    let end = start + 1;
    while (end < agentSession.messages.length && agentSession.messages[end].role !== 'user') {
        end += 1;
    }
    for (let i = start; i < end; i += 1) {
        if (hidden) agentSession.messages[i].hidden = true;
        else delete agentSession.messages[i].hidden;
    }
    agentSession.epoch = messagesView.createEpoch();
    const timestamp = new Date().toISOString();
    agentSession.updatedAt = timestamp;
    history.updatedAt = timestamp;
    saveWebSessionHistory(webHistoryDir, sessionRef.containerName, history);
    return end - start;
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
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true, includeArchived: true });
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
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true, includeArchived: true });
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

// Agent 原始输出只保留开头 AGENT_RAW_OUTPUT_MAX_CHARS（会话 id 在开头），另外保留一份结尾：
// 最终回复和用量都在输出末尾，超过上限后只看开头会把截断点之前的某条中间说明当成最终回复
const AGENT_RAW_OUTPUT_MAX_CHARS = 32 * 1024 * 1024;
const AGENT_OUTPUT_TAIL_MAX_CHARS = 8 * 1024 * 1024;
// 最终回复的上限：远大于正常回复，只挡住把整个文件当回复打出来的极端情况
const AGENT_FINAL_REPLY_MAX_CHARS = 1000000;

function createTailBuffer(maxChars) {
    let parts = [];
    let size = 0;
    return {
        push(text) {
            if (!text) return;
            parts.push(text);
            size += text.length;
            if (size > maxChars * 2) {
                const joined = parts.join('').slice(-maxChars);
                parts = [joined];
                size = joined.length;
            }
        },
        text() {
            return parts.join('').slice(-maxChars);
        }
    };
}

// 结束后的回复文本：结构化输出里提取到的最终回复按 AGENT_FINAL_REPLY_MAX_CHARS（远大于正常回复）保留；
// 提取不到才退回原始输出，原始输出按 WEB_OUTPUT_MAX_CHARS 截断
function resolveAgentFinalOutput(agentProgram, { stdout, stdoutTruncated, stdoutTail, raw }) {
    const extracted = (stdoutTruncated ? extractAgentMessageFromStructuredOutput(agentProgram, stdoutTail) : '')
        || extractAgentMessageFromStructuredOutput(agentProgram, stdout);
    if (extracted) {
        return clipText(stripAnsi(extracted).trim(), AGENT_FINAL_REPLY_MAX_CHARS);
    }
    return clipText(stripAnsi(raw).trim() || '(无输出)');
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
    // 用函数返回替换值：字符串形式会把提示词里的 $' $` $& 当成替换模式
    return templateText.replace(/\{prompt\}/g, () => safePrompt);
}

function buildCodexAgentExecCommand(template, prompt, options = {}) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const sessionId = options && typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
    const model = options && typeof options.model === 'string' ? options.model.trim() : '';
    const execMatch = templateText.match(
        /^((?:(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s+)*)codex\s+exec\b/
    );
    let codexTemplate = templateText;
    if (execMatch) {
        const prefix = execMatch[1] || '';
        const suffix = templateText.slice(execMatch[0].length);
        const hasJson = /(?:^|\s)--json(?:\s|$)/.test(suffix);
        const injectedFlags = hasJson ? '' : ' --json';
        const hasModel = /(?:^|\s)(?:-m|--model)(?:\s|$)/.test(suffix);
        const modelFlag = model && !hasModel ? ` --model ${quoteBashSingleValue(model)}` : '';
        // 环境说明：模板里已经写了 developer_instructions 就以用户的为准
        const instructions = options && typeof options.instructions === 'string' ? options.instructions : '';
        // 图片：--image=<路径>（等号形式只吃这一个值，不会把后面的提示词当成图片）；resume 子命令同样支持
        const images = options && Array.isArray(options.images) ? options.images : [];
        const imageFlags = images.map(item => ` --image=${quoteBashSingleValue(item)}`).join('');
        const instructionsFlag = instructions && !/developer_instructions/.test(suffix)
            ? ` -c ${quoteBashSingleValue(`developer_instructions=${toTomlBasicString(instructions)}`)}`
            : '';
        if (sessionId) {
            const promptIndex = suffix.indexOf('{prompt}');
            const resumeSuffix = `${suffix.slice(0, promptIndex)}${quoteBashSingleValue(sessionId)} ${suffix.slice(promptIndex)}`;
            codexTemplate = `${prefix}codex exec resume${injectedFlags}${modelFlag}${instructionsFlag}${imageFlags}${resumeSuffix}`;
        } else {
            codexTemplate = `${prefix}codex exec${injectedFlags}${modelFlag}${instructionsFlag}${imageFlags}${suffix}`;
        }
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
    // “模板里是否已经写了这个参数”只看原模板：插进去的参数值（比如环境说明正文里的 “-r”）不能让后面的参数被跳过
    const original = matched[matched.length - 1] || '';
    let suffix = original;
    for (let i = flagSpecs.length - 1; i >= 0; i -= 1) {
        const spec = flagSpecs[i];
        if (!spec || !spec.flag || !(spec.pattern instanceof RegExp) || spec.pattern.test(original)) {
            continue;
        }
        suffix = ` ${spec.flag}${suffix}`;
    }
    return `${prefix}${suffix}`;
}

function buildClaudeAgentExecCommand(template, prompt, options = {}) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const flagSpecs = [
        { flag: '--verbose', pattern: /(?:^|\s)--verbose(?:\s|$)/ },
        { flag: '--output-format stream-json', pattern: /(?:^|\s)--output-format(?:\s|$)/ },
        // 没有这个 flag 时 claude 只在整条 assistant 消息生成完之后才吐一行 JSON：
        // 一段几千字的回答会静默几十秒再一次性刷出来，用户看到的"执行过程"是分批跳变的。
        // 带上之后会额外输出 stream_event/content_block_delta 的 token 级增量
        //（解析见 extractContentDeltaFromPayload）
        { flag: '--include-partial-messages', pattern: /(?:^|\s)--include-partial-messages(?:\s|$)/ }
    ];
    const sessionId = options && typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
    if (sessionId) {
        flagSpecs.push({ flag: `-r ${sessionId}`, pattern: /(?:^|\s)-r(?:\s|$)/ });
    }
    const resumeAtUuid = options && typeof options.resumeAtUuid === 'string' && webRewind.UUID_PATTERN.test(options.resumeAtUuid) ? options.resumeAtUuid : '';
    if (sessionId && resumeAtUuid) {
        flagSpecs.push({ flag: `--resume-session-at ${resumeAtUuid}`, pattern: /(?:^|\s)--resume-session-at(?:\s|$)/ });
    }
    const model = options && typeof options.model === 'string' ? options.model.trim() : '';
    if (model) {
        flagSpecs.push({ flag: `--model ${quoteBashSingleValue(model)}`, pattern: /(?:^|\s)--model(?:\s|$)/ });
    }
    // 环境说明：追加在内置系统提示之后；模板里已经写了 --append-system-prompt(-file) 就以用户的为准
    const instructions = options && typeof options.instructions === 'string' ? options.instructions : '';
    if (instructions) {
        flagSpecs.push({
            flag: `--append-system-prompt ${quoteBashSingleValue(instructions)}`,
            pattern: /(?:^|\s)--append-system-prompt(?:-file)?(?:\s|$)/
        });
    }
    // 子 Agent 说的话和思考默认不转发（v2.1.211+ 才有 --forward-subagent-text，旧版本不认这个参数会直接报错）。
    // 'auto'：在容器里随命令探测（claude --help 约 50ms），支持就展开成这个参数、不支持展开成空；true：直接加。
    // 'auto' 的参数放在整条命令末尾，不改变前面已有参数的相对顺序
    const forwardSubagentText = options && options.forwardSubagentText;
    const templateHasForward = /(?:^|\s)--forward-subagent-text(?:\s|$)/.test(templateText);
    if (forwardSubagentText === true) {
        flagSpecs.push({ flag: '--forward-subagent-text', pattern: /(?:^|\s)--forward-subagent-text(?:\s|$)/ });
    }
    const claudeTemplate = prependAgentFlags(
        templateText,
        /^(((?:(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s+)*)claude\b)(.*)$/,
        flagSpecs
    );
    const rendered = claudeTemplate === templateText
        ? renderAgentPromptCommand(templateText, prompt)
        : renderAgentPromptCommand(claudeTemplate, prompt);
    if (forwardSubagentText === 'auto' && !templateHasForward) {
        return `MANYOYO_FWD_SUBAGENT="$(claude --help 2>&1 | grep -q -- '--forward-subagent-text' && echo --forward-subagent-text)"; ${rendered} $MANYOYO_FWD_SUBAGENT`;
    }
    return rendered;
}

function buildGeminiAgentExecCommand(template, prompt, options = {}) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const flagSpecs = [
        { flag: '--output-format stream-json', pattern: /(?:^|\s)--output-format(?:\s|$)/ }
    ];
    const model = options && typeof options.model === 'string' ? options.model.trim() : '';
    if (model) {
        flagSpecs.push({ flag: `--model ${quoteBashSingleValue(model)}`, pattern: /(?:^|\s)(?:-m|--model)(?:\s|$)/ });
    }
    const geminiTemplate = prependAgentFlags(
        templateText,
        /^(((?:(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s+)*)gemini\b)(.*)$/,
        flagSpecs
    );
    return geminiTemplate === templateText
        ? renderAgentPromptCommand(templateText, prompt)
        : renderAgentPromptCommand(geminiTemplate, prompt);
}

function buildOpenCodeAgentExecCommand(template, prompt, options = {}) {
    const templateText = normalizeAgentPromptCommandTemplate(template, 'agentPromptCommand');
    const sessionId = options && typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
    const flagSpecs = [
        { flag: '--format json', pattern: /(?:^|\s)--format(?:\s|$)/ }
    ];
    if (sessionId) {
        flagSpecs.push({
            flag: `--session ${quoteBashSingleValue(sessionId)}`,
            pattern: /(?:^|\s)(?:--session|-s)(?:\s|$)/
        });
    }
    const model = options && typeof options.model === 'string' ? options.model.trim() : '';
    if (model) {
        flagSpecs.push({ flag: `--model ${quoteBashSingleValue(model)}`, pattern: /(?:^|\s)(?:-m|--model)(?:\s|$)/ });
    }
    const opencodePattern = /^(((?:(?:[A-Za-z_][A-Za-z0-9_]*=)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)\s+)*)opencode\b.*?\s+run\b)(.*)$/;
    const opencodeTemplate = prependAgentFlags(templateText, opencodePattern, flagSpecs);
    const rendered = opencodeTemplate === templateText
        ? renderAgentPromptCommand(templateText, prompt)
        : renderAgentPromptCommand(opencodeTemplate, prompt);
    // 环境说明：opencode 的 instructions 只认文件路径。OPENCODE_CONFIG_CONTENT 会与用户自己的配置合并
    //（instructions 数组拼接，实测 1.19.3），用户已经设置了这个变量或在模板里写了它时不动
    const instructions = options && typeof options.instructions === 'string' ? options.instructions : '';
    if (!instructions || !opencodePattern.test(templateText) || /OPENCODE_CONFIG_CONTENT/.test(templateText)) {
        return rendered;
    }
    const file = '/tmp/manyoyo-agent-instructions.md';
    const content = quoteBashSingleValue(JSON.stringify({ instructions: [file] }));
    return `if [ -z "\${OPENCODE_CONFIG_CONTENT:-}" ]; then printf '%s' ${quoteBashSingleValue(instructions)} > ${file} && export OPENCODE_CONFIG_CONTENT=${content}; fi; ${rendered}`;
}

function buildWebAgentExecCommand(template, prompt, agentProgram, options = {}) {
    switch (agentProgram) {
    case 'claude':
        return buildClaudeAgentExecCommand(template, prompt, options);
    case 'gemini':
        return buildGeminiAgentExecCommand(template, prompt, options);
    case 'codex':
        return buildCodexAgentExecCommand(template, prompt, options);
    case 'opencode':
        return buildOpenCodeAgentExecCommand(template, prompt, options);
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
        // result 事件带权威的最终文本；后台任务场景结尾有两个 result（第一个是中间结论），取最后一个
        if (payload && payload.type === 'result' && typeof payload.result === 'string' && payload.result.trim()) {
            lastMessage = payload.result.trim();
            continue;
        }
        if (!payload || payload.type !== 'assistant' || pickFirstString(payload.parent_tool_use_id)) {
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
        const content = collectStructuredText(message.content || payload.content || payload.text || payload.part || payload);
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

function extractCodexThreadId(text) {
    for (const rawLine of String(text || '').split('\n')) {
        const payload = parseJsonObjectLine(rawLine);
        if (payload && payload.type === 'thread.started' && typeof payload.thread_id === 'string') {
            return payload.thread_id.trim();
        }
    }
    return '';
}

function extractClaudeSessionId(text) {
    for (const rawLine of String(text || '').split('\n')) {
        const payload = parseJsonObjectLine(rawLine);
        if (payload && payload.type === 'system' && payload.subtype === 'init' && typeof payload.session_id === 'string') {
            return payload.session_id.trim();
        }
    }
    return '';
}

function extractClaudeInitSlashCommands(text) {
    for (const rawLine of String(text || '').split('\n')) {
        const payload = parseJsonObjectLine(rawLine);
        if (payload && payload.type === 'system' && payload.subtype === 'init') {
            if (!Array.isArray(payload.slash_commands)) {
                return null;
            }
            return normalizeStoredSlashCommands({
                all: payload.slash_commands,
                skills: payload.skills,
                terminal: payload.terminal_slash_commands
            });
        }
    }
    return null;
}

function extractOpenCodeSessionId(text) {
    for (const rawLine of String(text || '').split('\n')) {
        const payload = parseJsonObjectLine(rawLine);
        const sessionId = payload && pickFirstString(payload.sessionID, payload.session_id);
        if (sessionId) {
            return sessionId;
        }
    }
    return '';
}

function extractEngineSessionId(agentProgram, text) {
    if (agentProgram === 'codex') {
        return extractCodexThreadId(text);
    }
    if (agentProgram === 'claude') {
        return extractClaudeSessionId(text);
    }
    if (agentProgram === 'opencode') {
        return extractOpenCodeSessionId(text);
    }
    return '';
}

function extractClaudeTurnUsage(text) {
    let result = null;
    for (const rawLine of String(text || '').split('\n')) {
        const payload = parseJsonObjectLine(rawLine);
        if (!payload || payload.type !== 'result') {
            continue;
        }
        const usage = toPlainObject(payload.usage);
        result = {
            inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
            outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
            costUsd: typeof payload.total_cost_usd === 'number' ? payload.total_cost_usd : null
        };
    }
    return result;
}

function extractCodexTurnUsage(text) {
    let result = null;
    for (const rawLine of String(text || '').split('\n')) {
        const payload = parseJsonObjectLine(rawLine);
        if (!payload || payload.type !== 'turn.completed') {
            continue;
        }
        const usage = toPlainObject(payload.usage);
        result = {
            inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
            outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
            costUsd: null
        };
    }
    return result;
}

function extractOpenCodeTurnUsage(text) {
    let result = null;
    for (const rawLine of String(text || '').split('\n')) {
        const payload = parseJsonObjectLine(rawLine);
        if (!payload || payload.type !== 'step_finish') {
            continue;
        }
        const part = toPlainObject(payload.part);
        const tokens = toPlainObject(part.tokens);
        result = {
            inputTokens: typeof tokens.input === 'number' ? tokens.input : null,
            outputTokens: typeof tokens.output === 'number' ? tokens.output : null,
            costUsd: typeof part.cost === 'number' ? part.cost : null
        };
    }
    return result;
}

// Gemini 的非交互 stream-json 输出目前没有已确认的 usage/token 字段可解析，故不返回数据（而非猜测字段名）。
function extractTurnUsage(agentProgram, text) {
    if (agentProgram === 'claude') {
        return extractClaudeTurnUsage(text);
    }
    if (agentProgram === 'codex') {
        return extractCodexTurnUsage(text);
    }
    if (agentProgram === 'opencode') {
        return extractOpenCodeTurnUsage(text);
    }
    return null;
}

function accumulateUsageTotal(baseline, turnUsage) {
    const base = baseline && typeof baseline === 'object'
        ? baseline
        : { inputTokens: 0, outputTokens: 0, costUsd: null };
    const baseCost = typeof base.costUsd === 'number' ? base.costUsd : null;
    const turnCost = typeof turnUsage.costUsd === 'number' ? turnUsage.costUsd : null;
    return {
        inputTokens: (base.inputTokens || 0) + (turnUsage.inputTokens || 0),
        outputTokens: (base.outputTokens || 0) + (turnUsage.outputTokens || 0),
        // 引擎从未上报过费用（如 Codex）时保持 null，不要伪装成"花费为 0"
        costUsd: baseCost === null && turnCost === null ? null : (baseCost || 0) + (turnCost || 0)
    };
}

// 所有进用户容器的 exec 都经这里：env 从状态目录现读（见 lib/container-exec.js），子进程结束后删临时 env 文件
function spawnContainerExec(ctx, containerName, execOptions, spawnOptions) {
    const exec = buildExecArgs({ homeDir: ctx.homeDir || os.homedir(), dockerExecArgs: ctx.dockerExecArgs }, containerName, execOptions);
    let child;
    try {
        child = spawn(ctx.dockerCmd, exec.args, { ...spawnOptions, env: ctx.dockerEnv });
    } catch (e) {
        exec.cleanup();
        throw e;
    }
    child.once('close', exec.cleanup);
    child.once('error', exec.cleanup);
    return child;
}

// 起一个短命的容器内子进程，通过对应协议问一次元信息（初始化握手 / model 列表），拿到结果就杀掉进程——
// 不是长驻会话，不会产生真实对话轮次或费用。
function runAgentProtocolProcess(ctx, containerName, command, options = {}) {
    const stdinLines = Array.isArray(options.stdinLines) ? options.stdinLines : [];
    const onLine = typeof options.onLine === 'function' ? options.onLine : null;
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 8000;
    return new Promise(resolve => {
        let settled = false;
        let pending = '';
        let stdoutAll = '';
        let child;
        try {
            child = spawnContainerExec(ctx, containerName, { interactive: true, command: ['/bin/bash', '-lc', command] }, { stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            resolve({ result: null, stdout: '' });
            return;
        }
        const timer = setTimeout(() => finish(null), timeoutMs);
        function finish(result) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill('SIGKILL'); } catch (e) { /* 进程可能已退出 */ }
            resolve({ result, stdout: stdoutAll });
        }
        child.on('error', () => finish(null));
        child.on('close', () => finish(null));
        child.stdout.on('data', chunk => {
            const text = chunk.toString('utf-8');
            stdoutAll += text;
            if (!onLine) {
                return;
            }
            pending += text;
            let newlineIndex = pending.indexOf('\n');
            while (newlineIndex !== -1) {
                const line = pending.slice(0, newlineIndex);
                pending = pending.slice(newlineIndex + 1);
                const trimmed = line.trim();
                if (trimmed) {
                    const payload = parseJsonObjectLine(trimmed);
                    if (payload) {
                        const matched = onLine(payload);
                        if (matched !== undefined) {
                            finish(matched);
                            return;
                        }
                    }
                }
                newlineIndex = pending.indexOf('\n');
            }
        });
        try {
            stdinLines.forEach(line => child.stdin.write(`${line}\n`));
            if (!stdinLines.length) {
                child.stdin.end();
            }
        } catch (e) { /* 进程可能已提前退出 */ }
    });
}

function normalizeAgentModelCatalogEntry(item) {
    const value = pickFirstString(item && item.value, item && item.id, item && item.model);
    if (!value) {
        return null;
    }
    return {
        value,
        label: pickFirstString(item && item.displayName, value),
        description: pickFirstString(item && item.description)
    };
}

function extractClaudeModelsFromControlResponse(payload) {
    if (!payload || payload.type !== 'control_response') {
        return undefined;
    }
    const response = toPlainObject(payload.response);
    if (response.request_id !== 'manyoyo-model-catalog') {
        return undefined;
    }
    const inner = toPlainObject(response.response);
    const models = Array.isArray(inner.models) ? inner.models : [];
    return models.map(normalizeAgentModelCatalogEntry).filter(Boolean);
}

function extractCodexModelsFromListResponse(payload) {
    if (!payload || payload.id !== 'manyoyo-model-list' || !payload.result) {
        return undefined;
    }
    const data = Array.isArray(payload.result.data) ? payload.result.data : [];
    return data.map(normalizeAgentModelCatalogEntry).filter(Boolean);
}

function extractOpenCodeModelsFromOutput(text) {
    return String(text || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(value => ({ value, label: value, description: '' }));
}

// 模型目录要在容器里起一个 Agent 进程才能问到，很慢：按“容器 + Agent 程序”缓存，
// 并合并同一时刻的重复请求。缓存挂在 ctx 上（随 serve 实例走），不放模块级，避免测试之间串味
const MODEL_CATALOG_TTL_MS = 10 * 60 * 1000;
const modelCatalogCaches = new WeakMap();

async function fetchAgentModelCatalogCached(ctx, containerName, agentProgram) {
    let cache = modelCatalogCaches.get(ctx);
    if (!cache) {
        cache = new Map();
        modelCatalogCaches.set(ctx, cache);
    }
    const key = `${containerName}\u0000${agentProgram}`;
    const hit = cache.get(key);
    if (hit && (hit.pending || Date.now() - hit.at < MODEL_CATALOG_TTL_MS)) {
        return hit.pending || hit.models;
    }
    const pending = fetchAgentModelCatalog(ctx, containerName, agentProgram).then(models => {
        // 探测失败（超时 / 容器没起来）返回空数组，不缓存，下次还能重试
        if (models.length) cache.set(key, { at: Date.now(), models });
        else cache.delete(key);
        return models;
    }, error => {
        cache.delete(key);
        throw error;
    });
    cache.set(key, { pending });
    return pending;
}

// 以会话实际配置的 env 生成模型选项。defaultModel 是“跟随默认”实际用的模型；
// Claude 另有按档位别名（opus / sonnet / haiku …）一行一个的选项：value 是别名（--model opus 由 CLI 按 env 解析），
// label 是该档位对应的真实模型名。不同档位指向同一个模型也各占一行，不合并。
// 只读 *_MODEL 这类非敏感键，容器可写的 env 只用来展示，不参与任何安全判断
const CLAUDE_TIER_ORDER = ['opus', 'fable', 'sonnet', 'haiku'];

function buildEnvModelOptions(agentProgram, env) {
    const source = env && typeof env === 'object' ? env : {};
    const defaultKey = { claude: 'ANTHROPIC_MODEL', codex: 'OPENAI_MODEL', opencode: 'OPENAI_MODEL', gemini: 'GEMINI_MODEL' }[agentProgram];
    if (!defaultKey) return { defaultModel: '', options: [] };
    const defaultModel = normalizeStoredAgentModelValue(source[defaultKey]);
    if (agentProgram !== 'claude') return { defaultModel, options: [] };
    const tiers = [];
    Object.keys(source).forEach(key => {
        const matched = key.match(/^ANTHROPIC_DEFAULT_([A-Z0-9]+)_MODEL$/);
        const model = matched ? normalizeStoredAgentModelValue(source[key]) : '';
        if (model) tiers.push({ alias: matched[1].toLowerCase(), model });
    });
    const rank = alias => (CLAUDE_TIER_ORDER.includes(alias) ? CLAUDE_TIER_ORDER.indexOf(alias) : CLAUDE_TIER_ORDER.length);
    tiers.sort((x, y) => rank(x.alias) - rank(y.alias) || x.alias.localeCompare(y.alias));
    return {
        defaultModel,
        options: tiers.map(tier => ({ value: tier.alias, label: tier.model, description: tier.alias }))
    };
}

async function fetchAgentModelCatalog(ctx, containerName, agentProgram) {
    if (agentProgram === 'claude') {
        const requestLine = JSON.stringify({
            type: 'control_request',
            request_id: 'manyoyo-model-catalog',
            request: { subtype: 'initialize' }
        });
        const { result } = await runAgentProtocolProcess(
            ctx,
            containerName,
            'claude -p --input-format stream-json --output-format stream-json --verbose',
            { stdinLines: [requestLine], onLine: extractClaudeModelsFromControlResponse }
        );
        return Array.isArray(result) ? result : [];
    }
    if (agentProgram === 'codex') {
        const stdinLines = [
            JSON.stringify({ jsonrpc: '2.0', id: 'manyoyo-init', method: 'initialize', params: { clientInfo: { name: 'manyoyo', version: '1.0.0' } } }),
            JSON.stringify({ jsonrpc: '2.0', id: 'manyoyo-model-list', method: 'model/list', params: {} })
        ];
        const { result } = await runAgentProtocolProcess(
            ctx,
            containerName,
            'codex app-server',
            { stdinLines, onLine: extractCodexModelsFromListResponse }
        );
        return Array.isArray(result) ? result : [];
    }
    if (agentProgram === 'opencode') {
        const { stdout } = await runAgentProtocolProcess(ctx, containerName, 'opencode models', {});
        return extractOpenCodeModelsFromOutput(stdout);
    }
    // Gemini 的 --acp 模式在认证前就会挂起重试，没有可用的“认证前”探测窗口，暂不支持目录抓取。
    return [];
}

const SAFE_AGENT_MODEL_VALUE_PATTERN = /^[A-Za-z0-9._\-[\]/]+$/;

function normalizeAgentModelValueInput(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return '';
    }
    if (!SAFE_AGENT_MODEL_VALUE_PATTERN.test(trimmed)) {
        throw new Error(`模型名称包含非法字符: ${trimmed}`);
    }
    return trimmed;
}

function normalizeStoredAgentModelValue(value) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return SAFE_AGENT_MODEL_VALUE_PATTERN.test(trimmed) ? trimmed : '';
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

// 派生子 Agent 的工具：v2.1.63 起叫 Agent，旧名字 Task 仍是别名，两个都认
const CLAUDE_SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

// 子 Agent 里的 assistant / user 消息带 parent_tool_use_id（发起它的那次 Agent 调用的 id），主对话里是 null。
// 只给事件加 parentToolId 字段，不改已有字段的含义
function prepareClaudeTraceEvents(payload, state) {
    const events = prepareClaudeTraceEventsBase(payload, state);
    const parentToolId = pickFirstString(payload && payload.parent_tool_use_id);
    if (parentToolId) {
        events.forEach(event => { event.parentToolId = parentToolId; });
    }
    return events;
}

function prepareClaudeTraceEventsBase(payload, state) {
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
                if (CLAUDE_SUBAGENT_TOOL_NAMES.has(toolName)) {
                    const input = toPlainObject(item.input);
                    const subagentType = pickFirstString(input.subagent_type, input.name);
                    const description = pickFirstString(input.description, input.name);
                    events.push(createStructuredTraceEvent('claude', 'subagent', eventType, `[子 Agent] ${[subagentType, description].filter(Boolean).join(' ') || toolName}`, {
                        phase: 'started',
                        status: 'in_progress',
                        toolName,
                        toolId,
                        subagentType,
                        description,
                        prompt: pickFirstString(input.prompt),
                        arguments: input,
                        argumentSummary: summarizeTraceArguments(input)
                    }));
                    return;
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
            events.push(createStructuredTraceEvent('claude', CLAUDE_SUBAGENT_TOOL_NAMES.has(toolName) ? 'subagent' : 'tool', eventType, `[${CLAUDE_SUBAGENT_TOOL_NAMES.has(toolName) ? '子 Agent 完成' : '工具完成'}] ${toolName} (${status})`, {
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
    const part = toPlainObject(payload.part);
    const partState = toPlainObject(part.state);
    const events = [];

    if (eventType === 'step_start' && part.type === 'step-start') {
        events.push(createStructuredTraceEvent('opencode', 'turn', eventType, '[回合] 开始生成响应', {
            phase: 'started',
            status: 'started',
            sessionId: pickFirstString(payload.sessionID, part.sessionID)
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'text' && part.type === 'text') {
        const detail = collectStructuredText(part.text);
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
    if (eventType === 'tool_use' && part.type === 'tool') {
        const toolName = pickFirstString(part.tool, part.callID, 'tool');
        const toolId = pickFirstString(part.callID, part.id);
        const status = pickFirstString(partState.status, 'completed');
        const argumentsValue = toPlainObject(partState.input);
        const summary = summarizeTraceArguments(argumentsValue);
        events.push(createStructuredTraceEvent('opencode', 'tool', eventType, `[工具完成] ${toolName} (${status})`, {
            phase: 'completed',
            status,
            toolName,
            toolId,
            arguments: argumentsValue,
            argumentSummary: summary,
            result: collectStructuredText(partState.output),
            error: collectStructuredText(partState.error)
        }));
        return events.filter(Boolean);
    }
    if (eventType === 'step_finish' && part.type === 'step-finish') {
        events.push(createStructuredTraceEvent('opencode', 'turn', eventType, '[回合] 响应完成', {
            phase: 'completed',
            status: pickFirstString(part.reason, 'completed')
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

function extractContentDeltaFromPayload(agentProgram, payload, state = {}) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    if (agentProgram === 'claude') {
        const payloadType = pickFirstString(payload.type);
        // --include-partial-messages 产生的 token 级增量。text 是累计全文（服务端
        // 落盘用），chunk 是本次新增的片段（下发给前端用）——一轮回答可能有几千个
        // 增量，每次都把累计全文发一遍是 O(n²) 流量，长回答能到 MB 级。
        // 一轮里可能有多条 assistant 消息（正文→工具→正文），message_start 清空累计，
        // 语义与下面整条 assistant 消息的 reset 一致
        if (payloadType === 'stream_event') {
            if (pickFirstString(payload.parent_tool_use_id)) {
                return null;
            }
            const streamEvent = toPlainObject(payload.event);
            const streamEventType = pickFirstString(streamEvent.type);
            if (streamEventType === 'message_start') {
                state.claudePartialText = '';
                return { text: '', reset: true, partial: true, chunk: '', chunkReset: true };
            }
            if (streamEventType !== 'content_block_delta') {
                return null;
            }
            const delta = toPlainObject(streamEvent.delta);
            if (pickFirstString(delta.type) !== 'text_delta') {
                return null;
            }
            const deltaText = typeof delta.text === 'string' ? delta.text : '';
            if (!deltaText) {
                return null;
            }
            state.claudePartialText = `${state.claudePartialText || ''}${deltaText}`;
            return { text: state.claudePartialText, reset: true, partial: true, chunk: deltaText };
        }
        if (payloadType !== 'assistant') {
            return null;
        }
        // 子 Agent 说的话（--forward-subagent-text）只属于执行过程，不是主 Agent 的回复
        if (pickFirstString(payload.parent_tool_use_id)) {
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
    const toolId = pickFirstString(item.id);

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
                toolName: toolName || 'tool_call',
                toolId
            });
        }
        if (itemType === 'command_execution') {
            return createTraceEvent('command', `[命令开始] ${commandText || 'command_execution'}`, {
                phase: 'started',
                status: pickDisplayStatus('in_progress'),
                command: commandText || 'command_execution',
                toolId
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
                    argumentSummary: summary,
                    toolId
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
                toolName: toolName || 'tool_call',
                toolId
            });
        }
        if (itemType === 'command_execution') {
            const suffix = itemStatus || (typeof item.exit_code === 'number' ? `exit=${item.exit_code}` : 'completed');
            return createTraceEvent('command', `[命令完成] ${commandText || 'command_execution'} (${suffix})`, {
                phase: 'completed',
                status: pickDisplayStatus(suffix),
                command: commandText || 'command_execution',
                exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
                result: item.aggregated_output !== undefined ? item.aggregated_output : null,
                toolId
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
                    error: item.error !== undefined ? item.error : null,
                    toolId
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

async function prepareWebAgentExecution(ctx, state, sessionRef, prompt, images = []) {
    const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true, includeArchived: true });
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
    const useNativeSessionResume = NATIVE_SESSION_RESUME_PROGRAMS.has(agentMeta.agentProgram);
    let resumeAttempted = false;
    let resumeSucceeded = false;
    let resumeError = '';
    let sessionIdForRun = '';

    if (useNativeSessionResume && hasPriorConversation && agentSession.engineSessionId) {
        // 已有引擎会话 ID 时直接续接；旧 Web 会话缺少 ID 时注入一次历史来建立新会话，
        // 会话 ID 由引擎自己生成，执行结束后从输出中提取（见 finalizeWebAgentExecution）。
        sessionIdForRun = agentSession.engineSessionId;
        resumeAttempted = true;
        resumeSucceeded = true;
    } else if (!useNativeSessionResume && hasPriorConversation && agentMeta.resumeSupported && agentMeta.resumeCommand) {
        resumeAttempted = true;
        const resumeResult = await execCommandInWebContainer(ctx, sessionRef.containerName, agentMeta.resumeCommand);
        if (resumeResult.exitCode === 0) {
            resumeSucceeded = true;
        } else {
            resumeError = clipText(String(resumeResult.output || '(无输出)'), 1200);
        }
    }

    // Codex 用 --image 传图；其余 Agent 在提示词末尾写路径，让它们用读文件的工具去看
    const imagesByFlag = agentMeta.agentProgram === 'codex';
    const promptWithImages = imagesByFlag ? prompt : webUploads.appendImageNote(prompt, images);
    const effectivePrompt = resumeSucceeded
        ? promptWithImages
        : buildAgentPromptWithHistory(agentSession, promptWithImages);
    // 环境说明每次执行时现读配置：改了设置不用重建容器；运行配置名记在创建时的快照里（旧会话没有，用全局配置）
    const configSnapshot = readWebConfigSnapshot(state.webConfigPath);
    const runName = history.runtimeSnapshot && typeof history.runtimeSnapshot.run === 'string' ? history.runtimeSnapshot.run : '';
    const command = buildWebAgentExecCommand(effectiveTemplate, effectivePrompt, agentMeta.agentProgram, {
        sessionId: sessionIdForRun,
        model: agentSession.model || '',
        forwardSubagentText: agentMeta.agentProgram === 'claude' ? 'auto' : false,
        images: imagesByFlag ? images : [],
        resumeAtUuid: agentSession.rewindToUuid || '',
        instructions: buildAgentInstructions(
            configSnapshot.parseError ? {} : configSnapshot.parsed,
            runName,
            readContainerSystemPrompt(ctx, sessionRef.containerName)
        )
    });
    const contextMode = resumeSucceeded ? 'resume' : (hasPriorConversation ? 'history-injected' : 'first-turn');

    return {
        history,
        agentSession,
        agentMeta,
        command,
        contextMode,
        resumeAttempted,
        resumeSucceeded,
        resumeError,
        engineSessionId: sessionIdForRun
    };
}

function finalizeWebAgentExecution(state, sessionRef, agentSession, agentMeta, meta, result) {
    // 用量在输出末尾：原始输出超过上限时开头里没有它
    const turnUsage = extractTurnUsage(agentMeta.agentProgram, result.stdoutTail || result.stdout);
    const replyMessage = appendWebSessionMessage(state.webHistoryDir, sessionRef, 'assistant', result.output, {
        exitCode: result.exitCode,
        mode: 'agent',
        contextMode: meta.contextMode,
        resumeAttempted: meta.resumeAttempted,
        resumeSucceeded: meta.resumeSucceeded,
        interrupted: result.interrupted === true,
        ...(result.networkDenied ? { networkDenied: result.networkDenied } : {}),
        ...(turnUsage ? { usage: turnUsage } : {})
    });
    const patch = {
        rewindToUuid: '',
        lastResumeAt: meta.resumeAttempted ? new Date().toISOString() : (agentSession.lastResumeAt || null),
        lastResumeOk: meta.resumeAttempted ? meta.resumeSucceeded : agentSession.lastResumeOk,
        lastResumeError: meta.resumeAttempted ? (meta.resumeSucceeded ? '' : meta.resumeError) : (agentSession.lastResumeError || '')
    };
    const engineSessionId = meta.engineSessionId || extractEngineSessionId(agentMeta.agentProgram, result.stdout);
    if (engineSessionId) {
        patch.engineSessionId = engineSessionId;
    }
    if (turnUsage) {
        patch.usageTotal = accumulateUsageTotal(agentSession.usageTotal, turnUsage);
    }
    if (agentMeta.agentProgram === 'claude') {
        const slashCommands = extractClaudeInitSlashCommands(result.stdout);
        if (slashCommands) {
            patch.slashCommands = slashCommands;
        }
    }
    patchWebAgentSessionState(state.webHistoryDir, sessionRef, patch);
    return replyMessage;
}

// 每轮前后各拍一次工作目录快照（影子 git，见 lib/web/snapshots.js）；失败 / 太大不影响这一轮，只是这一轮不能回退文件
// 在容器里跑一段 bash 脚本并取 stdout（脚本里的路径 / 提交号都已转义或校验）。
// 用 `bash -c` 而不是 execCommandInWebContainer 的 `/bin/bash -lc`：不走登录 shell，更快；也让测试里按 /bin/bash 识别 Agent 运行的假 docker 不会把它误当成一轮对话
function runWebContainerScript(ctx, containerName, script, timeoutMs = 60000) {
    return new Promise(resolve => {
        let child;
        try {
            child = spawnContainerExec(ctx, containerName, { withEnv: false, command: ['bash', '-c', script] }, { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) {
            resolve('');
            return;
        }
        let out = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { if (out.length < 4 * 1024 * 1024) out += chunk; });
        child.once('close', () => { clearTimeout(timer); resolve(out); });
        child.once('error', () => { clearTimeout(timer); resolve(out); });
    });
}

async function takeWebSnapshot(ctx, state, sessionRef, label) {
    const workDir = resolveWebSessionWorkDir(state, sessionRef);
    if (!workDir || workDir === '/') {
        return { skipped: 'unavailable' };
    }
    try {
        return webSnapshots.parseSnapshotOutput(await runWebContainerScript(ctx, sessionRef.containerName, webSnapshots.buildSnapshotCommand(workDir, label), 15000));
    } catch (e) {
        return { skipped: 'unavailable' };
    }
}

// 回退的目标必须是一条已经结束的 Agent 用户消息，且这个容器里没有任务在跑
function findWebRewindTarget(state, sessionRef, messageId) {
    if (state.agentRuns.has(sessionRef.containerName)) {
        return { status: 409, error: '任务进行中，暂时不能回退' };
    }
    const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true });
    const id = String(messageId || '');
    const message = agentSession && agentSession.messages.find(item => item && String(item.id || '') === id);
    if (!message || message.role !== 'user' || message.mode === 'command') {
        return { status: 404, error: '没有找到这条提示词' };
    }
    if (message.pending === true) {
        return { status: 409, error: '这一轮还在进行中' };
    }
    return { history, agentSession, message };
}

async function rewindWebSession(ctx, state, sessionRef, messageId, scope) {
    const target = findWebRewindTarget(state, sessionRef, messageId);
    if (target.error) {
        return target;
    }
    // 回退期间占住这个容器的运行锁：恢复脚本最长跑 2 分钟，这段时间里不能让新的一轮开跑（文件会被还原、新消息会被删）
    const runState = reserveWebAgentRun(state, sessionRef);
    try {
        return await rewindWebSessionLocked(ctx, state, sessionRef, scope, target);
    } finally {
        releaseWebAgentRun(state, sessionRef.containerName, runState);
    }
}

async function rewindWebSessionLocked(ctx, state, sessionRef, scope, target) {
    const { history, agentSession, message } = target;
    let filesRestored = false;
    if (scope !== 'conversation') {
        if (!webSnapshots.isSnapId(message.snapBefore)) {
            return { status: 409, error: '这一轮没有文件快照，不能回退文件' };
        }
        await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
        const out = await runWebContainerScript(ctx, sessionRef.containerName, webSnapshots.buildRestoreCommand(resolveWebSessionWorkDir(state, sessionRef), message.snapBefore), 120000);
        const restored = webSnapshots.parseRestoreOutput(out);
        if (!restored.ok) {
            return { status: 500, error: '恢复文件失败，工作目录没有改动' };
        }
        filesRestored = true;
    }
    let conversationMode = '';
    if (scope !== 'files') {
        const program = getAgentRuntimeMeta(resolveEffectiveAgentPromptCommandForSession(
            history, sessionRef.agentId, (listWebManyoyoContainers(ctx)[sessionRef.containerName] || {}).defaultCommand
        )).agentProgram;
        let engineSessionId = agentSession.engineSessionId || '';
        let rewindToUuid = '';
        if (!engineSessionId) {
            conversationMode = 'precise';
        } else if (program === 'claude') {
            const command = webRewind.buildClaudeRecordsCommand(engineSessionId);
            const records = command ? webRewind.parseClaudeRecords(await runWebContainerScript(ctx, sessionRef.containerName, command, 30000)) : [];
            const pick = webRewind.pickClaudeResumeAt(records, { text: message.content, timeMs: Date.parse(message.timestamp) });
            if (pick.found && pick.uuid) {
                rewindToUuid = pick.uuid;
                conversationMode = 'precise';
            } else if (pick.found) {
                // 回退到第一轮：Claude 那边什么都不需要记得，开新会话
                engineSessionId = '';
                conversationMode = 'precise';
            } else {
                engineSessionId = '';
                conversationMode = 'history';
            }
        } else {
            // 其它 Agent 没有精确回退：丢掉引擎会话，下一轮用剩下的聊天记录注入（不丢数据，只丢工具调用等细节）
            engineSessionId = '';
            conversationMode = 'history';
        }
        const removed = removeWebSessionMessagesFrom(state.webHistoryDir, sessionRef, message.id);
        if (!removed.length) {
            return { status: 409, error: '这条提示词已经不在了' };
        }
        patchWebAgentSessionState(state.webHistoryDir, sessionRef, { engineSessionId, rewindToUuid });
        appendWebSessionControlEvent(state.webHistoryDir, sessionRef, 'session.stopped', { reason: 'rewind', scope });
    }
    return { ok: true, scope, filesRestored, conversationMode, prompt: message.content, images: Array.isArray(message.images) ? message.images : [] };
}

function resolveWebSessionWorkDir(state, sessionRef) {
    const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
    const applied = history.applied && typeof history.applied === 'object' ? history.applied : {};
    return typeof applied.containerPath === 'string' && applied.containerPath ? applied.containerPath : '/';
}

async function readWebGitChanges(ctx, state, sessionRef) {
    const result = await execCommandInWebContainer(
        ctx,
        sessionRef.containerName,
        gitChanges.buildGitChangesCommand(resolveWebSessionWorkDir(state, sessionRef)),
        { withEnv: false }
    );
    return gitChanges.parseGitChangesOutput(result.stdout);
}

// 每轮结束后在后台读一次 Agent 自己生成的标题（目前只有 claude 会写 ai-title，交互模式实测；
// 其他 Agent 只用首条消息）。不阻塞本轮结果；读不到或失败都静默——每轮都会触发，属于高频路径，不写日志
async function refreshWebAgentTitle(ctx, state, sessionRef, agentProgram) {
    if (agentProgram !== 'claude') {
        return '';
    }
    try {
        const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
        const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true });
        const command = sessionMeta.buildClaudeTitleReadCommand(agentSession && agentSession.engineSessionId);
        if (!command) {
            return '';
        }
        const sessionId = agentSession.engineSessionId;
        const result = await execCommandInWebContainer(ctx, sessionRef.containerName, command);
        const title = sessionMeta.parseClaudeTitleOutput(result.stdout);
        // 读标题期间 AGENT 可能被删除或换了引擎会话：写回前重新读一次，不在了就放弃（不能把它重新建出来）
        const fresh = getWebAgentSession(
            loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName),
            sessionRef.agentId,
            { includeArchived: true }
        );
        if (!fresh || fresh.engineSessionId !== sessionId) {
            return '';
        }
        if (title && title !== fresh.title) {
            patchWebAgentSessionState(state.webHistoryDir, sessionRef, { title });
        }
        return title;
    } catch (e) {
        return '';
    }
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

function createWebAuthSession(state, username) {
    return state.authStore.create(username);
}

function getWebAuthSession(state, req) {
    const sessionId = parseCookies(req)[WEB_AUTH_COOKIE_NAME];
    if (!sessionId) return null;
    const session = state.authStore.touch(sessionId);
    return session ? { sessionId, username: session.username } : null;
}

function clearWebAuthSession(state, req) {
    const sessionId = parseCookies(req)[WEB_AUTH_COOKIE_NAME];
    if (sessionId) {
        state.authStore.remove(sessionId);
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

function computeContentEtag(text) {
    return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex');
}

// 规范化 If-Match：去掉引号和 W/ 前缀、统一小写；* 表示“只要存在就匹配”（原样保留）
function normalizeIfMatchHeader(value) {
    const text = String(value).trim();
    if (text === '*') {
        return '*';
    }
    return text.replace(/^W\//, '').replace(/"/g, '').trim().toLowerCase();
}

function ifMatchSatisfied(headerValue, currentEtag) {
    const normalized = normalizeIfMatchHeader(headerValue);
    return normalized === '*' || normalized === String(currentEtag).toLowerCase();
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
        // 版本号 = 磁盘原文的 sha256（不是脱敏后的文本：只有密钥变了也要能识别），只返回哈希，不泄露内容
        etag: computeContentEtag(snapshot && typeof snapshot.raw === 'string' ? snapshot.raw : ''),
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

// 环境变量文件：只解析路径并检查存在，内容每次 exec 现读（见 lib/container-state.js 的 readEnvFiles）
function resolveEnvFilePath(filePath) {
    const resolvedPath = expandHomeAliasPath(filePath);
    if (!path.isAbsolute(resolvedPath)) {
        throw new Error(`环境变量文件仅支持绝对路径: ${filePath}`);
    }
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`未找到环境变量文件: ${resolvedPath}`);
    }
    return resolvedPath;
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
    return resolveYoloCommandFromAdapters(yolo);
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
    if (hasOwn(config, 'mirrors')) {
        normalizeMirrors(config.mirrors);
    }
    if (hasOwn(config, 'agentPromptCommand')) {
        normalizeAgentPromptCommandTemplate(config.agentPromptCommand, 'agentPromptCommand');
    }
    if (hasOwn(config, 'agentInstructions') && typeof config.agentInstructions !== 'string') {
        throw new Error('agentInstructions 必须是字符串');
    }
    ['agentInstructionsBuiltinEnabled', 'agentInstructionsCustomEnabled'].forEach(key => {
        if (hasOwn(config, key) && typeof config[key] !== 'boolean') {
            throw new Error(`${key} 必须是布尔值`);
        }
    });
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
            if (hasOwn(normalizedRun, 'agentInstructions') && typeof normalizedRun.agentInstructions !== 'string') {
                throw new Error(`runs.${runName}.agentInstructions 必须是字符串`);
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

// 新建容器对话框会拿 defaults.hostPath 做预填，但 validateHostPath 明确拒绝
// 根目录 / /home / $HOME。serve 以 $HOME 启动（root 用户下就是 /root）时，
// 预填的值必定创建失败——这里直接留空，逼用户用"选择"选一个真实工作目录
function sanitizeDefaultHostPath(hostPath) {
    const value = String(hostPath || '').trim();
    if (!value) {
        return '';
    }
    const homeDir = process.env.HOME || os.homedir() || '/home';
    if (value === '/' || value === '/home' || value === homeDir) {
        return '';
    }
    return value;
}

function buildConfigDefaults(ctx, config) {
    const parsed = toPlainObject(config);
    const defaults = {
        containerName: hasOwn(parsed, 'containerName') ? String(parsed.containerName || '') : '',
        hostPath: sanitizeDefaultHostPath(pickFirstString(parsed.hostPath, ctx.hostPath)),
        containerPath: pickFirstString(parsed.containerPath),
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
        envFiles: Array.isArray(ctx.envFiles) ? ctx.envFiles.slice() : [],
        containerVolumes: Array.isArray(ctx.containerVolumes) ? ctx.containerVolumes.slice() : [],
        containerPorts: Array.isArray(ctx.containerPorts) ? ctx.containerPorts.slice() : [],
        defaultCommand: buildDefaultCommand(ctx.execCommandPrefix, ctx.execCommand, ctx.execCommandSuffix) || '/bin/bash'
    };
}

function normalizeFirstConfig(value, sourceLabel) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${sourceLabel} 的 first 必须是对象(map)，例如 {"shell":"init.sh"}`);
    }
    return value;
}

// first.envFile 里已存在的文件内容 + first.env，后者优先（与 CLI 一致）；返回 KEY=VALUE 行
function buildFirstEnvLines(firstResolved) {
    const lines = [];
    (firstResolved.envFile || []).forEach(file => {
        const resolvedPath = expandHomeAliasPath(file);
        if (!path.isAbsolute(resolvedPath)) {
            throw new Error(`环境变量文件仅支持绝对路径: ${file}`);
        }
        if (!fs.existsSync(resolvedPath)) return;
        containerState.parseEnvFileContent(fs.readFileSync(resolvedPath, 'utf-8')).entries
            .forEach(entry => lines.push(`${entry.key}=${entry.value}`));
    });
    Object.entries(firstResolved.env || {}).forEach(([key, value]) => {
        const parsed = parseEnvEntry(`${key}=${value}`);
        lines.push(`${parsed.key}=${parsed.value}`);
    });
    return lines;
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

    // first（首次命令）：请求里带了就只用它（复制容器时来自快照，已合并过），否则全局 + runs.<name>
    const hasRequestFirst = hasOwn(requestOptions, 'first');
    const globalFirstConfig = hasRequestFirst ? {} : normalizeFirstConfig(config.first, '全局配置');
    const runFirstConfig = hasRequestFirst
        ? normalizeFirstConfig(requestOptions.first, 'createOptions')
        : normalizeFirstConfig(runConfig.first, '运行配置');

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
        globalFirstConfig,
        runFirstConfig,
        defaults: {
            hostPath: ctx.hostPath,
            containerName: `my-${ctx.formatDate()}`,
            // 不用 ctx.containerPath：那是 serve 进程的启动目录（CLI 的 cwd 语义），与用户要挂载的目录无关；
            // 没配置也没传时落到下面的 `|| hostPath`，容器内路径与宿主机路径一致
            containerPath: '',
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

    // 自启动与网络：请求 > runs.<name> > 全局配置；请求里放开限制（自定义 / 很宽的允许规则 / 非本机绑定）要带 confirmRisk
    const manage = resolveManageOptions({ requestOptions, runConfig, globalConfig: config });
    if (manage.fromRequest && requestOptions.confirmRisk !== true && pendingRisks(defaultPolicy(), manage.network).length) {
        throw new Error('该网络设置会放开限制（自定义模式、很宽的允许规则或绑定非本机地址），需要确认（confirmRisk）');
    }

    // 系统提示词：请求里填了就用它（创建时定下），否则按系统设置里的默认 + 补充（各自的开关生效）
    const systemPrompt = normalizeSystemPromptInput(requestOptions.systemPrompt)
        || { enabled: true, text: composeSystemPrompt(config, runName) };

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
    let envFiles = Array.isArray(ctx.envFiles) ? ctx.envFiles.slice() : [];
    const hasRunEnv = hasOwn(runConfig, 'env');
    const hasRunEnvFile = hasOwn(runConfig, 'envFile');
    if (hasRequestEnv || hasRequestEnvFile || hasRunEnv || hasRunEnvFile || hasConfigEnv || hasConfigEnvFile) {
        const mergedEnv = resolvedBase.env;
        const envArgs = [];
        Object.entries(mergedEnv).forEach(([key, value]) => {
            const parsed = parseEnvEntry(`${key}=${value}`);
            envArgs.push('--env', `${parsed.key}=${parsed.value}`);
        });

        containerEnvs = envArgs;
        envFiles = resolvedBase.envFile.map(resolveEnvFilePath);
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

    const firstResolved = resolvedBase.first;
    const firstCommand = String(firstResolved.exec.shell || '').trim()
        ? `${firstResolved.exec.prefix || ''}${firstResolved.exec.shell}${firstResolved.exec.suffix || ''}`
        : '';
    // 写进快照的 first 已经是合并后的结果，复制容器时当作请求里的 first 使用
    const firstSnapshot = {
        shellPrefix: pickFirstString(runFirstConfig.shellPrefix, globalFirstConfig.shellPrefix),
        shell: pickFirstString(runFirstConfig.shell, globalFirstConfig.shell),
        shellSuffix: pickFirstString(runFirstConfig.shellSuffix, globalFirstConfig.shellSuffix),
        env: firstResolved.env || {},
        envFile: firstResolved.envFile || []
    };

    return {
        containerName,
        hostPath,
        containerPath,
        imageName,
        imageVersion,
        contModeArgs,
        containerExtraArgs: Array.isArray(ctx.containerExtraArgs) ? ctx.containerExtraArgs.slice() : [],
        containerEnvs,
        envFiles,
        first: firstCommand ? { command: firstCommand, envLines: buildFirstEnvLines(firstResolved) } : null,
        containerVolumes,
        containerPorts,
        autostart: manage.autostart,
        network: manage.network,
        systemPrompt,
        agentPromptCommand,
        defaultCommand: buildDefaultCommand(shellPrefix, shell, shellSuffix) || '/bin/bash',
        // 仅供服务端内部复用（如"创建相同配置容器"/"复制容器"），绝不能透传给任何对外响应字段，
        // 因为 env/volumes/ports 可能包含密钥原始值（对外响应不暴露它们）。
        runtimeSnapshot: {
            run: runName || '',
            hostPath,
            containerPath,
            imageName,
            imageVersion,
            containerMode,
            shellPrefix: shellPrefix || '',
            shell: shell || '',
            shellSuffix: shellSuffix || '',
            agentPromptCommand: configuredAgentPromptCommand,
            yolo: yolo || '',
            env: resolvedBase.env || {},
            envFile: resolvedBase.envFile || [],
            volumes: resolvedBase.volumes || [],
            ports: resolvedBase.ports || [],
            autostart: manage.autostart,
            systemPrompt,
            first: firstSnapshot,
            // 复制容器时端口暴露（宿主机端口会冲突）与 peers（按 id 引用别的容器）不带过去
            network: { ...manage.network, expose: [], peers: { inbound: [] } }
        },
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
            autostartEnabled: Boolean(manage.autostart.trim()),
            networkPreset: manage.network.preset
        }
    };
}

// 容器自己存的系统提示词；旧容器（没有 id 或没存过）返回 null，按系统设置现算
function readContainerSystemPrompt(ctx, containerName) {
    try {
        const homeDir = ctx.homeDir || os.homedir();
        const id = resolveContainerId(ctx.dockerExecArgs, containerName);
        return id && containerState.stateExists(homeDir, id) ? containerState.readSystemPrompt(homeDir, id) : null;
    } catch (e) {
        return null;
    }
}

// 请求里的系统提示词 {enabled, text}；没给返回 null，给了但格式不对抛错
function normalizeSystemPromptInput(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value) || typeof value.text !== 'string'
        || (value.enabled !== undefined && typeof value.enabled !== 'boolean')) {
        throw new Error('systemPrompt 必须是 {enabled, text}');
    }
    return { enabled: value.enabled !== false, text: value.text.slice(0, SYSTEM_PROMPT_MAX_CHARS) };
}

function resolveUniqueContainerName(ctx, state, baseName) {
    const containerMap = listWebManyoyoContainers(ctx);
    const historyNames = listWebHistorySessionNames(state.webHistoryDir, ctx.isValidContainerName);
    const taken = new Set([...Object.keys(containerMap), ...historyNames]);
    // 基于历史最大编号 +1 命名，即使较小编号的副本被删除也不回收其编号，
    // 避免"删除 -copy1 后新副本又叫 -copy1"造成的名称语义混乱。
    const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escapedBase}-copy(\\d+)$`);
    let maxN = 0;
    taken.forEach(name => {
        const matched = name.match(pattern);
        if (matched) {
            const n = Number(matched[1]);
            if (Number.isFinite(n) && n > maxN) {
                maxN = n;
            }
        }
    });
    return `${baseName}-copy${maxN + 1}`;
}

function buildCloneCreateOptionsFromSnapshot(runtimeSnapshot, fallbackHistory) {
    if (runtimeSnapshot && typeof runtimeSnapshot === 'object') {
        return {
            hostPath: runtimeSnapshot.hostPath || '',
            containerPath: runtimeSnapshot.containerPath || '',
            imageName: runtimeSnapshot.imageName || '',
            imageVersion: runtimeSnapshot.imageVersion || '',
            containerMode: runtimeSnapshot.containerMode || '',
            shellPrefix: runtimeSnapshot.shellPrefix || '',
            shell: runtimeSnapshot.shell || '',
            shellSuffix: runtimeSnapshot.shellSuffix || '',
            agentPromptCommand: runtimeSnapshot.agentPromptCommand || '',
            yolo: runtimeSnapshot.yolo || '',
            env: runtimeSnapshot.env || {},
            envFile: runtimeSnapshot.envFile || [],
            volumes: runtimeSnapshot.volumes || [],
            ports: runtimeSnapshot.ports || [],
            autostart: runtimeSnapshot.autostart || '',
            systemPrompt: runtimeSnapshot.systemPrompt || undefined,
            first: runtimeSnapshot.first || undefined,
            network: runtimeSnapshot.network || undefined,
            // 快照来自服务端、原容器创建时已确认过，复制不必再确认
            confirmRisk: runtimeSnapshot.network ? true : undefined
        };
    }

    const applied = fallbackHistory && fallbackHistory.applied && typeof fallbackHistory.applied === 'object'
        ? fallbackHistory.applied
        : {};
    return {
        hostPath: applied.hostPath || '',
        containerPath: applied.containerPath || '',
        imageName: applied.imageName || '',
        imageVersion: applied.imageVersion || '',
        containerMode: applied.containerMode || '',
        shellPrefix: applied.shellPrefix || '',
        shell: applied.shell || '',
        shellSuffix: applied.shellSuffix || '',
        agentPromptCommand: typeof fallbackHistory.agentPromptCommand === 'string' ? fallbackHistory.agentPromptCommand : '',
        yolo: applied.yolo || '',
        env: {},
        envFile: [],
        volumes: [],
        ports: []
    };
}

function cloneWebAgentSessionsDeep(sourceHistory) {
    const cloned = {};
    const agents = sourceHistory && sourceHistory.agents && typeof sourceHistory.agents === 'object'
        ? sourceHistory.agents
        : {};
    Object.keys(agents).forEach(agentId => {
        cloned[agentId] = JSON.parse(JSON.stringify(agents[agentId]));
        cloned[agentId].epoch = messagesView.createEpoch();
    });
    return cloned;
}

async function createClonedContainer(ctx, state, sourceContainerName, requestedName, options = {}) {
    const copyHistory = options.copyHistory === true;
    const history = loadWebSessionHistory(state.webHistoryDir, sourceContainerName);
    const cloneFidelity = history.runtimeSnapshot ? 'full' : 'partial';
    const createOptions = buildCloneCreateOptionsFromSnapshot(history.runtimeSnapshot, history);

    let finalName = '';
    if (requestedName) {
        validateContainerNameStrict(requestedName);
        const containerMap = listWebManyoyoContainers(ctx);
        const historyNames = listWebHistorySessionNames(state.webHistoryDir, ctx.isValidContainerName);
        const taken = new Set([...Object.keys(containerMap), ...historyNames]);
        if (taken.has(requestedName)) {
            const err = new Error(`容器名已存在: ${requestedName}`);
            err.statusCode = 409;
            throw err;
        }
        finalName = requestedName;
    } else {
        finalName = resolveUniqueContainerName(ctx, state, sourceContainerName);
    }

    createOptions.containerName = finalName;
    const runtime = buildCreateRuntime(ctx, state, { createOptions });
    await ensureWebContainer(ctx, state, runtime);
    setWebSessionAgentPromptCommand(state.webHistoryDir, runtime.containerName, runtime.agentPromptCommand);

    const patch = {
        applied: runtime.applied,
        runtimeSnapshot: runtime.runtimeSnapshot
    };
    if (copyHistory) {
        patch.agents = cloneWebAgentSessionsDeep(history);
        patch.agentPromptCommand = history.agentPromptCommand;
    }
    patchWebSessionHistory(state.webHistoryDir, finalName, patch);

    return {
        name: finalName,
        applied: runtime.applied,
        sourceContainerName,
        cloneFidelity,
        resumeMayFail: copyHistory
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

    const candidates = [];
    output.trim().split('\n').forEach(line => {
        const [name, status, image] = line.split('\t');
        if (!ctx.isValidContainerName(name) || isSidecarName(name)) {
            return;
        }
        const imageName = image || '';
        if (!imageName.includes('manyoyo') && !name.startsWith('manyoyo-') && !name.startsWith('my-')) {
            return;
        }
        candidates.push({ name, status, imageName });
    });

    // 逐容器单独 docker inspect 是 N+1 同步阻塞调用（spawnSync 无 timeout，会
    // 独占 Node 单线程事件循环），这里合并成一次批量 inspect。
    // 注意：31 个容器实测 `ps -a` 约 40ms、批量 `inspect` 约 45ms，容器运行时调用
    // 并不是 GET /api/sessions 慢的原因——真正的开销在逐容器同步读取并解析整份
    // 历史 JSON（见 buildSessionSummary 的 preloadedHistory 注释）。排查这条路径
    // 变慢时别先怀疑 docker/podman。
    const defaultCommandByName = {};
    if (candidates.length) {
        let inspectOutput = '';
        try {
            inspectOutput = String(
                ctx.dockerExecArgs(
                    [
                        'inspect',
                        '-f',
                        '{{.Name}}\t{{index .Config.Labels "manyoyo.default_cmd"}}',
                        ...candidates.map(c => c.name)
                    ],
                    { ignoreError: true }
                ) || ''
            );
        } catch (e) {
            inspectOutput = '';
        }
        inspectOutput.split('\n').forEach(line => {
            const [rawName, defaultCommand] = line.split('\t');
            if (!rawName) {
                return;
            }
            defaultCommandByName[rawName.replace(/^\//, '')] = (defaultCommand || '').trim();
        });
    }

    candidates.forEach(({ name, status, imageName }) => {
        map[name] = {
            name,
            status: status || 'unknown',
            image: imageName,
            createdAt: estimateStartTimeFromStatus(status),
            defaultCommand: defaultCommandByName[name] || ''
        };
    });

    return map;
}

function webImageRef(ctx, runtime) {
    return `${runtime ? runtime.imageName : ctx.imageName}:${runtime ? runtime.imageVersion : ctx.imageVersion}`;
}

const IMAGE_INSPECT_TIMEOUT_MS = 10000;

// 异步 + 超时：daemon 卡住时不能占住事件循环（向导每隔几秒轮询 /api/setup/status）
async function isWebImagePresent(ctx, imageRef) {
    try {
        if (ctx.dockerExecAsync) {
            await ctx.dockerExecAsync(['image', 'inspect', imageRef], { timeout: IMAGE_INSPECT_TIMEOUT_MS });
        } else {
            ctx.dockerExecArgs(['image', 'inspect', imageRef], { stdio: 'pipe' });
        }
        return true;
    } catch (e) {
        return false;
    }
}

function createImagePreparingError(message) {
    const error = new Error(message);
    error.statusCode = 409;
    error.imagePreparing = true;
    return error;
}

// 本地没有镜像就在后台拉取（异步进程，不阻塞事件循环）；同一镜像并发请求共用一次拉取。
// 进度写在 state.imagePulls，/api/setup/status 会读它。
async function ensureWebImage(ctx, state, imageRef, options = {}) {
    // 离线安装器正在后台导入镜像：不要同时去仓库拉同一个镜像。
    // 面向请求的调用（options.failFast）直接返回“镜像准备中”，不把 HTTP 请求挂起几分钟；后台预拉取才等待。
    if (ctx.importState().active) {
        if (options.failFast) {
            throw createImagePreparingError('镜像正在导入，请稍后再试（向导顶部进度条显示进度）');
        }
        await waitForImport({ readState: ctx.importState });
    }
    const current = state.imagePulls.get(imageRef);
    if (current && current.status === 'pulling') {
        if (options.failFast) {
            throw createImagePreparingError('镜像正在拉取，请稍后再试（向导顶部进度条显示进度）');
        }
        await current.promise;
        return;
    }
    if (await isWebImagePresent(ctx, imageRef)) {
        state.imagePulls.delete(imageRef);
        return;
    }
    const entry = { status: 'pulling', message: '正在拉取镜像', promise: null };
    entry.promise = ensureImagePresent({
        imageRef,
        command: ctx.dockerCmd,
        isPresent: () => false,
        pull: () => pullImageProcess({
            command: ctx.dockerCmd,
            env: ctx.dockerEnv,
            imageRef,
            onOutput: text => {
                const lastLine = String(text).split(/[\r\n]+/).map(line => line.trim()).filter(Boolean).pop();
                if (lastLine) entry.message = lastLine.slice(0, 200);
            }
        })
    }).then(() => {
        state.imagePulls.delete(imageRef);
    }, error => {
        entry.status = 'failed';
        entry.message = error.message;
        throw error;
    });
    state.imagePulls.set(imageRef, entry);
    await entry.promise;
}

// serve 启动后等容器环境就绪，再在后台把默认镜像拉好，首次向导的进度条才会走完
function startWebImagePrepare(ctx, state) {
    const imageRef = webImageRef(ctx);
    const deadline = Date.now() + 10 * 60 * 1000;
    const tick = () => {
        const status = ctx.runtimeState.status;
        if (status === 'ready') {
            ensureWebImage(ctx, state, imageRef).catch(e => ctx.logger.warn('image prepare failed', { message: e.message }));
            return;
        }
        if (status === 'failed' || Date.now() > deadline) return;
        setTimeout(tick, 1000).unref();
    };
    tick();
}

const SETUP_TEST_CONTAINER_PREFIX = 'manyoyo-setup-test-';

// 连接测试的一次性容器带着用户的 API Key：serve 被强杀时 finally 不会执行，下次启动（运行时就绪后）清掉残留
async function cleanupStaleSetupTestContainers(ctx) {
    if (!ctx.dockerExecAsync) return;
    try {
        const listed = await ctx.dockerExecAsync(['ps', '-a', '--filter', `name=${SETUP_TEST_CONTAINER_PREFIX}`, '--format', '{{.Names}}'], { timeout: 10000 });
        const names = String(listed || '').split('\n').map(line => line.trim())
            .filter(name => name.startsWith(SETUP_TEST_CONTAINER_PREFIX) && /^[A-Za-z0-9_.-]+$/.test(name));
        for (const name of names) {
            const stateId = String(await ctx.dockerExecAsync(
                ['inspect', '-f', '{{index .Config.Labels "manyoyo.id"}}', name], { timeout: 10000 }
            ).catch(() => '') || '').trim();
            await ctx.dockerExecAsync(['rm', '-f', name], { timeout: 20000 }).catch(() => {});
            if (stateId) containerState.removeState(ctx.homeDir || os.homedir(), stateId);
        }
    } catch (e) {
        ctx.logger.warn('cleanup stale setup test containers failed', { message: e && e.message });
    }
}

// Agent 一轮对话里，容器被过滤代理拦下的新域名（浏览器后台请求不算）：只在 allowlist 容器上轮询
function createWebDeniedNotifier(ctx, sessionRef, emit, modelOptions = {}) {
    try {
        const homeDir = ctx.homeDir || os.homedir();
        const id = resolveContainerId(ctx.dockerExecArgs, sessionRef.containerName);
        if (!id || !containerState.stateExists(homeDir, id)) return null;
        const deniedDir = egressPaths(homeDir).denied;
        const policyOf = () => normalizePolicy(containerState.readNetworkRaw(homeDir, id) || undefined);
        if (!usesProxy(policyOf())) return null;
        // 模型域名：env 里的 URL 域名 + 该 Agent 没配 BASE_URL 时的官方域名；每次现读 env（用户可能刚改过）
        const isModelHost = host => {
            const envLines = [
                ...containerState.readEnv(homeDir, id).entries.map(entry => `${entry.key}=${entry.value}`),
                ...containerState.envFileEntries(homeDir, id).map(entry => `${entry.key}=${entry.value}`)
            ];
            return agentModelDomains(envLines, modelOptions.agentProgram).includes(String(host).toLowerCase());
        };
        return createDeniedNotifier({
            read: () => readDenied(deniedDir, id),
            isIgnored: host => isBrowserBackground(host) || domainRuleAllows(policyOf(), host),
            emit,
            isModelHost,
            onModelDenied: modelOptions.onModelDenied
        });
    } catch (e) {
        return null;
    }
}

function getWebPortForwarder(ctx, state) {
    if (!state.portForwarder) {
        const homeDir = ctx.homeDir || os.homedir();
        state.portForwarder = createPortForwarder({
            command: ctx.dockerCmd,
            env: ctx.dockerEnv,
            homeDir,
            // id → 当前容器名：只信运行时里真实存在的（serve 启动时与接口调用时登记），meta.json 里的旧名字可能已被同名新容器占用
            resolveName: id => (state.containerNames && state.containerNames.get(id)) || '',
            warn: message => ctx.logger.warn(message)
        });
    }
    return state.portForwarder;
}

// 运行时就绪后的容器服务：规则对账 + start 事件订阅（外部重启后补下发）、serve 启动时拉起标记了“自动拉起”的容器、
// 恢复端口暴露。没有 watchStarts 的替身管理器（单测）不启动任何后台服务。
async function startContainerServices(ctx, state) {
    const manager = getWebNetworkManager(ctx, state);
    const homeDir = ctx.homeDir || os.homedir();
    sweepStaleExecEnvFiles(homeDir);
    const reconcile = () => reconcileContainerServices(ctx, state, manager);
    state.networkWatch = manager.watchStarts({ onReconnect: reconcile });
    await reconcile();
    resumeQueuedAgentTurns(ctx, state).catch(() => {});
}

// 拉起 autostartOnServe 的容器并恢复端口暴露：serve 启动时做一次，运行时重启后（事件流重连）再做一次，幂等
async function reconcileContainerServices(ctx, state, manager) {
    const homeDir = ctx.homeDir || os.homedir();
    const forwarder = getWebPortForwarder(ctx, state);
    // 以运行时里真实存在的容器为准（按 id 对应名字）；状态目录里有、容器却没有的是孤儿，既不拉起也不转发
    state.containerNames = new Map((await manager.listManaged()).map(item => [item.id, item.name]));
    for (const id of containerState.listStateIds(homeDir)) {
        const name = state.containerNames.get(id);
        if (!name) continue;
        let policy;
        try { policy = normalizePolicy(containerState.readNetworkRaw(homeDir, id) || undefined); } catch (e) { continue; }
        if (policy.autostartOnServe) {
            try {
                if (ctx.getContainerStatus(name) !== 'running') await ctx.dockerExecAsync(['start', name], { timeout: 30000 });
            } catch (e) {
                ctx.logger.warn('autostart container failed', { name, message: e && e.message });
            }
        }
        if (policy.expose.length) await forwarder.sync(id, policy.expose);
    }
}

// serve 异常退出时 exec 的临时 env 文件（明文）可能残留：启动时清掉超过 6 小时的（正在跑的长任务不会这么久还没读完它）
function sweepStaleExecEnvFiles(homeDir) {
    const dir = path.join(homeDir, '.manyoyo', 'tmp');
    try {
        for (const entry of fs.readdirSync(dir)) {
            if (!/^(exec|env)-/.test(entry)) continue;
            const file = path.join(dir, entry);
            if (Date.now() - fs.statSync(file).mtimeMs > 6 * 3600 * 1000) fs.rmSync(file, { force: true });
        }
    } catch (e) { /* 没有目录 */ }
}

// 运行时就绪后启动 startContainerServices
function startContainerNetworkWatch(ctx, state) {
    const manager = getWebNetworkManager(ctx, state);
    if (typeof manager.watchStarts !== 'function' || state.networkWatch || state.containerServicesStarting) return;
    state.containerServicesStarting = true;
    const deadline = Date.now() + 10 * 60 * 1000;
    const tick = () => {
        const status = ctx.runtimeState.status;
        if (status === 'ready') {
            startContainerServices(ctx, state).catch(e => ctx.logger.warn('container services failed', { message: e && e.message }));
            return;
        }
        if (status === 'failed' || Date.now() > deadline) return;
        setTimeout(tick, 1000).unref();
    };
    tick();
}

function startStaleSetupCleanup(ctx) {
    const deadline = Date.now() + 10 * 60 * 1000;
    const tick = () => {
        const status = ctx.runtimeState.status;
        if (status === 'ready') {
            cleanupStaleSetupTestContainers(ctx);
            return;
        }
        if (status === 'failed' || Date.now() > deadline) return;
        setTimeout(tick, 1000).unref();
    };
    tick();
}

// 软件源每次创建容器时现读配置：向导/系统设置里改了马上对新容器生效；配置写坏时退回官方默认
function readWebMirrors(state) {
    try {
        const snapshot = readWebConfigSnapshot(state.webConfigPath);
        return normalizeMirrors(snapshot.parseError ? undefined : (snapshot.parsed || {}).mirrors);
    } catch (e) {
        return normalizeMirrors(undefined);
    }
}

// 会话容器与 CLI run 共用同一个 Playwright 浏览器模式集成（挂载目录、NO_PROXY 等）
async function buildWebPlaywrightIntegration(ctx, state, runtime) {
    let globalConfig = {};
    try {
        const snapshot = readWebConfigSnapshot(state.webConfigPath);
        globalConfig = snapshot.parseError ? {} : (snapshot.parsed || {});
    } catch (e) {
        globalConfig = {};
    }
    const integration = await buildContainerIntegration({
        globalConfig,
        homeDir: ctx.homeDir,
        runtimeCommand: ctx.dockerCmd || 'docker',
        envEntries: (runtime.containerEnvs || []).filter((_, i) => i % 2 === 1)
    });
    if (integration.warning) {
        console.warn(integration.warning);
    }
    return mergeIntegration(runtime, integration);
}

// serve 进程的网络规则下发器（一份，懒创建）
function getWebNetworkManager(ctx, state) {
    if (ctx.networkManager) return ctx.networkManager;
    if (!state.networkManager) {
        state.networkManager = createNetworkManager({
            command: ctx.dockerCmd,
            env: ctx.dockerEnv,
            homeDir: ctx.homeDir || os.homedir(),
            imageRef: () => `${ctx.imageName}:${ctx.imageVersion}`,
            getMirrorUrls: () => Object.values(readWebMirrors(state)).filter(Boolean),
            warn: message => ctx.logger.warn(message)
        });
    }
    return state.networkManager;
}

// 进入容器前一律检查网络规则（宿主机侧的“本次启动已下发”状态）：文件浏览也会 exec /bin/bash -lc，
// 里面的 .bashrc 等是 Agent 能改的代码，不能在规则缺失的窗口里跑
async function ensureWebContainer(ctx, state, containerInput, messageSessionRef = null) {
    const runtime = typeof containerInput === 'string'
        ? buildStaticContainerRuntime(ctx, containerInput)
        : containerInput;

    if (!runtime || !runtime.containerName) {
        throw new Error('containerName 不能为空');
    }

    if (!ctx.containerExists(runtime.containerName)) {
        const mirrors = readWebMirrors(state);
        // 用户 env 不进容器配置，写进状态目录的 box/env，每次 exec 现读（见 lib/container-exec.js）
        const userEnvLines = containerState.userEnvLines(runtime.containerEnvs);
        const playwright = await buildWebPlaywrightIntegration(ctx, state, runtime);
        const containerEnvs = containerState.stripEnvKeys(playwright.containerEnvs, new Set(userEnvLines.map(containerState.envLineKey)));
        const networkManager = getWebNetworkManager(ctx, state);
        const networkPolicy = await withEnvEndpoints(await networkManager.resolveRefs(normalizePolicy(runtime.network)), [...userEnvLines, ...containerState.readEnvFilePaths(runtime.envFiles || []).flatMap(file => file.entries.map(entry => `${entry.key}=${entry.value}`))]);
        if (!hasNetworkArg([...(runtime.contModeArgs || []), ...(playwright.containerExtraArgs || [])])) {
            await networkManager.ensureBridgeNetwork();
        }
        const containerStateInfo = containerState.createState({
            homeDir: ctx.homeDir || os.homedir(),
            envLines: userEnvLines,
            envFiles: runtime.envFiles,
            autostart: runtime.autostart,
            systemPrompt: runtime.systemPrompt,
            network: networkPolicy,
            netRequired: !isUnrestrictedPolicy(networkPolicy),
            meta: { name: runtime.containerName }
        });
        const args = buildContainerRunArgs({
            state: containerStateInfo,
            defaultNetwork: NETWORK_NAME,
            mirrors,
            containerName: runtime.containerName,
            hostPath: runtime.hostPath,
            containerPath: runtime.containerPath,
            imageName: runtime.imageName,
            imageVersion: runtime.imageVersion,
            contModeArgs: runtime.contModeArgs,
            containerExtraArgs: playwright.containerExtraArgs,
            containerEnvs,
            containerVolumes: playwright.containerVolumes,
            containerPorts: runtime.containerPorts,
            defaultCommand: runtime.defaultCommand
        });

        try {
            await ensureWebImage(ctx, state, webImageRef(ctx, runtime), { failFast: true });
            ctx.dockerExecArgs(args, { stdio: 'pipe' });
        } catch (e) {
            containerState.removeState(ctx.homeDir || os.homedir(), containerStateInfo.id);
            ctx.showImagePullHint(e);
            throw e;
        }

        await ctx.waitForContainerReady(runtime.containerName, { throwOnFailure: true });
        // 先下发网络规则再做任何 exec；失败即关闭（抛错，容器留着，init 在等门闩）
        await networkManager.apply(runtime.containerName, { expectId: containerStateInfo.id });
        // 创建时填的端口暴露：容器已就绪、规则已下发后立即开始转发；端口被占等失败只警告，网络页里能看到没有生效
        if (networkPolicy.expose.length) {
            if (!state.containerNames) state.containerNames = new Map();
            state.containerNames.set(containerStateInfo.id, runtime.containerName);
            const failures = await getWebPortForwarder(ctx, state).sync(containerStateInfo.id, networkPolicy.expose);
            failures.forEach(message => console.warn(message));
        }
        applyAptMirror({
            dockerExecArgs: ctx.dockerExecArgs,
            containerName: runtime.containerName,
            mirrors,
            warn: message => console.warn(message)
        });
        appendWebSessionMessage(
            state.webHistoryDir,
            messageSessionRef || runtime.containerName,
            'system',
            `容器 ${runtime.containerName} 已创建并启动。`
        );
        if (runtime.first) {
            const firstResult = await runWebFirstCommand(ctx, runtime.containerName, runtime.first);
            appendWebSessionMessage(
                state.webHistoryDir,
                messageSessionRef || runtime.containerName,
                'system',
                firstResult.exitCode === 0 ? '首次命令已执行' : formatWebFirstFailure(firstResult, runtime.first)
            );
        }
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
    await getWebNetworkManager(ctx, state).ensureReady(runtime.containerName);
}

const WEB_FIRST_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const WEB_FIRST_COMMAND_OUTPUT_CHARS = 500;

// 新建容器后执行一次 first（与 CLI 的 executeFirstCommand 同语义，经 buildExecArgs 带上 first.env）；
// 失败只返回结果，不删容器、不抛错
function runWebFirstCommand(ctx, containerName, first) {
    return new Promise(resolve => {
        const tail = createTailBuffer(WEB_FIRST_COMMAND_OUTPUT_CHARS * 4);
        let settled = false;
        let timer = null;
        const finish = result => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve({ ...result, output: tail.text() });
        };
        let child;
        try {
            child = spawnContainerExec(
                ctx,
                containerName,
                { extraEnv: first.envLines, command: ['/bin/bash', '-c', first.command] },
                { stdio: ['ignore', 'pipe', 'pipe'] }
            );
        } catch (e) {
            tail.push(e && e.message ? e.message : '');
            finish({ exitCode: 1 });
            return;
        }
        timer = setTimeout(() => {
            tail.push('\n[等了 10 分钟仍未结束，已停止等待（容器里的命令可能还在运行）]');
            child.kill('SIGKILL');
            finish({ exitCode: 124 });
        }, ctx.firstCommandTimeoutMs || WEB_FIRST_COMMAND_TIMEOUT_MS);
        for (const stream of [child.stdout, child.stderr]) {
            stream.setEncoding('utf8');
            stream.on('data', chunk => tail.push(chunk));
        }
        child.on('error', error => {
            tail.push(error && error.message ? error.message : '');
            finish({ exitCode: 1 });
        });
        child.on('close', (code, signal) => finish({ exitCode: typeof code === 'number' ? code : (signal ? 1 : 0) }));
    });
}

function formatWebFirstFailure(result, first) {
    const secrets = first.envLines.map(line => line.slice(line.indexOf('=') + 1));
    const text = sanitizeServeLogText(redactSecrets(result.output, secrets)).trim().slice(-WEB_FIRST_COMMAND_OUTPUT_CHARS);
    return `首次命令失败（退出码 ${result.exitCode}）：${text}`;
}

async function execCommandInWebContainer(ctx, containerName, command, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const agentProgram = typeof opts.agentProgram === 'string' ? opts.agentProgram : '';
    return await new Promise((resolve, reject) => {
        const process = spawnContainerExec(
            ctx,
            containerName,
            { withEnv: opts.withEnv !== false, command: ['/bin/bash', '-lc', command] },
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        const MAX_RAW_OUTPUT_CHARS = ctx.agentRawOutputMaxChars || AGENT_RAW_OUTPUT_MAX_CHARS;
        const stdoutTail = createTailBuffer(Math.min(MAX_RAW_OUTPUT_CHARS, AGENT_OUTPUT_TAIL_MAX_CHARS));
        let stdoutOutput = '';
        let stderrOutput = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;

        function appendChunk(chunk, target) {
            if (!chunk) return;
            const text = chunk.toString('utf-8');
            if (!text) return;
            if (target.tail) target.tail.push(text);
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

        // 按流解码：逐块 toString 会把跨块的多字节字符（中文）拆成乱码
        process.stdout.setEncoding('utf8');
        process.stderr.setEncoding('utf8');
        process.stdout.on('data', chunk => appendChunk(chunk, {
            tail: stdoutTail,
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
            // 结尾只在开头被截断时才需要（拼接最多 16MB，只算一次）
            const tailText = stdoutTruncated ? stdoutTail.text() : '';
            const output = resolveAgentFinalOutput(agentProgram, { stdout: clippedStdout, stdoutTruncated, stdoutTail: tailText, raw: clippedRaw });
            resolve({
                exitCode,
                output,
                stdout: clippedStdout,
                ...(stdoutTruncated ? { stdoutTail: tailText } : {}),
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

function spawnContainerRawFileStream(ctx, containerName, filePath) {
    return spawnContainerExec(
        ctx,
        containerName,
        { withEnv: false, command: ['cat', '--', filePath] },
        { stdio: ['ignore', 'pipe', 'pipe'] }
    );
}

const webRawFileStreamCounts = new Map();

function acquireWebRawFileStreamSlot(containerName) {
    const current = webRawFileStreamCounts.get(containerName) || 0;
    if (current >= WEB_FILE_RAW_MAX_CONCURRENT_PER_CONTAINER) {
        return false;
    }
    webRawFileStreamCounts.set(containerName, current + 1);
    return true;
}

function releaseWebRawFileStreamSlot(containerName) {
    const current = webRawFileStreamCounts.get(containerName) || 0;
    if (current <= 1) {
        webRawFileStreamCounts.delete(containerName);
        return;
    }
    webRawFileStreamCounts.set(containerName, current - 1);
}

function inferFileLanguage(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    return FILE_LANGUAGE_MAP[ext] || 'text';
}

async function execJsonCommandInWebContainer(ctx, containerName, command) {
    const result = await execCommandInWebContainer(ctx, containerName, command, { withEnv: false });
    if (result.exitCode !== 0) {
        throw new Error(result.output || '容器命令执行失败');
    }
    try {
        return JSON.parse(String(result.stdout || '{}'));
    } catch (e) {
        throw new Error('容器返回了无法解析的 JSON');
    }
}

// options.limit / options.prefix 供输入框 @ 补全用：先按名字前缀过滤、按“目录在前 + 名字”排序后只取前 limit 项，
// 只对这些项做 lstat（大目录里全量 lstat 才是慢的部分）
function buildContainerFileListCommand(requestedPath, options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 0;
    const prefix = typeof options.prefix === 'string' ? options.prefix.toLowerCase() : '';
    return buildWebContainerNodeCommand(`
// __MANYOYO_FS_LIST__
const fs = require('fs');
const path = require('path');

const requestedPath = ${JSON.stringify(String(requestedPath || '/'))};
const limit = ${JSON.stringify(limit)};
const prefix = ${JSON.stringify(prefix)};

try {
    const realPath = fs.realpathSync(requestedPath);
    const stat = fs.statSync(realPath);
    if (!stat.isDirectory()) {
        throw new Error('目标不是目录: ' + realPath);
    }

    const root = path.parse(realPath).root;
    const parentPath = realPath === root ? '' : path.dirname(realPath);
    let dirents = fs.readdirSync(realPath, { withFileTypes: true });
    if (prefix) {
        dirents = dirents.filter(entry => entry.name.toLowerCase().startsWith(prefix));
    }
    let truncated = false;
    if (limit > 0 && dirents.length > limit) {
        dirents.sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name, 'zh-CN');
        });
        dirents = dirents.slice(0, limit);
        truncated = true;
    }
    const entries = dirents
        .map(entry => {
            const fullPath = path.join(realPath, entry.name);
            let itemStat = null;
            try {
                itemStat = fs.lstatSync(fullPath);
            } catch (e) {
                itemStat = null;
            }
            let kind = 'other';
            let symlinkTarget = null;
            let symlinkTargetKind = null;
            if (entry.isDirectory()) {
                kind = 'directory';
            } else if (entry.isFile()) {
                kind = 'file';
            } else if (entry.isSymbolicLink()) {
                kind = 'symlink';
                try {
                    const resolvedPath = fs.realpathSync(fullPath);
                    const resolvedStat = fs.statSync(resolvedPath);
                    symlinkTarget = resolvedPath;
                    symlinkTargetKind = resolvedStat.isDirectory() ? 'directory' : 'file';
                } catch (e) {
                    symlinkTarget = null;
                    symlinkTargetKind = null;
                }
            }
            return {
                name: entry.name,
                path: fullPath,
                kind,
                size: itemStat && typeof itemStat.size === 'number' ? itemStat.size : 0,
                mtimeMs: itemStat && typeof itemStat.mtimeMs === 'number' ? Math.floor(itemStat.mtimeMs) : 0,
                symlinkTarget,
                symlinkTargetKind
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
        entries,
        ...(truncated ? { truncated: true } : {})
    }));
} catch (e) {
    process.stdout.write(JSON.stringify({
        error: e && e.message ? e.message : '读取目录失败'
    }));
}
`);
}

// 只判断路径是否存在（点击聊天里的路径时用）；不存在不是错误，返回 exists:false
function buildContainerPathExistsCommand(requestedPath) {
    return buildWebContainerNodeCommand(`
// __MANYOYO_FS_EXISTS__
const fs = require('fs');

const requestedPath = ${JSON.stringify(String(requestedPath || ''))};

let result = { exists: false };
try {
    const stat = fs.statSync(requestedPath);
    result = { exists: true, type: stat.isDirectory() ? 'dir' : (stat.isFile() ? 'file' : 'other') };
} catch (e) {
    result = { exists: false };
}
process.stdout.write(JSON.stringify(result));
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
const path = require('path');

const crypto = require('crypto');

const requestedPath = ${JSON.stringify(String(requestedPath || ''))};
const maxBytes = ${String(maxBytes)};
const editMaxBytes = ${String(WEB_FILE_EDIT_MAX_BYTES)};
const imageExtensions = new Set(${JSON.stringify(Object.keys(IMAGE_EXTENSION_CONTENT_TYPES))});

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

    // 图片走 fs/raw 流式传输,这里只确认元信息,不把整份二进制读进内存/JSON
    if (imageExtensions.has(path.extname(realPath).toLowerCase())) {
        process.stdout.write(JSON.stringify({
            path: realPath,
            kind: 'image',
            size: stat.size
        }));
    } else {
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
            // 版本号：整个文件内容的 sha256（保存时带回来，容器里的文件被改过就能发现）；只给可编辑的小文件算
            let etag = '';
            if (size < editMaxBytes) {
                const whole = readBytes === size ? buffer : fs.readFileSync(realPath);
                etag = crypto.createHash('sha256').update(whole).digest('hex');
            }
            process.stdout.write(JSON.stringify({
                path: realPath,
                kind: 'text',
                size,
                truncated: maxBytes > 0 && size > maxBytes,
                etag,
                content: buffer.toString('utf8')
            }));
        }
    }
} catch (e) {
    process.stdout.write(JSON.stringify({
        error: e && e.message ? e.message : '读取文件失败'
    }));
}
`);
}

function buildContainerFileStatCommand(requestedPath) {
    return buildWebContainerNodeCommand(`
// __MANYOYO_FS_STAT__
const fs = require('fs');

const requestedPath = ${JSON.stringify(String(requestedPath || ''))};

try {
    const realPath = fs.realpathSync(requestedPath);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
        throw new Error('目标不是文件: ' + realPath);
    }
    process.stdout.write(JSON.stringify({
        path: realPath,
        size: stat.size
    }));
} catch (e) {
    process.stdout.write(JSON.stringify({
        error: e && e.message ? e.message : '读取文件失败'
    }));
}
`);
}

// expectedEtag：读取时拿到的内容 sha256。写入前在容器里重新计算当前内容的哈希，不一致就不写（返回 conflict）。
// 检查和写入之间仍有一个极短的窗口（同一个脚本里的两条语句之间），可以接受。
function buildContainerFileWriteCommand(requestedPath, content, expectedEtag) {
    return buildWebContainerNodeCommand(`
// __MANYOYO_FS_WRITE__
const fs = require('fs');
const crypto = require('crypto');

const requestedPath = ${JSON.stringify(String(requestedPath || ''))};
const editMaxBytes = ${String(WEB_FILE_EDIT_MAX_BYTES)};
const expectedEtag = ${JSON.stringify(String(expectedEtag == null ? '' : expectedEtag))};
const nextContent = ${JSON.stringify(String(content == null ? '' : content))};

try {
    const realPath = fs.realpathSync(requestedPath);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
        throw new Error('目标不是文件: ' + realPath);
    }

    // 太大的文件不整个读进内存比对：前端本来就不允许编辑，直接给明确的提示（而不是让用户看到“冲突”）
    if (stat.size >= editMaxBytes) {
        throw new Error('文件过大，当前仅支持编辑小于 2MB 的文本文件');
    }
    const currentEtag = crypto.createHash('sha256').update(fs.readFileSync(realPath)).digest('hex');
    if (expectedEtag !== '*' && currentEtag !== expectedEtag) {
        process.stdout.write(JSON.stringify({
            conflict: true,
            error: '文件已在容器里被修改'
        }));
    } else {
        fs.writeFileSync(realPath, nextContent, 'utf8');
        const savedStat = fs.statSync(realPath);
        process.stdout.write(JSON.stringify({
            path: realPath,
            saved: true,
            size: savedStat.size,
            etag: crypto.createHash('sha256').update(Buffer.from(nextContent, 'utf8')).digest('hex')
        }));
    }
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

function buildContainerFileCreateCommand(requestedPath) {
    return buildWebContainerNodeCommand(`
// __MANYOYO_FS_CREATE__
const fs = require('fs');
const path = require('path');

const requestedPath = ${JSON.stringify(String(requestedPath || ''))};

try {
    const resolvedPath = path.resolve(requestedPath);
    const parentPath = path.dirname(resolvedPath);
    const realParentPath = fs.realpathSync(parentPath);
    const targetPath = path.join(realParentPath, path.basename(resolvedPath));
    if (fs.existsSync(targetPath)) {
        throw new Error('文件已存在: ' + targetPath);
    }

    fs.writeFileSync(targetPath, '', 'utf8');
    const stat = fs.statSync(targetPath);
    process.stdout.write(JSON.stringify({
        path: targetPath,
        name: path.basename(targetPath),
        kind: 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        created: true
    }));
} catch (e) {
    process.stdout.write(JSON.stringify({
        error: e && e.message ? e.message : '创建文件失败'
    }));
}
`);
}

async function execAgentInWebContainerStream(ctx, state, sessionRefOrContainerName, command, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const sessionRef = typeof sessionRefOrContainerName === 'string'
        ? { containerName: sessionRefOrContainerName, agentId: WEB_DEFAULT_AGENT_ID }
        : sessionRefOrContainerName;
    const agentProgram = typeof opts.agentProgram === 'string' ? opts.agentProgram : '';
    const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
    // 调用方可能已经在路由入口占过锁（见 reserveWebAgentRun）：复用那一份 runState，
    // 不要另起一个对象，否则 stopWebAgentRun 拿到的还是占位、杀不到真正的进程
    const runState = opts.runState && typeof opts.runState === 'object'
        ? opts.runState
        : reserveWebAgentRun(state, sessionRef);
    let process;
    try {
        process = spawnContainerExec(
            ctx,
            sessionRef.containerName,
            // 包一层：新会话 + MANYOYO_RUN_ID + PID 文件，停止 / 打断时才能进到容器里按进程组发信号
            { command: ['/bin/bash', '-lc', agentRunControl.wrapAgentCommand(command, runState.runId)] },
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );
    } catch (e) {
        // spawn 同步抛错（如 dockerCmd 不存在）时必须释放锁，否则这个容器永远发不出消息
        releaseWebAgentRun(state, sessionRef.containerName, runState);
        throw e;
    }

    runState.process = process;
    runState.command = command;
    runState.startedAt = new Date().toISOString();
    state.agentRuns.set(sessionRef.containerName, runState);
    // 准备阶段（拉起容器等）用户就点了停止：进程刚 spawn 出来立刻收掉
    if (runState.stopping === true) {
        terminateWebAgentRun(ctx, runState);
    }

    return await new Promise((resolve, reject) => {
        const MAX_RAW_OUTPUT_CHARS = ctx.agentRawOutputMaxChars || AGENT_RAW_OUTPUT_MAX_CHARS;
        const stdoutTail = createTailBuffer(Math.min(MAX_RAW_OUTPUT_CHARS, AGENT_OUTPUT_TAIL_MAX_CHARS));
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
            if (target.tail) target.tail.push(text);
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
                            content: contentDeltaAccumulator,
                            // token 级增量标记为 partial：调用方据此跳过事件日志、
                            // 并对历史落盘做节流（否则每个 token 都要重写一次历史 JSON）；
                            // chunk/chunkReset 只在 partial 时有意义，见 extractContentDeltaFromPayload
                            partial: deltaContent.partial === true,
                            chunk: typeof deltaContent.chunk === 'string' ? deltaContent.chunk : '',
                            chunkReset: deltaContent.chunkReset === true
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

        // 按流解码：逐块 toString 会把跨块的多字节字符（中文）拆成乱码
        process.stdout.setEncoding('utf8');
        process.stderr.setEncoding('utf8');
        process.stdout.on('data', chunk => {
            appendChunk(chunk, {
                tail: stdoutTail,
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
            releaseWebAgentRun(state, sessionRef.containerName, runState);
            runState.markClosed();
            reject(error);
        });
        process.on('close', code => {
            releaseWebAgentRun(state, sessionRef.containerName, runState);
            runState.markClosed();
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
            // 结尾只在开头被截断时才需要（拼接最多 16MB，只算一次）
            const tailText = stdoutTruncated ? stdoutTail.text() : '';
            const output = resolveAgentFinalOutput(agentProgram, { stdout: clippedStdout, stdoutTruncated, stdoutTail: tailText, raw: clippedRaw });
            resolve({
                exitCode,
                output,
                stdout: clippedStdout,
                ...(stdoutTruncated ? { stdoutTail: tailText } : {}),
                // 真实的 claude 收到 SIGINT 会正常收尾、退出码为 0（L3 实测）：发过信号就算被打断，不能只看退出码
                interrupted: runState.stopping === true && (exitCode !== 0 || runState.signaled === true)
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

// 前端发送前为提示词生成的 id：服务端原样存进 user 消息，前端据此判断“这条是不是已经发出去了”
function readClientMessageId(res, payload) {
    const raw = payload && payload.clientMessageId;
    if (raw === undefined || raw === null || raw === '') {
        return { value: '' };
    }
    if (typeof raw !== 'string' || !messagesView.CLIENT_MESSAGE_ID_PATTERN.test(raw)) {
        sendJson(res, 400, { error: 'clientMessageId 格式不正确' });
        return null;
    }
    return { value: raw };
}

// 同一个 clientMessageId 已经出现在该 agent 的消息里：这条提示词服务端已经收到过，不能再执行一遍
// （前端在网络中断后重发同一条时，靠它兜住“服务端其实已经收到”的情况）
function rejectDuplicateClientMessage(res, webHistoryDir, sessionRef, clientMessageId, options = {}) {
    if (!clientMessageId) {
        return false;
    }
    const history = loadWebSessionHistory(webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true });
    // includeQueue：排队中的也算收到过（追加请求网络中断后，前端把原文放回输入框再发，不能执行两次）
    const duplicated = Boolean(agentSession) && (agentSession.messages.some(
        message => message && message.role === 'user' && message.clientMessageId === clientMessageId
    ) || (options.includeQueue === true && agentQueue.getQueue(agentSession).some(item => item.clientMessageId === clientMessageId)));
    if (!duplicated) {
        return false;
    }
    sendJson(res, 409, { error: '这条消息已经发出过', duplicate: true });
    return true;
}

// 检查重复到 user 消息落盘之间可能有 await（容器启动、网络规则就绪）：并发的同一条请求也要挡住
const inflightClientMessages = new Set();

// 返回 release()：消息落盘（或失败）后调用；已是重复则回 409 并返回 null
function claimClientMessage(res, webHistoryDir, sessionRef, clientMessageId) {
    if (!clientMessageId) {
        return () => {};
    }
    if (rejectDuplicateClientMessage(res, webHistoryDir, sessionRef, clientMessageId, { includeQueue: true })) {
        return null;
    }
    const key = `${path.resolve(webHistoryDir)}|${buildWebSessionKey(sessionRef.containerName, sessionRef.agentId)}|${clientMessageId}`;
    if (inflightClientMessages.has(key)) {
        sendJson(res, 409, { error: '这条消息已经发出过', duplicate: true });
        return null;
    }
    inflightClientMessages.add(key);
    return () => inflightClientMessages.delete(key);
}

const COMPRESS_MIN_BYTES = 1024;

function acceptsGzip(req) {
    return Boolean(req && req.headers && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || '')));
}

function etagMatches(req, etag) {
    const header = req && req.headers ? String(req.headers['if-none-match'] || '') : '';
    if (!header) {
        return false;
    }
    if (header.trim() === '*') {
        return true;
    }
    const strip = value => value.trim().replace(/^W\//, '');
    return header.split(',').some(candidate => strip(candidate) === strip(etag));
}

// 统一的响应出口：可选 ETag（命中 If-None-Match 回 304）+ >1KB 的内容异步 gzip。
// 只用于一次性 JSON/HTML；NDJSON 流和 WebSocket 不走这里，压缩会让它们被缓冲、失去实时性。
function sendBody(res, statusCode, contentType, body, extraHeaders = {}, options = {}) {
    const req = res.req;
    const headers = {
        'Content-Type': contentType,
        'Cache-Control': options.etag ? 'no-cache' : 'no-store',
        Vary: 'Accept-Encoding',
        ...extraHeaders
    };
    if (options.etag) {
        headers.ETag = options.etag;
        if (statusCode === 200 && etagMatches(req, options.etag)) {
            delete headers['Content-Type'];
            res.writeHead(304, headers);
            res.end();
            return;
        }
    }
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf-8');
    const finish = (payload, encoding) => {
        if (res.destroyed || res.writableEnded) {
            return;
        }
        if (encoding) {
            headers['Content-Encoding'] = encoding;
        }
        headers['Content-Length'] = payload.length;
        res.writeHead(statusCode, headers);
        res.end(payload);
    };
    if (acceptsGzip(req) && buffer.length > COMPRESS_MIN_BYTES) {
        const compressed = options.gzipBuffer
            ? Promise.resolve(options.gzipBuffer)
            : new Promise((resolve, reject) => {
                zlib.gzip(buffer, { level: 6 }, (error, result) => (error ? reject(error) : resolve(result)));
            });
        compressed.then(result => finish(result, 'gzip'), () => finish(buffer, ''));
        return;
    }
    finish(buffer, '');
}

// options.etag 传入时按它做条件请求；options.autoEtag 则用响应体的 sha1（响应体小、生成成本低的接口用）
function sendJson(res, statusCode, payload, extraHeaders = {}, options = {}) {
    const text = JSON.stringify(payload);
    const etag = options.etag
        || (options.autoEtag === true && statusCode === 200
            ? `W/"${crypto.createHash('sha1').update(text).digest('hex')}"`
            : '');
    sendBody(res, statusCode, 'application/json; charset=utf-8', text, extraHeaders, { etag });
}

function sendNdjson(res, payload) {
    res.write(`${JSON.stringify(payload)}\n`);
}

const WEB_STREAM_FLUSH_EVENT_TYPES = new Set(['process.exited', 'process.interrupted', 'agent.turn.failed']);

function createWebStreamEmitter(res, webHistoryDir, sessionRef) {
    return (payload, type, data = {}) => {
        // 流式过程中的事件只改内存（最迟 1 秒落盘）；结束类事件立即写盘，顺带写出之前攒着的内容
        const controlEvent = appendWebSessionControlEvent(webHistoryDir, sessionRef, type, data, {
            defer: !WEB_STREAM_FLUSH_EVENT_TYPES.has(type)
        });
        sendNdjson(res, { ...payload, controlEvent });
    };
}

function resolveWebStreamControlEventType(event) {
    if (event && event.type === 'content_delta') {
        return 'agent.turn.delta';
    }
    if (event && event.type === 'trace' && event.traceEvent) {
        return 'agent.tool.observed';
    }
    return 'process.stdout';
}

// 容器级运行锁的"占位"。必须在路由里同步调用：从 409 检查到真正 spawn 之间隔着
// readJsonBody / prepareWebAgentExecution（含 ensureWebContainer 拉起容器）等多个
// await，容器冷启动时这个窗口有好几秒。不先占住的话第二次发送会穿过 409 检查，
// 同一容器里真的跑起两个 agent 进程，而且后者会覆盖前者的运行登记，
// 让第一个进程再也停不掉
function reserveWebAgentRun(state, sessionRef) {
    const runState = {
        containerName: sessionRef.containerName,
        sessionRef: { containerName: sessionRef.containerName, agentId: sessionRef.agentId },
        sessionKey: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
        process: null,
        command: '',
        startedAt: new Date().toISOString(),
        stopping: false,
        // 进程 close 时 resolve：停止 / 打断时据此判断容器里的进程有没有退出（见 agent-run-control.js）
        runId: agentRunControl.createRunId(),
        closed: null,
        markClosed: null
    };
    runState.closed = new Promise(resolve => { runState.markClosed = resolve; });
    state.agentRuns.set(sessionRef.containerName, runState);
    return runState;
}

// 只有占位仍是自己那一份时才释放，避免误删别人的登记
function releaseWebAgentRun(state, containerName, runState) {
    if (state.agentRuns.get(containerName) === runState) {
        state.agentRuns.delete(containerName);
    }
}

// 追加提示词时打断当前这一轮（立即 / 当前步骤结束后 / 步骤超时）：和用户停止一样走进程组信号，
// 区别是不置 userStopped，这一轮结束后会接着发队首
function steerWebAgentRun(ctx, runState, reason, state = null) {
    if (!runState || runState.steered || runState.stopping) {
        return false;
    }
    // 排队的 now / step 项已被取消：不要白白打断正在跑的任务
    if (state && !queueHasSteerItems(state, runState.sessionRef)) {
        clearTimeout(runState.stepTimer);
        runState.stepPending = false;
        return false;
    }
    clearTimeout(runState.stepTimer);
    runState.steered = reason;
    runState.stopping = true;
    if (runState.process) {
        terminateWebAgentRun(ctx, runState);
    }
    return true;
}

function queueHasSteerItems(state, sessionRef) {
    return peekAgentQueue(state, sessionRef).some(item => item.when === 'now' || item.when === 'step');
}

function armStepSteer(ctx, state, runState) {
    if (runState.steered || runState.stopping || runState.stepPending) {
        return;
    }
    runState.stepPending = true;
    runState.stepTimer = setTimeout(() => {
        if (steerWebAgentRun(ctx, runState, 'step-timeout', state)) {
            ctx.logger.warn('agent steer step fallback to now', { session: runState.sessionKey });
        }
    }, ctx.agentStepFallbackMs || agentQueue.STEP_FALLBACK_MS);
    if (typeof runState.stepTimer.unref === 'function') {
        runState.stepTimer.unref();
    }
}

// 没有前端连着时顶替 res：事件照常落盘，只是没人收
function createHeadlessResponse() {
    const sink = new EventEmitter();
    sink.writableEnded = false;
    sink.writableFinished = false;
    sink.destroyed = false;
    sink.writeHead = () => {};
    sink.write = () => true;
    sink.end = () => {
        sink.writableEnded = true;
        sink.writableFinished = true;
        sink.emit('close');
    };
    return sink;
}

function peekAgentSession(state, sessionRef) {
    const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
    return getWebAgentSession(history, sessionRef.agentId, { includeArchived: true });
}

function peekAgentQueue(state, sessionRef) {
    const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true });
    return agentSession && Array.isArray(agentSession.queue) ? agentSession.queue : [];
}

// 同步取出队首并开始新一轮（取出和占锁之间没有 await，提示词不会丢也不会重复发）。
// 开不起来（容器忙、准备失败）就放回队首，由用户决定
// force：用户点了“继续发送”，解除暂停后发；其余（自动调度）遇到暂停的队列不发
function dispatchNextQueued(ctx, state, sessionRef, { force = false } = {}) {
    if (state.agentRuns.has(sessionRef.containerName)) {
        return false;
    }
    const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true });
    if (!agentSession || !agentQueue.getQueue(agentSession).length) {
        return false;
    }
    if (force) {
        agentQueue.resumeQueue(agentSession);
    } else if (agentQueue.isPaused(agentSession)) {
        return false;
    }
    const item = agentQueue.takeNext(agentSession);
    saveWebSessionHistory(state.webHistoryDir, sessionRef.containerName, history);
    const putBack = reason => {
        const latest = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
        const latestSession = getWebAgentSession(latest, sessionRef.agentId, { includeArchived: true });
        if (latestSession) {
            agentQueue.getQueue(latestSession).unshift(item);
            saveWebSessionHistory(state.webHistoryDir, sessionRef.containerName, latest);
        }
        ctx.logger.warn('queued prompt put back', { session: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId), reason });
    };
    runWebAgentStreamTurn(ctx, state, sessionRef, item.text, item.clientMessageId || '', createHeadlessResponse(), Array.isArray(item.images) ? item.images : [])
        .then(turn => {
            if (turn && turn.busy) putBack('busy');
            else if (turn && turn.error) putBack(turn.error);
        })
        .catch(e => putBack(e && e.message ? e.message : 'failed'));
    return true;
}

// 容器里还活着的运行 id（上一个 serve 留下的孤儿任务，或另一个 serve 实例正在跑的任务）；读不到当作没有
function listLiveRunsInContainer(ctx, containerName) {
    return new Promise(resolve => {
        let child;
        try {
            child = spawnContainerExec(ctx, containerName, { command: agentRunControl.buildLiveRunsCommand() }, { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) {
            resolve([]);
            return;
        }
        let out = '';
        child.stdout.on('data', chunk => { out += chunk; });
        child.once('close', () => resolve(out.split('\n').map(line => line.trim()).filter(agentRunControl.isValidRunId)));
        child.once('error', () => resolve([]));
    });
}

// serve 重启后：队列里还有内容（用户停止过的除外）、又没有在跑的任务，就当作“这一轮结束后发送”处理。
// 容器里还有活着的 Agent 进程时不发：那是上一个 serve 留下的孤儿任务或另一个 serve 实例的任务，
// 再开一轮会和它并发；排队保留，由用户在界面上“继续发送”
async function resumeQueuedAgentTurns(ctx, state) {
    // 先等启动对账：否则会在还挂着旧 pending 的会话上再开新一轮
    try { await state.orphanReconcileReady; } catch (e) { /* 对账失败不影响排队恢复 */ }
    let containers = {};
    try {
        containers = listWebManyoyoContainers(ctx);
    } catch (e) {
        return;
    }
    for (const containerName of Object.keys(containers)) {
        const history = loadWebSessionHistory(state.webHistoryDir, containerName);
        const agentIds = Object.keys(history.agents || {}).filter(agentId => agentQueue.shouldAutoDispatch(history.agents[agentId]));
        if (!agentIds.length) {
            continue;
        }
        const live = await listLiveRunsInContainer(ctx, containerName);
        if (live.length) {
            ctx.logger.warn('queued prompts kept: agent still running in container', { container: containerName, runs: live.length });
            continue;
        }
        for (const agentId of agentIds) {
            dispatchNextQueued(ctx, state, { containerName, agentId });
        }
    }
}

// signals：默认 INT → TERM → KILL（用户点停止）；ctx 缺省时退回只杀宿主机上的客户端
function stopWebAgentRun(state, containerName, ctx = null) {
    const runState = state.agentRuns.get(containerName);
    if (!runState) {
        return false;
    }
    // 用户主动停止：排队的提示词不再自动发送（队列保留，由用户决定取消或继续）。
    // 暂停要落盘：只记在这一轮的内存里的话，serve 重启或下一轮结束后会被自动发出去
    runState.userStopped = true;
    if (runState.sessionRef) {
        const history = loadWebSessionHistory(state.webHistoryDir, runState.sessionRef.containerName);
        const agentSession = getWebAgentSession(history, runState.sessionRef.agentId, { includeArchived: true });
        if (agentSession && agentQueue.getQueue(agentSession).length && !agentQueue.isPaused(agentSession)) {
            agentQueue.pauseQueue(agentSession);
            saveWebSessionHistory(state.webHistoryDir, runState.sessionRef.containerName, history);
        }
    }
    clearTimeout(runState.stepTimer);
    if (!runState.process) {
        // 还在准备阶段（拉起容器 / 探测 resume），进程尚未 spawn：先记下停止意图，
        // execAgentInWebContainerStream 拿到进程后会立刻收掉它
        runState.stopping = true;
        return true;
    }
    if (runState.process.killed) {
        return false;
    }
    runState.stopping = true;
    if (!ctx) {
        try {
            runState.process.kill('SIGTERM');
        } catch (e) {
            // 进程可能已自行退出，视为停止成功（close 事件会收尾）
        }
        return true;
    }
    terminateWebAgentRun(ctx, runState);
    return true;
}

// 进到容器里按进程组停：只杀宿主机上的 exec 客户端，容器里的进程会继续跑（实测）
function terminateWebAgentRun(ctx, runState) {
    if (runState.terminating) {
        return runState.terminating;
    }
    runState.terminating = agentRunControl.terminateRun({
        runState,
        graceMs: ctx.agentStopGraceMs || agentRunControl.DEFAULT_GRACE_MS,
        killInContainer: (runId, signal) => new Promise(resolve => {
            runState.signaled = true;
            let child;
            try {
                child = spawnContainerExec(ctx, runState.containerName, { command: agentRunControl.buildRunKillCommand(runId, signal) }, { stdio: 'ignore' });
            } catch (e) {
                resolve();
                return;
            }
            child.once('close', resolve);
            child.once('error', resolve);
        })
    }).catch(() => {});
    return runState.terminating;
}

// serve 重启等原因会丢失 agentRuns 运行登记，但消息里可能残留 pending 标记
// （孤儿任务：容器里的进程或许还在跑，但再没有任何代码会去收尾这些消息）。
// 前端把 pending 视为"任务进行中"会永久禁用输入，这里把它们标记为已中断
function interruptOrphanPendingMessages(webHistoryDir, sessionRef) {
    const history = loadWebSessionHistory(webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true });
    if (!agentSession || !Array.isArray(agentSession.messages)) {
        return;
    }
    let touched = false;
    for (const message of agentSession.messages) {
        if (message && message.pending === true) {
            message.pending = false;
            message.interrupted = true;
            touched = true;
        }
    }
    if (!touched) {
        return;
    }
    const timestamp = new Date().toISOString();
    agentSession.updatedAt = timestamp;
    history.updatedAt = timestamp;
    saveWebSessionHistory(webHistoryDir, sessionRef.containerName, history);
}

// ---- serve 启动对账 ----
// serve 重启会丢掉内存里的运行登记，历史里留着 pending=true 的消息，前端据此永远显示“进行中”。
// 启动时记下当时就 pending 的那批消息 id（之后新发起的轮次不碰），再按容器里是否还有活着的运行分两种处理：
// 没有 → 立即标成已中断；还有（docker 下容器里的 agent 会比 serve 活得久）→ 每 5 秒查一次，跑完再标。
const WEB_ORPHAN_POLL_MS = 5000;
const ORPHAN_NOTE_INTERRUPTED = {
    trace: '服务重启，本轮已中断',
    reply: '服务重启时这一轮被中断了。可以发送“继续”让它接着做。'
};
const ORPHAN_NOTE_FINISHED = {
    trace: '服务重启，本轮在后台跑完，结果未接收',
    reply: '服务重启后这一轮在后台跑完了，但结果没能接收；可以发送“继续”让它总结。'
};

function collectStartupPending(ctx, state) {
    const entries = [];
    let names = [];
    try {
        names = listWebHistorySessionNames(state.webHistoryDir, ctx.isValidContainerName);
    } catch (e) {
        ctx.logger.warn('orphan reconcile: list history failed', { message: e && e.message });
        return entries;
    }
    for (const containerName of names) {
        try {
            const history = loadWebSessionHistory(state.webHistoryDir, containerName);
            for (const [agentId, agentSession] of Object.entries(history.agents || {})) {
                const ids = (agentSession.messages || []).filter(message => message && message.pending === true).map(message => message.id);
                if (ids.length) entries.push({ containerName, agentId, ids: new Set(ids) });
            }
        } catch (e) {
            ctx.logger.warn('orphan reconcile: skip unreadable history', { container: containerName, message: e && e.message });
        }
    }
    return entries;
}

// 只改启动时记下的那些消息；这一轮的执行过程末尾补一行，最终回复（没有流式半截回复就新建一条）写一句说明
function finalizeOrphanEntry(ctx, state, entry, note) {
    const sessionRef = { containerName: entry.containerName, agentId: entry.agentId };
    const history = loadWebSessionHistory(state.webHistoryDir, entry.containerName);
    const agentSession = getWebAgentSession(history, entry.agentId, { includeArchived: true });
    if (!agentSession || !Array.isArray(agentSession.messages)) return;
    const running = state.agentRuns.get(entry.containerName);
    const newerRunInSession = Boolean(running && running.sessionRef && running.sessionRef.agentId === entry.agentId);
    let touched = false;
    let replied = false;
    for (const message of agentSession.messages) {
        if (!message || message.pending !== true || !entry.ids.has(message.id)) continue;
        message.pending = false;
        message.interrupted = true;
        touched = true;
        if (message.streamTrace) {
            message.content = `${message.content || ''}\n[任务] ${note.trace}`;
        } else if (message.streamingReply) {
            message.streamingReply = false;
            message.content = message.content ? `${message.content}\n\n${note.reply}` : note.reply;
            replied = true;
        }
    }
    if (!touched) return;
    const timestamp = new Date().toISOString();
    agentSession.updatedAt = timestamp;
    history.updatedAt = timestamp;
    saveWebSessionHistory(state.webHistoryDir, entry.containerName, history);
    // 这个会话已经有新的一轮在跑：不在末尾插入说明，免得夹进新一轮的消息中间
    if (!replied && !newerRunInSession) {
        appendWebSessionMessage(state.webHistoryDir, sessionRef, 'assistant', note.reply, { mode: 'agent', interrupted: true });
    }
    appendWebSessionControlEvent(state.webHistoryDir, sessionRef, 'process.interrupted', { reason: 'serve-restart' });
}

function isWebContainerRunning(ctx, containerName) {
    try {
        return Boolean(ctx.containerExists(containerName)) && ctx.getContainerStatus(containerName) === 'running';
    } catch (e) {
        return false;
    }
}

async function waitForRuntimeReady(ctx) {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (ctx.runtimeState && ctx.runtimeState.status === 'starting' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function reconcileOrphanTurns(ctx, state) {
    const entries = collectStartupPending(ctx, state);
    if (!entries.length) return;
    await waitForRuntimeReady(ctx);
    const byContainer = new Map();
    for (const entry of entries) {
        if (!byContainer.has(entry.containerName)) byContainer.set(entry.containerName, []);
        byContainer.get(entry.containerName).push(entry);
    }
    for (const [containerName, list] of byContainer) {
        const live = isWebContainerRunning(ctx, containerName) ? await listLiveRunsInContainer(ctx, containerName) : [];
        if (!live.length) {
            for (const entry of list) {
                try { finalizeOrphanEntry(ctx, state, entry, ORPHAN_NOTE_INTERRUPTED); } catch (e) { ctx.logger.warn('orphan reconcile failed', { container: containerName, message: e && e.message }); }
            }
            continue;
        }
        let checking = false;
        const timer = setInterval(async () => {
            if (checking) return;
            checking = true;
            try {
                const stillLive = isWebContainerRunning(ctx, containerName) ? await listLiveRunsInContainer(ctx, containerName) : [];
                if (stillLive.length) return;
                clearInterval(timer);
                state.orphanTimers.delete(timer);
                for (const entry of list) {
                    try { finalizeOrphanEntry(ctx, state, entry, ORPHAN_NOTE_FINISHED); } catch (e) { ctx.logger.warn('orphan reconcile failed', { container: containerName, message: e && e.message }); }
                }
            } finally {
                checking = false;
            }
        }, ctx.orphanPollMs || WEB_ORPHAN_POLL_MS);
        if (typeof timer.unref === 'function') timer.unref();
        state.orphanTimers.add(timer);
    }
}

// 一轮 agent 对话的完整流程（占锁 → 落盘 → 执行 → 收尾）。res 是 NDJSON 响应；
// 排队的提示词在没有前端连接时由 createHeadlessResponse() 顶替，事件照常落盘。
// 返回 { busy } / { error }（没开始）或 { started: true }（跑完了）
async function runWebAgentStreamTurn(ctx, state, sessionRef, prompt, clientMessageId, res, images = []) {
    if (state.agentRuns.has(sessionRef.containerName)) {
        // 锁是容器级的：同一容器里其他 agent 会话在跑任务时同样命中这里
        return { busy: true };
    }
    // 紧接着检查同步占位，中间不能有 await，否则并发请求会同时穿过上面这道检查
    const runState = reserveWebAgentRun(state, sessionRef);

    let userMessage;
    let traceMessage;
    try {
        userMessage = appendWebSessionMessage(state.webHistoryDir, sessionRef, 'user', prompt, {
            mode: 'agent',
            pending: true,
            ...(images.length ? { images } : {}),
            ...(clientMessageId ? { clientMessageId: clientMessageId } : {})
        });
        traceMessage = appendWebAgentTraceMessage(
            state.webHistoryDir,
            sessionRef,
            '[执行过程]\n等待 Agent 启动…',
            {
                traceEvents: [],
                pending: true
            }
        );
    } catch (e) {
        // 落盘失败（磁盘错误等）：锁必须放掉，否则这个容器永远发不出消息
        releaseWebAgentRun(state, sessionRef.containerName, runState);
        throw e;
    }

    let prepared = null;
    try {
        prepared = await prepareWebAgentExecution(ctx, state, sessionRef, prompt, images);
    } catch (e) {
        releaseWebAgentRun(state, sessionRef.containerName, runState);
        removeWebSessionMessage(state.webHistoryDir, sessionRef, traceMessage && traceMessage.id);
        removeWebSessionMessage(state.webHistoryDir, sessionRef, userMessage && userMessage.id);
        return { error: e && e.message ? e.message : 'Agent 执行准备失败' };
    }

    const { agentSession, agentMeta, command, contextMode, resumeAttempted, resumeSucceeded, resumeError, engineSessionId } = prepared;
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
    // agent 流的生命周期日志：每轮最多三条（开始 / 客户端断开 / 结束），
    // 不是逐事件打点。没有这几条的话，用户报"跑到一半断流了"时服务端
    // 日志里查不到任何痕迹——断连本身只发生在客户端侧，服务端不主动感知
    const turnStartedAt = Date.now();
    const turnSessionKey = buildWebSessionKey(sessionRef.containerName, sessionRef.agentId);
    ctx.logger.info('agent turn started', {
        session: turnSessionKey,
        agentProgram: agentMeta.agentProgram,
        contextMode,
        resumeAttempted,
        resumeSucceeded
    });
    // 'close' 先于 'finish' 触发且 writableFinished 仍为 false，说明是
    // 客户端/反代把连接掐了，而不是我们正常收尾。此时容器里的任务还在跑，
    // 前端会转入恢复轮询——日志要把这个区别写清楚，否则事后无法归因
    res.on('close', () => {
        if (res.writableFinished) {
            return;
        }
        ctx.logger.warn('agent stream client disconnected', {
            session: turnSessionKey,
            elapsedMs: Date.now() - turnStartedAt,
            runContinues: state.agentRuns.has(sessionRef.containerName)
        });
    });
    // agent 可能几十秒不产生任何输出（长 WebSearch、长 Bash、长思考），
    // 而反向代理按"上游多久没发字节"计空闲超时（nginx proxy_read_timeout
    // 默认 60s），超时会 RST 掉这条流，浏览器侧抛 network error。这里定期
    // 发一行 ping 保活；前端忽略该事件，也不写入会话事件日志
    const heartbeatMs = ctx.agentStreamHeartbeatMs || DEFAULT_AGENT_STREAM_HEARTBEAT_MS;
    let lastStreamWriteAt = Date.now();
    const heartbeatTimer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
            return;
        }
        if (Date.now() - lastStreamWriteAt < heartbeatMs) {
            return;
        }
        sendNdjson(res, { type: 'ping' });
        lastStreamWriteAt = Date.now();
    }, Math.max(50, Math.floor(heartbeatMs / 2)));
    if (typeof heartbeatTimer.unref === 'function') {
        heartbeatTimer.unref();
    }
    const rawEmitStreamEvent = createWebStreamEmitter(res, state.webHistoryDir, sessionRef);
    const emitStreamEvent = (...args) => {
        lastStreamWriteAt = Date.now();
        return rawEmitStreamEvent(...args);
    };
    emitStreamEvent({
        type: 'meta',
        containerName: sessionRef.containerName,
        sessionName: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
        // 前端用这两个 id 把本地乐观占位（local-* / __streaming_trace__）换成
        // 服务端持久化 id，轮询对账时 React key 才能对得上、DOM 不整体重建
        userMessageId: userMessage && userMessage.id,
        traceMessageId: traceMessage && traceMessage.id,
        contextMode,
        resumeAttempted,
        resumeSucceeded,
        agentProgram: agentMeta.agentProgram
    }, 'session.ready', { agentProgram: agentMeta.agentProgram });
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

    let lastPartialPersistAt = 0;
    const handleStreamEvent = event => {
        if (runState.stepPending && agentQueue.isStepBoundary(event)) {
            steerWebAgentRun(ctx, runState, 'step', state);
        }
        // token 级增量：只走网线，不进事件日志，历史落盘按
        // AGENT_STREAM_PARTIAL_PERSIST_INTERVAL_MS 节流
        const isPartialDelta = event && event.type === 'content_delta' && event.partial === true;
        if (event && event.type === 'trace' && event.text) {
            traceLines.push(String(event.text));
            if (event.traceEvent && typeof event.traceEvent === 'object') {
                traceEvents.push(event.traceEvent);
            }
            patchWebSessionMessage(state.webHistoryDir, sessionRef, traceMessage && traceMessage.id, {
                content: traceLines.join('\n'),
                traceEvents: traceEvents.slice(),
                pending: true
            }, { defer: true });
        }
        if (event && event.type === 'content_delta' && typeof event.content === 'string') {
            const now = Date.now();
            const shouldPersist = !isPartialDelta
                || now - lastPartialPersistAt >= AGENT_STREAM_PARTIAL_PERSIST_INTERVAL_MS;
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
                lastPartialPersistAt = now;
            } else if (shouldPersist) {
                patchWebSessionMessage(state.webHistoryDir, sessionRef, streamingReplyMessageId, {
                    content: event.content,
                    pending: true
                }, { defer: true });
                lastPartialPersistAt = now;
            }
        }
        if (isPartialDelta) {
            lastStreamWriteAt = Date.now();
            // 只发增量片段：前端在 content_chunk 上做追加，
            // reset 表示换了一条 assistant 消息、从空白重新开始
            sendNdjson(res, event.chunkReset === true
                ? { type: 'content_chunk', text: '', reset: true }
                : { type: 'content_chunk', text: event.chunk });
            return;
        }
        emitStreamEvent(event, resolveWebStreamControlEventType(event), {
            transportType: event && event.type ? event.type : '',
            text: event && (event.text || event.content) ? String(event.text || event.content) : ''
        });

    };
    // 有域名规则时被过滤代理拦下的新域名：对话进行中立即提示一次
    // 被拦的是 Agent 自己的模型域名：继续等只会白等到超时，立即中止本轮（不暂停排队，不是用户点的停止）
    const deniedNotifier = createWebDeniedNotifier(ctx, sessionRef, text => handleStreamEvent({ type: 'trace', stream: 'stdout', text }), {
        agentProgram: agentMeta.agentProgram,
        onModelDenied: host => {
            if (runState.modelDenied) return;
            runState.modelDenied = host;
            handleStreamEvent({ type: 'network_denied', host, model: true });
            runState.stopping = true;
            if (runState.process) terminateWebAgentRun(ctx, runState);
        }
    });
    let snapBefore = { skipped: 'unavailable' };
    try {
        if (deniedNotifier) deniedNotifier.start();
        snapBefore = await takeWebSnapshot(ctx, state, sessionRef, `web ${userMessage && userMessage.id} before`);
        patchWebSessionMessage(state.webHistoryDir, sessionRef, userMessage && userMessage.id,
            snapBefore.sha ? { snapBefore: snapBefore.sha } : { snapSkipped: snapBefore.skipped });
        let result;
        try {
            result = await execAgentInWebContainerStream(ctx, state, sessionRef, command, {
                agentProgram: agentMeta.agentProgram,
                // 复用路由入口占好的那把锁，而不是另起一份运行登记
                runState,
                onEvent: handleStreamEvent
            });
        } finally {
            if (deniedNotifier) deniedNotifier.stop();
        }
        ctx.logger.info('agent turn finished', {
            session: turnSessionKey,
            durationMs: Date.now() - turnStartedAt,
            exitCode: result.exitCode,
            interrupted: result.interrupted === true
        });
        const modelDeniedHost = runState.modelDenied || '';
        traceLines.push(modelDeniedHost
            ? '[任务] 已中止：模型地址被网络策略拦截'
            : (result.interrupted === true
                ? (runState.steered && runState.userStopped !== true ? '[任务] 已打断，继续执行新的提示词' : '[任务] 已停止')
                : '[任务] 已完成'));
        const snapAfter = snapBefore.sha
            ? await takeWebSnapshot(ctx, state, sessionRef, `web ${userMessage && userMessage.id} after`)
            : { skipped: snapBefore.skipped };
        patchWebSessionMessage(state.webHistoryDir, sessionRef, userMessage && userMessage.id, {
            pending: false,
            contextMode,
            resumeAttempted,
            resumeSucceeded,
            ...(snapAfter.sha ? { snapAfter: snapAfter.sha } : {})
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
        const finalResult = modelDeniedHost
            ? { ...result, interrupted: true, output: `已中止：模型地址 ${modelDeniedHost} 被网络策略拦截。`, networkDenied: { host: modelDeniedHost, model: true } }
            : result;
        const replyMessage = finalizeWebAgentExecution(state, sessionRef, agentSession, agentMeta, {
            contextMode,
            resumeAttempted,
            resumeSucceeded,
            resumeError,
            engineSessionId
        }, finalResult);
        void refreshWebAgentTitle(ctx, state, sessionRef, agentMeta.agentProgram);
        emitStreamEvent({
            type: 'result',
            exitCode: finalResult.exitCode,
            output: finalResult.output,
            ...(finalResult.networkDenied ? { networkDenied: finalResult.networkDenied } : {}),
            // 最终 assistant 消息的持久化 id：前端把 __streaming__ 占位换成它，
            // 发送后的首次对账才不会重建整个消息列表 DOM（滚动位置/选区保持）
            replyMessageId: replyMessage && replyMessage.id,
            contextMode,
            resumeAttempted,
            resumeSucceeded,
            interrupted: finalResult.interrupted === true
        }, finalResult.interrupted === true ? 'process.interrupted' : 'process.exited', { exitCode: result.exitCode });
    } catch (e) {
        ctx.logger.error('agent turn failed', {
            session: turnSessionKey,
            durationMs: Date.now() - turnStartedAt,
            message: e && e.message ? e.message : 'Agent 执行失败'
        });
        traceLines.push(`[错误] ${e && e.message ? e.message : 'Agent 执行失败'}`);
        const failedSnapAfter = snapBefore.sha
            ? await takeWebSnapshot(ctx, state, sessionRef, `web ${userMessage && userMessage.id} after`)
            : { skipped: snapBefore.skipped };
        patchWebSessionMessage(state.webHistoryDir, sessionRef, userMessage && userMessage.id, {
            pending: false,
            contextMode,
            resumeAttempted,
            resumeSucceeded,
            ...(failedSnapAfter.sha ? { snapAfter: failedSnapAfter.sha } : {})
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
        emitStreamEvent({
            type: 'error',
            error: e && e.message ? e.message : 'Agent 执行失败'
        }, 'agent.turn.failed', { error: e && e.message ? e.message : 'Agent 执行失败' });
    } finally {
        clearInterval(heartbeatTimer);
        clearTimeout(runState.stepTimer);
        // 用户停止的不自动发；其余（完成 / 失败 / 被追加打断）有排队就接着发队首
        const hasNext = runState.userStopped !== true && !runState.modelDenied && agentQueue.shouldAutoDispatch(peekAgentSession(state, sessionRef));
        if (hasNext && !res.writableEnded && !res.destroyed) {
            // 前端收到后改为跟随下一轮（走掉线恢复的那套轮询）
            sendNdjson(res, { type: 'queue_next' });
        }
        res.end();
        if (hasNext) {
            setImmediate(() => dispatchNextQueued(ctx, state, sessionRef));
        }
    }
    return { started: true };
}

function sendHtml(res, statusCode, html, extraHeaders = {}, options = {}) {
    sendBody(res, statusCode, 'text/html; charset=utf-8', html, extraHeaders, options);
}

const SETUP_TEST_TIMEOUT_SECONDS = 60;
const SETUP_TEST_PROMPT = 'Reply with the single word OK.';

function getSetupWorkpath(state) {
    return path.join(path.dirname(path.resolve(state.webConfigPath)), 'work');
}

async function inspectSetupImage(ctx, state) {
    const image = `${ctx.imageName}:${ctx.imageVersion}`;
    const pulling = state && state.imagePulls.get(image);
    if (pulling) {
        return { status: pulling.status, name: image, message: pulling.message };
    }
    const importing = ctx.importState();
    if (importing.active) {
        return { status: 'pulling', name: image, message: importing.message };
    }
    if (!ctx.runtimeState || ctx.runtimeState.status !== 'ready') {
        return { status: 'unknown', name: image };
    }
    // 多个标签页同时轮询时共用同一次 inspect（只合并进行中的请求，不做时间缓存，镜像状态变化马上可见）
    if (state && state.setupImageInflight && state.setupImageInflight.image === image) {
        return state.setupImageInflight.promise;
    }
    const promise = isWebImagePresent(ctx, image).then(present => ({ status: present ? 'ready' : 'missing', name: image }));
    if (!state) return promise;
    state.setupImageInflight = { image, promise };
    try {
        return await promise;
    } finally {
        if (state.setupImageInflight && state.setupImageInflight.promise === promise) state.setupImageInflight = null;
    }
}

// 镜像里装了哪些 Agent CLI；镜像没就绪或探测失败返回 null（未知，向导照常可选）
async function probeSetupImageAgents(ctx, state) {
    if (!ctx.dockerExecAsync) return null;
    const image = await inspectSetupImage(ctx, state);
    if (image.status !== 'ready') return null;
    if (!state.imageAgentProbe) state.imageAgentProbe = createImageAgentProbe(ctx.dockerExecAsync);
    return state.imageAgentProbe(image.name);
}

// 在一次性容器里用所选 Agent 发一次最小请求；容器无论成败都会删除。
async function runSetupConnectionTest(ctx, state, agent, envMap) {
    const secrets = Object.values(envMap);
    const image = await inspectSetupImage(ctx, state);
    if (image.status !== 'ready') {
        return { category: 'other', message: image.status === 'missing' ? `镜像 ${image.name} 尚未就绪，请等待准备完成后重试` : '容器环境尚未就绪，请稍后重试', detail: '' };
    }

    const spec = AGENT_ENV_SCHEMA[agent];
    const template = deriveAgentPromptCommandFromDefaultCommand(resolveYoloCommand(spec.yolo));
    if (!template) {
        return { category: 'other', message: `${spec.label} 暂不支持连接测试`, detail: '' };
    }
    const agentCommand = renderAgentPromptCommand(template, SETUP_TEST_PROMPT);
    const command = `timeout ${SETUP_TEST_TIMEOUT_SECONDS} /bin/bash -lc ${quoteBashSingleValue(agentCommand)}`;

    const workpath = getSetupWorkpath(state);
    fs.mkdirSync(workpath, { recursive: true });
    const containerName = `manyoyo-setup-test-${crypto.randomBytes(4).toString('hex')}`;
    const testHome = ctx.homeDir || os.homedir();
    const containerStateInfo = containerState.createState({
        homeDir: testHome,
        envLines: Object.entries(envMap).map(([key, value]) => `${key}=${value}`),
        meta: { name: containerName }
    });
    const args = buildContainerRunArgs({
        state: containerStateInfo,
        containerName,
        hostPath: workpath,
        containerPath: '/workspace',
        imageName: ctx.imageName,
        imageVersion: ctx.imageVersion,
        contModeArgs: [],
        containerExtraArgs: [],
        containerEnvs: [],
        containerVolumes: [],
        containerPorts: [],
        defaultCommand: '/bin/bash'
    });

    try {
        ctx.dockerExecArgs(args, { stdio: 'pipe' });
        await ctx.waitForContainerReady(containerName, { throwOnFailure: true });
        let timer;
        const result = await Promise.race([
            execCommandInWebContainer(ctx, containerName, command),
            new Promise(resolve => {
                timer = setTimeout(() => resolve({ exitCode: 124, output: '' }), (SETUP_TEST_TIMEOUT_SECONDS + 15) * 1000);
            })
        ]);
        clearTimeout(timer);
        return classifyConnectionResult(result, secrets);
    } catch (e) {
        return classifyConnectionResult({ exitCode: 1, output: e && e.message ? e.message : '' }, secrets);
    } finally {
        try {
            ctx.dockerExecArgs(['rm', '-f', containerName], { stdio: 'pipe' });
        } catch (e) {
            // 容器可能根本没创建成功
        }
        containerState.removeState(testHome, containerStateInfo.id);
    }
}

// 网页只展示和“能不能用”相关的检查项，其余（端口、插件、模式、Agent 命令）对网页没有意义
const WEB_DOCTOR_CODES = new Set([
    'RUNTIME_AVAILABLE', 'RUNTIME_UNAVAILABLE', 'DAEMON_AVAILABLE', 'DAEMON_UNAVAILABLE',
    'IMAGE_AVAILABLE', 'IMAGE_MISSING', 'CONFIG_AVAILABLE', 'CONFIG_MISSING'
]);

function sanitizeDoctorText(value) {
    return redactSecrets(sanitizeServeLogText(String(value || ''))).slice(0, 500);
}

function buildWebDoctorReport(report) {
    const checks = report.checks
        .filter(check => WEB_DOCTOR_CODES.has(check.code))
        .map(check => {
            const item = {
                code: check.code,
                status: check.status,
                summary: sanitizeDoctorText(check.summary),
                action: sanitizeDoctorText(check.action),
                // 通过项的 detail 是 info 的整段输出，只会带出本机路径和无关信息
                detail: check.status === 'ok' ? '' : sanitizeDoctorText(check.detail)
            };
            if (check.fix) {
                item.fix = {
                    attempted: Boolean(check.fix.attempted),
                    fixed: Boolean(check.fix.fixed),
                    message: sanitizeDoctorText(check.fix.message)
                };
            }
            return item;
        });
    return {
        ok: !checks.some(check => check.status === 'error' && !(check.fix && check.fix.fixed)),
        checks
    };
}

async function buildSetupStatus(ctx, state) {
    // 向导的“选择目录”与默认路径校验都要求目录已存在，所以展示默认路径前先建好
    try { fs.mkdirSync(getSetupWorkpath(state), { recursive: true }); } catch (e) { /* 建不出来时由后续校验报错 */ }
    // 向导的“选择目录”与默认路径校验都要求目录已存在，所以展示默认路径前先建好
    try { fs.mkdirSync(getSetupWorkpath(state), { recursive: true }); } catch (e) { /* 建不出来时由后续校验报错 */ }
    const snapshot = readWebConfigSnapshot(state.webConfigPath);
    const config = snapshot.parseError ? {} : snapshot.parsed;
    const configuredAgents = getConfiguredAgents(config);
    return {
        needsSetup: configuredAgents.length === 0,
        configuredAgents,
        serverUser: ctx.authUser,
        // 自动生成（用户看不到）的密码不算“已设置”
        passwordSet: !ctx.authPassAuto || (typeof config.serverPass === 'string' && config.serverPass !== ''),
        configError: snapshot.parseError || null,
        runtime: { status: ctx.runtimeState.status, message: ctx.runtimeState.message },
        image: await inspectSetupImage(ctx, state),
        defaultHostPath: getSetupWorkpath(state),
        mirrors: readWebMirrors(state),
        platform: process.platform,
        runtimeKind: path.basename(String(ctx.dockerCmd || ''))
    };
}

function resolveSetupRunInput(ctx, state, payload) {
    const body = toPlainObject(payload);
    const agent = String(body.agent || '').trim();
    const snapshot = readWebConfigSnapshot(state.webConfigPath);
    if (snapshot.parseError) {
        const error = new Error('当前配置解析失败，无法继续');
        error.detail = snapshot.parseError;
        throw error;
    }
    const existingRun = toPlainObject(toPlainObject(snapshot.parsed.runs)[agent]);
    let hostPath = '';
    if (body.hostPath !== undefined && body.hostPath !== '') {
        hostPath = typeof body.hostPath === 'string' ? body.hostPath.trim() : '';
        if (!hostPath || !path.isAbsolute(hostPath)) {
            throw new Error('hostPath 必须是绝对路径');
        }
        if (hostPath === getSetupWorkpath(state)) fs.mkdirSync(hostPath, { recursive: true });
        ctx.validateHostPath(hostPath);
    }
    const profile = buildAgentRunProfile(agent, body.env === undefined ? {} : body.env, {
        existingRun,
        defaultHostPath: getSetupWorkpath(state),
        hostPath
    });
    return { agent, snapshot, profile };
}

function redactLoginTokenInUrl(rawUrl) {
    return String(rawUrl || '').replace(/([?&]token=)[^&#]*/gi, '$1[redacted]');
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

// preloadedHistory：调用方已经读过同一个容器的历史时直接复用。历史 JSON 是整份
// 读文件 + JSON.parse，容器多、agent 多时按 agent 数重复读会把 GET /api/sessions
// 拖到秒级，而它是同步 IO——事件循环被占住期间 agent/stream 的输出只能攒着分批推
function buildSessionSummary(ctx, state, containerMap, sessionRef, preloadedHistory = null) {
    const containerName = sessionRef && sessionRef.containerName ? sessionRef.containerName : '';
    const agentId = sessionRef && sessionRef.agentId ? sessionRef.agentId : WEB_DEFAULT_AGENT_ID;
    const history = preloadedHistory && typeof preloadedHistory === 'object'
        ? preloadedHistory
        : loadWebSessionHistory(state.webHistoryDir, containerName);
    const realAgentSession = getWebAgentSession(history, agentId, { includeArchived: true });
    const agentSession = realAgentSession
        || (agentId === WEB_DEFAULT_AGENT_ID ? createEmptyWebAgentSession(WEB_DEFAULT_AGENT_ID) : null);
    if (!agentSession) {
        return null;
    }
    const synthetic = !realAgentSession;
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
    const agentRunState = state.agentRuns ? state.agentRuns.get(containerName) : undefined;
    const createdAt = agentSession.createdAt || containerInfo.createdAt || null;
    const updatedAt = agentSession.updatedAt
        || (latestMessage && latestMessage.timestamp)
        || (agentId === WEB_DEFAULT_AGENT_ID
            ? (history.updatedAt || containerInfo.createdAt)
            : null)
        || null;
    return {
        name: buildWebSessionKey(containerName, agentId),
        containerName,
        agentId,
        agentName: agentSession.agentName,
        agentRemark: agentSession.remark || '',
        agentTitle: agentSession.title || '',
        firstPrompt: agentSession.firstPrompt || '',
        pinned: agentSession.pinned === true,
        containerRemark: history.remark || '',
        status: containerInfo.status || 'history',
        image: containerInfo.image || '',
        createdAt,
        updatedAt,
        messageCount: agentSession.messages.length,
        agentEnabled: isAgentPromptCommandEnabled(effectiveAgentPromptCommand),
        agentProgram: effectiveAgentProgram || '',
        resumeSupported: effectiveResumeSupported,
        model: agentSession.model || '',
        hostPath: applied.hostPath || '',
        containerPath: applied.containerPath || '',
        archived: agentSession.archived === true,
        // 运行锁是容器级的，界面却是 agent 级的：把"容器在忙"和"是不是自己在忙"
        // 都透出去，同容器的其他 AGENT 才能提前禁用输入，而不是点了发送才吃 409
        containerBusy: agentRunState !== undefined,
        agentRunning: agentRunState !== undefined
            && agentRunState.sessionKey === buildWebSessionKey(containerName, agentId),
        ...(synthetic ? { synthetic: true } : {})
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
    const summary = buildSessionSummary(ctx, state, containerMap, sessionRef, history);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true })
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
        usageTotal: agentSession.usageTotal || null,
        model: agentSession.model || '',
        applied
    };
}

function buildSessionAudit(ctx, state, sessionRef) {
    const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
    const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true })
        || createEmptyWebAgentSession(sessionRef.agentId);
    const events = loadWebSessionControlEvents(state.webHistoryDir, sessionRef, agentSession.events);
    const applied = history.applied && typeof history.applied === 'object' && !Array.isArray(history.applied)
        ? history.applied
        : {};
    return {
        runSpec: applied.runSpec ? redactConfigObject(applied.runSpec) : null,
        events,
        projection: projectSessionEvents(events)
    };
}

// 按文件 mtime + size 缓存 index.html 原文（2MB，之前每次请求都同步读一遍）
let indexHtmlCache = { key: '', html: '', variants: new Map() };

function loadIndexHtml() {
    let stat = null;
    try {
        stat = fs.statSync(INDEX_HTML_PATH);
    } catch (e) {
        return '<h1>Template Not Found</h1>';
    }
    const key = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    if (indexHtmlCache.key !== key) {
        indexHtmlCache = { key, html: fs.readFileSync(INDEX_HTML_PATH, 'utf-8'), variants: new Map() };
    }
    return indexHtmlCache.html;
}

// 渲染结果（含 serveTitle 处理）+ ETag + gzip 都缓存，文件没变就不重算
function getIndexHtmlVariant(kind, ctx) {
    const html = loadIndexHtml();
    const variantKey = `${kind}:${typeof ctx.serveTitle === 'string' ? ctx.serveTitle : ''}`;
    let variant = indexHtmlCache.variants.get(variantKey);
    if (!variant) {
        const rendered = kind === 'app' ? renderAppHtml(ctx) : applyServeTitle(html, ctx);
        variant = {
            html: rendered,
            etag: `W/"${crypto.createHash('sha1').update(rendered).digest('hex')}"`,
            gzipBuffer: null
        };
        indexHtmlCache.variants.set(variantKey, variant);
    }
    return variant;
}

function sendIndexHtml(res, kind, ctx, extraHeaders = {}) {
    const variant = getIndexHtmlVariant(kind, ctx);
    const options = { etag: variant.etag };
    if (variant.gzipBuffer) {
        options.gzipBuffer = variant.gzipBuffer;
    } else if (acceptsGzip(res.req)) {
        // 第一次压缩的结果留着给后面的请求
        zlib.gzip(Buffer.from(variant.html, 'utf-8'), { level: 6 }, (error, result) => {
            if (!error) {
                variant.gzipBuffer = result;
            }
        });
    }
    sendHtml(res, 200, variant.html, extraHeaders, options);
}

function escapeHtmlText(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function applyServeTitle(html, ctx) {
    if (typeof ctx.serveTitle !== 'string') {
        return html;
    }
    // 正则匹配任意 <title> 内容而非硬编码 "MANYOYO Web"，前端换了默认标题也不用改这里
    return html.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtmlText(ctx.serveTitle)}</title>`);
}

function renderAppHtml(ctx) {
    // index.html 是 vite singlefile 打包产物，全部依赖内联成一个 <script>，
    // 用 .replace('</head>', ...) 注入标记有极小概率命中某个库源码里字面量出现的
    // "</head>"，把注入内容插进内联脚本中间导致整页解析错乱；所以改成跟
    // applyServeTitle 同款更窄、更安全的 <title> 定位，插一个 meta 标记
    // 告知前端跳过动态改写 document.title
    let html = applyServeTitle(loadIndexHtml(), ctx);
    if (typeof ctx.serveTitle === 'string') {
        html = html.replace(
            /<\/title>/,
            () => '</title>\n    <meta name="manyoyo-serve-title" content="1">'
        );
    }
    return html;
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

// resize 消息的数值必须是整数且在范围内，否则整条忽略（不夹到边界，避免把异常值悄悄变成合法值）
function parseTerminalResize(cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
        return null;
    }
    if (cols < WEB_TERMINAL_RESIZE_MIN_COLS || cols > WEB_TERMINAL_MAX_COLS
        || rows < WEB_TERMINAL_RESIZE_MIN_ROWS || rows > WEB_TERMINAL_MAX_ROWS) {
        return null;
    }
    return { cols, rows };
}

// 容器里跑的固定脚本，参数只有三个位置参数（终端 id、列、行），不经过 shell 拼接。
// tty 文件在容器里，容器内的进程可以改写它，所以内容只当不可信输入：
// 必须是普通文件（不跟符号链接、不碰 FIFO），读最多 64 字节，且整行匹配 /dev/pts/<数字> 才会执行 stty。
const TERMINAL_RESIZE_SCRIPT = [
    'f="/tmp/manyoyo-term-$1.tty"',
    '[ -f "$f" ] && [ ! -L "$f" ] || exit 3',
    't="$(head -c 64 "$f" 2>/dev/null | head -n 1)"',
    'printf \'%s\\n\' "$t" | grep -Eq \'^/dev/pts/[0-9]+$\' || exit 4',
    'case "$2$3" in *[!0-9]*) exit 5;; esac',
    'exec stty -F "$t" cols "$2" rows "$3"'
].join('\n');

function spawnWebTerminalProcess(ctx, containerName, cols, rows, termId) {
    const terminalBootstrap = [
        'MANYOYO_WEB_BASHRC="$(mktemp /tmp/manyoyo-web-bashrc.XXXXXX 2>/dev/null || mktemp)"',
        'cat > "$MANYOYO_WEB_BASHRC" <<\'EOF_MANYOYO_RC\'',
        'if [ -f /etc/bash.bashrc ]; then',
        '    . /etc/bash.bashrc',
        'fi',
        'if [ -f ~/.bashrc ]; then',
        '    . ~/.bashrc',
        'fi',
        'if [ -f /run/manyoyo-sys/env.sh ]; then',
        '    . /run/manyoyo-sys/env.sh',
        'fi',
        'if [ -n "${MANYOYO_TERM_ID:-}" ]; then',
        '    tty > "/tmp/manyoyo-term-$MANYOYO_TERM_ID.tty" 2>/dev/null || true',
        '    trap \'rm -f "/tmp/manyoyo-term-$MANYOYO_TERM_ID.tty"\' EXIT',
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
    return spawnContainerExec(ctx, containerName, {
        interactive: true,
        envs: [
            `TERM=${termValue}`,
            `COLORTERM=${colorTermValue}`,
            `MANYOYO_TERM_COLS=${String(cols)}`,
            `MANYOYO_TERM_ROWS=${String(rows)}`,
            `MANYOYO_TERM_ID=${termId}`
        ],
        command: ['/bin/bash', '-lc', terminalBootstrap]
    }, { stdio: ['pipe', 'pipe', 'pipe'] });
}

function bindTerminalWebSocket(ctx, state, ws, containerName, cols, rows) {
    const sessionId = `${containerName}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const termId = crypto.randomBytes(8).toString('hex');
    const ptyProcess = spawnWebTerminalProcess(ctx, containerName, cols, rows, termId);
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

    let missedPongs = 0;
    ws.on('pong', () => {
        missedPongs = 0;
    });
    const pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
            return;
        }
        if (missedPongs >= WEB_TERMINAL_MAX_MISSED_PONGS) {
            ws.terminate();
            return;
        }
        missedPongs += 1;
        try {
            ws.ping();
        } catch (e) {
            // ping 失败说明链路已经不可用，交给 close/error 事件收尾
        }
    }, WEB_TERMINAL_PING_INTERVAL_MS);

    const cleanup = () => {
        if (session.closing) {
            return;
        }
        session.closing = true;
        clearInterval(pingTimer);
        if (resizeState.timer) {
            clearTimeout(resizeState.timer);
            resizeState.timer = null;
        }
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

    // 把前端新的窗口大小同步给容器里的伪终端，内核会自动给前台进程发 SIGWINCH。
    // 数值严格校验；节流：同一时刻只有一个 exec 在跑，期间的新尺寸只保留最后一个
    const resizeState = { running: false, pending: null, last: null, lastAt: 0, timer: null, retries: 0 };
    const runTerminalResize = () => {
        if (resizeState.running || !resizeState.pending || session.closing) {
            return;
        }
        const wait = resizeState.lastAt + WEB_TERMINAL_RESIZE_MIN_INTERVAL_MS - Date.now();
        if (wait > 0) {
            if (!resizeState.timer) {
                resizeState.timer = setTimeout(() => {
                    resizeState.timer = null;
                    runTerminalResize();
                }, wait);
            }
            return;
        }
        const size = resizeState.pending;
        resizeState.pending = null;
        resizeState.running = true;
        resizeState.lastAt = Date.now();
        let child = null;
        let killTimer = null;
        const done = code => {
            if (!resizeState.running) {
                return;
            }
            clearTimeout(killTimer);
            resizeState.running = false;
            resizeState.lastAt = Date.now();
            if (code !== 0 && !resizeState.pending && !session.closing && resizeState.retries < 3) {
                // 失败（比如 tty 文件还没写好）：同尺寸的上报会被去重丢掉，所以这里自己重试几次
                resizeState.retries += 1;
                resizeState.pending = size;
            } else if (code === 0) {
                resizeState.retries = 0;
            }
            runTerminalResize();
        };
        try {
            child = spawnContainerExec(ctx, containerName, {
                command: ['/bin/bash', '-c', TERMINAL_RESIZE_SCRIPT, 'manyoyo-resize', termId, String(size.cols), String(size.rows)]
            }, { stdio: 'ignore' });
        } catch (e) {
            done(1);
            return;
        }
        killTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e) { /* 已经退出 */ }
        }, 5000);
        child.once('close', code => done(code));
        child.once('error', () => done(1));
    };
    const requestTerminalResize = (rawCols, rawRows) => {
        const size = parseTerminalResize(rawCols, rawRows);
        if (!size) {
            return;
        }
        if (resizeState.last && resizeState.last.cols === size.cols && resizeState.last.rows === size.rows) {
            return;
        }
        resizeState.last = size;
        resizeState.pending = size;
        runTerminalResize();
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
            requestTerminalResize(payload.cols, payload.rows);
            return;
        }

        if (payload.type === 'ping') {
            // 浏览器 JS 发不出 WebSocket ping 帧，前端改用应用层消息保活上行链路
            sendTerminalEvent(ws, 'pong');
            return;
        }

        if (payload.type === 'close') {
            ws.close();
        }
    });

    ws.on('close', cleanup);
    ws.on('error', cleanup);
}

const LOGIN_FREE_FAILURES = 5;
const LOGIN_MAX_BACKOFF_SECONDS = 300;
const LOGIN_FAILURE_TTL_MS = 15 * 60 * 1000;

function getLoginRetryAfterSeconds(state, key, nowMs) {
    const entry = state.loginFailures.get(key);
    if (!entry || entry.blockedUntil <= nowMs) return 0;
    return Math.max(1, Math.ceil((entry.blockedUntil - nowMs) / 1000));
}

// 前 5 次失败不限；之后每次失败把封禁时间翻倍（1、2、4…秒，上限 300 秒）；成功后清零
function recordLoginFailure(state, key, nowMs) {
    for (const [otherKey, entry] of state.loginFailures) {
        if (nowMs - entry.lastAt > LOGIN_FAILURE_TTL_MS) state.loginFailures.delete(otherKey);
    }
    const entry = state.loginFailures.get(key) || { count: 0, blockedUntil: 0, lastAt: nowMs };
    entry.count += 1;
    entry.lastAt = nowMs;
    if (entry.count > LOGIN_FREE_FAILURES) {
        const seconds = Math.min(2 ** (entry.count - LOGIN_FREE_FAILURES - 1), LOGIN_MAX_BACKOFF_SECONDS);
        entry.blockedUntil = nowMs + seconds * 1000;
    }
    state.loginFailures.set(key, entry);
}

async function handleWebAuthRoutes(req, res, pathname, ctx, state) {
    if (req.method === 'GET' && pathname === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return true;
    }

    // 登录页：与 / 复用同一份构建产物，由前端按 pathname 自行渲染登录表单，
    // 登录逻辑走下面的 POST /auth/login 接口
    // 带 ?token= 时是本机启动器的一次性登录：仅回环监听启用，令牌用后即删；令牌无效就落在登录页
    if (req.method === 'GET' && pathname === '/auth/login') {
        const token = new URL(req.url || '/', 'http://localhost').searchParams.get('token');
        if (token !== null && ctx.loginTokenDir && isLoopbackHost(ctx.serverHost) && consumeLoginToken(ctx.loginTokenDir, token)) {
            const sessionId = createWebAuthSession(state, ctx.authUser);
            sendRedirect(res, 302, '/', {
                'Set-Cookie': getWebAuthCookie(sessionId),
                'Referrer-Policy': 'no-referrer'
            });
            return true;
        }
        sendIndexHtml(res, 'login', ctx, { 'Referrer-Policy': 'no-referrer' });
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

        // 失败限速：按连接来源地址计数（不信任 X-Forwarded-For，伪造它就能绕过限速）；
        // 反代后所有人共用一个来源，会被一起限速，这是有意的保守取舍
        const rateKey = String(req.socket && req.socket.remoteAddress || '');
        const retryAfter = getLoginRetryAfterSeconds(state, rateKey, ctx.nowMs());
        if (retryAfter > 0) {
            sendJson(res, 429, { error: `登录失败次数过多，请 ${retryAfter} 秒后重试` }, { 'Retry-After': String(retryAfter) });
            return true;
        }

        const userOk = secureStringEqual(username, ctx.authUser);
        const passOk = secureStringEqual(password, ctx.authPass);
        if (!(userOk && passOk)) {
            recordLoginFailure(state, rateKey, ctx.nowMs());
            sendJson(res, 401, { error: '用户名或密码错误' });
            return true;
        }
        state.loginFailures.delete(rateKey);

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
    // 其余都是页面请求：一律打回登录页。登录页本身在认证网关之前就被
    // handleWebAuthRoutes 放行，不会在这里形成重定向循环
    sendRedirect(res, 302, '/auth/login', { 'Set-Cookie': getWebAuthClearCookie() });
}

// 运行日志查看接口的支撑函数。日志目录以 serve 实际使用的 logger.path 为准，
// 拿不到时退回 ~/.manyoyo/logs/serve/ 的默认规则
function resolveServeLogDir(ctx) {
    if (ctx && ctx.logger && typeof ctx.logger.path === 'string' && ctx.logger.path) {
        return path.dirname(ctx.logger.path);
    }
    return buildManyoyoLogPath('serve').dir;
}

function listServeLogDates(ctx) {
    const dir = resolveServeLogDir(ctx);
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch (e) {
        return [];
    }
    return names
        .map(name => {
            const matched = String(name).match(/^serve-(\d{4}-\d{2}-\d{2})\.log$/);
            return matched ? matched[1] : '';
        })
        .filter(Boolean)
        .sort()
        .reverse();
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
            match: currentPath => currentPath === '/api/logs/dates' ? [] : null,
            handler: async () => {
                sendJson(res, 200, { dates: listServeLogDates(ctx) });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/logs' ? [] : null,
            handler: async () => {
                const requestUrl = new URL(req.url || '/api/logs', 'http://localhost');
                const rawDate = requestUrl.searchParams.get('date') || '';
                // date 会拼进文件名，必须白名单校验，否则能拼出目录穿越
                if (rawDate && !isValidLogDateTag(rawDate)) {
                    sendJson(res, 400, { error: 'date 必须是 YYYY-MM-DD' });
                    return;
                }
                const date = rawDate || getLocalDateTag();
                const levelParam = (requestUrl.searchParams.get('level') || '').trim();
                const levels = levelParam
                    ? levelParam.split(',').map(item => item.trim().toUpperCase()).filter(Boolean)
                    : [];
                const endOffsetParam = requestUrl.searchParams.get('endOffset');
                const result = readServeLogEntries(
                    path.join(resolveServeLogDir(ctx), `serve-${date}.log`),
                    {
                        limit: Number(requestUrl.searchParams.get('limit')) || undefined,
                        endOffset: endOffsetParam === null ? undefined : Number(endOffsetParam),
                        levels,
                        keyword: requestUrl.searchParams.get('keyword') || '',
                        session: requestUrl.searchParams.get('session') || ''
                    }
                );
                sendJson(res, 200, {
                    date,
                    entries: result.entries,
                    nextEndOffset: result.nextEndOffset,
                    limit: result.limit
                });
            }
        },
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
            // 系统设置“Agent 环境说明”：内置说明（只读）+ 全局配置里用户追加的说明
            method: 'GET',
            match: currentPath => currentPath === '/api/agent-instructions' ? [] : null,
            handler: async () => {
                const snapshot = readWebConfigSnapshot(state.webConfigPath);
                const config = snapshot.parseError ? {} : snapshot.parsed;
                sendJson(res, 200, {
                    builtin: BUILTIN_AGENT_INSTRUCTIONS,
                    custom: typeof config.agentInstructions === 'string' ? config.agentInstructions : '',
                    builtinEnabled: config.agentInstructionsBuiltinEnabled !== false,
                    customEnabled: config.agentInstructionsCustomEnabled !== false,
                    // 新建容器时系统提示词的初始内容
                    composed: composeSystemPrompt(config, '')
                });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath === '/api/agent-instructions' ? [] : null,
            handler: async () => {
                const payload = toPlainObject(await readJsonBody(req));
                const toggles = [['builtinEnabled', 'agentInstructionsBuiltinEnabled'], ['customEnabled', 'agentInstructionsCustomEnabled']];
                if (payload.custom !== undefined && typeof payload.custom !== 'string') {
                    sendJson(res, 400, { error: 'custom 必须是字符串' });
                    return;
                }
                if (toggles.some(([field]) => payload[field] !== undefined && typeof payload[field] !== 'boolean')) {
                    sendJson(res, 400, { error: '开关必须是布尔值' });
                    return;
                }
                const snapshot = readWebConfigSnapshot(state.webConfigPath);
                if (snapshot.parseError) {
                    sendJson(res, 400, { error: '当前配置解析失败，无法继续', detail: snapshot.parseError });
                    return;
                }
                let nextRaw = baseRawOf(snapshot);
                let changed = false;
                try {
                    // 没写过、也没填内容时不动配置文件；开关保持默认（开）且没写过时同理
                    if (typeof payload.custom === 'string' && (payload.custom.trim() || hasOwn(snapshot.parsed, 'agentInstructions'))) {
                        nextRaw = buildAgentInstructionsConfigRaw(nextRaw, payload.custom.slice(0, 4000));
                        changed = true;
                    }
                    toggles.forEach(([field, key]) => {
                        if (typeof payload[field] === 'boolean' && (payload[field] === false || hasOwn(snapshot.parsed, key))) {
                            nextRaw = buildBooleanConfigRaw(nextRaw, key, payload[field]);
                            changed = true;
                        }
                    });
                    if (changed) parseAndValidateConfigRaw(nextRaw);
                } catch (e) {
                    sendJson(res, 400, { error: '配置写入失败' });
                    return;
                }
                if (changed) writeConfigFileSecure(path.resolve(state.webConfigPath), nextRaw);
                sendJson(res, 200, { saved: changed });
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
                const ifMatch = req.headers['if-match'];
                if (ifMatch === undefined) {
                    sendJson(res, 428, { error: STALE_PAGE_MESSAGE });
                    return;
                }

                // 从这里到写盘之间不能有 await：读文件、比对版本、写文件在同一个同步段里完成，并发的两个请求不会同时通过检查
                const currentSnapshot = readWebConfigSnapshot(state.webConfigPath);
                const currentEtag = computeContentEtag(currentSnapshot.raw);
                if (!ifMatchSatisfied(ifMatch, currentEtag)) {
                    sendJson(res, 409, {
                        error: '配置文件已被其他地方修改',
                        conflict: true,
                        ...buildSafeWebConfigSnapshot(currentSnapshot, ctx)
                    });
                    return;
                }
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
                writeConfigFileSecure(savePath, finalRaw);

                sendJson(res, 200, {
                    saved: true,
                    path: savePath,
                    etag: computeContentEtag(finalRaw),
                    defaults: buildConfigDefaults(ctx, parsed)
                });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/setup/status' ? [] : null,
            handler: async () => {
                sendJson(res, 200, await buildSetupStatus(ctx, state));
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/setup/agents' ? [] : null,
            handler: async () => {
                const installed = await probeSetupImageAgents(ctx, state);
                const agents = listSetupAgents().map(agent => ({
                    ...agent,
                    available: installed ? installed.includes(agent.id) : null
                }));
                sendJson(res, 200, { agents, mirrorPresets: listMirrorPresets() });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath === '/api/setup/agent' ? [] : null,
            handler: async () => {
                const payload = await readJsonBody(req);
                let input;
                try {
                    input = resolveSetupRunInput(ctx, state, payload);
                } catch (e) {
                    sendJson(res, 400, { error: e.message || '参数无效', detail: e.detail || '' });
                    return;
                }

                let nextRaw;
                try {
                    nextRaw = buildAgentConfigRaw(baseRawOf(input.snapshot), input.agent, input.profile);
                    parseAndValidateConfigRaw(nextRaw);
                } catch (e) {
                    sendJson(res, 400, { error: '配置写入失败', detail: e.message || '' });
                    return;
                }

                const savePath = path.resolve(state.webConfigPath);
                writeConfigFileSecure(savePath, nextRaw);
                fs.mkdirSync(getSetupWorkpath(state), { recursive: true });

                sendJson(res, 200, { saved: true, agent: input.agent, run: sanitizeSensitiveData(input.profile) });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath === '/api/setup/password' ? [] : null,
            handler: async () => {
                const payload = toPlainObject(await readJsonBody(req));
                const reason = validateSetupPassword(payload.password);
                if (reason) {
                    sendJson(res, 400, { error: reason });
                    return;
                }
                const snapshot = readWebConfigSnapshot(state.webConfigPath);
                if (snapshot.parseError) {
                    sendJson(res, 400, { error: '当前配置解析失败，无法继续', detail: snapshot.parseError });
                    return;
                }
                let nextRaw;
                try {
                    nextRaw = buildPasswordConfigRaw(baseRawOf(snapshot), payload.password);
                    parseAndValidateConfigRaw(nextRaw);
                } catch (e) {
                    sendJson(res, 400, { error: '配置写入失败' });
                    return;
                }
                const savePath = path.resolve(state.webConfigPath);
                writeConfigFileSecure(savePath, nextRaw);
                // 就地生效：已登录会话保持有效，新登录用新密码；重启后配置里的 serverPass 优先于环境变量
                ctx.authPass = payload.password;
                ctx.authPassAuto = false;
                sendJson(res, 200, { saved: true });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath === '/api/setup/mirrors' ? [] : null,
            handler: async () => {
                const payload = toPlainObject(await readJsonBody(req));
                let mirrors;
                try {
                    mirrors = normalizeMirrors(payload.mirrors === undefined ? payload : payload.mirrors);
                } catch (e) {
                    sendJson(res, 400, { error: e.message || '软件源无效' });
                    return;
                }
                const snapshot = readWebConfigSnapshot(state.webConfigPath);
                if (snapshot.parseError) {
                    sendJson(res, 400, { error: '当前配置解析失败，无法继续', detail: snapshot.parseError });
                    return;
                }
                // 全部为官方默认且配置里本来没有 mirrors 时不写任何东西
                if (!shouldWriteMirrors(snapshot.parsed, mirrors)) {
                    sendJson(res, 200, { saved: false, mirrors });
                    return;
                }
                let nextRaw;
                try {
                    nextRaw = buildMirrorsConfigRaw(baseRawOf(snapshot), mirrors);
                    parseAndValidateConfigRaw(nextRaw);
                } catch (e) {
                    sendJson(res, 400, { error: '配置写入失败' });
                    return;
                }
                writeConfigFileSecure(path.resolve(state.webConfigPath), nextRaw);
                sendJson(res, 200, { saved: true, mirrors });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath === '/api/setup/test-connection' ? [] : null,
            handler: async () => {
                const payload = await readJsonBody(req);
                let input;
                try {
                    input = resolveSetupRunInput(ctx, state, payload);
                } catch (e) {
                    sendJson(res, 400, { error: e.message || '参数无效', detail: e.detail || '' });
                    return;
                }
                if (state.setupTestRunning) {
                    sendJson(res, 409, { error: '已有连接测试正在进行，请稍后重试' });
                    return;
                }
                state.setupTestRunning = true;
                try {
                    const result = await runSetupConnectionTest(ctx, state, input.agent, toPlainObject(input.profile.env));
                    sendJson(res, 200, result);
                } finally {
                    state.setupTestRunning = false;
                }
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/system/update' ? [] : null,
            handler: async () => {
                sendJson(res, 200, ctx.updateInfo());
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath === '/api/system/runtime/retry' ? [] : null,
            handler: async () => {
                // 失败/超时后重新自愈；正在进行或已就绪时只返回当前状态，不重复启动
                if (ctx.runtimeState.status === 'failed' && typeof ctx.retryRuntimeHeal === 'function') {
                    ctx.retryRuntimeHeal();
                    if (ctx.autoPullImage) startWebImagePrepare(ctx, state);
                    startStaleSetupCleanup(ctx);
                    startContainerNetworkWatch(ctx, state);
                }
                // 镜像拉取失败的条目会一直挂着：清掉后重新拉
                if (ctx.runtimeState.status === 'ready' && ctx.autoPullImage) {
                    let cleared = false;
                    for (const [ref, entry] of state.imagePulls) {
                        if (entry.status === 'failed') {
                            state.imagePulls.delete(ref);
                            cleared = true;
                        }
                    }
                    if (cleared) startWebImagePrepare(ctx, state);
                }
                sendJson(res, 202, { status: ctx.runtimeState.status, message: ctx.runtimeState.message });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/system/runtime' ? [] : null,
            handler: async () => {
                sendJson(res, 200, { status: ctx.runtimeState.status, message: ctx.runtimeState.message });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/system/doctor' ? [] : null,
            handler: async () => {
                if (typeof ctx.doctorCheck !== 'function') {
                    sendJson(res, 503, { error: '环境检查不可用' });
                    return;
                }
                try {
                    sendJson(res, 200, buildWebDoctorReport(await ctx.doctorCheck()));
                } catch (e) {
                    sendJson(res, 500, { error: '环境检查失败', detail: sanitizeDoctorText(e && e.message) });
                }
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath === '/api/system/doctor/fix' ? [] : null,
            handler: async () => {
                if (typeof ctx.doctorCheck !== 'function') {
                    sendJson(res, 503, { error: '环境检查不可用' });
                    return;
                }
                if (state.doctorFixRunning) {
                    sendJson(res, 409, { error: '已有修复正在进行，请稍后重试' });
                    return;
                }
                state.doctorFixRunning = true;
                try {
                    const report = await ctx.doctorCheck();
                    const fixed = await applyDoctorFixes(report, {
                        startRuntime: typeof ctx.doctorStartRuntime === 'function' ? ctx.doctorStartRuntime : undefined,
                        pullImage: async () => {
                            const imageRef = webImageRef(ctx);
                            await ensureWebImage(ctx, state, imageRef);
                            return { fixed: true, message: `已准备镜像 ${imageRef}` };
                        }
                    });
                    sendJson(res, 200, buildWebDoctorReport(fixed));
                } catch (e) {
                    sendJson(res, 500, { error: '自动修复失败', detail: sanitizeDoctorText(e && e.message) });
                } finally {
                    state.doctorFixRunning = false;
                }
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/system/capacity' ? [] : null,
            handler: async () => {
                const containerMap = listWebManyoyoContainers(ctx);
                const diskPath = path.dirname(path.resolve(state.webConfigPath));
                const report = estimateContainerCapacity({
                    runtimeCommand: ctx.dockerCmd || 'docker',
                    imageName: ctx.imageName,
                    imageVersion: ctx.imageVersion,
                    containerNames: Object.keys(containerMap),
                    diskPath,
                    runCommand: (command, args) => ctx.dockerExecArgs(args, { ignoreError: false }),
                    statfs: statPath => fs.statfsSync(statPath)
                });
                sendJson(res, 200, report);
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/system/quick-chat-config' ? [] : null,
            handler: async () => {
                const snapshot = readWebConfigSnapshot(state.webConfigPath);
                const serve = snapshot.parsed && typeof snapshot.parsed.serve === 'object' && snapshot.parsed.serve !== null
                    ? snapshot.parsed.serve
                    : {};
                const quickChat = serve.quickChat && typeof serve.quickChat === 'object' ? serve.quickChat : {};
                sendJson(res, 200, {
                    path: typeof quickChat.path === 'string' && quickChat.path.trim() ? quickChat.path : null,
                    run: typeof quickChat.run === 'string' && quickChat.run.trim() ? quickChat.run : null
                });
            }
        },
        {
            method: 'PUT',
            match: currentPath => currentPath === '/api/system/quick-chat-config' ? [] : null,
            handler: async () => {
                const payload = await readJsonBody(req);
                const quickChatPath = typeof payload.path === 'string' ? payload.path.trim() : '';
                const quickChatRun = typeof payload.run === 'string' ? payload.run.trim() : '';
                if (!quickChatPath) {
                    sendJson(res, 400, { error: 'path 不能为空' });
                    return;
                }
                if (!quickChatRun) {
                    sendJson(res, 400, { error: 'run 不能为空' });
                    return;
                }
                const resolvedPath = expandHomeAliasPath(quickChatPath);
                const homeDir = process.env.HOME || os.homedir() || '/home';
                if (resolvedPath === '/' || resolvedPath === homeDir) {
                    sendJson(res, 400, { error: 'path 不能是根目录或 home 目录本身' });
                    return;
                }

                const snapshot = readWebConfigSnapshot(state.webConfigPath);
                if (snapshot.parseError) {
                    sendJson(res, 400, { error: '当前配置解析失败，无法写入', detail: snapshot.parseError });
                    return;
                }

                let nextRaw;
                try {
                    nextRaw = upsertValueByPath(snapshot.raw, ['serve', 'quickChat', 'path'], JSON.stringify(quickChatPath));
                    nextRaw = upsertValueByPath(nextRaw, ['serve', 'quickChat', 'run'], JSON.stringify(quickChatRun));
                } catch (e) {
                    sendJson(res, 400, { error: '配置写入失败', detail: e.message || '' });
                    return;
                }

                const savePath = path.resolve(state.webConfigPath);
                writeConfigFileSecure(savePath, nextRaw);

                sendJson(res, 200, { saved: true, path: quickChatPath, run: quickChatRun });
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
                        return listWebAgentSessions(history, { includeSyntheticDefault: true, includeArchived: true })
                            .map(agentSession => buildSessionSummary(ctx, state, containerMap, {
                                containerName: name,
                                agentId: agentSession.agentId
                            }, history))
                            .filter(Boolean);
                    })
                    .sort(compareWebSessionCreatedDesc);

                sendJson(res, 200, { sessions }, {}, { autoEtag: true });
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
                    applied: runtime.applied,
                    runtimeSnapshot: runtime.runtimeSnapshot
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
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/clone-config$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                if (sessionRef.agentId !== WEB_DEFAULT_AGENT_ID) {
                    sendJson(res, 400, { error: '该操作需在容器层级执行' });
                    return;
                }
                const sourceContainerName = sessionRef.containerName;
                const historyExists = fs.existsSync(getWebHistoryFile(state.webHistoryDir, sourceContainerName));
                if (!historyExists && !ctx.containerExists(sourceContainerName)) {
                    sendJson(res, 404, { error: `容器不存在: ${sourceContainerName}` });
                    return;
                }
                const payload = await readJsonBody(req);
                const requestedName = pickFirstString(payload.containerName);
                try {
                    const result = await createClonedContainer(ctx, state, sourceContainerName, requestedName, { copyHistory: false });
                    sendJson(res, 200, result);
                } catch (e) {
                    sendJson(res, e.statusCode || 400, { error: e.message || '创建相同配置容器失败' });
                }
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/duplicate$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                if (sessionRef.agentId !== WEB_DEFAULT_AGENT_ID) {
                    sendJson(res, 400, { error: '该操作需在容器层级执行' });
                    return;
                }
                const sourceContainerName = sessionRef.containerName;
                const historyExists = fs.existsSync(getWebHistoryFile(state.webHistoryDir, sourceContainerName));
                if (!historyExists && !ctx.containerExists(sourceContainerName)) {
                    sendJson(res, 404, { error: `容器不存在: ${sourceContainerName}` });
                    return;
                }
                const payload = await readJsonBody(req);
                const requestedName = pickFirstString(payload.containerName);
                try {
                    const result = await createClonedContainer(ctx, state, sourceContainerName, requestedName, { copyHistory: true });
                    sendJson(res, 200, result);
                } catch (e) {
                    sendJson(res, e.statusCode || 400, { error: e.message || '复制容器失败' });
                }
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/container-remark$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                if (sessionRef.agentId !== WEB_DEFAULT_AGENT_ID) {
                    sendJson(res, 400, { error: '该操作需在容器层级执行' });
                    return;
                }
                const payload = await readJsonBody(req);
                const remark = normalizeRemarkText(payload.remark);
                patchWebSessionHistory(state.webHistoryDir, sessionRef.containerName, { remark });
                sendJson(res, 200, { containerName: sessionRef.containerName, remark });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agent-remark$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const payload = await readJsonBody(req);
                const remark = normalizeRemarkText(payload.remark);
                patchWebAgentSessionState(state.webHistoryDir, sessionRef, { remark });
                sendJson(res, 200, { name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId), remark });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agent-pin$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const payload = await readJsonBody(req);
                const pinned = payload.pinned === true;
                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                // 默认 AGENT 在还没有任何消息时也会出现在列表里（历史里还没有它的记录），允许置顶
                if (sessionRef.agentId !== WEB_DEFAULT_AGENT_ID && !getWebAgentSession(history, sessionRef.agentId, { includeArchived: true })) {
                    sendJson(res, 404, { error: 'AGENT 不存在' });
                    return;
                }
                patchWebAgentSessionState(state.webHistoryDir, sessionRef, { pinned });
                sendJson(res, 200, { name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId), pinned });
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
                const requestUrl = new URL(req.url || '/', 'http://localhost');
                const query = messagesView.parseMessagesQuery(requestUrl.searchParams);
                if (query.error) {
                    sendJson(res, 400, { error: query.error });
                    return;
                }
                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true })
                    || createEmptyWebAgentSession(sessionRef.agentId);
                // 版本号来自历史缓存的进程内计数：不用算响应体就能判断 304，也不会像 mtime 那样在同一毫秒内撞车
                const version = getWebSessionHistoryVersion(state.webHistoryDir, sessionRef.containerName);
                const queryDigest = crypto.createHash('sha1')
                    .update(`${sessionRef.agentId}|${requestUrl.search}`)
                    .digest('hex')
                    .slice(0, 12);
                const etag = `W/"${historyStore.bootId}.${version}.${queryDigest}"`;
                if (etagMatches(req, etag)) {
                    sendJson(res, 200, {}, {}, { etag });
                    return;
                }
                const view = messagesView.buildMessagesResponse(agentSession.messages, agentSession.epoch, query);
                sendJson(res, 200, {
                    name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
                    containerName: sessionRef.containerName,
                    agentId: sessionRef.agentId,
                    queue: agentQueue.publicQueue(agentSession),
                    queuePaused: agentQueue.isPaused(agentSession),
                    ...view
                }, {}, { etag });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/trace$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const messageId = match[2];
                if (!messagesView.MESSAGE_ID_PATTERN.test(messageId)) {
                    sendJson(res, 400, { error: '消息 id 格式不正确' });
                    return;
                }
                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true });
                const message = agentSession
                    ? agentSession.messages.find(item => item && item.id === messageId && item.streamTrace === true)
                    : null;
                if (!message) {
                    sendJson(res, 404, { error: '没有找到这条执行过程' });
                    return;
                }
                sendJson(res, 200, {
                    id: message.id,
                    content: message.content,
                    traceEvents: Array.isArray(message.traceEvents) ? message.traceEvents : [],
                    pending: message.pending === true
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
                const limitParam = Number.parseInt(requestUrl.searchParams.get('limit') || '', 10);
                const listOptions = {
                    limit: Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, WEB_FS_LIST_MAX_LIMIT) : 0,
                    prefix: String(requestUrl.searchParams.get('prefix') || '').slice(0, 255)
                };

                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                const payload = await execJsonCommandInWebContainer(
                    ctx,
                    sessionRef.containerName,
                    buildContainerFileListCommand(targetPath, listOptions)
                );
                if (payload && payload.error) {
                    sendJson(res, 400, { error: payload.error });
                    return;
                }
                sendJson(res, 200, payload);
            }
        },
        {
            // 聊天里的图片：原始请求体，类型只收 png/jpeg/gif/webp，单张 10MB
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/uploads$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const ext = webUploads.extForContentType(req.headers['content-type']);
                if (!ext) {
                    sendJson(res, 415, { error: '只支持 png、jpeg、gif、webp 图片' });
                    return;
                }
                const declared = Number(req.headers['content-length']);
                if (Number.isFinite(declared) && declared > webUploads.MAX_IMAGE_BYTES) {
                    sendJson(res, 413, { error: '图片不能超过 10MB' });
                    return;
                }
                if (!ctx.containerExists(sessionRef.containerName)) {
                    sendJson(res, 404, { error: `容器不存在: ${sessionRef.containerName}` });
                    return;
                }
                const homeDir = ctx.homeDir || os.homedir();
                const id = resolveContainerId(ctx.dockerExecArgs, sessionRef.containerName);
                if (!id || !containerState.stateExists(homeDir, id)) {
                    sendJson(res, 409, { error: '这个容器太旧，不支持发图片，重建后可用' });
                    return;
                }
                const saved = await webUploads.saveUpload(req, path.join(containerState.paths(homeDir, id).box, 'uploads'), ext);
                if (!saved.ok) {
                    sendJson(res, saved.status, { error: saved.error });
                    return;
                }
                sendJson(res, 200, { path: `${webUploads.CONTAINER_UPLOAD_DIR}/${saved.name}` });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/fs\/stat$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const requestUrl = new URL(req.url || '/api/sessions/x/fs/stat', 'http://localhost');
                const targetPath = String(requestUrl.searchParams.get('path') || '').trim();
                // 点一下文字不该拉起容器：没在运行就当作不存在
                if (!targetPath || !ctx.containerExists(sessionRef.containerName) || ctx.getContainerStatus(sessionRef.containerName) !== 'running') {
                    sendJson(res, 200, { exists: false });
                    return;
                }
                let payload = null;
                try {
                    payload = await execJsonCommandInWebContainer(ctx, sessionRef.containerName, buildContainerPathExistsCommand(targetPath));
                } catch (e) {
                    payload = null;
                }
                sendJson(res, 200, payload && payload.exists === true
                    ? { exists: true, type: payload.type }
                    : { exists: false });
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
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/fs\/raw$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const requestUrl = new URL(req.url || '/api/sessions/x/fs/raw', 'http://localhost');
                const targetPath = String(requestUrl.searchParams.get('path') || '').trim();
                if (!targetPath) {
                    sendJson(res, 400, { error: 'path 不能为空' });
                    return;
                }
                const ext = path.extname(targetPath).toLowerCase();
                const contentType = IMAGE_EXTENSION_CONTENT_TYPES[ext];
                if (!contentType) {
                    sendJson(res, 400, { error: '不支持预览该文件类型' });
                    return;
                }

                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                const statPayload = await execJsonCommandInWebContainer(
                    ctx,
                    sessionRef.containerName,
                    buildContainerFileStatCommand(targetPath)
                );
                if (statPayload && statPayload.error) {
                    sendJson(res, 404, { error: statPayload.error });
                    return;
                }

                if (!acquireWebRawFileStreamSlot(sessionRef.containerName)) {
                    sendJson(res, 429, { error: '预览并发已达上限，请稍后重试' });
                    return;
                }

                let released = false;
                const releaseOnce = () => {
                    if (released) {
                        return;
                    }
                    released = true;
                    releaseWebRawFileStreamSlot(sessionRef.containerName);
                };

                const child = spawnContainerRawFileStream(ctx, sessionRef.containerName, statPayload.path);
                // stderr 单独消费,绝不混入响应体,避免管道缓冲区打满导致 cat 进程卡死
                child.stderr.on('data', () => {});
                child.on('error', () => releaseOnce());
                child.on('close', () => releaseOnce());
                res.on('close', () => {
                    releaseOnce();
                    if (!child.killed) {
                        child.kill();
                    }
                });

                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Content-Length': String(statPayload.size),
                    'X-Content-Type-Options': 'nosniff',
                    'Cache-Control': 'no-store'
                });
                child.stdout.pipe(res);
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

                const ifMatch = req.headers['if-match'];
                if (ifMatch === undefined) {
                    sendJson(res, 428, { error: STALE_PAGE_MESSAGE });
                    return;
                }

                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                const result = await execJsonCommandInWebContainer(
                    ctx,
                    sessionRef.containerName,
                    buildContainerFileWriteCommand(targetPath, content, normalizeIfMatchHeader(ifMatch))
                );
                if (result && result.conflict === true) {
                    sendJson(res, 409, { error: result.error || '文件已在容器里被修改', conflict: true });
                    return;
                }
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
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/fs\/create$/),
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
                    buildContainerFileCreateCommand(targetPath)
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
                sendJson(res, 200, { name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId), detail }, {}, { autoEtag: true });
            }
        },
        {
            // 按轮看改动：比较某一轮前后两个快照（提交号必须是 40 位小写十六进制）
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/git\/rounds\/changes$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const requestUrl = new URL(req.url || '/', 'http://localhost');
                const from = String(requestUrl.searchParams.get('from') || '');
                const to = String(requestUrl.searchParams.get('to') || '');
                if (!webSnapshots.isSnapId(from) || !webSnapshots.isSnapId(to)) {
                    sendJson(res, 400, { error: '快照号不合法' });
                    return;
                }
                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                const out = await runWebContainerScript(ctx, sessionRef.containerName, webSnapshots.buildRoundChangesCommand(resolveWebSessionWorkDir(state, sessionRef), from, to), 30000);
                sendJson(res, 200, webSnapshots.parseRoundChangesOutput(out));
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/git\/rounds\/diff$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const requestUrl = new URL(req.url || '/', 'http://localhost');
                const from = String(requestUrl.searchParams.get('from') || '');
                const to = String(requestUrl.searchParams.get('to') || '');
                const filePath = String(requestUrl.searchParams.get('path') || '');
                if (!webSnapshots.isSnapId(from) || !webSnapshots.isSnapId(to)) {
                    sendJson(res, 400, { error: '快照号不合法' });
                    return;
                }
                if (!gitChanges.isAcceptableDiffPath(filePath)) {
                    sendJson(res, 400, { error: '文件路径不合法' });
                    return;
                }
                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                const workDir = resolveWebSessionWorkDir(state, sessionRef);
                // 只给这两个快照之间出现过的文件看 diff：路径由服务端重新取一次核对，不信任请求
                const listed = webSnapshots.parseRoundChangesOutput(await runWebContainerScript(ctx, sessionRef.containerName, webSnapshots.buildRoundChangesCommand(workDir, from, to), 30000));
                if (!listed.files.some(file => file.path === filePath)) {
                    sendJson(res, 404, { error: '该文件不在这一轮的改动里' });
                    return;
                }
                const out = await runWebContainerScript(ctx, sessionRef.containerName, webSnapshots.buildRoundDiffCommand(workDir, from, to, filePath), 30000);
                sendJson(res, 200, { path: filePath, ...webSnapshots.parseRoundDiffOutput(out) });
            }
        },
        {
            // 回退前预览：会改 / 删 / 恢复哪些文件（会先拍一张“现在”的快照，不改任何文件）
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/rewind\/preview$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const payload = await readJsonBody(req);
                const target = findWebRewindTarget(state, sessionRef, payload.messageId);
                if (target.error) {
                    sendJson(res, target.status, { error: target.error });
                    return;
                }
                const program = getAgentRuntimeMeta(resolveEffectiveAgentPromptCommandForSession(
                    target.history, sessionRef.agentId, (listWebManyoyoContainers(ctx)[sessionRef.containerName] || {}).defaultCommand
                )).agentProgram;
                const result = { agentProgram: program, precise: program === 'claude', files: null };
                if (webSnapshots.isSnapId(target.message.snapBefore)) {
                    const out = await runWebContainerScript(ctx, sessionRef.containerName, webSnapshots.buildRestorePreviewCommand(resolveWebSessionWorkDir(state, sessionRef), target.message.snapBefore), 30000);
                    const preview = webSnapshots.parseRestorePreviewOutput(out);
                    result.files = preview.ok ? preview : { ok: false, reason: preview.reason };
                }
                sendJson(res, 200, result);
            }
        },
        {
            // 回退：scope = both（对话和文件）/ conversation（只对话）/ files（只文件）
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/rewind$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const payload = await readJsonBody(req);
                const scope = String(payload.scope || '');
                if (!['both', 'conversation', 'files'].includes(scope)) {
                    sendJson(res, 400, { error: 'scope 只能是 both、conversation 或 files' });
                    return;
                }
                const outcome = await rewindWebSession(ctx, state, sessionRef, payload.messageId, scope);
                if (outcome.error) {
                    sendJson(res, outcome.status, { error: outcome.error });
                    return;
                }
                sendJson(res, 200, outcome);
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/messages\/hide$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const payload = await readJsonBody(req);
                if (state.agentRuns.has(sessionRef.containerName)) {
                    sendJson(res, 409, { error: '任务进行中，暂时不能隐藏' });
                    return;
                }
                const changed = setWebSessionTurnHidden(state.webHistoryDir, sessionRef, String(payload.messageId || ''), payload.hidden !== false);
                if (!changed) {
                    sendJson(res, 404, { error: '没有找到这一组' });
                    return;
                }
                sendJson(res, 200, { ok: true, count: changed });
            }
        },
        {
            // “改动”视图：工作目录所在 git 仓库的改动列表（按需请求，前端不轮询）
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/git\/changes$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                const changes = await readWebGitChanges(ctx, state, sessionRef);
                sendJson(res, 200, changes);
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/git\/diff$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const requestUrl = new URL(req.url || '/', 'http://localhost');
                const filePath = String(requestUrl.searchParams.get('path') || '');
                if (!gitChanges.isAcceptableDiffPath(filePath)) {
                    sendJson(res, 400, { error: '文件路径不合法' });
                    return;
                }
                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                // 只给改动列表里出现过的文件看 diff：路径由服务端重新取一次核对，不信任请求
                const changes = await readWebGitChanges(ctx, state, sessionRef);
                const entry = changes.files.find(file => file.path === filePath);
                if (!entry || entry.status === 'untracked') {
                    sendJson(res, 404, { error: '该文件不在改动列表里' });
                    return;
                }
                const result = await execCommandInWebContainer(
                    ctx,
                    sessionRef.containerName,
                    gitChanges.buildGitDiffCommand(resolveWebSessionWorkDir(state, sessionRef), filePath),
                    { withEnv: false }
                );
                sendJson(res, 200, { path: filePath, ...gitChanges.parseGitDiffOutput(result.stdout) });
            }
        },
        {
            // 输入框里打 / 时的候选：只列实测能在 Web 端执行的（见 lib/web/session-meta.js）
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/slash-commands$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true });
                sendJson(res, 200, {
                    name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
                    commands: sessionMeta.listUsableSlashCommands(agentSession && agentSession.slashCommands)
                });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/models$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const containerMap = listWebManyoyoContainers(ctx);
                const containerInfo = containerMap[sessionRef.containerName] || {};
                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                const effectiveTemplate = resolveEffectiveAgentPromptCommandForSession(
                    history,
                    sessionRef.agentId,
                    containerInfo.defaultCommand
                );
                const agentProgram = resolveAgentProgram(effectiveTemplate);
                const models = await fetchAgentModelCatalogCached(ctx, sessionRef.containerName, agentProgram);
                sendJson(res, 200, {
                    name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
                    agentProgram,
                    models
                });
            }
        },
        {
            // 毫秒级：只读宿主机上的 env 文件，不进容器；慢的 CLI 目录探测走上面的 /models
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/model-options$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const containerMap = listWebManyoyoContainers(ctx);
                const containerInfo = containerMap[sessionRef.containerName] || {};
                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                const agentProgram = resolveAgentProgram(resolveEffectiveAgentPromptCommandForSession(
                    history,
                    sessionRef.agentId,
                    containerInfo.defaultCommand
                ));
                let env = {};
                try {
                    env = readMergedEnv({ homeDir: ctx.homeDir || os.homedir(), dockerExecArgs: ctx.dockerExecArgs }, sessionRef.containerName);
                } catch (e) { /* 读不到 env 就只给空选项 */ }
                sendJson(res, 200, {
                    name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId),
                    agentProgram,
                    ...buildEnvModelOptions(agentProgram, env)
                });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/model$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const payload = await readJsonBody(req);
                let model;
                try {
                    model = normalizeAgentModelValueInput(payload.model);
                } catch (e) {
                    sendJson(res, 400, { error: e.message || String(e) });
                    return;
                }
                patchWebAgentSessionState(state.webHistoryDir, sessionRef, { model });
                sendJson(res, 200, { name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId), model });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/audit$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }

                const audit = buildSessionAudit(ctx, state, sessionRef);
                sendJson(res, 200, { name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId), audit });
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
                const commandClientId = readClientMessageId(res, payload);
                if (!commandClientId) {
                    return;
                }
                const releaseCommandClaim = claimClientMessage(res, state.webHistoryDir, sessionRef, commandClientId.value);
                if (!releaseCommandClaim) {
                    return;
                }
                try {
                    await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                    appendWebSessionMessage(state.webHistoryDir, sessionRef, 'user', command, {
                        mode: 'command',
                        ...(commandClientId.value ? { clientMessageId: commandClientId.value } : {})
                    });
                } finally {
                    releaseCommandClaim();
                }
                const result = await execCommandInWebContainer(ctx, sessionRef.containerName, command);
                // role 用 'system'、带 mode: 'command'，与前端实时发送时的约定对齐（workspace-panel.tsx
                // handleSend 的 command 分支）——命令输出本来就不该走 assistant 的气泡样式和 markdown 渲染，
                // 之前这里存的是 'assistant' 且没带 mode，历史记录重新加载后气泡样式和渲染方式会跟实时时不一致
                appendWebSessionMessage(
                    state.webHistoryDir,
                    sessionRef,
                    'system',
                    result.output,
                    { exitCode: result.exitCode, mode: 'command' }
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
                const agentClientId = readClientMessageId(res, payload);
                if (!agentClientId) {
                    return;
                }
                const releaseAgentClaim = claimClientMessage(res, state.webHistoryDir, sessionRef, agentClientId.value);
                if (!releaseAgentClaim) {
                    return;
                }

                let prepared = null;
                try {
                    prepared = await prepareWebAgentExecution(ctx, state, sessionRef, prompt);
                } catch (e) {
                    releaseAgentClaim();
                    sendJson(res, 400, { error: e && e.message ? e.message : 'Agent 执行准备失败' });
                    return;
                }

                const { agentSession, agentMeta, command, contextMode, resumeAttempted, resumeSucceeded, resumeError, engineSessionId } = prepared;
                appendWebSessionMessage(state.webHistoryDir, sessionRef, 'user', prompt, {
                    mode: 'agent',
                    contextMode,
                    ...(agentClientId.value ? { clientMessageId: agentClientId.value } : {})
                });
                releaseAgentClaim();
                const result = await execCommandInWebContainer(ctx, sessionRef.containerName, command, {
                    agentProgram: agentMeta.agentProgram
                });
                finalizeWebAgentExecution(state, sessionRef, agentSession, agentMeta, {
                    contextMode,
                    resumeAttempted,
                    resumeSucceeded,
                    resumeError,
                    engineSessionId
                }, result);
                void refreshWebAgentTitle(ctx, state, sessionRef, agentMeta.agentProgram);
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
                let streamImages;
                try {
                    streamImages = webUploads.parseImages(payload.images);
                } catch (e) {
                    sendJson(res, 400, { error: e.message });
                    return;
                }
                const prompt = (payload.prompt || '').trim();
                if (!prompt) {
                    sendJson(res, 400, { error: 'prompt 不能为空' });
                    return;
                }
                const streamClientId = readClientMessageId(res, payload);
                if (!streamClientId) {
                    return;
                }
                if (rejectDuplicateClientMessage(res, state.webHistoryDir, sessionRef, streamClientId.value, { includeQueue: true })) {
                    return;
                }
                const turn = await runWebAgentStreamTurn(ctx, state, sessionRef, prompt, streamClientId.value, res, streamImages);
                if (turn.busy) {
                    sendJson(res, 409, { error: '当前容器已有运行中的 agent 任务，请等它结束或先停止' });
                } else if (turn.error) {
                    sendJson(res, 400, { error: turn.error });
                }
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agent\/queue$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const payload = await readJsonBody(req);
                let queueImages;
                try {
                    queueImages = webUploads.parseImages(payload.images);
                } catch (e) {
                    sendJson(res, 400, { error: e.message });
                    return;
                }
                const text = (payload.prompt || '').trim();
                if (!text) {
                    sendJson(res, 400, { error: 'prompt 不能为空' });
                    return;
                }
                const when = agentQueue.normalizeWhen(payload.when === undefined ? 'turn' : payload.when);
                if (!when) {
                    sendJson(res, 400, { error: 'when 只能是 now、step 或 turn' });
                    return;
                }
                const queueClientId = readClientMessageId(res, payload);
                if (!queueClientId) {
                    return;
                }
                if (rejectDuplicateClientMessage(res, state.webHistoryDir, sessionRef, queueClientId.value)) {
                    return;
                }
                const runState = state.agentRuns.get(sessionRef.containerName);
                if (runState && runState.sessionKey !== buildWebSessionKey(sessionRef.containerName, sessionRef.agentId)) {
                    sendJson(res, 409, { error: '当前容器已有其他会话的 agent 任务在运行，请等它结束或先停止' });
                    return;
                }
                // 入队与下面的调度之间没有 await：队列落盘和打断判断对同一会话是原子的
                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                const agentSession = getWebAgentSession(history, sessionRef.agentId, { create: true, includeArchived: true });
                const added = agentQueue.enqueue(agentSession, { clientMessageId: queueClientId.value, text, when, images: queueImages });
                if (!added.ok) {
                    sendJson(res, 409, { error: '排队已满（最多 10 条），请先取消几条或等它们发出', full: true });
                    return;
                }
                if (!added.duplicate) {
                    saveWebSessionHistory(state.webHistoryDir, sessionRef.containerName, history);
                    if (!runState) {
                        dispatchNextQueued(ctx, state, sessionRef);
                    } else if (when === 'now') {
                        steerWebAgentRun(ctx, runState, 'now', state);
                    } else if (when === 'step') {
                        armStepSteer(ctx, state, runState);
                    }
                }
                sendJson(res, 200, { item: added.item, duplicate: added.duplicate, queue: agentQueue.publicQueue(agentSession) });
            }
        },
        {
            method: 'DELETE',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agent\/queue\/([A-Za-z0-9_-]+)$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                const agentSession = getWebAgentSession(history, sessionRef.agentId, { includeArchived: true });
                const removed = agentSession ? agentQueue.removeFromQueue(agentSession, match[2]) : null;
                if (!removed) {
                    // 已经发出去了或早被取消：前端据此刷新，不当错误
                    sendJson(res, 404, { error: '这条排队的提示词已经发出或已取消' });
                    return;
                }
                saveWebSessionHistory(state.webHistoryDir, sessionRef.containerName, history);
                // 取消的是最后一个 now / step：撤掉还在等的“步骤结束后打断”
                const activeRun = state.agentRuns.get(sessionRef.containerName);
                if (activeRun && activeRun.stepPending && !queueHasSteerItems(state, sessionRef)) {
                    clearTimeout(activeRun.stepTimer);
                    activeRun.stepPending = false;
                }
                sendJson(res, 200, { removed: removed.id, queue: agentQueue.publicQueue(agentSession) });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/agent\/queue\/continue$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) {
                    return;
                }
                if (state.agentRuns.has(sessionRef.containerName)) {
                    sendJson(res, 409, { error: '当前容器已有运行中的 agent 任务' });
                    return;
                }
                const started = dispatchNextQueued(ctx, state, sessionRef, { force: true });
                sendJson(res, 200, { started });
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
                const stopped = stopWebAgentRun(state, sessionRef.containerName, ctx);
                if (!stopped) {
                    // 运行登记不存在（serve 重启后常见的孤儿任务）：把残留的
                    // pending 消息标记为已中断，否则前端会因 pending 永久禁用输入
                    interruptOrphanPendingMessages(state.webHistoryDir, sessionRef);
                    sendJson(res, 404, { error: '当前会话没有运行中的 agent 任务' });
                    return;
                }
                appendWebSessionControlEvent(state.webHistoryDir, sessionRef, 'session.stopping');
                sendJson(res, 200, { ok: true, stopping: true });
            }
        },
        {
            // 容器菜单里的“启动容器”：与对话前的拉起同一条路径（含网络规则下发）
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/container\/start$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) return;
                if (!ctx.containerExists(sessionRef.containerName)) {
                    sendJson(res, 404, { error: `容器不存在: ${sessionRef.containerName}` });
                    return;
                }
                await ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
                sendJson(res, 200, { ok: true });
            }
        },
        {
            method: 'POST',
            match: currentPath => currentPath.match(/^\/api\/sessions\/([^/]+)\/container\/stop$/),
            handler: async match => {
                const sessionRef = getValidSessionRef(ctx, res, match[1]);
                if (!sessionRef) return;
                if (!ctx.containerExists(sessionRef.containerName)) {
                    sendJson(res, 404, { error: `容器不存在: ${sessionRef.containerName}` });
                    return;
                }
                if (state.agentRuns && state.agentRuns.has(sessionRef.containerName)) {
                    sendJson(res, 409, { error: '容器里有 AGENT 正在执行，请先停止任务' });
                    return;
                }
                await ctx.dockerExecAsync(['stop', '-t', '10', sessionRef.containerName], { timeout: 60000 });
                sendJson(res, 200, { ok: true });
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

                const payload = await readJsonBody(req);
                const removeHistory = payload.removeHistory === true;
                const { removedContainer } = removeContainerIdempotent(ctx, sessionRef.containerName);

                if (removeHistory) {
                    const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                    removeAllAgentHistoryArtifacts(state.webHistoryDir, sessionRef.containerName, Object.keys(history.agents || {}));
                    removeWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                } else if (removedContainer) {
                    appendWebSessionMessage(state.webHistoryDir, sessionRef, 'system', `容器 ${sessionRef.containerName} 已删除。`);
                }

                sendJson(res, 200, {
                    removed: true,
                    removedHistory: removeHistory,
                    name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId)
                });
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

                const payload = await readJsonBody(req);
                const removeHistory = payload.removeHistory === true;

                const history = loadWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                if (history.agents && typeof history.agents === 'object') {
                    if (removeHistory) {
                        delete history.agents[sessionRef.agentId];
                        removeAllAgentHistoryArtifacts(state.webHistoryDir, sessionRef.containerName, [sessionRef.agentId]);
                    } else if (history.agents[sessionRef.agentId]) {
                        history.agents[sessionRef.agentId].archived = true;
                        history.agents[sessionRef.agentId].updatedAt = new Date().toISOString();
                    }
                }
                if (!Object.keys(history.agents || {}).length && !ctx.containerExists(sessionRef.containerName)) {
                    removeWebSessionHistory(state.webHistoryDir, sessionRef.containerName);
                } else {
                    saveWebSessionHistory(state.webHistoryDir, sessionRef.containerName, history);
                }
                sendJson(res, 200, {
                    removedHistory: removeHistory,
                    name: buildWebSessionKey(sessionRef.containerName, sessionRef.agentId)
                });
            }
        }
    ];

    routes.push(...createContainerManageRoutes({
        ctx,
        state,
        req,
        res,
        deps: {
            sendJson,
            readJsonBody,
            decodeSessionName,
            getNetworkManager: () => getWebNetworkManager(ctx, state),
            getPortForwarder: () => getWebPortForwarder(ctx, state),
            rememberContainerName: (id, name) => {
                if (!state.containerNames) state.containerNames = new Map();
                state.containerNames.set(id, name);
            },
            ensureWebContainer,
            execCommandInWebContainer,
            readConfig: () => {
                const snapshot = readWebConfigSnapshot(state.webConfigPath);
                return snapshot.parseError ? {} : snapshot.parsed;
            }
        }
    }));

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
        serveTitle: typeof options.serveTitle === 'string' ? options.serveTitle : null,
        dockerCmd: options.dockerCmd,
        homeDir: options.homeDir,
        dockerEnv: options.dockerEnv,
        loginTokenDir: options.loginTokenDir || '',
        doctorCheck: options.doctorCheck,
        doctorStartRuntime: options.doctorStartRuntime,
        runtimeState: options.runtimeState || { status: 'ready', message: '' },
        autoPullImage: Boolean(options.autoPullImage),
        // 离线安装器后台导入镜像的状态读取（默认没有导入）
        updateInfo: typeof options.updateInfo === 'function' ? options.updateInfo : () => ({ enabled: false, installMode: 'unknown', current: '', latest: '', updateAvailable: false, checkedAt: null, error: '' }),
        importState: typeof options.importState === 'function' ? options.importState : () => ({ active: false, message: '' }),
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
        networkManager: options.networkManager,
        envFiles: options.envFiles,
        containerVolumes: options.containerVolumes,
        containerPorts: options.containerPorts,
        validateHostPath: options.validateHostPath,
        formatDate: options.formatDate,
        isValidContainerName: options.isValidContainerName,
        containerExists: options.containerExists,
        getContainerStatus: options.getContainerStatus,
        waitForContainerReady: options.waitForContainerReady,
        dockerExecArgs: options.dockerExecArgs,
        dockerExecAsync: options.dockerExecAsync,
        nowMs: typeof options.nowMs === 'function' ? options.nowMs : Date.now,
        retryRuntimeHeal: options.retryRuntimeHeal,
        showImagePullHint: options.showImagePullHint,
        removeContainer: options.removeContainer,
        logger: options.logger && typeof options.logger.info === 'function' ? options.logger : fallbackLogger,
        // agent/stream 的保活心跳间隔，需小于反向代理的空闲读超时（nginx 默认 60s）
        agentStreamHeartbeatMs: Number.isFinite(options.agentStreamHeartbeatMs) && options.agentStreamHeartbeatMs > 0
            ? options.agentStreamHeartbeatMs
            : DEFAULT_AGENT_STREAM_HEARTBEAT_MS,
        // 停止 / 打断时每一级信号（INT → TERM → KILL）等进程退出的时间
        agentStopGraceMs: Number.isFinite(options.agentStopGraceMs) && options.agentStopGraceMs > 0
            ? options.agentStopGraceMs
            : agentRunControl.DEFAULT_GRACE_MS,
        // Agent 原始输出保留开头的上限（测试可调小）；结尾另留一份，见 createTailBuffer
        agentRawOutputMaxChars: Number.isFinite(options.agentRawOutputMaxChars) && options.agentRawOutputMaxChars > 0
            ? options.agentRawOutputMaxChars
            : AGENT_RAW_OUTPUT_MAX_CHARS,
        // 追加提示词“当前步骤结束后插入”等不到步骤边界时，退化成立即打断的等待时间
        orphanPollMs: Number.isFinite(options.orphanPollMs) && options.orphanPollMs > 0 ? options.orphanPollMs : WEB_ORPHAN_POLL_MS,
        agentStepFallbackMs: Number.isFinite(options.agentStepFallbackMs) && options.agentStepFallbackMs > 0
            ? options.agentStepFallbackMs
            : agentQueue.STEP_FALLBACK_MS,
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
        orphanTimers: new Set(),
        authStore: createAuthStore({
            file: options.authSessionsFile || '',
            user: ctx.authUser,
            pass: ctx.authPass,
            ttlMs: WEB_AUTH_TTL_SECONDS * 1000,
            now: Date.now,
            warn: message => ctx.logger.warn(message)
        }),
        terminalSessions: new Map(),
        agentRuns: new Map(),
        // imageRef -> { status: 'pulling'|'failed', message, promise }
        imagePulls: new Map(),
        loginFailures: new Map()
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
        // 身份标记：无参启动器复用实例前用它确认端口上跑的确实是 manyoyo serve（未登录的 401 也带）；不含任何版本或本机信息
        res.setHeader('X-Manyoyo-Serve', '1');
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

            // 前端构建产物见 frontend/（npm run build:web），输出到 lib/web/index.html
            if (req.method === 'GET' && pathname === '/') {
                sendIndexHtml(res, 'app', ctx);
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
            if (e && e.imagePreparing) {
                sendJson(res, 409, { error: e.message, imagePreparing: true });
                return;
            }
            ctx.logger.error('http request error', {
                method: req && req.method ? req.method : '',
                url: redactLoginTokenInUrl(req && req.url ? req.url : ''),
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

        // 升级成 WebSocket 后这条连接是长连接，不能再受 HTTP 请求的空闲超时约束；
        // 同时打开 TCP keepalive，避免中间设备（NAT / 代理）回收看起来空闲的连接
        socket.setTimeout(0);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, WEB_TERMINAL_PING_INTERVAL_MS);

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
            console.log(`${CYAN}提示: 左侧是 manyoyo 容器与 AGENT 列表，右侧是聊天/终端/文件/详情/配置/检查工作台。${NC}`);
            if (ctx.serverHost === '0.0.0.0') {
                console.log(`${CYAN}提示: 当前监听全部网卡，请用本机局域网 / 公网 IP 访问。${NC}`);
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

    startStaleSetupCleanup(ctx);
    state.orphanReconcileReady = reconcileOrphanTurns(ctx, state).catch(e => ctx.logger.warn('orphan reconcile failed', { message: e && e.message }));
    startContainerNetworkWatch(ctx, state);
    if (ctx.autoPullImage) {
        startWebImagePrepare(ctx, state);
    }

    return {
        server,
        wsServer,
        host: ctx.serverHost,
        port: listenPort,
        close: () => new Promise(resolve => {
            ctx.logger.info('web server closing');
            flushWebSessionHistories();
            state.authStore.close();
            state.orphanTimers.forEach(timer => clearInterval(timer));
            state.orphanTimers.clear();
            if (state.networkWatch) {
                state.networkWatch.stop();
                state.networkWatch = null;
            }
            if (state.portForwarder) state.portForwarder.closeAll();
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
    startWebServer,
    buildEnvModelOptions,
    // 仅供测试：直接驱动历史读写层
    __testing: {
        prepareStructuredTraceEvents,
        buildClaudeAgentExecCommand,
        buildWebAgentExecCommand,
        buildContainerFileListCommand,
        extractContentDeltaFromPayload,
        extractAgentMessageFromStructuredOutput,
        appendWebSessionMessage,
        appendWebSessionControlEvent,
        removeWebSessionMessage,
        loadWebSessionHistory,
        saveWebSessionHistory,
        cloneWebAgentSessionsDeep
    }
};
