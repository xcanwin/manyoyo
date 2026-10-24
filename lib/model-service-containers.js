'use strict';

// 模型服务改了 Key / 地址 / 模型后，已有容器的 box/env 里还是创建时写进去的旧值。
// 这里按“env 里的 Key 等于旧 Key”找出还在用它的容器，并把新值写进它们的 box/env（每次 exec 都会重新读，下一轮对话生效，不用重建）。
// 只改指定的几个变量（整行替换，没有就追加，要删的删掉），其余行和注释原样保留。
const state = require('./container-state');
const { formatEnvValue, parseEnvText } = require('./env-text');
const { parseEnvEntry } = require('./runtime-normalizers');

/** containers：[{ name, id }]（受管容器）；返回 box/env 里 keyEnv 的值等于 keyValue 的那些 */
function findUsingContainers({ homeDir, containers, keyEnv, keyValue }) {
    if (!keyEnv || !keyValue) return [];
    return containers.filter(item => {
        if (!state.stateExists(homeDir, item.id)) return false;
        const { entries } = parseEnvText(state.readEnv(homeDir, item.id).text);
        return entries.some(entry => entry.key === keyEnv && entry.value === keyValue);
    });
}

/** 返回改写后的 env 文本；set：{ KEY: 新值 }，remove：[KEY…] */
function rewriteEnvText(text, { set = {}, remove = [] }) {
    const lines = String(text || '').split('\n');
    const { entries } = parseEnvText(text);
    const handled = new Set();
    const drop = new Set();
    entries.forEach(entry => {
        if (Object.prototype.hasOwnProperty.call(set, entry.key)) {
            lines[entry.line - 1] = `${entry.key}=${formatEnvValue(String(set[entry.key]))}`;
            handled.add(entry.key);
        } else if (remove.includes(entry.key)) {
            drop.add(entry.line - 1);
        }
    });
    let out = lines.filter((_, index) => !drop.has(index)).join('\n');
    const missing = Object.keys(set).filter(key => !handled.has(key));
    if (missing.length) {
        if (out && !out.endsWith('\n')) out += '\n';
        out += missing.map(key => `${key}=${formatEnvValue(String(set[key]))}`).join('\n');
    }
    return out && !out.endsWith('\n') ? `${out}\n` : out;
}

function applyToContainers({ homeDir, targets, set, remove }) {
    const updated = [];
    for (const item of targets) {
        const current = state.readEnv(homeDir, item.id);
        // 读到的 etag 随写随比，容器里同时改过就跳过这一个，不覆盖别人的修改
        try {
            state.writeEnv(homeDir, item.id, rewriteEnvText(current.text, { set, remove }), { ifMatch: current.etag, parseEnvEntry });
            updated.push(item.name);
        } catch (e) {
            if (e.code !== 'CONFLICT') throw e;
        }
    }
    return updated;
}

module.exports = { findUsingContainers, rewriteEnvText, applyToContainers };
