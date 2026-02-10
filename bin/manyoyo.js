#!/usr/bin/env node

// ==============================================================================
// manyoyo - AI Agent CLI Sandbox - xcanwin
// ==============================================================================

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const readline = require('readline');
const { Command } = require('commander');
const JSON5 = require('json5');
const { startWebServer } = require('../lib/web/server');
const { version: BIN_VERSION, imageVersion: IMAGE_VERSION_BASE } = require('../package.json');

// Helper function to format date like bash $(date +%m%d-%H%M)
function formatDate() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    return `${month}${day}-${hour}${minute}`;
}

function detectCommandName() {
    const rawArgv1 = process.argv[1] || '';
    const baseName = path.basename(rawArgv1).replace(/\.(cjs|mjs|js)$/i, '');

    if (baseName === 'docker-manyoyo') {
        const pluginCommand = String(process.argv[2] || '').trim();
        return pluginCommand || 'manyoyo';
    }

    return baseName || 'manyoyo';
}

// ==============================================================================
// Configuration Constants
// ==============================================================================

const CONFIG = {
    CACHE_TTL_DAYS: 2,                    // 缓存过期天数
    CONTAINER_READY_MAX_RETRIES: 30,      // 容器就绪最大重试次数
    CONTAINER_READY_INITIAL_DELAY: 100,   // 容器就绪初始延迟(ms)
    CONTAINER_READY_MAX_DELAY: 2000,      // 容器就绪最大延迟(ms)
};

// Default configuration
let CONTAINER_NAME = `my-${formatDate()}`;
let HOST_PATH = process.cwd();
let CONTAINER_PATH = HOST_PATH;
let IMAGE_NAME = "localhost/xcanwin/manyoyo";
let IMAGE_VERSION = `${IMAGE_VERSION_BASE}-full`;
let EXEC_COMMAND = "";
let EXEC_COMMAND_PREFIX = "";
let EXEC_COMMAND_SUFFIX = "";
let ENV_FILE = "";
let SHOULD_REMOVE = false;
let IMAGE_BUILD_NEED = false;
let IMAGE_BUILD_ARGS = [];
let CONTAINER_ENVS = [];
let CONTAINER_VOLUMES = [];
let MANYOYO_NAME = detectCommandName();
let CONT_MODE = "";
let CONT_MODE_ARGS = [];
let QUIET = {};
let SHOW_COMMAND = false;
let YES_MODE = false;
let RM_ON_EXIT = false;
let SERVER_MODE = false;
let SERVER_HOST = '127.0.0.1';
let SERVER_PORT = 3000;
let SERVER_AUTH_USER = "";
let SERVER_AUTH_PASS = "";
let SERVER_AUTH_PASS_AUTO = false;
const SAFE_CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// Color definitions using ANSI codes
const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const CYAN = '\x1b[0;36m';
const NC = '\x1b[0m'; // No Color

// Docker command (will be set by ensure_docker)
let DOCKER_CMD = 'docker';
const SUPPORTED_INIT_AGENTS = ['claude', 'codex', 'gemini', 'opencode'];

// ==============================================================================
// SECTION: Utility Functions
// ==============================================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeCommandSuffix(suffix) {
    if (typeof suffix !== 'string') return "";
    const trimmed = suffix.trim();
    return trimmed ? ` ${trimmed}` : "";
}

function resolveContainerNameTemplate(name) {
    if (typeof name !== 'string') {
        return name;
    }
    const nowValue = formatDate();
    return name.replace(/\{now\}|\$\{now\}/g, nowValue);
}

function validateServerHost(host, rawServer) {
    const value = String(host || '').trim();
    const isIp = net.isIP(value) !== 0;
    const isHostName = /^[A-Za-z0-9.-]+$/.test(value);

    if (isIp || isHostName) {
        return value;
    }

    console.error(`${RED}⚠️  错误: --server 地址格式应为 端口 或 host:port (例如 3000 / 0.0.0.0:3000): ${rawServer}${NC}`);
    process.exit(1);
}

function parseServerListen(rawServer) {
    if (rawServer === true || rawServer === undefined || rawServer === null || rawServer === '') {
        return { host: '127.0.0.1', port: 3000 };
    }

    const value = String(rawServer).trim();
    if (!value) {
        return { host: '127.0.0.1', port: 3000 };
    }

    let host = '127.0.0.1';
    let portText = value;

    const ipv6Match = value.match(/^\[([^\]]+)\]:(\d+)$/);
    if (ipv6Match) {
        host = ipv6Match[1].trim();
        portText = ipv6Match[2].trim();
    } else {
        const lastColonIndex = value.lastIndexOf(':');
        if (lastColonIndex > 0) {
            const maybePort = value.slice(lastColonIndex + 1).trim();
            if (/^\d+$/.test(maybePort)) {
                host = value.slice(0, lastColonIndex).trim();
                portText = maybePort;
            }
        }
    }

    if (!/^\d+$/.test(portText)) {
        console.error(`${RED}⚠️  错误: --server 端口必须是 1-65535 的整数: ${rawServer}${NC}`);
        process.exit(1);
    }

    const port = Number(portText);
    if (port < 1 || port > 65535) {
        console.error(`${RED}⚠️  错误: --server 端口超出范围 (1-65535): ${rawServer}${NC}`);
        process.exit(1);
    }

    return {
        host: validateServerHost(host, rawServer),
        port
    };
}

function ensureWebServerAuthCredentials() {
    if (!SERVER_AUTH_USER) {
        SERVER_AUTH_USER = 'admin';
    }

    if (!SERVER_AUTH_PASS) {
        SERVER_AUTH_PASS = crypto.randomBytes(12).toString('hex');
        SERVER_AUTH_PASS_AUTO = true;
    }
}

/**
 * 计算文件的 SHA256 哈希值（跨平台）
 * @param {string} filePath - 文件路径
 * @returns {string} SHA256 哈希值（十六进制）
 */
function getFileSha256(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
}

/**
 * 敏感信息脱敏（用于 --show-config 输出）
 * @param {Object} obj - 配置对象
 * @returns {Object} 脱敏后的配置对象
 */
function sanitizeSensitiveData(obj) {
    const sensitiveKeys = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASS', 'AUTH', 'CREDENTIAL'];

    function sanitizeValue(key, value) {
        if (typeof value !== 'string') return value;
        const upperKey = key.toUpperCase();
        if (sensitiveKeys.some(k => upperKey.includes(k))) {
            if (value.length <= 8) return '****';
            return value.slice(0, 4) + '****' + value.slice(-4);
        }
        return value;
    }

    function sanitizeArray(arr) {
        return arr.map(item => {
            if (typeof item === 'string' && item.includes('=')) {
                const idx = item.indexOf('=');
                const key = item.slice(0, idx);
                const value = item.slice(idx + 1);
                return `${key}=${sanitizeValue(key, value)}`;
            }
            return item;
        });
    }

    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (Array.isArray(value)) {
            result[key] = sanitizeArray(value);
        } else if (typeof value === 'object' && value !== null) {
            result[key] = sanitizeSensitiveData(value);
        } else {
            result[key] = sanitizeValue(key, value);
        }
    }
    return result;
}

// ==============================================================================
// SECTION: Configuration Management
// ==============================================================================

/**
 * @typedef {Object} Config
 * @property {string} [containerName] - 容器名称
 * @property {string} [hostPath] - 宿主机路径
 * @property {string} [containerPath] - 容器路径
 * @property {string} [imageName] - 镜像名称
 * @property {string} [imageVersion] - 镜像版本
 * @property {Object.<string, string|number|boolean>} [env] - 环境变量映射
 * @property {string[]} [envFile] - 环境文件数组
 * @property {string[]} [volumes] - 挂载卷数组
 * @property {Object.<string, Object>} [runs] - 运行配置映射（-r <name>）
 * @property {string} [yolo] - YOLO 模式
 * @property {string} [containerMode] - 容器模式
 * @property {number} [cacheTTL] - 缓存过期天数
 * @property {string} [nodeMirror] - Node.js 镜像源
 */

/**
 * 加载全局配置文件
 * @returns {Config} 配置对象
 */
function loadConfig() {
    const configPath = path.join(os.homedir(), '.manyoyo', 'manyoyo.json');
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON5.parse(fs.readFileSync(configPath, 'utf-8'));
            return config;
        } catch (e) {
            console.error(`${YELLOW}⚠️  配置文件格式错误: ${configPath}${NC}`);
            return {};
        }
    }
    return {};
}

function loadRunConfig(name, config) {
    const runName = String(name || '').trim();
    if (!runName) {
        console.error(`${RED}⚠️  错误: --run 不能为空${NC}`);
        process.exit(1);
    }
    if (runName.includes('/') || runName.includes('\\')) {
        console.error(`${RED}⚠️  错误: --run 仅支持 runs 配置名: ${name}${NC}`);
        process.exit(1);
    }

    const runs = config && config.runs;
    if (runs !== undefined && (typeof runs !== 'object' || runs === null || Array.isArray(runs))) {
        console.error(`${RED}⚠️  错误: ~/.manyoyo/manyoyo.json 的 runs 必须是对象(map)${NC}`);
        process.exit(1);
    }

    const runConfig = runs && Object.prototype.hasOwnProperty.call(runs, runName) ? runs[runName] : undefined;
    if (!runConfig || typeof runConfig !== 'object' || Array.isArray(runConfig)) {
        console.error(`${RED}⚠️  未找到运行配置: runs.${runName}${NC}`);
        process.exit(1);
    }

    return runConfig;
}

