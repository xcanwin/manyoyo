const {
    SCENE_ORDER,
    SCENE_DEFS,
    isCliScene,
    isCliSessionScene,
    isMcpScene
} = require('../lib/plugin/playwright-scenes');

describe('Playwright 场景定义', () => {
    test('保持既有场景顺序与运行位置', () => {
        expect(SCENE_ORDER).toEqual([
            'mcp-cont-headless',
            'mcp-cont-headed',
            'mcp-host-headless',
            'mcp-host-headed',
            'cli-host-headless',
            'cli-host-headed',
            'dev-host-headed'
        ]);
        expect(SCENE_DEFS['mcp-cont-headless']).toMatchObject({ type: 'container', engine: 'mcp', portKey: 'mcpContHeadless' });
        expect(SCENE_DEFS['cli-host-headed']).toMatchObject({ type: 'host', engine: 'cli', portKey: 'cliHostHeaded' });
        expect(SCENE_DEFS['dev-host-headed']).toMatchObject({ type: 'host', engine: 'dev' });
    });

    test('场景分类与 CLI 会话资格保持稳定', () => {
        expect(isMcpScene('mcp-cont-headed')).toBe(true);
        expect(isCliScene('cli-host-headless')).toBe(true);
        expect(isCliSessionScene('cli-host-headed')).toBe(true);
        expect(isCliSessionScene('dev-host-headed')).toBe(true);
        expect(isCliSessionScene('mcp-host-headed')).toBe(false);
    });
});
