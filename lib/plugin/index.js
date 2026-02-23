'use strict';

const { PlaywrightPlugin } = require('./playwright');

const AVAILABLE_PLUGINS = ['playwright'];

function asObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value;
}

function getPluginConfigs(pluginName, globalConfig, runConfig) {
    const globalPlugins = asObject(asObject(globalConfig).plugins);
    const runPlugins = asObject(asObject(runConfig).plugins);
    return {
        globalPluginConfig: asObject(globalPlugins[pluginName]),
        runPluginConfig: asObject(runPlugins[pluginName])
    };
}

function createPlugin(pluginName, options = {}) {
    if (pluginName !== 'playwright') {
        throw new Error(`未知插件: ${pluginName}`);
    }

    const cfg = getPluginConfigs(pluginName, options.globalConfig, options.runConfig);
    return new PlaywrightPlugin({
        projectRoot: options.projectRoot,
        stdout: options.stdout,
        stderr: options.stderr,
        globalConfig: cfg.globalPluginConfig,
        runConfig: cfg.runPluginConfig
    });
}

async function runPluginCommand(request, options = {}) {
    const action = String(request && request.action || '').trim();

    if (action === 'ls') {
        const plugin = createPlugin('playwright', options);
        return await plugin.run({ action: 'ls' });
    }

    const pluginName = String(request && request.pluginName || '').trim();
    if (!pluginName) {
        throw new Error('plugin 名称不能为空');
    }

    const plugin = createPlugin(pluginName, options);
    return await plugin.run({
        action,
        scene: request.scene,
        host: request.host,
        extensions: request.extensions,
        prodversion: request.prodversion
    });
}

module.exports = {
    AVAILABLE_PLUGINS,
    createPlugin,
    runPluginCommand
};
