const { resolvePlaywrightConfig } = require('../lib/plugin/playwright-config');

describe('Playwright 插件配置解析', () => {
    test('按 global → run 覆盖标量，并合并 ports', () => {
        const config = resolvePlaywrightConfig({
            homeDir: '/tmp/manyoyo-home',
            composeDir: '/tmp/playwright-assets',
            globalConfig: {
                runtime: 'container',
                mcpDefaultHost: 'global.example',
                ports: { mcpContHeadless: 9100, cliHostHeaded: 9101 }
            },
            runConfig: {
                mcpDefaultHost: 'run.example',
                enabledScenes: ['mcp-cont-headless'],
                ports: { cliHostHeaded: 9201 }
            },
            resolveContainerRuntime: () => 'podman'
        });

        expect(config).toMatchObject({
            runtime: 'container',
            mcpDefaultHost: 'run.example',
            containerRuntime: 'podman',
            enabledScenes: ['mcp-cont-headless'],
            ports: { mcpContHeadless: 9100, cliHostHeaded: 9201 },
            configDir: '/tmp/manyoyo-home/.manyoyo/plugin/playwright/config',
            composeDir: '/tmp/playwright-assets'
        });
    });

    test('拒绝未知场景、空场景和无效 CLI 会话场景', () => {
        const base = {
            homeDir: '/tmp/manyoyo-home',
            composeDir: '/tmp/playwright-assets',
            resolveContainerRuntime: () => 'docker'
        };

        expect(() => resolvePlaywrightConfig({ ...base, runConfig: { enabledScenes: [] } })).toThrow('不能为空');
        expect(() => resolvePlaywrightConfig({ ...base, runConfig: { enabledScenes: ['unknown'] } })).toThrow('未知场景');
        expect(() => resolvePlaywrightConfig({ ...base, runConfig: { cliSessionScene: 'mcp-host-headed' } })).toThrow('cliSessionScene 无效');
    });
});
