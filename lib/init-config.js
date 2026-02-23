'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function readJsonFileSafely(filePath, label, ctx) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        const { YELLOW, NC } = ctx.colors;
        ctx.log(`${YELLOW}⚠️  ${label} 解析失败: ${filePath}${NC}`);
        return null;
    }
}

function parseSimpleToml(content) {
    const result = {};
    let current = result;

    for (const rawLine of String(content || '').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const sectionMatch = line.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
            current = result;
            for (const part of sectionMatch[1].split('.').map(v => v.trim()).filter(Boolean)) {
                if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
                    current[part] = {};
                }
                current = current[part];
            }
            continue;
        }

        const keyValueMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
        if (!keyValueMatch) continue;

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

function readTomlFileSafely(filePath, label, ctx) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return parseSimpleToml(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        const { YELLOW, NC } = ctx.colors;
        ctx.log(`${YELLOW}⚠️  ${label} 解析失败: ${filePath}${NC}`);
        return null;
    }
}

function dedupeList(list) {
    return Array.from(new Set((list || []).filter(Boolean)));
}

function setInitValue(values, key, value) {
    if (value === undefined || value === null) return;
    const text = String(value).replace(/[\r\n\0]/g, '').trim();
    if (!text) return;
    values[key] = text;
}

function fillValuesFromEnv(keys, values) {
    keys.forEach(key => setInitValue(values, key, process.env[key]));
}

