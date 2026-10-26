'use strict';

// 归档里的创建参数（runtimeSnapshot）来自别人时，哪些设置会让导入后的容器拥有更大的权限，
// 以及用户没有逐项确认时怎么处理。导出端把摘要写进清单，导入端据此让用户确认，并在建容器前过滤。

const path = require('path');
const { normalizePolicy, isUnrestricted } = require('../network-policy');

const RISKY_MODES = new Set(['sock', 'dind']);

function asArray(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function volumeSource(volume) {
    const first = String(volume).split(':')[0];
    return first.startsWith('/') || first.startsWith('~') ? first : '';
}

// 网络“不限制”：自定义里只有“允许任何地址”。策略读不懂时按“不限制”处理（宁可多问一次）
function isNetworkOpen(network) {
    if (!network || typeof network !== 'object') return false;
    try {
        return isUnrestricted(normalizePolicy(network));
    } catch (error) {
        return true;
    }
}

/**
 * 摘要：{ containerMode, volumes, ports, autostart, networkOpen }
 * autostartText：状态目录里的自启动脚本（快照里的 autostart 为空时用它）。
 */
function summarizeRisks(snapshot, autostartText = '') {
    const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const autostart = String(snap.autostart || autostartText || '').trim();
    return {
        containerMode: RISKY_MODES.has(snap.containerMode) ? snap.containerMode : '',
        volumes: asArray(snap.volumes),
        ports: asArray(snap.ports),
        autostart: autostart.length > 0,
        networkOpen: isNetworkOpen(snap.network)
    };
}

/**
 * 按用户确认过滤快照，得到可交给 buildCreateRuntime 的 createOptions。
 * confirm：{ containerMode, volumes: [字符串], ports: bool, autostart: bool, networkOpen: bool }
 * options：{ hostPath, imageMode, pathExists(p) }
 * 返回 { createOptions, dropped: [说明] }。first 永远不带；containerPath 保持原样（续接依赖它）。
 */
function buildImportCreateOptions(snapshot, confirm, options) {
    const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const ok = confirm && typeof confirm === 'object' ? confirm : {};
    const pathExists = options.pathExists || (() => false);
    const dropped = [];
    const createOptions = {
        hostPath: options.hostPath,
        containerPath: typeof snap.containerPath === 'string' ? snap.containerPath : '',
        shellPrefix: snap.shellPrefix || '',
        shell: snap.shell || '',
        shellSuffix: snap.shellSuffix || '',
        agentPromptCommand: snap.agentPromptCommand || '',
        yolo: snap.yolo || '',
        env: snap.env && typeof snap.env === 'object' && !Array.isArray(snap.env) ? snap.env : {},
        systemPrompt: snap.systemPrompt || undefined
    };
    if (options.imageMode !== 'default') {
        createOptions.imageName = snap.imageName || '';
        createOptions.imageVersion = snap.imageVersion || '';
    }
    if (RISKY_MODES.has(snap.containerMode)) {
        if (ok.containerMode === snap.containerMode) createOptions.containerMode = snap.containerMode;
        else dropped.push(`容器模式 ${snap.containerMode} 未确认，改用普通模式`);
    } else {
        createOptions.containerMode = snap.containerMode || '';
    }
    const confirmedVolumes = new Set(asArray(ok.volumes));
    createOptions.volumes = asArray(snap.volumes).filter(volume => {
        if (!confirmedVolumes.has(volume)) { dropped.push(`挂载 ${volume} 未确认`); return false; }
        const source = volumeSource(volume);
        if (source && !pathExists(source.startsWith('~') ? path.join(process.env.HOME || '', source.slice(1)) : source)) {
            dropped.push(`挂载 ${volume} 的宿主机路径在本机不存在`);
            return false;
        }
        return true;
    });
    createOptions.ports = ok.ports === true ? asArray(snap.ports) : [];
    if (!createOptions.ports.length && asArray(snap.ports).length) dropped.push('端口映射未确认');
    createOptions.autostart = ok.autostart === true ? String(snap.autostart || '') : '';
    if (snap.autostart && ok.autostart !== true) dropped.push('自启动脚本未确认');
    createOptions.envFile = asArray(snap.envFile).filter(file => path.isAbsolute(file) && pathExists(file));
    if (snap.network && typeof snap.network === 'object') {
        if (isNetworkOpen(snap.network) && ok.networkOpen !== true) dropped.push('网络“不限制”未确认，改用默认的受限网络');
        else {
            createOptions.network = snap.network;
            createOptions.confirmRisk = true;
        }
    }
    return { createOptions, dropped };
}

module.exports = { summarizeRisks, buildImportCreateOptions, isNetworkOpen, RISKY_MODES };
