'use strict';

// Web 端执行 Agent 时追加给它的系统提示词（唯一数据源）。
// 只写环境事实、用条件句：不鼓励它主动生成或展示图片，也不重复模型本来就知道的事。
const BUILTIN_AGENT_INSTRUCTIONS = [
    '你的回复会显示在网页里（用户可能在手机上看），Markdown 会被渲染。',
    '- 需要让用户看某张图片时（如截图、生成的图表），用 Markdown 图片语法写容器内的绝对路径：![说明](/路径/图.png)，支持 png/jpg/jpeg/gif/webp/bmp/ico。没有必要时不要专门生成或展示图片。',
    '- 提到文件时写容器内的绝对路径，用户可以点开查看。'
].join('\n');

const USER_INSTRUCTIONS_MAX_CHARS = 4000;
// 容器的系统提示词 = 默认 + 补充，上限放宽
const SYSTEM_PROMPT_MAX_CHARS = 8000;

function pickUserInstructions(config, runName) {
    const source = config && typeof config === 'object' ? config : {};
    const runs = source.runs && typeof source.runs === 'object' ? source.runs : {};
    const run = runName && Object.prototype.hasOwnProperty.call(runs, runName) ? runs[runName] : null;
    if (run && typeof run === 'object' && typeof run.agentInstructions === 'string') {
        return run.agentInstructions;
    }
    return typeof source.agentInstructions === 'string' ? source.agentInstructions : '';
}

// 去掉控制字符（保留换行、制表符）：codex 的 TOML 字符串不接受它们，也没有正当用途；
// {prompt} 会被命令模板当成占位符替换，拆开写
function sanitizeUserInstructions(text, max = USER_INSTRUCTIONS_MAX_CHARS) {
    return String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        .replace(/\{prompt\}/g, '{ prompt }')
        .trim()
        .slice(0, max);
}

// 系统设置里两段各有开关（默认开）：默认系统提示词（内置）与补充系统提示词（agentInstructions）
function pickEnabled(config, key) {
    return !(config && typeof config === 'object' && config[key] === false);
}

// 默认系统提示词 + 补充系统提示词（按开关取用），新建容器时作为初始内容
function composeSystemPrompt(config, runName) {
    const parts = [];
    if (pickEnabled(config, 'agentInstructionsBuiltinEnabled')) parts.push(BUILTIN_AGENT_INSTRUCTIONS);
    const extra = pickEnabled(config, 'agentInstructionsCustomEnabled')
        ? sanitizeUserInstructions(pickUserInstructions(config, runName))
        : '';
    if (extra) parts.push(extra);
    return parts.length ? `${parts.join('\n\n')}\n` : '';
}

// 某个容器实际使用的系统提示词：容器自己存过就以它为准（enabled=false 即不注入），没存过（旧容器）用当前全局设置
function buildAgentInstructions(config, runName, containerPrompt) {
    if (containerPrompt && typeof containerPrompt === 'object') {
        return containerPrompt.enabled === false ? '' : sanitizeUserInstructions(containerPrompt.text, SYSTEM_PROMPT_MAX_CHARS);
    }
    return sanitizeUserInstructions(composeSystemPrompt(config, runName), SYSTEM_PROMPT_MAX_CHARS);
}

// TOML 基本字符串：JSON 的转义（\" \\ \n \t \uXXXX）在 TOML 里含义相同；
// 控制字符已在 sanitize 时去掉，这里只剩 JSON 会原样输出、TOML 也允许的字符
function toTomlBasicString(text) {
    return JSON.stringify(String(text || ''));
}

module.exports = {
    BUILTIN_AGENT_INSTRUCTIONS,
    buildAgentInstructions,
    composeSystemPrompt,
    sanitizeUserInstructions,
    SYSTEM_PROMPT_MAX_CHARS,
    toTomlBasicString
};