function isSafeInitEnvValue(value) {
    if (value === undefined || value === null) return false;
    const text = String(value).replace(/[\r\n\0]/g, '').trim();
    if (!text) return false;
    if (/[\$\(\)\`\|\&\*\{\};<>]/.test(text)) return false;
    if (/^\(/.test(text)) return false;
    return true;
}

function resolveEnvPlaceholder(value) {
    if (typeof value !== 'string') return '';
    const match = value.match(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/);
    if (!match) return '';
    const envName = match[1];
    return process.env[envName] ? String(process.env[envName]).trim() : '';
}

function normalizeInitConfigAgents(rawAgents, ctx) {
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
        return [...ctx.supportedAgents];
    }

    const tokens = String(rawAgents).split(/[,\s]+/).map(v => v.trim().toLowerCase()).filter(Boolean);
    if (tokens.length === 0) return [...ctx.supportedAgents];

    const normalized = [];
    for (const token of tokens) {
        const mapped = aliasMap[token];
        if (!mapped) {
            const { RED, YELLOW, NC } = ctx.colors;
            ctx.error(`${RED}⚠️  错误: init 不支持的 Agent: ${token}${NC}`);
            ctx.error(`${YELLOW}支持: ${ctx.supportedAgents.join(', ')} 或 all${NC}`);
            ctx.exit(1);
            return [];
        }
        if (mapped === 'all') return [...ctx.supportedAgents];
        if (!normalized.includes(mapped)) normalized.push(mapped);
    }
    return normalized;
}

function collectClaudeInitData(homeDir, ctx) {
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
    fillValuesFromEnv(keys, values);

    const settingsJson = readJsonFileSafely(path.join(homeDir, '.claude', 'settings.json'), 'Claude settings', ctx);
    if (settingsJson && settingsJson.env && typeof settingsJson.env === 'object') {
        keys.forEach(key => setInitValue(values, key, settingsJson.env[key]));
    }

    return { keys, values, notes: [], volumes: [] };
}

function collectGeminiInitData(homeDir) {
    const keys = ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_API_KEY', 'GEMINI_MODEL'];
    const values = {};
    const notes = [];
    const volumes = [];
    fillValuesFromEnv(keys, values);

    const geminiDir = path.join(homeDir, '.gemini');
    if (fs.existsSync(geminiDir)) {
        volumes.push(`${geminiDir}:/root/.gemini`);
    } else {
        notes.push('未检测到 Gemini 本地配置目录（~/.gemini），已生成占位模板。');
    }

    return { keys, values, notes, volumes };
}

function collectCodexInitData(homeDir, ctx) {
    const keys = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];
    const values = {};
    const notes = [];
    const volumes = [];
    fillValuesFromEnv(keys, values);

    const codexDir = path.join(homeDir, '.codex');
    const authJson = readJsonFileSafely(path.join(codexDir, 'auth.json'), 'Codex auth', ctx);
    const configToml = readTomlFileSafely(path.join(codexDir, 'config.toml'), 'Codex TOML', ctx);

    if (authJson && typeof authJson === 'object') {
        setInitValue(values, 'OPENAI_API_KEY', authJson.OPENAI_API_KEY);
    }

    if (configToml && typeof configToml === 'object') {
        setInitValue(values, 'OPENAI_MODEL', configToml.model);
        const providers = configToml.model_providers;
        let providerConfig = null;
        if (providers && typeof providers === 'object') {
            const selectedProviderName =
                (typeof configToml.model_provider === 'string' && providers[configToml.model_provider])
                    ? configToml.model_provider
                    : Object.keys(providers)[0];
            providerConfig = selectedProviderName ? providers[selectedProviderName] : null;
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

    return { keys, values, notes, volumes };
}

function collectOpenCodeInitData(homeDir, ctx) {
    const keys = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];
    const values = {};
    const notes = [];
    const volumes = [];
    fillValuesFromEnv(keys, values);

    const opencodePath = path.join(homeDir, '.config', 'opencode', 'opencode.json');
    const opencodeAuthPath = path.join(homeDir, '.local', 'share', 'opencode', 'auth.json');
    const opencodeJson = readJsonFileSafely(opencodePath, 'OpenCode config', ctx);

    if (opencodeJson && typeof opencodeJson === 'object') {
        const providerList = opencodeJson.provider && typeof opencodeJson.provider === 'object'
            ? Object.values(opencodeJson.provider).filter(v => v && typeof v === 'object')
            : [];
        const provider = providerList[0];

        if (provider) {
            const providerOptions = provider.options && typeof provider.options === 'object' ? provider.options : {};
            setInitValue(values, 'OPENAI_API_KEY', resolveEnvPlaceholder(providerOptions.apiKey) || providerOptions.apiKey);
            setInitValue(values, 'OPENAI_BASE_URL', resolveEnvPlaceholder(providerOptions.baseURL) || providerOptions.baseURL);

            if (provider.models && typeof provider.models === 'object') {
                const firstModelName = Object.keys(provider.models)[0];
                if (firstModelName) setInitValue(values, 'OPENAI_MODEL', firstModelName);
            }
        }

        if (typeof opencodeJson.model === 'string') {
            const modelFromEnv = resolveEnvPlaceholder(opencodeJson.model);
            if (modelFromEnv) setInitValue(values, 'OPENAI_MODEL', modelFromEnv);
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
            envMap[key] = '';
            unsafeKeys.push(key);
        } else {
            envMap[key] = '';
            missingKeys.push(key);
        }
    }

    return { envMap, missingKeys, unsafeKeys };
}

function buildInitRunProfile(agent, yolo, volumes, keys, values) {
    const envResult = buildInitRunEnv(keys, values);
    const runProfile = {
        containerName: `my-${agent}-{now}`,
        env: envResult.envMap,
        yolo
    };
    const volumeList = dedupeList(volumes);
    if (volumeList.length > 0) runProfile.volumes = volumeList;

    return {
        runProfile,
        missingKeys: envResult.missingKeys,
        unsafeKeys: envResult.unsafeKeys
    };
}

async function shouldOverwriteInitRunEntry(runName, exists, ctx) {
    const { YELLOW, NC } = ctx.colors;
    if (!exists) return true;

    if (ctx.yesMode) {
        ctx.log(`${YELLOW}⚠️  runs.${runName} 已存在，--yes 模式自动覆盖${NC}`);
        return true;
    }

    const reply = await ctx.askQuestion(`❔ runs.${runName} 已存在，是否覆盖? [y/N]: `);
    const firstChar = String(reply || '').trim().toLowerCase()[0];
    if (firstChar === 'y') return true;

    ctx.log(`${YELLOW}⏭️  已保留原配置: runs.${runName}${NC}`);
    return false;
}

async function initAgentConfigs(rawAgents, options = {}) {
    const ctx = {
        homeDir: options.homeDir || os.homedir(),
        yesMode: Boolean(options.yesMode),
        askQuestion: options.askQuestion || (async () => ''),
        loadConfig: options.loadConfig || (() => ({})),
        supportedAgents: Array.isArray(options.supportedAgents) && options.supportedAgents.length > 0
            ? options.supportedAgents
            : ['claude', 'codex', 'gemini', 'opencode'],
        log: options.log || console.log,
        error: options.error || console.error,
        exit: options.exit || (code => process.exit(code)),
        colors: options.colors || { RED: '', GREEN: '', YELLOW: '', CYAN: '', NC: '' }
    };
    const { RED, GREEN, YELLOW, CYAN, NC } = ctx.colors;

    const agents = normalizeInitConfigAgents(rawAgents, ctx);
    const manyoyoHome = path.join(ctx.homeDir, '.manyoyo');
    const manyoyoConfigPath = path.join(manyoyoHome, 'manyoyo.json');
    fs.mkdirSync(manyoyoHome, { recursive: true });

    const manyoyoConfig = ctx.loadConfig();
    let runsMap = {};
    if (manyoyoConfig.runs !== undefined) {
        if (typeof manyoyoConfig.runs !== 'object' || manyoyoConfig.runs === null || Array.isArray(manyoyoConfig.runs)) {
            ctx.error(`${RED}⚠️  错误: ~/.manyoyo/manyoyo.json 的 runs 必须是对象(map)${NC}`);
            ctx.exit(1);
            return;
        }
        runsMap = { ...manyoyoConfig.runs };
    }

    const extractors = {
        claude: homeDir => collectClaudeInitData(homeDir, ctx),
        codex: homeDir => collectCodexInitData(homeDir, ctx),
        gemini: collectGeminiInitData,
        opencode: homeDir => collectOpenCodeInitData(homeDir, ctx)
    };
    const yoloMap = { claude: 'c', codex: 'cx', gemini: 'gm', opencode: 'oc' };

    let hasConfigChanged = false;
    ctx.log(`${CYAN}🧭 正在初始化 MANYOYO 配置: ${agents.join(', ')}${NC}`);

    for (const agent of agents) {
        const data = extractors[agent](ctx.homeDir);
        const shouldWriteRun = await shouldOverwriteInitRunEntry(agent, Object.prototype.hasOwnProperty.call(runsMap, agent), ctx);

        let writeResult = { missingKeys: [], unsafeKeys: [] };
        if (shouldWriteRun) {
            const buildResult = buildInitRunProfile(agent, yoloMap[agent], data.volumes, data.keys, data.values);
            runsMap[agent] = buildResult.runProfile;
            writeResult = { missingKeys: buildResult.missingKeys, unsafeKeys: buildResult.unsafeKeys };
            hasConfigChanged = true;
        }

        if (shouldWriteRun) {
            ctx.log(`${GREEN}✅ [${agent}] 初始化完成${NC}`);
        } else {
            ctx.log(`${YELLOW}⚠️  [${agent}] 已跳过（配置保留）${NC}`);
        }
        ctx.log(`   run: ${shouldWriteRun ? '已写入' : '保留'} runs.${agent}`);

        if (shouldWriteRun && writeResult.missingKeys.length > 0) {
            ctx.log(`${YELLOW}⚠️  [${agent}] 以下变量未找到，请手动填写:${NC} ${writeResult.missingKeys.join(', ')}`);
        }
        if (shouldWriteRun && writeResult.unsafeKeys.length > 0) {
            ctx.log(`${YELLOW}⚠️  [${agent}] 以下变量包含不安全字符，已留空 env 键:${NC} ${writeResult.unsafeKeys.join(', ')}`);
        }
        if (data.notes && data.notes.length > 0) {
            data.notes.forEach(note => ctx.log(`${YELLOW}⚠️  [${agent}] ${note}${NC}`));
        }
    }

    if (hasConfigChanged || !fs.existsSync(manyoyoConfigPath)) {
        manyoyoConfig.runs = runsMap;
        fs.writeFileSync(manyoyoConfigPath, `${JSON.stringify(manyoyoConfig, null, 4)}\n`);
    }
}

module.exports = {
    initAgentConfigs
};
