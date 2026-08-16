const { bootstrapFirstRun } = require('../lib/first-run-setup');

describe('首次 run 初始化', () => {
    test('仅在缺少配置且执行 run 时自动初始化所有 Agent', async () => {
        const calls = [];
        const initialized = await bootstrapFirstRun({
            action: 'run',
            configExists: false,
            initialize: async () => calls.push('initialize'),
            log: message => calls.push(message)
        });

        expect(initialized).toBe(true);
        expect(calls).toEqual([
            '🧭 检测到首次运行，正在自动初始化 Agent 配置…',
            'initialize',
            '✅ 首次配置已创建，继续启动容器。'
        ]);
    });

    test('已有配置或非 run 操作不重复初始化', async () => {
        const initialize = jest.fn();
        await expect(bootstrapFirstRun({ action: 'run', configExists: true, initialize })).resolves.toBe(false);
        await expect(bootstrapFirstRun({ action: 'doctor', configExists: false, initialize })).resolves.toBe(false);
        expect(initialize).not.toHaveBeenCalled();
    });
});
