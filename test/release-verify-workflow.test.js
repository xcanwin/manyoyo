'use strict';

const fs = require('fs');
const path = require('path');

const text = fs.readFileSync(path.join(__dirname, '../.github/workflows/release-verify.yml'), 'utf8');

describe('release-verify workflow', () => {
    test('is manual only, read-only, needs no secrets and creates nothing', () => {
        expect(text).toMatch(/on:\s*\n\s*workflow_dispatch:/);
        expect(text).not.toMatch(/\n\s*(push|pull_request|release|schedule):/);
        expect(text).toMatch(/permissions:\s*\n\s*contents: read/);
        expect(text).not.toMatch(/secrets\./);
        expect(text).not.toMatch(/gh release (create|upload|delete)/);
    });

    test('matrix runners are pinned (Ubuntu 24.04 x64/arm64, macOS 15 arm64/Intel)', () => {
        const runners = [...text.matchAll(/runner:\s*(\S+)/g)].map(m => m[1]);
        expect(runners.sort()).toEqual(['macos-15', 'macos-15-intel', 'ubuntu-24.04', 'ubuntu-24.04-arm']);
        expect(text).not.toMatch(/-latest/);
    });

    test('downloads anonymously from the public Release URL and checks the shipped checksum file', () => {
        expect(text).toContain('https://github.com/xcanwin/manyoyo/releases/download/');
        expect(text).not.toMatch(/GH_TOKEN|github\.token/);
        expect(text).toContain('sums="SHA256SUMS"');
        expect(text).not.toMatch(/SHA256SUMS-(linux|macos)-/);
        expect(text).not.toContain('release-manifest');
        expect(text).not.toContain('-lite');
    });

    test('also installs through the tag\'s own scripts/install.sh (not main) and checks the download is cleaned up', () => {
        expect(text).toContain('uses: actions/checkout@v7');
        expect(text).toContain('ref: ${{ inputs.tag }}');
        expect(text).toContain('MANYOYO_VERSION="$ver" sh scripts/install.sh --install-only');
        expect(text).not.toMatch(/raw\.githubusercontent|raw\/main/);
        expect(text).not.toMatch(/^\s*! ls /m); // set -e 对 `! cmd` 不生效，检查会变成空操作
    });

    test('every download retries transient network errors', () => {
        const curls = text.split('\n').filter(line => /\bcurl\b/.test(line) && !line.trim().startsWith('#'));
        expect(curls.length).toBeGreaterThanOrEqual(4);
        curls.forEach(line => expect(line).toContain('--retry 3 --retry-all-errors'));
    });

    test('checks the imported image in whichever runtime the installer picked (runners have both docker and podman)', () => {
        const check = text.split('\n').find(line => line.includes("'^ghcr.io/xcanwin/manyoyo:'"));
        expect(check).toBeDefined();
        expect(text).toContain('podman images --format');
        expect(text).toContain('docker images --format');
    });

    test('exercises install, version, update (latest) and uninstall on every platform', () => {
        for (const needle of ['--install-only', '已是最新版本', 'uninstall --yes', 'MANYOYO_TEST_SKIP_MACHINE=1']) expect(text).toContain(needle);
    });
});
