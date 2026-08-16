const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    buildCrxUrl,
    convertManifestV2ToV3,
    crxZipOffset
} = require('../lib/plugin/playwright-extensions');

describe('Playwright 扩展工具', () => {
    test('构建 Chrome CRX 下载地址', () => {
        expect(buildCrxUrl('extension-id', '132.0.0.0')).toContain('id%3Dextension-id');
        expect(buildCrxUrl('extension-id', '132.0.0.0')).toContain('prodversion=132.0.0.0');
    });

    test('将 MV2 manifest 转换为 MV3 并保留 host permission', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-extension-'));
        try {
            fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
                manifest_version: 2,
                browser_action: { default_title: 'Example' },
                permissions: ['storage', 'https://example.com/*'],
                web_accessible_resources: ['script.js']
            }));

            expect(convertManifestV2ToV3(directory)).toBe(true);
            expect(JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))).toMatchObject({
                manifest_version: 3,
                action: { default_title: 'Example' },
                permissions: ['storage'],
                host_permissions: ['https://example.com/*'],
                web_accessible_resources: [{ resources: ['script.js'], matches: ['<all_urls>'] }]
            });
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('解析 CRX v2 与 v3 的 zip 起始位置', () => {
        const v2 = Buffer.alloc(24);
        v2.write('Cr24');
        v2.writeUInt32LE(2, 4);
        v2.writeUInt32LE(4, 8);
        v2.writeUInt32LE(4, 12);
        expect(crxZipOffset(v2)).toBe(24);

        const v3 = Buffer.alloc(20);
        v3.write('Cr24');
        v3.writeUInt32LE(3, 4);
        v3.writeUInt32LE(8, 8);
        expect(crxZipOffset(v3)).toBe(20);
    });
});
