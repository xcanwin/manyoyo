'use strict';

const { detectHeadless, parseLauncherArgs } = require('../lib/headless');

describe('detectHeadless', () => {
    const cases = [
        // [说明, 平台, 环境变量, force, 期望 headless]
        ['linux 桌面（X11）', 'linux', { DISPLAY: ':0' }, null, false],
        ['linux 桌面（Wayland）', 'linux', { WAYLAND_DISPLAY: 'wayland-0' }, null, false],
        ['linux 没有图形环境', 'linux', {}, null, true],
        ['linux DISPLAY 为空串', 'linux', { DISPLAY: '', WAYLAND_DISPLAY: ' ' }, null, true],
        ['linux 桌面上的 SSH 会话（SSH_CONNECTION）', 'linux', { DISPLAY: ':0', SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }, null, true],
        ['linux 桌面上的 SSH 会话（SSH_TTY）', 'linux', { DISPLAY: ':0', SSH_TTY: '/dev/pts/1' }, null, true],
        ['macOS 本地', 'darwin', {}, null, false],
        ['macOS 的 SSH 会话', 'darwin', { SSH_CONNECTION: 'a b c d' }, null, true],
        ['环境变量强制无头', 'linux', { DISPLAY: ':0', MANYOYO_HEADLESS: '1' }, null, true],
        ['环境变量强制有头（压过 SSH 与无显示）', 'linux', { SSH_TTY: '/dev/pts/1', MANYOYO_HEADLESS: '0' }, null, false],
        ['命令行 --headless 压过环境变量', 'darwin', { MANYOYO_HEADLESS: '0' }, true, true],
        ['命令行 --gui 压过一切', 'linux', { SSH_CONNECTION: 'x', MANYOYO_HEADLESS: '1' }, false, false],
        ['无法识别的 MANYOYO_HEADLESS 值被忽略', 'linux', { DISPLAY: ':0', MANYOYO_HEADLESS: 'maybe' }, null, false]
    ];
    test.each(cases)('%s', (name, platform, env, force, expected) => {
        const result = detectHeadless({ platform, env, force });
        expect(result.headless).toBe(expected);
        expect(result.reason).not.toBe('');
    });
});

describe('parseLauncherArgs', () => {
    test('only --headless / --gui count as launcher arguments', () => {
        expect(parseLauncherArgs([])).toEqual({ force: null });
        expect(parseLauncherArgs(['--headless'])).toEqual({ force: true });
        expect(parseLauncherArgs(['--gui'])).toEqual({ force: false });
        expect(parseLauncherArgs(['--headless', '--gui'])).toBeNull();
        expect(parseLauncherArgs(['serve'])).toBeNull();
        expect(parseLauncherArgs(['--headless', 'run'])).toBeNull();
    });
});
