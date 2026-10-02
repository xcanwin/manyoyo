'use strict';

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../.github/workflows');
const files = fs.readdirSync(dir).filter(name => name.endsWith('.yml'));

describe('workflow runners are pinned', () => {
    test.each(files)('%s never uses a floating *-latest runner (ubuntu-latest will silently become Ubuntu 26)', name => {
        const text = fs.readFileSync(path.join(dir, name), 'utf8');
        expect(text).not.toMatch(/runs-on:\s*\S*-latest/);
        for (const match of text.matchAll(/runs-on:\s*(\S+)/g)) {
            const value = match[1];
            if (value.startsWith('${{')) continue; // matrix 里单独检查
            expect(value).toMatch(/^(ubuntu-24\.04(-arm)?|macos-15(-intel)?)$/);
        }
    });

    test('the offline workflow matrix runners are pinned macOS 15 images', () => {
        const text = fs.readFileSync(path.join(dir, 'offline-macos.yml'), 'utf8');
        const runners = [...text.matchAll(/runner:\s*(\S+)/g)].map(m => m[1]);
        expect(runners.sort()).toEqual(['macos-15', 'macos-15-intel']);
    });

    test('the linux offline workflow matrix runners are pinned Ubuntu 24.04 images (x64 and arm64)', () => {
        const text = fs.readFileSync(path.join(dir, 'offline-linux.yml'), 'utf8');
        const runners = [...text.matchAll(/runner:\s*(\S+)/g)].map(m => m[1]);
        expect(runners.sort()).toEqual(['ubuntu-24.04', 'ubuntu-24.04-arm']);
    });

    test('the workflows we test ourselves use Node 24-based action majors (no Node 20 deprecation warnings)', () => {
        for (const name of ['image-publish.yml', 'offline-macos.yml', 'offline-linux.yml']) {
            const text = fs.readFileSync(path.join(dir, name), 'utf8');
            expect(text).not.toMatch(/(checkout|setup-node|upload-artifact|download-artifact)@v4/);
            expect(text).not.toMatch(/docker\/(login|setup-buildx|setup-qemu)-action@v3|build-push-action@v6/);
        }
    });
});