function readJsonFileSafely(filePath, label) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        console.log(`${YELLOW}⚠️  ${label} 解析失败: ${filePath}${NC}`);
        return null;
    }
}

function parseSimpleToml(content) {
    const result = {};
    let current = result;
    const lines = String(content || '').split('\n');

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const sectionMatch = line.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
            const parts = sectionMatch[1].split('.').map(p => p.trim()).filter(Boolean);
            current = result;
            for (const part of parts) {
                if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
                    current[part] = {};
                }
                current = current[part];
            }
            continue;
        }

        const keyValueMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
        if (!keyValueMatch) {
            continue;
        }

        const key = keyValueMatch[1];
        let valueText = keyValueMatch[2].trim();
        if ((valueText.startsWith('"') && valueText.endsWith('"')) || (valueText.startsWith("'") && valueText.endsWith("'"))) {
            valueText = valueText.slice(1, -1);
        } else if (valueText === 'true') {
            valueText = true;
        } else if (valueText === 'false') {
            valueText = false;
        } else if (/^-?\d+(\.\d+)?$/.test(valueText)) {
            valueText = Number(valueText);
        }

        current[key] = valueText;
    }

    return result;
}

function readTomlFileSafely(filePath, label) {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return parseSimpleToml(content);
    } catch (e) {
        console.log(`${YELLOW}⚠️  ${label} 解析失败: ${filePath}${NC}`);
        return null;
    }
}

function normalizeInitConfigAgents(rawAgents) {
    const aliasMap = {
        all: 'all',
        claude: 'claude',
        c: 'claude',
        cc: 'claude',
        codex: 'codex',
        cx: 'codex',
        gemini: 'gemini',
        gm: 'gemini',
        g: 'gemini',
        opencode: 'opencode',
        oc: 'opencode'
    };

    if (rawAgents === true || rawAgents === undefined || rawAgents === null || rawAgents === '') {
        return [...SUPPORTED_INIT_AGENTS];
    }

    const tokens = String(rawAgents).split(/[,\s]+/).map(v => v.trim().toLowerCase()).filter(Boolean);
    if (tokens.length === 0) {
        return [...SUPPORTED_INIT_AGENTS];
    }

    const normalized = [];
    for (const token of tokens) {
        const mapped = aliasMap[token];
        if (!mapped) {
            console.error(`${RED}⚠️  错误: --init-config 不支持的 Agent: ${token}${NC}`);
            console.error(`${YELLOW}支持: ${SUPPORTED_INIT_AGENTS.join(', ')} 或 all${NC}`);
            process.exit(1);
        }
        if (mapped === 'all') {
            return [...SUPPORTED_INIT_AGENTS];
        }
        if (!normalized.includes(mapped)) {
            normalized.push(mapped);
        }
    }
    return normalized;
}

