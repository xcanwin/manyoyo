'use strict';

const path = require('path');
const { SCENE_DEFS, SCENE_ORDER, isCliSessionScene } = require('./playwright-scenes');

const VALID_RUNTIME = new Set(['container', 'host', 'mixed']);
const DEFAULT_NAVIGATOR_PLATFORM = 'MacIntel';

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asStringArray(value, fallback) {
    if (!Array.isArray(value)) {
        return fallback;
    }
    return value.map(item => String(item || '').trim()).filter(Boolean);
}

function asBoolean(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') {
            return true;
        }
        if (normalized === 'false') {
            return false;
        }
    }
    return fallback;
}

function resolvePlaywrightConfig(options = {}) {
    const homeDir = String(options.homeDir || '').trim();
    const composeDir = String(options.composeDir || '').trim();
    const globalConfig = asObject(options.globalConfig);
    const runConfig = asObject(options.runConfig);
    const resolveContainerRuntime = typeof options.resolveContainerRuntime === 'function'
        ? options.resolveContainerRuntime
        : value => value || 'docker';
    const pluginRootDir = path.join(homeDir, '.manyoyo', 'plugin', 'playwright');
    const defaultConfig = {
        homeDir,
        runtime: 'mixed',
        enabledScenes: [...SCENE_ORDER],
        cliSessionScene: 'cli-host-headless',
        mcpDefaultHost: 'host.docker.internal',
        dockerTag: options.dockerTag || 'latest',
        containerRuntime: '',
        vncPasswordEnvKey: 'VNC_PASSWORD',
        headedImage: 'localhost/xcanwin/manyoyo-playwright-headed',
        configDir: path.join(pluginRootDir, 'config'),
        runDir: path.join(pluginRootDir, 'run'),
        extensionProdversion: '132.0.0.0',
        navigatorPlatform: DEFAULT_NAVIGATOR_PLATFORM,
        disableWebRTC: false,
        devtoolsActivePortPath: '',
        devtoolsCdpTimeout: 60000,
        composeDir,
        ports: {
            mcpContHeadless: 8931,
            mcpContHeaded: 8932,
            mcpHostHeadless: 8933,
            mcpHostHeaded: 8934,
            cliHostHeadless: 8935,
            cliHostHeaded: 8936,
            mcpContHeadedNoVnc: 6080
        }
    };
    const merged = {
        ...defaultConfig,
        ...globalConfig,
        ...runConfig,
        ports: {
            ...defaultConfig.ports,
            ...asObject(globalConfig.ports),
            ...asObject(runConfig.ports)
        }
    };

    merged.runtime = String(merged.runtime || defaultConfig.runtime).trim().toLowerCase();
    if (!VALID_RUNTIME.has(merged.runtime)) {
        throw new Error(`playwright.runtime 无效: ${merged.runtime}`);
    }
    merged.enabledScenes = asStringArray(
        runConfig.enabledScenes,
        asStringArray(globalConfig.enabledScenes, [...defaultConfig.enabledScenes])
    );
    merged.containerRuntime = resolveContainerRuntime(merged.containerRuntime);
    merged.cliSessionScene = String(merged.cliSessionScene || defaultConfig.cliSessionScene).trim();
    merged.navigatorPlatform = String(merged.navigatorPlatform || defaultConfig.navigatorPlatform).trim() || defaultConfig.navigatorPlatform;
    merged.disableWebRTC = asBoolean(merged.disableWebRTC, defaultConfig.disableWebRTC);
    if (merged.enabledScenes.length === 0) {
        throw new Error('playwright.enabledScenes 不能为空');
    }
    const invalidScene = merged.enabledScenes.find(scene => !SCENE_DEFS[scene]);
    if (invalidScene) {
        throw new Error(`playwright.enabledScenes 包含未知场景: ${invalidScene}`);
    }
    merged.devtoolsActivePortPath = String(merged.devtoolsActivePortPath || '').trim();
    merged.devtoolsCdpTimeout = Number(merged.devtoolsCdpTimeout) || defaultConfig.devtoolsCdpTimeout;
    if (merged.cliSessionScene && !isCliSessionScene(merged.cliSessionScene)) {
        throw new Error(`playwright.cliSessionScene 无效: ${merged.cliSessionScene}`);
    }
    return merged;
}

module.exports = {
    DEFAULT_NAVIGATOR_PLATFORM,
    resolvePlaywrightConfig
};
