'use strict';

// 向导写配置的“构造新文本”部分：Web 接口（/api/setup/*）与命令行 `manyoyo setup` 共用，保证两边写出同样的配置。
// 只负责在原文上做局部替换（保留注释与其它字段），读写文件与校验由调用方负责。

const { upsertValueByPath } = require('./json5-text-edit');

const EMPTY_CONFIG_RAW = '{\n}\n';

function baseRawOf(snapshot) {
    return snapshot && snapshot.exists && String(snapshot.raw || '').trim() ? snapshot.raw : EMPTY_CONFIG_RAW;
}

function buildAgentConfigRaw(baseRaw, agent, profile) {
    return upsertValueByPath(baseRaw, ['runs', agent], JSON.stringify(profile, null, 4));
}

function buildPasswordConfigRaw(baseRaw, password) {
    return upsertValueByPath(baseRaw, ['serverPass'], JSON.stringify(password));
}

// 全部为官方默认且配置里本来没有 mirrors 时不需要写任何东西
function shouldWriteMirrors(parsedConfig, mirrors) {
    const hasExisting = Object.prototype.hasOwnProperty.call(parsedConfig || {}, 'mirrors');
    return hasExisting || Boolean(mirrors.apt || mirrors.npm || mirrors.pip);
}

function buildMirrorsConfigRaw(baseRaw, mirrors) {
    return upsertValueByPath(baseRaw, ['mirrors'], JSON.stringify(mirrors, null, 4));
}

module.exports = { EMPTY_CONFIG_RAW, baseRawOf, buildAgentConfigRaw, buildPasswordConfigRaw, shouldWriteMirrors, buildMirrorsConfigRaw };