function isSafeInitEnvValue(value) {
    if (value === undefined || value === null) {
        return false;
    }
    const text = String(value).replace(/[\r\n\0]/g, '').trim();
    if (!text) {
        return false;
    }
    if (/[\$\(\)\`\|\&\*\{\};<>]/.test(text)) {
        return false;
    }
    if (/^\(/.test(text)) {
        return false;
    }
    return true;
}

function setInitValue(values, key, value) {
    if (value === undefined || value === null) {
        return;
    }
    const text = String(value).replace(/[\r\n\0]/g, '').trim();
    if (!text) {
        return;
    }
    values[key] = text;
}

function dedupeList(list) {
    return Array.from(new Set((list || []).filter(Boolean)));
}

function resolveEnvPlaceholder(value) {
    if (typeof value !== 'string') {
        return "";
    }
    const match = value.match(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/);
    if (!match) {
        return "";
    }
    const envName = match[1];
    return process.env[envName] ? String(process.env[envName]).trim() : "";
}

function collectClaudeInitData(homeDir) {
    const keys = [
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'CLAUDE_CODE_SUBAGENT_MODEL'
    ];
    const values = {};
    const notes = [];
    const volumes = [];

    const claudeDir = path.join(homeDir, '.claude');
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');
    const settingsJson = readJsonFileSafely(claudeSettingsPath, 'Claude settings');

    keys.forEach(key => setInitValue(values, key, process.env[key]));

    if (settingsJson && settingsJson.env && typeof settingsJson.env === 'object') {
        keys.forEach(key => setInitValue(values, key, settingsJson.env[key]));
    }

    return { keys, values, notes, volumes: dedupeList(volumes) };
}

function collectGeminiInitData(homeDir) {
    const keys = [
        'GOOGLE_GEMINI_BASE_URL',
        'GEMINI_API_KEY',
        'GEMINI_MODEL'
    ];
    const values = {};
    const notes = [];
    const volumes = [];
    const geminiDir = path.join(homeDir, '.gemini');

    keys.forEach(key => setInitValue(values, key, process.env[key]));

    if (fs.existsSync(geminiDir)) {
        volumes.push(`${geminiDir}:/root/.gemini`);
    } else {
        notes.push('未检测到 Gemini 本地配置目录（~/.gemini），已生成占位模板。');
    }

    return { keys, values, notes, volumes: dedupeList(volumes) };
}

function collectCodexInitData(homeDir) {
    const keys = [
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
        'OPENAI_MODEL'
    ];
    const values = {};
    const notes = [];
    const volumes = [];

    const codexDir = path.join(homeDir, '.codex');
    const authPath = path.join(codexDir, 'auth.json');
    const configPath = path.join(codexDir, 'config.toml');
    const authJson = readJsonFileSafely(authPath, 'Codex auth');
    const configToml = readTomlFileSafely(configPath, 'Codex TOML');

    keys.forEach(key => setInitValue(values, key, process.env[key]));

    if (authJson && typeof authJson === 'object') {
        setInitValue(values, 'OPENAI_API_KEY', authJson.OPENAI_API_KEY);
    }

    if (configToml && typeof configToml === 'object') {
        setInitValue(values, 'OPENAI_MODEL', configToml.model);

        let providerConfig = null;
        const providers = configToml.model_providers;
        if (providers && typeof providers === 'object') {
            if (typeof configToml.model_provider === 'string' && providers[configToml.model_provider]) {
                providerConfig = providers[configToml.model_provider];
            } else {
                const firstProviderName = Object.keys(providers)[0];
                if (firstProviderName) {
                    providerConfig = providers[firstProviderName];
                }
            }
        }
        if (providerConfig && typeof providerConfig === 'object') {
            setInitValue(values, 'OPENAI_BASE_URL', providerConfig.base_url);
        }
    }

    if (fs.existsSync(codexDir)) {
        volumes.push(`${codexDir}:/root/.codex`);
    } else {
        notes.push('未检测到 Codex 本地配置目录（~/.codex），已生成占位模板。');
    }

    return { keys, values, notes, volumes: dedupeList(volumes) };
}

function collectOpenCodeInitData(homeDir) {
    const keys = [
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
        'OPENAI_MODEL'
    ];
    const values = {};
    const notes = [];
    const volumes = [];

    const opencodeDir = path.join(homeDir, '.config', 'opencode');
    const opencodePath = path.join(opencodeDir, 'opencode.json');
    const opencodeAuthPath = path.join(homeDir, '.local', 'share', 'opencode', 'auth.json');
    const opencodeJson = readJsonFileSafely(opencodePath, 'OpenCode config');

    keys.forEach(key => setInitValue(values, key, process.env[key]));

    if (opencodeJson && typeof opencodeJson === 'object') {
        const providers = opencodeJson.provider && typeof opencodeJson.provider === 'object'
            ? Object.values(opencodeJson.provider).filter(v => v && typeof v === 'object')
            : [];
        const provider = providers[0];

        if (provider) {
            const options = provider.options && typeof provider.options === 'object' ? provider.options : {};
            const apiKeyValue = resolveEnvPlaceholder(options.apiKey) || options.apiKey;
            const baseUrlValue = resolveEnvPlaceholder(options.baseURL) || options.baseURL;
            setInitValue(values, 'OPENAI_API_KEY', apiKeyValue);
            setInitValue(values, 'OPENAI_BASE_URL', baseUrlValue);

            if (provider.models && typeof provider.models === 'object') {
                const firstModelName = Object.keys(provider.models)[0];
                if (firstModelName) {
                    setInitValue(values, 'OPENAI_MODEL', firstModelName);
                }
            }
        }

        if (typeof opencodeJson.model === 'string') {
            const modelFromEnv = resolveEnvPlaceholder(opencodeJson.model);
            if (modelFromEnv) {
                setInitValue(values, 'OPENAI_MODEL', modelFromEnv);
            }
        }
    }

    if (fs.existsSync(opencodePath)) {
        volumes.push(`${opencodePath}:/root/.config/opencode/opencode.json`);
    } else {
        notes.push('未检测到 OpenCode 配置文件（~/.config/opencode/opencode.json），已生成占位模板。');
    }
    if (fs.existsSync(opencodeAuthPath)) {
        volumes.push(`${opencodeAuthPath}:/root/.local/share/opencode/auth.json`);
    }

    return { keys, values, notes, volumes: dedupeList(volumes) };
}

function buildInitRunEnv(keys, values) {
    const envMap = {};
    const missingKeys = [];
    const unsafeKeys = [];

    for (const key of keys) {
        const value = values[key];
        if (isSafeInitEnvValue(value)) {
            envMap[key] = String(value).replace(/[\r\n\0]/g, '');
        } else if (value !== undefined && value !== null && String(value).trim() !== '') {
            envMap[key] = "";
            unsafeKeys.push(key);
        } else {
            envMap[key] = "";
            missingKeys.push(key);
        }
    }
    return { envMap, missingKeys, unsafeKeys };
}

function buildInitRunProfile(agent, yolo, volumes, keys, values) {
    const envBuildResult = buildInitRunEnv(keys, values);
    const runProfile = {
        containerName: `my-${agent}-{now}`,
        env: envBuildResult.envMap,
        yolo
    };
    const volumeList = dedupeList(volumes);
    if (volumeList.length > 0) {
        runProfile.volumes = volumeList;
    }
    return {
        runProfile,
        missingKeys: envBuildResult.missingKeys,
        unsafeKeys: envBuildResult.unsafeKeys
    };
}

async function shouldOverwriteInitRunEntry(runName, exists) {
    if (!exists) {
        return true;
    }

    if (YES_MODE) {
        console.log(`${YELLOW}⚠️  runs.${runName} 已存在，--yes 模式自动覆盖${NC}`);
        return true;
    }

    const reply = await askQuestion(`❔ runs.${runName} 已存在，是否覆盖? [y/N]: `);
    const firstChar = String(reply || '').trim().toLowerCase()[0];
    if (firstChar === 'y') {
        return true;
    }
    console.log(`${YELLOW}⏭️  已保留原配置: runs.${runName}${NC}`);
    return false;
}

async function initAgentConfigs(rawAgents) {
    const agents = normalizeInitConfigAgents(rawAgents);
    const homeDir = os.homedir();
    const manyoyoHome = path.join(homeDir, '.manyoyo');
    const manyoyoConfigPath = path.join(manyoyoHome, 'manyoyo.json');

    fs.mkdirSync(manyoyoHome, { recursive: true });

    const manyoyoConfig = loadConfig();
    let runsMap = {};
    if (manyoyoConfig.runs !== undefined) {
        if (typeof manyoyoConfig.runs !== 'object' || manyoyoConfig.runs === null || Array.isArray(manyoyoConfig.runs)) {
            console.error(`${RED}⚠️  错误: ~/.manyoyo/manyoyo.json 的 runs 必须是对象(map)${NC}`);
            process.exit(1);
        }
        runsMap = { ...manyoyoConfig.runs };
    }
    let hasConfigChanged = false;

    const extractors = {
        claude: collectClaudeInitData,
        codex: collectCodexInitData,
        gemini: collectGeminiInitData,
        opencode: collectOpenCodeInitData
    };
    const yoloMap = {
        claude: 'c',
        codex: 'cx',
        gemini: 'gm',
        opencode: 'oc'
    };

    console.log(`${CYAN}🧭 正在初始化 MANYOYO 配置: ${agents.join(', ')}${NC}`);

    for (const agent of agents) {
        const data = extractors[agent](homeDir);
        const shouldWriteRun = await shouldOverwriteInitRunEntry(
            agent,
            Object.prototype.hasOwnProperty.call(runsMap, agent)
        );

        let writeResult = { missingKeys: [], unsafeKeys: [] };
        if (shouldWriteRun) {
            const buildResult = buildInitRunProfile(agent, yoloMap[agent], data.volumes, data.keys, data.values);
            runsMap[agent] = buildResult.runProfile;
            writeResult = {
                missingKeys: buildResult.missingKeys,
                unsafeKeys: buildResult.unsafeKeys
            };
            hasConfigChanged = true;
        }

        if (shouldWriteRun) {
            console.log(`${GREEN}✅ [${agent}] 初始化完成${NC}`);
        } else {
            console.log(`${YELLOW}⚠️  [${agent}] 已跳过（配置保留）${NC}`);
        }
        console.log(`   run: ${shouldWriteRun ? '已写入' : '保留'} runs.${agent}`);

        if (shouldWriteRun && writeResult.missingKeys.length > 0) {
            console.log(`${YELLOW}⚠️  [${agent}] 以下变量未找到，请手动填写:${NC} ${writeResult.missingKeys.join(', ')}`);
        }
        if (shouldWriteRun && writeResult.unsafeKeys.length > 0) {
            console.log(`${YELLOW}⚠️  [${agent}] 以下变量包含不安全字符，已留空 env 键:${NC} ${writeResult.unsafeKeys.join(', ')}`);
        }
        if (data.notes && data.notes.length > 0) {
            data.notes.forEach(note => console.log(`${YELLOW}⚠️  [${agent}] ${note}${NC}`));
        }
    }

    if (hasConfigChanged || !fs.existsSync(manyoyoConfigPath)) {
        manyoyoConfig.runs = runsMap;
        fs.writeFileSync(manyoyoConfigPath, `${JSON.stringify(manyoyoConfig, null, 4)}\n`);
    }
}

// ==============================================================================
// SECTION: UI Functions
// ==============================================================================

function getHelloTip(containerName, defaultCommand) {
    if ( !(QUIET.tip || QUIET.full) ) {
        console.log("");
        console.log(`${BLUE}----------------------------------------${NC}`);
        console.log(`📦 首次命令        : ${defaultCommand}`);
        console.log(`⚫ 恢复首次命令会话: ${CYAN}${MANYOYO_NAME} -n ${containerName} -- -c${NC}`);
        console.log(`⚫ 执行首次命令    : ${GREEN}${MANYOYO_NAME} -n ${containerName}${NC}`);
        console.log(`⚫ 执行指定命令    : ${GREEN}${MANYOYO_NAME} -n ${containerName} -x /bin/bash${NC}`);
        console.log(`⚫ 执行指定命令    : ${GREEN}docker exec -it ${containerName} /bin/bash${NC}`);
        console.log(`⚫ 删除容器        : ${MANYOYO_NAME} -n ${containerName} --crm`);
        console.log("");
    }
}

function setQuiet(actions) {
    // Support both string and array input
    const actionArray = Array.isArray(actions) ? actions : [actions];
    actionArray.forEach(action => {
        // Remove comma splitting - each action should be a single quiet option
        const ac = action.trim();
        switch (ac) {
            case 'cnew':
                QUIET.cnew = 1;
                break;
            case 'crm':
                QUIET.crm = 1;
                break;
            case 'tip':
                QUIET.tip = 1;
                break;
            case 'askkeep':
                QUIET.askkeep = 1;
                break;
            case 'cmd':
                QUIET.cmd = 1;
                break;
            case 'full':
                QUIET.full = 1;
                break;
        }
    });
}

function validateName(label, value, pattern) {
    if (!value) return;
    if (!pattern.test(value)) {
        console.error(`${RED}⚠️  错误: ${label} 非法: ${value}${NC}`);
        process.exit(1);
    }
}

function isValidContainerName(value) {
    return typeof value === 'string' && SAFE_CONTAINER_NAME_PATTERN.test(value);
}

// ==============================================================================
// SECTION: Environment Variables and Volume Handling
// ==============================================================================

async function askQuestion(prompt) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

// ==============================================================================
// Configuration Functions
// ==============================================================================

/**
 * 添加环境变量
 * @param {string} env - 环境变量字符串 (KEY=VALUE)
 */
function parseEnvEntry(env) {
    const envText = String(env);
    const idx = envText.indexOf('=');
    if (idx <= 0) {
        console.error(`${RED}⚠️  错误: env 格式应为 KEY=VALUE: ${envText}${NC}`);
        process.exit(1);
    }
    const key = envText.slice(0, idx);
    const value = envText.slice(idx + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        console.error(`${RED}⚠️  错误: env key 非法: ${key}${NC}`);
        process.exit(1);
    }
    if (/[\r\n\0]/.test(value) || /[;&|`$<>]/.test(value)) {
        console.error(`${RED}⚠️  错误: env value 含非法字符: ${key}${NC}`);
        process.exit(1);
    }
    return { key, value };
}

function normalizeJsonEnvMap(envConfig, sourceLabel) {
    if (envConfig === undefined || envConfig === null) {
        return {};
    }

    if (typeof envConfig !== 'object' || Array.isArray(envConfig)) {
        console.error(`${RED}⚠️  错误: ${sourceLabel} 的 env 必须是对象(map)，例如 {"KEY":"VALUE"}${NC}`);
        process.exit(1);
    }

    const envMap = {};
    for (const [key, rawValue] of Object.entries(envConfig)) {
        if (rawValue !== null && !['string', 'number', 'boolean'].includes(typeof rawValue)) {
            console.error(`${RED}⚠️  错误: ${sourceLabel} 的 env.${key} 必须是 string/number/boolean/null${NC}`);
            process.exit(1);
        }
        const value = rawValue === null ? '' : String(rawValue);
        const parsed = parseEnvEntry(`${key}=${value}`);
        envMap[parsed.key] = parsed.value;
    }
    return envMap;
}

