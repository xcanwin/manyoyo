'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadChatBehavior() {
    const scriptPath = path.join(__dirname, '..', 'lib', 'web', 'frontend', 'chat-behavior.js');
    const script = fs.readFileSync(scriptPath, 'utf-8');
    const window = {};
    const context = { window, globalThis: window, self: window, console };
    vm.runInNewContext(script, context, { filename: 'chat-behavior.js' });
    return window.ManyoyoChatBehavior;
}

describe('ManyoyoChatBehavior.isNearBottom', () => {
    const { isNearBottom } = loadChatBehavior();

    test('返回 true：滚动条已经在底部（distance = 0）', () => {
        expect(isNearBottom(160, 200, 40, 40)).toBe(true);
    });

    test('返回 true：距离底部正好等于阈值', () => {
        expect(isNearBottom(120, 200, 40, 40)).toBe(true);
    });

    test('返回 false：距离底部超过阈值（用户正在往上翻看历史）', () => {
        expect(isNearBottom(0, 200, 40, 40)).toBe(false);
    });

    test('返回 true：内容本身不足以滚动（scrollHeight <= clientHeight）', () => {
        expect(isNearBottom(0, 40, 200, 40)).toBe(true);
    });

    test('未传阈值时默认使用 40px', () => {
        expect(isNearBottom(160, 200, 40)).toBe(true);
        expect(isNearBottom(100, 200, 40)).toBe(false);
    });
});
