'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { openXar, extractCpio, extractPkgPayload } = require('../scripts/offline/xar');
const { buildCpio, buildXar, buildPkg } = require('./helpers/pkg-fixture');

const ENTRIES = [
    { name: './podman', type: 'dir' },
    { name: './podman/bin', type: 'dir' },
    { name: './podman/bin/podman', mode: 0o755, data: '#!/bin/sh\necho podman\n' },
    { name: './podman/bin/._podman', data: 'appledouble' },
    { name: './podman/lib/libx.dylib', data: 'lib' },
    { name: './podman/bin/link', type: 'symlink', data: 'podman' }
];

describe('offline pkg unpack (xar + cpio, no pkgutil)', () => {
    let root;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-pkg-')); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test.each(['odc', 'newc'])('extracts regular files, dirs, modes and symlinks from %s cpio', async format => {
        const pkg = path.join(root, 'a.pkg');
        fs.writeFileSync(pkg, buildPkg(ENTRIES, format));
        const out = path.join(root, 'out');
        const { files } = await extractPkgPayload(pkg, out);

        expect(files).toBe(3); // 3 个普通文件（符号链接与目录不计）
        expect(fs.readFileSync(path.join(out, 'podman/bin/podman'), 'utf8')).toBe('#!/bin/sh\necho podman\n');
        expect(fs.statSync(path.join(out, 'podman/bin/podman')).mode & 0o777).toBe(0o755);
        expect(fs.readlinkSync(path.join(out, 'podman/bin/link'))).toBe('podman');
        expect(fs.existsSync(path.join(out, 'podman/lib/libx.dylib'))).toBe(true);
    });

    test('lists xar entries and never touches Scripts', () => {
        const pkg = path.join(root, 'a.pkg');
        fs.writeFileSync(pkg, buildPkg(ENTRIES));
        const { entries } = openXar(pkg);
        expect(entries.map(e => e.path)).toEqual(expect.arrayContaining(['Distribution', 'podman.pkg', 'podman.pkg/Payload', 'podman.pkg/Scripts']));
    });

    test('filter skips entries (used to drop ._ files and docs)', async () => {
        const pkg = path.join(root, 'a.pkg');
        fs.writeFileSync(pkg, buildPkg(ENTRIES));
        const out = path.join(root, 'out');
        await extractPkgPayload(pkg, out, name => !path.posix.basename(name).startsWith('._'));
        expect(fs.existsSync(path.join(out, 'podman/bin/._podman'))).toBe(false);
        expect(fs.existsSync(path.join(out, 'podman/bin/podman'))).toBe(true);
    });

    test('rejects path traversal and absolute paths in the payload', async () => {
        for (const name of ['../evil', './a/../../evil', '/abs/evil']) {
            const stream = require('stream').Readable.from([buildCpio([{ name, data: 'x' }])]);
            await expect(extractCpio(stream, path.join(root, 'out'))).rejects.toThrow(/不安全|越界/);
        }
        expect(fs.existsSync(path.join(root, 'evil'))).toBe(false);
    });

    test('rejects non-xar input, non-cpio payloads and truncated files', async () => {
        const notXar = path.join(root, 'x.pkg');
        fs.writeFileSync(notXar, Buffer.alloc(64, 1));
        expect(() => openXar(notXar)).toThrow(/xar/);

        const badCpio = path.join(root, 'b.pkg');
        fs.writeFileSync(badCpio, buildXar([{ path: 'podman.pkg/Payload', data: zlib.gzipSync(Buffer.from('not a cpio archive at all')) }]));
        await expect(extractPkgPayload(badCpio, path.join(root, 'o1'))).rejects.toThrow(/cpio/);

        const noPayload = path.join(root, 'c.pkg');
        fs.writeFileSync(noPayload, buildXar([{ path: 'Distribution', data: Buffer.from('x') }]));
        await expect(extractPkgPayload(noPayload, path.join(root, 'o2'))).rejects.toThrow(/Payload/);

        const truncated = path.join(root, 'd.pkg');
        fs.writeFileSync(truncated, buildPkg(ENTRIES).subarray(0, 40));
        expect(() => openXar(truncated)).toThrow();
    });

    const realPkg = process.env.MANYOYO_REAL_PODMAN_PKG;
    (realPkg ? test : test.skip)('real Podman pkg (set MANYOYO_REAL_PODMAN_PKG to run)', async () => {
        const out = path.join(root, 'real');
        const { files } = await extractPkgPayload(realPkg, out);
        expect(files).toBeGreaterThan(100);
        expect(fs.existsSync(path.join(out, 'podman/bin/podman'))).toBe(true);
    });
});
