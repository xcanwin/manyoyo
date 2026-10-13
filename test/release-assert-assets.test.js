'use strict';

const { assertReleaseAssets, readSizes } = require('../scripts/release/assert-assets');
const fs = require('fs');
const os = require('os');
const path = require('path');

const names = version => ['SHA256SUMS', ...['macos', 'linux'].flatMap(os => ['arm64', 'x64'].flatMap(arch => [`manyoyo-${version}-${os}-${arch}.run`, `manyoyo-${version}-${os}-${arch}-app.tar.gz`]))];
const sumsText = list => list.filter(name => name !== 'SHA256SUMS').map(name => `${'a'.repeat(64)}  ${name}`).join('\n');

function fakeGh({ assets, sums, draft = true, states = {} }) {
    return args => {
        if (args[0] === 'release' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ isDraft: draft, assets: assets.map(name => ({ name, state: states[name] || 'uploaded', size: 10 })) }) };
        if (args[0] === 'release' && args[1] === 'download') return sums === null ? { status: 1, stdout: '' } : { status: 0, stdout: sums };
        return { status: 1, stdout: '' };
    };
}

describe('assertReleaseAssets (the gate in front of publish)', () => {
    test('complete assets that match SHA256SUMS pass', () => {
        const list = names('8.7.0');
        expect(assertReleaseAssets({ tag: 'v8.7.0', version: '8.7.0', gh: fakeGh({ assets: list, sums: sumsText(list) }) })).toMatchObject({ ok: true });
    });

    test('a missing platform, a stray file, a missing SHA256SUMS or a mismatching list are all refused', () => {
        const list = names('8.7.0');
        const bad = gh => assertReleaseAssets({ tag: 'v8.7.0', version: '8.7.0', gh });
        expect(bad(fakeGh({ assets: list.filter(name => !name.includes('linux-arm64')), sums: sumsText(list) })).ok).toBe(false);
        expect(bad(fakeGh({ assets: [...list, 'manyoyo-8.7.0-macos-arm64-lite.run'], sums: sumsText(list) })).ok).toBe(false);
        expect(bad(fakeGh({ assets: list, sums: null })).ok).toBe(false);
        expect(bad(fakeGh({ assets: list, sums: sumsText(list.slice(0, -1)) })).ok).toBe(false);
    });

    test('an asset whose upload did not finish (state is not "uploaded") or is empty blocks publishing', () => {
        const list = names('8.7.0');
        const result = assertReleaseAssets({ tag: 'v8.7.0', version: '8.7.0', gh: fakeGh({ assets: list, sums: sumsText(list), states: { 'manyoyo-8.7.0-macos-x64.run': 'open' } }) });
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('manyoyo-8.7.0-macos-x64.run') });
    });

    test('with the sizes recorded by the build jobs: a size mismatch (an upload cut short) or a missing recorded file blocks publishing', () => {
        const list = names('8.7.0');
        const sizes = Object.fromEntries(list.filter(name => name !== 'SHA256SUMS').map(name => [name, 10]));
        const ok = assertReleaseAssets({ tag: 'v8.7.0', version: '8.7.0', gh: fakeGh({ assets: list, sums: sumsText(list) }), sizes });
        expect(ok.ok).toBe(true);
        const bad = assertReleaseAssets({ tag: 'v8.7.0', version: '8.7.0', gh: fakeGh({ assets: list, sums: sumsText(list) }), sizes: { ...sizes, 'manyoyo-8.7.0-linux-x64.run': 11 } });
        expect(bad).toMatchObject({ ok: false, reason: expect.stringContaining('manyoyo-8.7.0-linux-x64.run') });
        const missing = assertReleaseAssets({ tag: 'v8.7.0', version: '8.7.0', gh: fakeGh({ assets: list.filter(name => name !== 'manyoyo-8.7.0-linux-x64.run'), sums: sumsText(list.filter(name => name !== 'manyoyo-8.7.0-linux-x64.run')) }), sizes });
        expect(missing.ok).toBe(false);
    });

    test('readSizes reads every SIZES-*.txt in a folder (name and size per line)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-sizes-'));
        try {
            fs.writeFileSync(path.join(dir, 'SIZES-linux-x64.txt'), 'a.run 100\nb.tar.gz 5\n');
            fs.writeFileSync(path.join(dir, 'SIZES-macos-arm64.txt'), 'c.run 7\n');
            expect(readSizes(dir)).toEqual({ 'a.run': 100, 'b.tar.gz': 5, 'c.run': 7 });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a release that is already public is not touched', () => {
        const list = names('8.7.0');
        expect(assertReleaseAssets({ tag: 'v8.7.0', version: '8.7.0', gh: fakeGh({ assets: list, sums: sumsText(list), draft: false }) })).toMatchObject({ ok: false, reason: expect.stringContaining('草稿') });
    });
});
