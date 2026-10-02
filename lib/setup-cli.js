'use strict';

// `manyoyo setup`：无头环境（SSH、没有图形界面）的命令行配置向导，等价于网页向导的几个步骤。
// 配置文本的构造复用 lib/setup-config.js 与 lib/setup.js（和 /api/setup/* 同源），写入走 secure-file（0600、原子）。
// 所有 IO 都从 deps 注入，便于测试；密钥与密码不回显、不写日志、不打印。

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Writable } = require('stream');
const JSON5 = require('json5');
const { listSetupAgents, buildAgentRunProfile, validateSetupPassword, listMirrorPresets } = require('./setup');
const { baseRawOf, buildAgentConfigRaw, buildPasswordConfigRaw, shouldWriteMirrors, buildMirrorsConfigRaw } = require('./setup-config');
const { normalizeMirrors } = require('./runtime-normalizers');
const { writeConfigFileSecure } = require('./secure-file');
const { getManyoyoConfigPath } = require('./global-config');

class InputClosedError extends Error {}

/**
 * 读 stdin 的提示器。askSecret 输入不回显：提示文字直接写到真实 output，
 * 回显通道（readline 的 output）在读密码期间静音。
 */
function createPrompter({ input = process.stdin, output = process.stdout, terminal = Boolean(input.isTTY) } = {}) {
    let muted = false;
    const echo = new Writable({
        write(chunk, encoding, callback) {
            if (!muted) output.write(chunk, encoding);
            callback();
        }
    });
    const rl = readline.createInterface({ input, output: echo, terminal });
    let closed = false;
    let rejectPending = null;
    rl.on('close', () => {
        closed = true;
        if (rejectPending) rejectPending(new InputClosedError('输入已结束'));
    });
    const question = prompt => new Promise((resolve, reject) => {
        if (closed) {
            reject(new InputClosedError('输入已结束'));
            return;
        }
        rejectPending = reject;
        rl.question(prompt, answer => {
            rejectPending = null;
            resolve(answer);
        });
    });
    return {
        ask: text => question(text),
        async askSecret(text) {
            output.write(text);
            muted = true;
            try {
                return await question('');
            } finally {
                muted = false;
                output.write('\n');
            }
        },
        close: () => rl.close()
    };
}

async function chooseNumber(prompter, log, title, items, { defaultIndex = 0, allowSkip = false } = {}) {
    log(title);
    items.forEach((item, index) => log(`  ${index + 1}) ${item}`));
    if (allowSkip) log('  0) 跳过 / 官方默认');
    for (;;) {
        const answer = String(await prompter.ask(`请选择${allowSkip ? '' : ` [${defaultIndex + 1}]`}: `)).trim();
        if (answer === '' && !allowSkip) return defaultIndex;
        if (allowSkip && (answer === '' || answer === '0')) return -1;
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && index >= 0 && index < items.length) return index;
        log('请输入列表里的编号。');
    }
}

async function askMirrors(prompter, log) {
    const presets = listMirrorPresets();
    const toolNames = { apt: 'apt（Ubuntu 软件包）', npm: 'npm', pip: 'pip（Python）' };
    const mirrors = {};
    for (const tool of ['apt', 'npm', 'pip']) {
        const items = [...presets[tool].map(item => `${item.label}  ${item.value}`), '自定义地址'];
        const choice = await chooseNumber(prompter, log, `${toolNames[tool]} 软件源：`, items, { allowSkip: true });
        if (choice === -1) continue;
        if (choice < presets[tool].length) {
            mirrors[tool] = presets[tool][choice].value;
            continue;
        }
        for (;;) {
            const value = String(await prompter.ask('请输入 http(s) 地址（留空取消）: ')).trim();
            if (!value) break;
            try {
                mirrors[tool] = normalizeMirrors({ [tool]: value })[tool];
                break;
            } catch (error) {
                log(error.message);
            }
        }
    }
    return mirrors;
}

async function askPassword(prompter, log) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const first = await prompter.askSecret('设置登录密码（至少 8 位，输入不回显）: ');
        const reason = validateSetupPassword(first);
        if (reason) {
            log(reason);
            continue;
        }
        const second = await prompter.askSecret('再输入一次: ');
        if (first !== second) {
            log('两次输入不一致，请重新设置。');
            continue;
        }
        return first;
    }
    throw new Error('登录密码设置失败次数过多，已退出。');
}

/**
 * @returns {Promise<number>} 退出码
 */
