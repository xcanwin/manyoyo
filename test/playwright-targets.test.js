const { resolveSceneTargets } = require('../lib/plugin/playwright-targets');

describe('Playwright 场景目标选择', () => {
    const config = {
        runtime: 'mixed',
        enabledScenes: ['mcp-cont-headless', 'mcp-host-headed', 'cli-host-headless']
    };

    test('all 按稳定场景顺序筛选启用项', () => {
        expect(resolveSceneTargets('all', config)).toEqual([
            'mcp-cont-headless',
            'mcp-host-headed',
            'cli-host-headless'
        ]);
    });

    test('runtime 仅保留对应 host 或 container 场景', () => {
        expect(resolveSceneTargets('all', { ...config, runtime: 'host' })).toEqual([
            'mcp-host-headed',
            'cli-host-headless'
        ]);
        expect(() => resolveSceneTargets('mcp-cont-headless', { ...config, runtime: 'host' })).toThrow('不允许场景');
    });

    test('拒绝未知或未启用场景', () => {
        expect(() => resolveSceneTargets('unknown', config)).toThrow('未知场景');
        expect(() => resolveSceneTargets('mcp-cont-headed', config)).toThrow('场景未启用');
    });
});