function normalizeCliEnvMap(envList) {
    const envMap = {};
    for (const envText of (envList || [])) {
        const parsed = parseEnvEntry(envText);
        envMap[parsed.key] = parsed.value;
    }
    return envMap;
}

function addEnv(env) {
    const parsed = parseEnvEntry(env);
    CONTAINER_ENVS.push("--env", `${parsed.key}=${parsed.value}`);
}

function addEnvFile(envFile) {
    const filePath = String(envFile || '').trim();
    if (!path.isAbsolute(filePath)) {
        console.error(`${RED}⚠️  错误: --env-file 仅支持绝对路径: ${envFile}${NC}`);
        process.exit(1);
    }

    ENV_FILE = filePath;
    if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let line of lines) {
            // Match pattern: (export )?(KEY)=(VALUE)
            const match = line.match(/^(?:export\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/);
            if (match) {
                let key = match[1];
                let value = match[2].trim();

                // Filter malicious characters
                if (/[\r\n\0]/.test(value)) continue;
                if (/[\$\(\)\`\|\&\*\{\};<>]/.test(value)) continue;
                if (/^\(/.test(value)) continue;

                // Remove quotes
                if (/^"(.*)"$/.test(value)) {
                    value = value.slice(1, -1);
                } else if (/^'(.*)'$/.test(value)) {
                    value = value.slice(1, -1);
                }

                if (key) {
                    CONTAINER_ENVS.push("--env", `${key}=${value}`);
                }
            }
        }
        return {};
    }
    console.error(`${RED}⚠️  未找到环境文件: ${envFile}${NC}`);
    return {};
}

function addVolume(volume) {
    CONTAINER_VOLUMES.push("--volume", volume);
}

// ==============================================================================
// SECTION: YOLO Mode and Container Mode Configuration
// ==============================================================================

function setYolo(cli) {
    switch (cli) {
        case 'claude':
        case 'cc':
        case 'c':
            EXEC_COMMAND = "IS_SANDBOX=1 claude --dangerously-skip-permissions";
            break;
        case 'gemini':
        case 'gm':
        case 'g':
            EXEC_COMMAND = "gemini --yolo";
            break;
        case 'codex':
        case 'cx':
            EXEC_COMMAND = "codex --dangerously-bypass-approvals-and-sandbox";
            break;
        case 'opencode':
        case 'oc':
            EXEC_COMMAND = "OPENCODE_PERMISSION='{\"*\":\"allow\"}' opencode";
            break;
        default:
            console.log(`${RED}⚠️  未知LLM CLI: ${cli}${NC}`);
            process.exit(0);
    }
}

/**
 * 设置容器嵌套模式
 * @param {string} mode - 模式名称 (common, dind, sock)
 */
function setContMode(mode) {
    switch (mode) {
        case 'common':
            CONT_MODE = "";
            CONT_MODE_ARGS = [];
            break;
        case 'docker-in-docker':
        case 'dind':
        case 'd':
            CONT_MODE = "--privileged";
            CONT_MODE_ARGS = ['--privileged'];
            console.log(`${GREEN}✅ 开启安全的容器嵌套容器模式, 手动在容器内启动服务: nohup dockerd &${NC}`);
            break;
        case 'mount-docker-socket':
        case 'sock':
        case 's':
            CONT_MODE = "--privileged --volume /var/run/docker.sock:/var/run/docker.sock --env DOCKER_HOST=unix:///var/run/docker.sock --env CONTAINER_HOST=unix:///var/run/docker.sock";
            CONT_MODE_ARGS = [
                '--privileged',
                '--volume', '/var/run/docker.sock:/var/run/docker.sock',
                '--env', 'DOCKER_HOST=unix:///var/run/docker.sock',
                '--env', 'CONTAINER_HOST=unix:///var/run/docker.sock'
            ];
            console.log(`${RED}⚠️  开启危险的容器嵌套容器模式, 危害: 容器可访问宿主机文件${NC}`);
            break;
        default:
            console.log(`${RED}⚠️  未知模式: ${mode}${NC}`);
            process.exit(0);
    }
}

// ==============================================================================
// Docker Helper Functions
// ==============================================================================

function dockerExec(cmd, options = {}) {
    try {
        return execSync(cmd, { encoding: 'utf-8', ...options });
    } catch (e) {
        if (options.ignoreError) {
            return e.stdout || '';
        }
        throw e;
    }
}

function showImagePullHint(err) {
    const stderr = err && err.stderr ? err.stderr.toString() : '';
    const stdout = err && err.stdout ? err.stdout.toString() : '';
    const message = err && err.message ? err.message : '';
    const combined = `${message}\n${stderr}\n${stdout}`;
    if (!/localhost\/v2|pinging container registry localhost|connection refused|dial tcp .*:443/i.test(combined)) {
        return;
    }
    const image = `${IMAGE_NAME}:${IMAGE_VERSION}`;
    console.log(`${YELLOW}💡 提示: 本地未找到镜像 ${image}，并且从 localhost 注册表拉取失败。${NC}`);
    console.log(`${YELLOW}   你可以: (1) 更新 ~/.manyoyo/manyoyo.json 的 imageVersion。 (2) 或先执行 ${MANYOYO_NAME} --ib --iv <version> 构建镜像。${NC}`);
}

function runCmd(cmd, args, options = {}) {
    const result = spawnSync(cmd, args, { encoding: 'utf-8', ...options });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        if (options.ignoreError) {
            return result.stdout || '';
        }
        const err = new Error(`Command failed: ${cmd} ${args.join(' ')}`);
        err.stdout = result.stdout;
        err.stderr = result.stderr;
        err.status = result.status;
        throw err;
    }
    return result.stdout || '';
}

function dockerExecArgs(args, options = {}) {
    return runCmd(DOCKER_CMD, args, options);
}

function containerExists(name) {
    const containers = dockerExecArgs(['ps', '-a', '--format', '{{.Names}}']);
    return containers.split('\n').some(n => n.trim() === name);
}

function getContainerStatus(name) {
    return dockerExecArgs(['inspect', '-f', '{{.State.Status}}', name]).trim();
}

function removeContainer(name) {
    if ( !(QUIET.crm || QUIET.full) ) console.log(`${YELLOW}🗑️ 正在删除容器: ${name}...${NC}`);
    dockerExecArgs(['rm', '-f', name], { stdio: 'pipe' });
    if ( !(QUIET.crm || QUIET.full) ) console.log(`${GREEN}✅ 已彻底删除。${NC}`);
}

// ==============================================================================
// SECTION: Docker Operations
// ==============================================================================

function ensureDocker() {
    const commands = ['docker', 'podman'];
    for (const cmd of commands) {
        try {
            runCmd(cmd, ['--version'], { stdio: 'pipe' });
            DOCKER_CMD = cmd;
            return true;
        } catch (e) {
            // Try next command
        }
    }
    console.error("docker/podman not found");
    process.exit(1);
}

function installManyoyo(name) {
    const MANYOYO_FILE = fs.realpathSync(__filename);
    switch (name) {
        case 'docker-cli-plugin':
            const pluginDir = path.join(process.env.HOME, '.docker/cli-plugins');
            fs.mkdirSync(pluginDir, { recursive: true });
            const targetPath = path.join(pluginDir, 'docker-manyoyo');
            if (fs.existsSync(targetPath)) {
                fs.unlinkSync(targetPath);
            }
            fs.symlinkSync(MANYOYO_FILE, targetPath);
            break;
        default:
            console.log("");
    }
    process.exit(0);
}

function getContList() {
    try {
        const result = execSync(`${DOCKER_CMD} ps -a --size --filter "ancestor=manyoyo" --filter "ancestor=$(${DOCKER_CMD} images -a --format '{{.Repository}}:{{.Tag}}' | grep manyoyo)" --format "table {{.Names}}\\t{{.Status}}\\t{{.Size}}\\t{{.ID}}\\t{{.Image}}\\t{{.Ports}}\\t{{.Networks}}\\t{{.Mounts}}"`,
            { encoding: 'utf-8' });
        console.log(result);
    } catch (e) {
        console.log(e.stdout || '');
    }
}

function pruneDanglingImages() {
    console.log(`\n${YELLOW}清理悬空镜像...${NC}`);
    dockerExecArgs(['image', 'prune', '-f'], { stdio: 'inherit' });

    // Remove remaining <none> images
    try {
        const imagesOutput = dockerExecArgs(['images', '-a', '--format', '{{.ID}} {{.Repository}}']);
        const noneImages = imagesOutput
            .split('\n')
            .filter(line => line.includes('<none>'))
            .map(line => line.split(' ')[0])
            .filter(id => id);

        if (noneImages.length > 0) {
            console.log(`${YELLOW}清理剩余的 <none> 镜像 (${noneImages.length} 个)...${NC}`);
            dockerExecArgs(['rmi', '-f', ...noneImages], { stdio: 'inherit' });
        }
    } catch (e) {
        // Ignore errors if no <none> images found
    }

    console.log(`${GREEN}✅ 清理完成${NC}`);
}

// ==============================================================================
// SECTION: Image Build System
// ==============================================================================

/**
 * 准备构建缓存（Node.js、JDT LSP、gopls）
 * @param {string} imageTool - 构建工具类型
 */
async function prepareBuildCache(imageTool) {
    const cacheDir = path.join(__dirname, '../docker/cache');
    const timestampFile = path.join(cacheDir, '.timestamps.json');

    // 从配置文件读取 TTL，默认 2 天
    const config = loadConfig();
    const cacheTTLDays = config.cacheTTL || CONFIG.CACHE_TTL_DAYS;

    // 镜像源优先级：用户配置 > 腾讯云 > 官方
    const nodeMirrors = [
        config.nodeMirror,
        'https://mirrors.tencent.com/nodejs-release',
        'https://nodejs.org/dist'
    ].filter(Boolean);

    console.log(`\n${CYAN}准备构建缓存...${NC}`);

    // Create cache directory
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Load timestamps
    let timestamps = {};
    if (fs.existsSync(timestampFile)) {
        try {
            timestamps = JSON.parse(fs.readFileSync(timestampFile, 'utf-8'));
        } catch (e) {
            timestamps = {};
        }
    }

    const now = new Date();
    const isExpired = (key) => {
        if (!timestamps[key]) return true;
        const cachedTime = new Date(timestamps[key]);
        const diffDays = (now - cachedTime) / (1000 * 60 * 60 * 24);
        return diffDays > cacheTTLDays;
    };

    // Determine architecture
    const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
    const archNode = arch === 'amd64' ? 'x64' : 'arm64';

    // Prepare Node.js cache
    const nodeCacheDir = path.join(cacheDir, 'node');
    const nodeVersion = 24;
    const nodeKey = 'node/';  // 使用目录级别的相对路径

    if (!fs.existsSync(nodeCacheDir)) {
        fs.mkdirSync(nodeCacheDir, { recursive: true });
    }

    const hasNodeCache = fs.existsSync(nodeCacheDir) && fs.readdirSync(nodeCacheDir).some(f => f.startsWith('node-') && f.includes(`linux-${archNode}`));
    if (!hasNodeCache || isExpired(nodeKey)) {
        console.log(`${YELLOW}下载 Node.js ${nodeVersion} (${archNode})...${NC}`);

        // 尝试多个镜像源
        let downloadSuccess = false;
        for (const mirror of nodeMirrors) {
            try {
                console.log(`${BLUE}尝试镜像源: ${mirror}${NC}`);
                const shasumUrl = `${mirror}/latest-v${nodeVersion}.x/SHASUMS256.txt`;
                const shasumContent = execSync(`curl -sL ${shasumUrl}`, { encoding: 'utf-8' });
                const shasumLine = shasumContent.split('\n').find(line => line.includes(`linux-${archNode}.tar.gz`));
                if (!shasumLine) continue;

                const [expectedHash, fileName] = shasumLine.trim().split(/\s+/);
                const nodeUrl = `${mirror}/latest-v${nodeVersion}.x/${fileName}`;
                const nodeTargetPath = path.join(nodeCacheDir, fileName);

                // 下载文件
                runCmd('curl', ['-fsSL', nodeUrl, '-o', nodeTargetPath], { stdio: 'inherit' });

                // SHA256 校验（使用 Node.js crypto 模块，跨平台）
                const actualHash = getFileSha256(nodeTargetPath);
                if (actualHash !== expectedHash) {
                    console.log(`${RED}SHA256 校验失败，删除文件${NC}`);
                    fs.unlinkSync(nodeTargetPath);
                    continue;
                }

                console.log(`${GREEN}✓ SHA256 校验通过${NC}`);
                timestamps[nodeKey] = now.toISOString();
                fs.writeFileSync(timestampFile, JSON.stringify(timestamps, null, 4));
                console.log(`${GREEN}✓ Node.js 下载完成${NC}`);
                downloadSuccess = true;
                break;
            } catch (e) {
                console.log(`${YELLOW}镜像源 ${mirror} 失败，尝试下一个...${NC}`);
            }
        }

        if (!downloadSuccess) {
            console.error(`${RED}错误: Node.js 下载失败（所有镜像源均不可用）${NC}`);
            throw new Error('Node.js download failed');
        }
    } else {
        console.log(`${GREEN}✓ Node.js 缓存已存在${NC}`);
    }

    // Prepare JDT LSP cache (for java variant)
    if (imageTool === 'full' || imageTool.includes('java')) {
        const jdtlsCacheDir = path.join(cacheDir, 'jdtls');
        const jdtlsKey = 'jdtls/jdt-language-server-latest.tar.gz';  // 使用相对路径
        const jdtlsPath = path.join(cacheDir, jdtlsKey);

        if (!fs.existsSync(jdtlsCacheDir)) {
            fs.mkdirSync(jdtlsCacheDir, { recursive: true });
        }

        if (!fs.existsSync(jdtlsPath) || isExpired(jdtlsKey)) {
            console.log(`${YELLOW}下载 JDT Language Server...${NC}`);
            const apkUrl = 'https://mirrors.tencent.com/alpine/latest-stable/community/x86_64/jdtls-1.53.0-r0.apk';
            const tmpDir = path.join(jdtlsCacheDir, '.tmp-apk');
            const apkPath = path.join(tmpDir, 'jdtls.apk');
            try {
                fs.mkdirSync(tmpDir, { recursive: true });
                runCmd('curl', ['-fsSL', apkUrl, '-o', apkPath], { stdio: 'inherit' });
                runCmd('tar', ['-xzf', apkPath, '-C', tmpDir], { stdio: 'inherit' });
                const srcDir = path.join(tmpDir, 'usr', 'share', 'jdtls');
                runCmd('tar', ['-czf', jdtlsPath, '-C', srcDir, '.'], { stdio: 'inherit' });
                timestamps[jdtlsKey] = now.toISOString();
                fs.writeFileSync(timestampFile, JSON.stringify(timestamps, null, 4));
                console.log(`${GREEN}✓ JDT LSP 下载完成${NC}`);
            } catch (e) {
                console.error(`${RED}错误: JDT LSP 下载失败${NC}`);
                throw e;
            } finally {
                try { runCmd('rm', ['-rf', tmpDir], { stdio: 'inherit', ignoreError: true }); } catch {}
            }
        } else {
            console.log(`${GREEN}✓ JDT LSP 缓存已存在${NC}`);
        }
    }

    // Prepare gopls cache (for go variant)
    if (imageTool === 'full' || imageTool.includes('go')) {
        const goplsCacheDir = path.join(cacheDir, 'gopls');
        const goplsKey = `gopls/gopls-linux-${arch}`;  // 使用相对路径
        const goplsPath = path.join(cacheDir, goplsKey);

        if (!fs.existsSync(goplsCacheDir)) {
            fs.mkdirSync(goplsCacheDir, { recursive: true });
        }

        if (!fs.existsSync(goplsPath) || isExpired(goplsKey)) {
            console.log(`${YELLOW}下载 gopls (${arch})...${NC}`);
            try {
                // Download using go install in temporary environment
                const tmpGoPath = path.join(cacheDir, '.tmp-go');

                // Clean up existing temp directory (with go clean for mod cache)
                if (fs.existsSync(tmpGoPath)) {
                    try {
                        execSync(`GOPATH="${tmpGoPath}" go clean -modcache 2>/dev/null || true`, { stdio: 'inherit' });
                        execSync(`chmod -R u+w "${tmpGoPath}" 2>/dev/null || true`, { stdio: 'inherit' });
                        execSync(`rm -rf "${tmpGoPath}"`, { stdio: 'inherit' });
                    } catch (e) {
                        // Ignore cleanup errors
                    }
                }
                fs.mkdirSync(tmpGoPath, { recursive: true });

                runCmd('go', ['install', 'golang.org/x/tools/gopls@latest'], {
                    stdio: 'inherit',
                    env: { ...process.env, GOPATH: tmpGoPath, GOOS: 'linux', GOARCH: arch }
                });
                execSync(`cp "${tmpGoPath}/bin/linux_${arch}/gopls" "${goplsPath}" || cp "${tmpGoPath}/bin/gopls" "${goplsPath}"`, { stdio: 'inherit' });
                runCmd('chmod', ['+x', goplsPath], { stdio: 'inherit' });

                // Save timestamp immediately after successful download
                timestamps[goplsKey] = now.toISOString();
                fs.writeFileSync(timestampFile, JSON.stringify(timestamps, null, 4));
                console.log(`${GREEN}✓ gopls 下载完成${NC}`);

                // Clean up temp directory (with go clean for mod cache)
                try {
                    execSync(`GOPATH="${tmpGoPath}" go clean -modcache 2>/dev/null || true`, { stdio: 'inherit' });
                    execSync(`chmod -R u+w "${tmpGoPath}" 2>/dev/null || true`, { stdio: 'inherit' });
                    execSync(`rm -rf "${tmpGoPath}"`, { stdio: 'inherit' });
                } catch (e) {
                    console.log(`${YELLOW}提示: 临时目录清理失败，可手动删除 ${tmpGoPath}${NC}`);
                }
            } catch (e) {
                console.error(`${RED}错误: gopls 下载失败${NC}`);
                throw e;
            }
        } else {
            console.log(`${GREEN}✓ gopls 缓存已存在${NC}`);
        }
    }

    // Save timestamps
    fs.writeFileSync(timestampFile, JSON.stringify(timestamps, null, 4));
    console.log(`${GREEN}✅ 构建缓存准备完成${NC}\n`);
}

function addImageBuildArg(string) {
    IMAGE_BUILD_ARGS.push("--build-arg", string);
}

async function buildImage(IMAGE_BUILD_ARGS, imageName, imageVersion) {
    let imageTool = "full";
    if (IMAGE_BUILD_ARGS.length === 0) {
        IMAGE_BUILD_ARGS = ["--build-arg", `TOOL=${imageTool}`];
    } else {
        imageTool = IMAGE_BUILD_ARGS.filter(v => v.startsWith("TOOL=")).at(-1)?.slice("TOOL=".length) ?? imageTool;
    }
    // Use package.json imageVersion if not specified
    const version = imageVersion || IMAGE_VERSION_BASE;
    const fullImageTag = `${imageName}:${version}-${imageTool}`;

    console.log(`${CYAN}🔨 正在构建镜像: ${YELLOW}${fullImageTag}${NC}`);
    console.log(`${BLUE}构建组件类型: ${imageTool}${NC}\n`);

    // Prepare cache (自动检测并下载缺失的文件)
    await prepareBuildCache(imageTool);

    // Find Dockerfile path
    const dockerfilePath = path.join(__dirname, '../docker/manyoyo.Dockerfile');
    if (!fs.existsSync(dockerfilePath)) {
        console.error(`${RED}错误: 找不到 Dockerfile: ${dockerfilePath}${NC}`);
        process.exit(1);
    }

    // Build command
    const imageBuildArgs = IMAGE_BUILD_ARGS.join(' ');
    const buildCmd = `${DOCKER_CMD} build -t "${fullImageTag}" -f "${dockerfilePath}" "${path.join(__dirname, '..')}" ${imageBuildArgs} --load --progress=plain --no-cache`;

    console.log(`${BLUE}准备执行命令:${NC}`);
    console.log(`${buildCmd}\n`);

    if (!YES_MODE) {
        await askQuestion(`❔ 是否继续构建? [ 直接回车=继续, ctrl+c=取消 ]: `);
        console.log("");
    }

    try {
        execSync(buildCmd, { stdio: 'inherit' });
        console.log(`\n${GREEN}✅ 镜像构建成功: ${fullImageTag}${NC}`);
        console.log(`${BLUE}使用镜像:${NC}`);
        console.log(`  ${MANYOYO_NAME} -n test --in ${imageName} --iv ${version}-${imageTool} -y c`);

        // Prune dangling images
        pruneDanglingImages();
    } catch (e) {
        console.error(`${RED}错误: 镜像构建失败${NC}`);
        process.exit(1);
    }
}

// ==============================================================================
// SECTION: Command Line Interface
// ==============================================================================

async function setupCommander() {
    // Load config file
    const config = loadConfig();

    const program = new Command();

    program
        .name(MANYOYO_NAME)
        .version(BIN_VERSION, '-V, --version', '显示版本')
        .description('MANYOYO - AI Agent CLI Sandbox\nhttps://github.com/xcanwin/manyoyo')
        .addHelpText('after', `
配置文件:
  ~/.manyoyo/manyoyo.json    全局配置文件 (JSON5格式，支持注释)
  ~/.manyoyo/run/c.json      运行配置示例

路径规则:
  -r name       → ~/.manyoyo/manyoyo.json 的 runs.name
  --ef /abs/path.env → 绝对路径环境文件
  --ss "<args>" → 显式设置命令后缀
  -- <args...>  → 直接透传命令后缀（优先级最高）

示例:
  ${MANYOYO_NAME} --ib --iv ${IMAGE_VERSION_BASE || "1.0.0"}                     构建镜像
  ${MANYOYO_NAME} --init-config all                   从本机 Agent 配置初始化 ~/.manyoyo
  ${MANYOYO_NAME} -r claude                           使用 manyoyo.json.runs.claude 快速启动
  ${MANYOYO_NAME} -r codex --ss "resume --last"       使用命令后缀
  ${MANYOYO_NAME} -n test --ef /abs/path/myenv.env -y c  使用绝对路径环境变量文件
  ${MANYOYO_NAME} -n test -- -c                       恢复之前会话
  ${MANYOYO_NAME} -x echo 123                         指定命令执行
  ${MANYOYO_NAME} --server --server-user admin --server-pass 123456   启动带登录认证的网页服务
  ${MANYOYO_NAME} --server 3000                       启动网页交互服务
  ${MANYOYO_NAME} --server 0.0.0.0:3000               监听全部网卡，便于局域网访问
  ${MANYOYO_NAME} -n test -q tip -q cmd               多次使用静默选项
        `);

    // Options
    program
        .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
        .option('--hp, --host-path <path>', '设置宿主机工作目录 (默认当前路径)')
        .option('-n, --cont-name <name>', '设置容器名称')
        .option('--cp, --cont-path <path>', '设置容器工作目录')
        .option('-l, --cont-list', '列举容器')
        .option('--crm, --cont-remove', '删除-n指定容器')
        .option('-m, --cont-mode <mode>', '设置容器嵌套容器模式 (common, dind, sock)')
        .option('--in, --image-name <name>', '指定镜像名称')
        .option('--iv, --image-ver <version>', '指定镜像版本')
        .option('--ib, --image-build', '构建镜像')
        .option('--iba, --image-build-arg <arg>', '构建镜像时传参给dockerfile (可多次使用)', (value, previous) => [...(previous || []), value], [])
        .option('--init-config [agents]', '初始化 Agent 配置到 ~/.manyoyo (all 或逗号分隔: claude,codex,gemini,opencode)')
        .option('--irm, --image-remove', '清理悬空镜像和 <none> 镜像')
        .option('-e, --env <env>', '设置环境变量 XXX=YYY (可多次使用)', (value, previous) => [...(previous || []), value], [])
        .option('--ef, --env-file <file>', '设置环境变量通过文件 (仅支持绝对路径，如 /abs/path.env)', (value, previous) => [...(previous || []), value], [])
        .option('-v, --volume <volume>', '绑定挂载卷 XXX:YYY (可多次使用)', (value, previous) => [...(previous || []), value], [])
        .option('--sp, --shell-prefix <command>', '临时环境变量 (作为-s前缀)')
        .option('-s, --shell <command>', '指定命令执行')
        .option('--ss, --shell-suffix <command>', '指定命令后缀 (追加到-s之后，等价于 -- <args>)')
        .option('-x, --shell-full <command...>', '指定完整命令执行 (代替--sp和-s和--命令)')
        .option('-y, --yolo <cli>', '使AGENT无需确认 (claude/c, gemini/gm, codex/cx, opencode/oc)')
        .option('--install <name>', `安装${MANYOYO_NAME}命令 (docker-cli-plugin)`)
        .option('--show-config', '显示最终生效配置并退出')
        .option('--show-command', '显示将执行的 docker run 命令并退出')
        .option('--server [port]', '启动网页交互服务 (默认 127.0.0.1:3000，支持 host:port)')
        .option('--server-user <username>', '网页服务登录用户名 (默认 admin)')
        .option('--server-pass <password>', '网页服务登录密码 (默认自动生成随机密码)')
        .option('--yes', '所有提示自动确认 (用于CI/脚本)')
        .option('--rm-on-exit', '退出后自动删除容器 (一次性模式)')
        .option('-q, --quiet <item>', '静默显示 (可多次使用: cnew,crm,tip,cmd,full)', (value, previous) => [...(previous || []), value], []);

    // Docker CLI plugin metadata check
    if (process.argv[2] === 'docker-cli-plugin-metadata') {
        console.log(JSON.stringify({
            "SchemaVersion": "0.1.0",
            "Vendor": "xcanwin",
            "Version": "v1.0.0",
            "Description": "AI Agent CLI Sandbox"
        }, null, 4));
        process.exit(0);
    }

    // Docker CLI plugin mode - remove first arg if running as plugin
    const dockerPluginPath = path.join(process.env.HOME || '', '.docker/cli-plugins/docker-manyoyo');
    if (process.argv[1] === dockerPluginPath && process.argv[2] === 'manyoyo') {
        process.argv.splice(2, 1);
    }

    // No args: show help instead of starting container
    if (process.argv.length <= 2) {
        program.help();
    }

    const isInitConfigMode = process.argv.some(arg => arg === '--init-config' || arg.startsWith('--init-config='));
    // init-config 只处理本地文件，不依赖 docker/podman
    if (!isInitConfigMode) {
        // Ensure docker/podman is available
        ensureDocker();
    }

    // Pre-handle -x/--shell-full: treat all following args as a single command
    const shellFullIndex = process.argv.findIndex(arg => arg === '-x' || arg === '--shell-full');
    if (shellFullIndex !== -1 && shellFullIndex < process.argv.length - 1) {
        const shellFullArgs = process.argv.slice(shellFullIndex + 1).join(' ');
        process.argv.splice(shellFullIndex + 1, process.argv.length - (shellFullIndex + 1), shellFullArgs);
    }

    // Parse arguments
    program.allowUnknownOption(false);
    program.parse(process.argv);

    const options = program.opts();

    if (options.yes) {
        YES_MODE = true;
    }

    if (options.initConfig !== undefined) {
        await initAgentConfigs(options.initConfig);
        process.exit(0);
    }

    // Load run config if specified
    const runConfig = options.run ? loadRunConfig(options.run, config) : {};

    // Merge configs: command line > run config > global config > defaults
    // Override mode (scalar values): use first defined value
    HOST_PATH = options.hostPath || runConfig.hostPath || config.hostPath || HOST_PATH;
    if (options.contName || runConfig.containerName || config.containerName) {
        CONTAINER_NAME = options.contName || runConfig.containerName || config.containerName;
    }
    CONTAINER_NAME = resolveContainerNameTemplate(CONTAINER_NAME);
    if (options.contPath || runConfig.containerPath || config.containerPath) {
        CONTAINER_PATH = options.contPath || runConfig.containerPath || config.containerPath;
    }
    IMAGE_NAME = options.imageName || runConfig.imageName || config.imageName || IMAGE_NAME;
    if (options.imageVer || runConfig.imageVersion || config.imageVersion) {
        IMAGE_VERSION = options.imageVer || runConfig.imageVersion || config.imageVersion;
    }
    if (options.shellPrefix || runConfig.shellPrefix || config.shellPrefix) {
        EXEC_COMMAND_PREFIX = (options.shellPrefix || runConfig.shellPrefix || config.shellPrefix) + " ";
    }
    if (options.shell || runConfig.shell || config.shell) {
        EXEC_COMMAND = options.shell || runConfig.shell || config.shell;
    }
    if (options.shellSuffix || runConfig.shellSuffix || config.shellSuffix) {
        EXEC_COMMAND_SUFFIX = normalizeCommandSuffix(options.shellSuffix || runConfig.shellSuffix || config.shellSuffix);
    }

    // Basic name validation to reduce injection risk
    validateName('containerName', CONTAINER_NAME, SAFE_CONTAINER_NAME_PATTERN);
    validateName('imageName', IMAGE_NAME, /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/);
    validateName('imageVersion', IMAGE_VERSION, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

    // Merge mode (array values): concatenate all sources
    const toArray = (val) => Array.isArray(val) ? val : (val ? [val] : []);
    const envFileList = [
        ...toArray(config.envFile),
        ...toArray(runConfig.envFile),
        ...(options.envFile || [])
    ].filter(Boolean);
    envFileList.forEach(ef => addEnvFile(ef));

    // env in JSON config uses map type, and is merged by key with CLI priority.
    const envMap = {
        ...normalizeJsonEnvMap(config.env, '全局配置'),
        ...normalizeJsonEnvMap(runConfig.env, '运行配置'),
        ...normalizeCliEnvMap(options.env)
    };
    Object.entries(envMap).forEach(([key, value]) => addEnv(`${key}=${value}`));

    const volumeList = [...(config.volumes || []), ...(runConfig.volumes || []), ...(options.volume || [])];
    volumeList.forEach(v => addVolume(v));

    const buildArgList = [...(config.imageBuildArgs || []), ...(runConfig.imageBuildArgs || []), ...(options.imageBuildArg || [])];
    buildArgList.forEach(arg => addImageBuildArg(arg));

    // Override mode for special options
    const yoloValue = options.yolo || runConfig.yolo || config.yolo;
    if (yoloValue) setYolo(yoloValue);

    const contModeValue = options.contMode || runConfig.containerMode || config.containerMode;
    if (contModeValue) setContMode(contModeValue);

    const quietValue = options.quiet || runConfig.quiet || config.quiet;
    if (quietValue) setQuiet(quietValue);

    // Handle shell-full (variadic arguments)
    if (options.shellFull) {
        EXEC_COMMAND = options.shellFull.join(' ');
        EXEC_COMMAND_PREFIX = "";
        EXEC_COMMAND_SUFFIX = "";
    }

    // Handle -- suffix arguments
    if (!options.shellFull) {
        const doubleDashIndex = process.argv.indexOf('--');
        if (doubleDashIndex !== -1 && doubleDashIndex < process.argv.length - 1) {
            EXEC_COMMAND_SUFFIX = normalizeCommandSuffix(process.argv.slice(doubleDashIndex + 1).join(' '));
        }
    }

    if (options.yes) {
        YES_MODE = true;
    }

    if (options.rmOnExit) {
        RM_ON_EXIT = true;
    }

    if (options.server !== undefined) {
        SERVER_MODE = true;
        const serverListen = parseServerListen(options.server);
        SERVER_HOST = serverListen.host;
        SERVER_PORT = serverListen.port;
    }

    const serverUserValue = options.serverUser || runConfig.serverUser || config.serverUser || process.env.MANYOYO_SERVER_USER;
    if (serverUserValue) {
        SERVER_AUTH_USER = String(serverUserValue);
    }

    const serverPassValue = options.serverPass || runConfig.serverPass || config.serverPass || process.env.MANYOYO_SERVER_PASS;
    if (serverPassValue) {
        SERVER_AUTH_PASS = String(serverPassValue);
        SERVER_AUTH_PASS_AUTO = false;
    }

    if (SERVER_MODE) {
        ensureWebServerAuthCredentials();
    }

    if (options.showConfig) {
        const finalConfig = {
            hostPath: HOST_PATH,
            containerName: CONTAINER_NAME,
            containerPath: CONTAINER_PATH,
            imageName: IMAGE_NAME,
            imageVersion: IMAGE_VERSION,
            envFile: envFileList,
            env: envMap,
            volumes: volumeList,
            imageBuildArgs: buildArgList,
            containerMode: contModeValue || "",
            shellPrefix: EXEC_COMMAND_PREFIX.trim(),
            shell: EXEC_COMMAND || "",
            shellSuffix: EXEC_COMMAND_SUFFIX || "",
            yolo: yoloValue || "",
            quiet: quietValue || [],
            server: SERVER_MODE,
            serverHost: SERVER_MODE ? SERVER_HOST : null,
            serverPort: SERVER_MODE ? SERVER_PORT : null,
            serverUser: SERVER_AUTH_USER || "",
            serverPass: SERVER_AUTH_PASS || "",
            exec: {
                prefix: EXEC_COMMAND_PREFIX,
                shell: EXEC_COMMAND,
                suffix: EXEC_COMMAND_SUFFIX
            }
        };
        // 敏感信息脱敏
        const sanitizedConfig = sanitizeSensitiveData(finalConfig);
        console.log(JSON.stringify(sanitizedConfig, null, 4));
        process.exit(0);
    }

    if (options.showCommand) {
        SHOW_COMMAND = true;
    }

    if (options.contList) { getContList(); process.exit(0); }
    if (options.contRemove) SHOULD_REMOVE = true;
    if (options.imageBuild) IMAGE_BUILD_NEED = true;
    if (options.imageRemove) { pruneDanglingImages(); process.exit(0); }
    if (options.install) { installManyoyo(options.install); process.exit(0); }

    return program;
}

function handleRemoveContainer() {
    if (SHOULD_REMOVE) {
        try {
            if (containerExists(CONTAINER_NAME)) {
                removeContainer(CONTAINER_NAME);
            } else {
                console.log(`${RED}⚠️  错误: 未找到名为 ${CONTAINER_NAME} 的容器。${NC}`);
            }
        } catch (e) {
            console.log(`${RED}⚠️  错误: 未找到名为 ${CONTAINER_NAME} 的容器。${NC}`);
        }
        process.exit(0);
    }
}

function validateHostPath() {
    if (!fs.existsSync(HOST_PATH)) {
        console.log(`${RED}⚠️  错误: 宿主机路径不存在: ${HOST_PATH}${NC}`);
        process.exit(1);
    }
    const realHostPath = fs.realpathSync(HOST_PATH);
    const homeDir = process.env.HOME || '/home';
    if (realHostPath === '/' || realHostPath === '/home' || realHostPath === homeDir) {
        console.log(`${RED}⚠️  错误: 不允许挂载根目录或home目录。${NC}`);
        process.exit(1);
    }
}

/**
 * 等待容器就绪（使用指数退避算法）
 * @param {string} containerName - 容器名称
 */
async function waitForContainerReady(containerName) {
    const MAX_RETRIES = CONFIG.CONTAINER_READY_MAX_RETRIES;
    let retryDelay = CONFIG.CONTAINER_READY_INITIAL_DELAY;

    for (let count = 0; count < MAX_RETRIES; count++) {
        try {
            const status = getContainerStatus(containerName);

            if (status === 'running') {
                return;
            }

            if (status === 'exited') {
                console.log(`${RED}⚠️  错误: 容器启动后立即退出。${NC}`);
                dockerExecArgs(['logs', containerName], { stdio: 'inherit' });
                process.exit(1);
            }

            await sleep(retryDelay);
            retryDelay = Math.min(retryDelay * 2, CONFIG.CONTAINER_READY_MAX_DELAY);
        } catch (e) {
            await sleep(retryDelay);
            retryDelay = Math.min(retryDelay * 2, CONFIG.CONTAINER_READY_MAX_DELAY);
        }
    }

    console.log(`${RED}⚠️  错误: 容器启动超时。${NC}`);
    process.exit(1);
}

// ==============================================================================
// SECTION: Container Lifecycle Management
// ==============================================================================

/**
 * 创建新容器
 * @returns {Promise<string>} 默认命令
 */
async function createNewContainer() {
    if ( !(QUIET.cnew || QUIET.full) ) console.log(`${CYAN}📦 manyoyo by xcanwin 正在创建新容器: ${YELLOW}${CONTAINER_NAME}${NC}`);

    EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}`;
    const defaultCommand = EXEC_COMMAND;

    if (SHOW_COMMAND) {
        console.log(buildDockerRunCmd());
        process.exit(0);
    }

    // 使用数组参数执行命令（安全方式）
    try {
        const args = buildDockerRunArgs();
        dockerExecArgs(args, { stdio: 'pipe' });
    } catch (e) {
        showImagePullHint(e);
        throw e;
    }

    // Wait for container to be ready
    await waitForContainerReady(CONTAINER_NAME);

    return defaultCommand;
}

/**
 * 构建 Docker run 命令参数数组（安全方式，避免命令注入）
 * @returns {string[]} 命令参数数组
 */
function buildDockerRunArgs() {
    const fullImage = `${IMAGE_NAME}:${IMAGE_VERSION}`;
    const safeLabelCmd = EXEC_COMMAND.replace(/[\r\n]/g, ' ');

    const args = [
        'run', '-d',
        '--name', CONTAINER_NAME,
        '--entrypoint', '',
        ...CONT_MODE_ARGS,
        ...CONTAINER_ENVS,
        ...CONTAINER_VOLUMES,
        '--volume', `${HOST_PATH}:${CONTAINER_PATH}`,
        '--workdir', CONTAINER_PATH,
        '--label', `manyoyo.default_cmd=${safeLabelCmd}`,
        fullImage,
        'tail', '-f', '/dev/null'
    ];

    return args;
}

/**
 * 构建 Docker run 命令字符串（用于显示）
 * @returns {string} 命令字符串
 */
function buildDockerRunCmd() {
    const args = buildDockerRunArgs();
    // 对包含空格或特殊字符的参数加引号
    const quotedArgs = args.map(arg => {
        if (arg.includes(' ') || arg.includes('"') || arg.includes('=')) {
            return `"${arg.replace(/"/g, '\\"')}"`;
        }
        return arg;
    });
    return `${DOCKER_CMD} ${quotedArgs.join(' ')}`;
}

async function connectExistingContainer() {
    if ( !(QUIET.cnew || QUIET.full) ) console.log(`${CYAN}🔄 manyoyo by xcanwin 正在连接到现有容器: ${YELLOW}${CONTAINER_NAME}${NC}`);

    // Start container if stopped
    const status = getContainerStatus(CONTAINER_NAME);
    if (status !== 'running') {
        dockerExecArgs(['start', CONTAINER_NAME], { stdio: 'pipe' });
    }

    // Get default command from label
    const defaultCommand = dockerExecArgs(['inspect', '-f', '{{index .Config.Labels "manyoyo.default_cmd"}}', CONTAINER_NAME]).trim();

    if (!EXEC_COMMAND) {
        EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${defaultCommand}${EXEC_COMMAND_SUFFIX}`;
    } else {
        EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}`;
    }

    return defaultCommand;
}

async function setupContainer() {
    if (SHOW_COMMAND) {
        if (containerExists(CONTAINER_NAME)) {
            const defaultCommand = dockerExecArgs(['inspect', '-f', '{{index .Config.Labels "manyoyo.default_cmd"}}', CONTAINER_NAME]).trim();
            const execCmd = EXEC_COMMAND
                ? `${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}`
                : `${EXEC_COMMAND_PREFIX}${defaultCommand}${EXEC_COMMAND_SUFFIX}`;
            console.log(`${DOCKER_CMD} exec -it ${CONTAINER_NAME} /bin/bash -c "${execCmd.replace(/"/g, '\\"')}"`);
            process.exit(0);
        }
        EXEC_COMMAND = `${EXEC_COMMAND_PREFIX}${EXEC_COMMAND}${EXEC_COMMAND_SUFFIX}`;
        console.log(buildDockerRunCmd());
        process.exit(0);
    }
    if (!containerExists(CONTAINER_NAME)) {
        return await createNewContainer();
    } else {
        return await connectExistingContainer();
    }
}

function executeInContainer(defaultCommand) {
    getHelloTip(CONTAINER_NAME, defaultCommand);
    if ( !(QUIET.cmd || QUIET.full) ) {
        console.log(`${BLUE}----------------------------------------${NC}`);
        console.log(`💻 执行命令: ${YELLOW}${EXEC_COMMAND || '交互式 Shell'}${NC}`);
    }

    // Execute command in container
    if (EXEC_COMMAND) {
        spawnSync(`${DOCKER_CMD}`, ['exec', '-it', CONTAINER_NAME, '/bin/bash', '-c', EXEC_COMMAND], { stdio: 'inherit' });
    } else {
        spawnSync(`${DOCKER_CMD}`, ['exec', '-it', CONTAINER_NAME, '/bin/bash'], { stdio: 'inherit' });
    }
}

/**
 * 处理会话退出后的交互
 * @param {string} defaultCommand - 默认命令
 */
async function handlePostExit(defaultCommand) {
    // --rm-on-exit 模式：自动删除容器
    if (RM_ON_EXIT) {
        removeContainer(CONTAINER_NAME);
        return;
    }

    getHelloTip(CONTAINER_NAME, defaultCommand);

    let tipAskKeep = `❔ 会话已结束。是否保留此后台容器 ${CONTAINER_NAME}? [ y=默认保留, n=删除, 1=首次命令进入, x=执行命令, i=交互式SHELL ]: `;
    if ( QUIET.askkeep || QUIET.full ) tipAskKeep = `保留容器吗? [y n 1 x i] `;
    const reply = await askQuestion(tipAskKeep);

    const firstChar = reply.trim().toLowerCase()[0];

    if (firstChar === 'n') {
        removeContainer(CONTAINER_NAME);
    } else if (firstChar === '1') {
        if ( !(QUIET.full) ) console.log(`${GREEN}✅ 离开当前连接，用首次命令进入。${NC}`);
        // Reset command variables to use default command
        EXEC_COMMAND = "";
        EXEC_COMMAND_PREFIX = "";
        EXEC_COMMAND_SUFFIX = "";
        const newArgs = ['-n', CONTAINER_NAME];
        process.argv = [process.argv[0], process.argv[1], ...newArgs];
        await main();
    } else if (firstChar === 'x') {
        const command = await askQuestion('❔ 输入要执行的命令: ');
        if ( !(QUIET.cmd || QUIET.full) ) console.log(`${GREEN}✅ 离开当前连接，执行命令。${NC}`);
        const newArgs = ['-n', CONTAINER_NAME, '-x', command];
        process.argv = [process.argv[0], process.argv[1], ...newArgs];
        await main();
    } else if (firstChar === 'i') {
        if ( !(QUIET.full) ) console.log(`${GREEN}✅ 离开当前连接，进入容器交互式SHELL。${NC}`);
        const newArgs = ['-n', CONTAINER_NAME, '-x', '/bin/bash'];
        process.argv = [process.argv[0], process.argv[1], ...newArgs];
        await main();
    } else {
        console.log(`${GREEN}✅ 已退出连接。容器 ${CONTAINER_NAME} 仍在后台运行。${NC}`);
    }
}

// ==============================================================================
// SECTION: Web Server
// ==============================================================================

async function runWebServerMode() {
    ensureWebServerAuthCredentials();

    await startWebServer({
        serverHost: SERVER_HOST,
        serverPort: SERVER_PORT,
        authUser: SERVER_AUTH_USER,
        authPass: SERVER_AUTH_PASS,
        authPassAuto: SERVER_AUTH_PASS_AUTO,
        dockerCmd: DOCKER_CMD,
        hostPath: HOST_PATH,
        containerPath: CONTAINER_PATH,
        imageName: IMAGE_NAME,
        imageVersion: IMAGE_VERSION,
        execCommandPrefix: EXEC_COMMAND_PREFIX,
        execCommand: EXEC_COMMAND,
        execCommandSuffix: EXEC_COMMAND_SUFFIX,
        contModeArgs: CONT_MODE_ARGS,
        containerEnvs: CONTAINER_ENVS,
        containerVolumes: CONTAINER_VOLUMES,
        validateHostPath,
        formatDate,
        isValidContainerName,
        containerExists,
        getContainerStatus,
        waitForContainerReady,
        dockerExecArgs,
        showImagePullHint,
        removeContainer,
        webHistoryDir: path.join(os.homedir(), '.manyoyo', 'web-history'),
        colors: {
            RED,
            GREEN,
            YELLOW,
            BLUE,
            CYAN,
            NC
        }
    });
}

// ==============================================================================
// Main Function
// ==============================================================================

async function main() {
    try {
        // 1. Setup commander and parse arguments
        await setupCommander();

        // 2. Start web server mode
        if (SERVER_MODE) {
            await runWebServerMode();
            return;
        }

        // 3. Handle image build operation
        if (IMAGE_BUILD_NEED) {
            await buildImage(IMAGE_BUILD_ARGS, IMAGE_NAME, IMAGE_VERSION.split('-')[0]);
            process.exit(0);
        }

        // 4. Handle remove container operation
        handleRemoveContainer();

        // 5. Validate host path safety
        validateHostPath();

        // 6. Setup container (create or connect)
        const defaultCommand = await setupContainer();

        // 7. Execute command in container
        executeInContainer(defaultCommand);

        // 8. Handle post-exit interactions
        await handlePostExit(defaultCommand);

    } catch (e) {
        console.error(`${RED}Error: ${e.message}${NC}`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
