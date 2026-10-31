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

// 需要确认的网络设置：任何“自定义”策略（里面可能放行内网 / 元数据地址，或干脆不限制），策略读不懂时也算（宁可多问一次）
function isNetworkOpen(network) {
    if (!network || typeof network !== 'object') return false;
    try {
        const policy = normalizePolicy(network);
        return policy.preset === 'custom' || isUnrestricted(policy);
    } catch (error) {
        return true;
    }
}

// 默认只信任 manyoyo 自己的镜像名：归档里写别的镜像名会让导入后的容器拉取并运行别人指定的镜像（带着工作目录）
const TRUSTED_IMAGE_NAMES = ['ghcr.io/xcanwin/manyoyo', 'localhost/xcanwin/manyoyo'];

/**
 * 摘要：{ containerMode, volumes, ports, autostart, envFiles, networkOpen }
 * autostartText：状态目录里的自启动脚本（快照里的 autostart 为空时用它）；state：{ network, envFiles } 状态目录里当前的值。
 */
function summarizeRisks(snapshot, autostartText = '', state = {}) {
    const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const autostart = String(snap.autostart || autostartText || '').trim();
    // 面板里改过的网络规则、环境变量文件在状态目录里，以它为准；没有时才看建容器时的快照
    const network = state.network && typeof state.network === 'object' ? state.network : snap.network;
    const envFiles = Array.isArray(state.envFiles) ? state.envFiles : asArray(snap.envFile);
    return {
        containerMode: RISKY_MODES.has(snap.containerMode) ? snap.containerMode : '',
        volumes: asArray(snap.volumes),
        ports: asArray(snap.ports),
        autostart: autostart.length > 0,
        envFiles: asArray(envFiles),
        networkOpen: isNetworkOpen(network)
    };
}

/**
 * 按用户确认过滤快照，得到可交给 buildCreateRuntime 的 createOptions。
 * confirm：{ containerMode, volumes: [字符串], ports: bool, autostart: bool, envFiles: [路径], networkOpen: bool }
 * options：{ hostPath, imageMode, pathExists(p), trustedImages? }
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
        const trusted = [...TRUSTED_IMAGE_NAMES, ...asArray(options.trustedImages)];
        if (snap.imageName && !trusted.includes(String(snap.imageName))) {
            dropped.push(`镜像 ${String(snap.imageName).slice(0, 80)} 不是 manyoyo 的镜像，改用本机默认镜像`);
        } else {
            createOptions.imageName = snap.imageName || '';
            createOptions.imageVersion = snap.imageVersion || '';
        }
    }
    if (RISKY_MODES.has(snap.containerMode)) {
        if (ok.containerMode === snap.containerMode) createOptions.containerMode = snap.containerMode;
        else dropped.push(`容器模式 ${snap.containerMode} 没勾选，改用普通模式`);
    } else {
        createOptions.containerMode = snap.containerMode || '';
    }
    const confirmedVolumes = new Set(asArray(ok.volumes));
    createOptions.volumes = asArray(snap.volumes).filter(volume => {
        if (!confirmedVolumes.has(volume)) { dropped.push(`额外挂载 ${volume} 没勾选，没有挂上`); return false; }
        const source = volumeSource(volume);
        if (source && !pathExists(source.startsWith('~') ? path.join(process.env.HOME || '', source.slice(1)) : source)) {
            dropped.push(`额外挂载 ${volume} 的宿主机路径在本机不存在，没有挂上`);
            return false;
        }
        return true;
    });
    createOptions.ports = ok.ports === true ? asArray(snap.ports) : [];
    if (!createOptions.ports.length && asArray(snap.ports).length) dropped.push('端口映射没勾选，没有映射');
    createOptions.autostart = ok.autostart === true ? String(snap.autostart || '') : '';
    if (snap.autostart && ok.autostart !== true) dropped.push('自启动脚本没勾选，没有带上');
    // 环境变量文件里的内容会进容器环境：宿主机上的任意绝对路径，必须逐个确认
    const confirmedEnvFiles = new Set(asArray(ok.envFiles));
    createOptions.envFile = asArray(snap.envFile).filter(file => {
        if (!path.isAbsolute(file) || !pathExists(file)) return false;
        if (!confirmedEnvFiles.has(file)) { dropped.push(`环境变量文件 ${file} 没勾选，没有带上`); return false; }
        return true;
    });
    if (snap.network && typeof snap.network === 'object') {
        if (isNetworkOpen(snap.network) && ok.networkOpen !== true) {
            dropped.push('自定义网络规则没勾选，改用默认的受限网络');
        } else {
            createOptions.network = snap.network;
            // 用户确认过“自定义”才跳过后面的风险检查；其它策略仍要过 buildCreateRuntime 里的宽规则检查
            if (ok.networkOpen === true) createOptions.confirmRisk = true;
        }
    }
    return { createOptions, dropped };
}

module.exports = { summarizeRisks, buildImportCreateOptions, isNetworkOpen, RISKY_MODES, TRUSTED_IMAGE_NAMES };
