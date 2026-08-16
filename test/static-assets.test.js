'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStaticAssetResolver } = require('../lib/web/static-assets');

describe('static asset resolver', () => {
    let rootDir;

    beforeEach(() => {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-static-assets-'));
        fs.mkdirSync(path.join(rootDir, 'assets'), { recursive: true });
        fs.mkdirSync(path.join(rootDir, '.vite'), { recursive: true });
        fs.writeFileSync(path.join(rootDir, 'assets', 'main-abc.js'), 'export {};', 'utf-8');
        fs.writeFileSync(path.join(rootDir, '.vite', 'manifest.json'), JSON.stringify({
            'src/main.tsx': { file: 'assets/main-abc.js' }
        }), 'utf-8');
    });

    afterEach(() => {
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    test('serves only manifest-declared files below the dist root', () => {
        const resolver = createStaticAssetResolver(rootDir);

        expect(resolver.resolveViteAsset('assets/main-abc.js')).toBe(path.join(rootDir, 'assets', 'main-abc.js'));
        expect(resolver.resolveViteAsset('../package.json')).toBeNull();
        expect(resolver.resolveViteAsset('assets/%2e%2e/main-abc.js')).toBeNull();
        expect(resolver.resolveViteAsset('assets/unknown.js')).toBeNull();
    });
});
