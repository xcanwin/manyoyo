const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    buildContainerExtensionMounts,
    resolveExtensionInputs
} = require('../lib/plugin/playwright-extension-paths');

describe('Playwright 扩展路径处理', () => {
    test('支持直接扩展目录和扩展集合目录，并去重', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ext-paths-'));
        try {
            const direct = path.join(root, 'direct');
            const bundle = path.join(root, 'bundle');
            const nested = path.join(bundle, 'nested');
            fs.mkdirSync(direct, { recursive: true });
            fs.mkdirSync(nested, { recursive: true });
            fs.writeFileSync(path.join(direct, 'manifest.json'), '{}');
            fs.writeFileSync(path.join(nested, 'manifest.json'), '{}');

            expect(resolveExtensionInputs({ extensionPaths: [direct, bundle, direct] })).toEqual([direct, nested]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('命名扩展不接受路径穿越，容器挂载只读且路径稳定', () => {
        expect(() => resolveExtensionInputs({
            extensionNames: ['../unsafe'],
            extensionRoot: '/tmp/extensions'
        })).toThrow('扩展名称无效');

        expect(buildContainerExtensionMounts(['/tmp/Hello Extension', '/tmp/second'])).toEqual({
            containerPaths: ['/app/extensions/ext-1-Hello-Extension', '/app/extensions/ext-2-second'],
            volumeMounts: [
                '/tmp/Hello Extension:/app/extensions/ext-1-Hello-Extension:ro',
                '/tmp/second:/app/extensions/ext-2-second:ro'
            ]
        });
    });
});
