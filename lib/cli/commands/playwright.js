'use strict';

function registerPlaywrightAliasCommands(command, dependencies) {
    const { appendArrayOption, selectPluginAction } = dependencies;

    command.command('ls')
        .description('列出 playwright 启用场景')
        .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
        .action(options => selectPluginAction({
            action: 'ls',
            pluginName: 'playwright',
            scene: 'all'
        }, options));

    ['up', 'down', 'status', 'health', 'logs'].forEach(action => {
        const sceneCommand = command.command(`${action} [scene]`)
            .description(`执行 playwright ${action} 场景（scene 默认 mcp-host-headless）`)
            .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)');

        if (action === 'up') {
            appendArrayOption(sceneCommand, '--ext-path <path>', '追加浏览器扩展目录（可多次传入；目录需包含 manifest.json）');
            appendArrayOption(sceneCommand, '--ext-name <name>', '追加 ~/.manyoyo/plugin/playwright/extensions/ 下的扩展目录名（可多次传入）');
        }

        sceneCommand.action((scene, options) => selectPluginAction({
            action,
            pluginName: 'playwright',
            scene: scene || 'mcp-host-headless',
            extensionPaths: action === 'up' ? (options.extPath || []) : [],
            extensionNames: action === 'up' ? (options.extName || []) : []
        }, options));
    });

    command.command('mcp-add')
        .description('输出 playwright 的 MCP 接入命令')
        .option('--host <host>', 'MCP URL 使用的主机名或IP (默认 host.docker.internal)')
        .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
        .action(options => selectPluginAction({
            action: 'mcp-add',
            pluginName: 'playwright',
            scene: 'all',
            host: options.host || ''
        }, options));

    command.command('cli-add')
        .description('输出 playwright-cli skill 安装命令')
        .action(() => selectPluginAction({
            action: 'cli-add',
            pluginName: 'playwright',
            scene: 'all'
        }));

    command.command('ext-download')
        .description('下载并解压 Playwright 扩展到 ~/.manyoyo/plugin/playwright/extensions/')
        .option('--prodversion <ver>', 'CRX 下载使用的 Chrome 版本号 (默认 132.0.0.0)')
        .action(options => selectPluginAction({
            action: 'ext-download',
            pluginName: 'playwright',
            scene: 'all',
            prodversion: options.prodversion || ''
        }, options));
}

module.exports = { registerPlaywrightAliasCommands };
