'use strict';

const { normalizePolicy, defaultPolicy } = require('./network-policy');

const MAX_AUTOSTART_BYTES = 256 * 1024;

function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined(...values) {
    return values.find(value => value !== undefined && value !== null);
}

/**
 * 新建容器时的自启动与网络：命令行 / Web 请求 > runs.<name> > 全局配置，标量与对象都是整体覆盖。
 * 字段：`autostart`（脚本文本）、`autostartOnServe`（serve 启动时自动拉起）、`network`（策略，见 lib/network-policy.js）。
 * @returns {{autostart: string, network: object, fromRequest: boolean}} network 已校验，autostartOnServe 并进 network
 */
function resolveManageOptions({ requestOptions = {}, runConfig = {}, globalConfig = {} } = {}) {
    const layers = [requestOptions, runConfig, globalConfig];
    const autostart = firstDefined(...layers.map(l => l.autostart));
    if (autostart !== undefined && typeof autostart !== 'string') throw new Error('autostart 必须是字符串（脚本文本）');
    if (typeof autostart === 'string' && Buffer.byteLength(autostart) > MAX_AUTOSTART_BYTES) throw new Error('autostart 脚本过大');
    const network = firstDefined(...layers.map(l => l.network));
    if (network !== undefined && !isPlainObject(network)) throw new Error('network 必须是对象');
    const onServe = firstDefined(...layers.map(l => l.autostartOnServe));
    const policy = normalizePolicy({
        ...(network || defaultPolicy()),
        autostartOnServe: onServe === undefined ? (network && network.autostartOnServe) : onServe === true
    });
    return { autostart: autostart || '', network: policy, fromRequest: requestOptions.network !== undefined };
}

module.exports = { resolveManageOptions, MAX_AUTOSTART_BYTES };
