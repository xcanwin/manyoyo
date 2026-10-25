'use strict';

// 推理强度：选项来自 Agent 自己的模型目录（容器里的进程给出，按不可信文本处理：只接受小写字母 2～16 位）。

const EFFORT_PATTERN = /^[a-z]{2,16}$/;
const MAX_LEVELS = 12;

function isEffortValue(value) {
    return typeof value === 'string' && EFFORT_PATTERN.test(value);
}

// 目录项里的强度列表：claude 是 supportedEffortLevels（字符串），codex 是 supportedReasoningEfforts（字符串或带 reasoningEffort 的对象）。
// supportsEffort 明确为 false 的模型没有强度可选
function extractEfforts(item) {
    const source = item && typeof item === 'object' ? item : {};
    if (source.supportsEffort === false) {
        return [];
    }
    const raw = Array.isArray(source.supportedEffortLevels)
        ? source.supportedEffortLevels
        : (Array.isArray(source.supportedReasoningEfforts) ? source.supportedReasoningEfforts : []);
    const levels = [];
    for (const entry of raw) {
        const value = typeof entry === 'string'
            ? entry
            : (entry && typeof entry === 'object' ? (entry.reasoningEffort || entry.effort || entry.value) : '');
        if (isEffortValue(value) && !levels.includes(value)) {
            levels.push(value);
        }
        if (levels.length >= MAX_LEVELS) {
            break;
        }
    }
    return levels;
}

// 当前模型能选的强度。claude：当前模型对应目录项（没选模型用 default 项；选了目录里没有的模型不显示）；codex：id 必须和当前模型一致，找不到就不显示
function effortLevelsFor(agentProgram, catalog, currentModel) {
    const entries = Array.isArray(catalog) ? catalog : [];
    const model = typeof currentModel === 'string' ? currentModel.trim() : '';
    let entry = null;
    if (agentProgram === 'claude') {
        // 选了目录里没有的模型（自定义名字）就不知道它支不支持，宁可不显示
        entry = model
            ? entries.find(item => item.value === model || item.resolvedModel === model) || null
            : entries.find(item => item.value === 'default') || null;
    } else if (agentProgram === 'codex') {
        entry = model ? entries.find(item => item.value === model) || null : null;
    }
    return entry && Array.isArray(entry.efforts) ? entry.efforts : [];
}

module.exports = {
    isEffortValue,
    extractEfforts,
    effortLevelsFor
};
