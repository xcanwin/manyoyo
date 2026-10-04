'use strict';

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../.github/workflows');
const text = fs.readFileSync(path.join(dir, 'build-packages.yml'), 'utf8');

function jobBlock(name) {
    const start = text.indexOf(`\n  ${name}:\n`);
    expect(start).toBeGreaterThan(-1);
    const next = text.slice(start + 1).search(/\n  [a-z-]+:\n/);
    return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

describe('build-packages workflow (macOS + Linux in one run)', () => {
    test('replaces the two old offline workflows', () => {
        expect(fs.existsSync(path.join(dir, 'offline-macos.yml'))).toBe(false);
        expect(fs.existsSync(path.join(dir, 'offline-linux.yml'))).toBe(false);
        expect(text).toContain('name: Build Packages');
    });

    test('is manual only, has no secrets and cannot create a Release or publish', () => {
        const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\nenv:'));
        expect(onBlock).toContain('workflow_dispatch:');
        expect(onBlock).not.toMatch(/^\s*(pull_request|schedule|release):/m);
        expect(text).not.toMatch(/secrets\./);
        expect(text).not.toMatch(/gh release|softprops|action-gh-release|npm publish|docker push/);
    });

    test('runners are pinned: macOS 15 arm64/Intel and Ubuntu 24.04 x64/arm64', () => {
        const runners = [...text.matchAll(/runner:\s*(\S+)/g)].map(m => m[1]).sort();
        expect(runners).toEqual(['macos-15', 'macos-15-intel', 'ubuntu-24.04', 'ubuntu-24.04-arm']);
        expect(text).toMatch(/image-archive:\n\s+runs-on: ubuntu-24\.04\n/);
    });

    test('only image-archive pulls the image; the four platform jobs download the artifact instead', () => {
        expect(text.match(/docker pull/g) || []).toHaveLength(1);
        expect(text.match(/docker save/g) || []).toHaveLength(1);
        for (const name of ['build-macos', 'build-linux']) {
            const job = jobBlock(name);
            expect(job).toContain('needs: image-archive');
            expect(job).toContain('actions/download-artifact@v8');
            expect(job).not.toMatch(/docker (pull|save)/);
            expect(job).not.toContain('scan-allowlist-image.json');
        }
    });

    test('the image scan runs once per architecture, cached by image ID + allowlist + scanner hash', () => {
        const archive = jobBlock('image-archive');
        expect(archive).toContain('docker image inspect');
        expect(archive).toContain('{{.Id}}');
        expect(archive).toContain('actions/cache@v5');
        expect(archive).toContain('hashFiles(');
        expect(archive).toContain('scan-allowlist-image.json');
        expect(archive).toContain('scripts/scan-release-artifacts.js');
        expect(archive).toMatch(/steps\.scan-cache\.outputs\.cache-hit != 'true'/);
        expect(archive.indexOf('node scripts/scan-release-artifacts.js')).toBeLessThan(archive.indexOf('actions/upload-artifact@v7'));
    });

    test('artifacts holding already-compressed files are uploaded with compression-level: 0', () => {
        const uploads = text.split('actions/upload-artifact@v7').slice(1);
        expect(uploads).toHaveLength(3);
        uploads.forEach(chunk => expect(chunk.split('\n\n')[0]).toContain('compression-level: 0'));
    });

    test('the packaged tree is still scanned in every platform job, before the upload', () => {
        for (const [name, allowlist] of [['build-macos', 'scan-allowlist.json'], ['build-linux', 'scan-allowlist-linux.json']]) {
            const job = jobBlock(name);
            expect(job).toContain('name: Scan packaged tree');
            expect(job).toContain(allowlist);
            expect(job.indexOf('node scripts/scan-release-artifacts.js')).toBeLessThan(job.indexOf('actions/upload-artifact@v7'));
        }
        expect(text).toContain("--exclude '^full/images(/|$)' --exclude '^full/vm(/|$)'");
        expect(text).toContain("--exclude '^lite/images(/|$)'");
    });

    test('artifact names keep the per-platform naming that release-offline downloads', () => {
        expect(text).toContain('name: manyoyo-${{ steps.version.outputs.version }}-macos-${{ matrix.arch }}');
        expect(text).toContain('name: manyoyo-${{ steps.version.outputs.version }}-linux-${{ matrix.arch }}');
        expect(text).toContain('name: manyoyo-image-${{ steps.version.outputs.imageVersion }}-${{ matrix.arch }}');
        expect(text).toContain('--platform linux');
        expect(text).toContain('brew install gnu-tar');
        expect(text).toContain('steps.files.outputs.list');
        expect(jobBlock('build-linux')).not.toMatch(/podman/);
    });

    test('the macOS VM disk is cached by podman version + arch + ISO week', () => {
        const job = jobBlock('build-macos');
        expect(job).toContain('MANYOYO_VM_DISK_CACHE_DIR');
        expect(job).toMatch(/key: vm-disk-[^\n]*matrix\.arch[^\n]*week/);
        expect(job).toContain('date -u +%G-W%V');
        expect(job).toContain('scripts/offline/lock.js');
    });

    test('only needs read permissions (packages: read for the pull)', () => {
        expect(text).toContain('packages: read');
        expect(text).not.toMatch(/contents: write|packages: write/);
    });
});