async function runSetupCli(deps) {
    const log = deps.log || (line => console.log(line));
    const commandName = deps.commandName || 'manyoyo';
    if (!deps.isTTY) {
        log(`${commandName} setup 需要在交互式终端里运行（当前输入不是终端）。`);
        log('可选做法：');
        log('  1. 在能交互的终端（例如 ssh 登录后的 shell）里重新运行 setup；');
        log(`  2. 在有图形界面的环境里运行 ${commandName}，用网页向导完成配置；`);
        log(`  3. 直接编辑 ${deps.configPath}（可先用 ${commandName} init 生成默认配置）。`);
        return 1;
    }
    const prompter = deps.prompter;
    try {
        const agents = listSetupAgents();
        const agentIndex = await chooseNumber(prompter, log, '选择要配置的 Agent：', agents.map(item => `${item.label}（${item.id}）`));
        const agent = agents[agentIndex];

        const env = {};
        let keyName = agent.requiredAnyOf[0];
        if (agent.requiredAnyOf.length > 1) {
            const keyIndex = await chooseNumber(prompter, log, '使用哪种凭据：', agent.requiredAnyOf.map(name => {
                const entry = agent.env.find(item => item.name === name);
                return `${name}  ${entry ? entry.description : ''}`;
            }));
            keyName = agent.requiredAnyOf[keyIndex];
        }
        const key = String(await prompter.askSecret(`${keyName}（输入不回显）: `)).trim();
        if (!key) {
            log('凭据不能为空，已退出，没有改动任何配置。');
            return 1;
        }
        env[keyName] = key;

        const baseUrlItems = [...agent.baseUrlPresets.map(item => `${item.label}  ${item.value}`), '自定义地址'];
        const baseIndex = await chooseNumber(prompter, log, 'API 地址：', baseUrlItems, { allowSkip: true });
        if (baseIndex >= 0 && baseIndex < agent.baseUrlPresets.length) {
            env[agent.baseUrlKey] = agent.baseUrlPresets[baseIndex].value;
        } else if (baseIndex === agent.baseUrlPresets.length) {
            const custom = String(await prompter.ask('请输入 API 地址: ')).trim();
            if (custom) env[agent.baseUrlKey] = custom;
        }
        const model = String(await prompter.ask(`默认模型 ${agent.modelKey}（可留空）: `)).trim();
        if (model) env[agent.modelKey] = model;

        const defaultWork = deps.defaultWorkpath;
        let hostPath = String(await prompter.ask(`工作目录（Agent 只能看到这里）[${defaultWork}]: `)).trim() || defaultWork;
        if (!path.isAbsolute(hostPath)) {
            log('工作目录必须是绝对路径，已退出，没有改动任何配置。');
            return 1;
        }
        hostPath = path.resolve(hostPath);
        fs.mkdirSync(hostPath, { recursive: true });
        deps.validateHostPath(hostPath);

        const password = await askPassword(prompter, log);

        let mirrors = {};
        if (/^y(es)?$/i.test(String(await prompter.ask('配置 apt / npm / pip 软件源吗？默认官方源 [y/N]: ')).trim())) {
            mirrors = await askMirrors(prompter, log);
        }

        // 一次性构造并校验新配置，通过后原子写入；任何一步出错都不会留下半份配置
        const configPath = deps.configPath;
        const exists = fs.existsSync(configPath);
        const snapshot = { exists, raw: exists ? fs.readFileSync(configPath, 'utf-8') : '' };
        const parsed = exists && snapshot.raw.trim() ? JSON5.parse(snapshot.raw) : {};
        const existingRun = parsed.runs && typeof parsed.runs === 'object' ? parsed.runs[agent.id] : undefined;
        const profile = buildAgentRunProfile(agent.id, env, { existingRun, hostPath });
        let nextRaw = buildAgentConfigRaw(baseRawOf(snapshot), agent.id, profile);
        nextRaw = buildPasswordConfigRaw(nextRaw, password);
        if (shouldWriteMirrors(parsed, mirrors)) nextRaw = buildMirrorsConfigRaw(nextRaw, normalizeMirrors(mirrors));
        JSON5.parse(nextRaw);
        writeConfigFileSecure(configPath, nextRaw);
        log(`已保存到 ${configPath}（权限 0600）：Agent ${agent.id}、工作目录 ${hostPath}、登录密码${Object.keys(mirrors).length > 0 ? '、软件源' : ''}。`);
    } catch (error) {
        if (error instanceof InputClosedError) {
            log('输入已结束，没有改动任何配置。');
            return 1;
        }
        log(`配置失败：${error.message}`);
        return 1;
    } finally {
        prompter.close();
    }
    if (deps.afterSave) await deps.afterSave();
    return 0;
}

module.exports = { runSetupCli, createPrompter, getManyoyoConfigPath };
