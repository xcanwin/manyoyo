'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { downloadVerified, sha256File } = require('../lib/download-verified');
const { renderRunHeader, writeRunFile, verifyRunFile, splitFile, joinVolumes } = require('../scripts/offline/pack');
const { inventoryDir, buildManifest, formatSha256Sums } = require('../scripts/offline/manifest');
const { shouldKeepPodmanFile, patchKrunkit, fetchVmDisk, findVmDiskFile } = require('../scripts/offline/stage');
const { resolveLock, LOCK } = require('../scripts/offline/lock');
const { buildOfflinePackages, parseArgs } = require('../scripts/offline/build');
const { buildPkg } = require('./helpers/pkg-fixture');

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const tar = (...args) => { const r = spawnSync('tar', args, { encoding: 'utf-8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-offline-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('lock', () => {
    test('every pinned component has a sha256 and a supported arch', () => {
        for (const arch of ['arm64', 'x64']) {
            const lock = resolveLock(arch);
            expect(lock.node.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(lock.podman.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(lock.node.url).toContain(`v${LOCK.node.version}`);
        }
        expect(resolveLock('arm64').podman.version).toMatch(/^6\./);
        expect(resolveLock('x64').podman.version).toMatch(/^5\.8\./);
        expect(() => resolveLock('ia32')).toThrow(/不支持的架构/);
    });
});

describe('downloadVerified', () => {
    const body = Buffer.from('component bytes');
    const okFetch = jest.fn(async () => new Response(body));

    test('saves a file whose hash matches, then reuses it from cache', async () => {
        const dest = path.join(root, 'cache/a.bin');
        okFetch.mockClear();
        await downloadVerified({ url: 'https://x/a', sha256: sha(body), dest, fetchImpl: okFetch });
        expect(fs.readFileSync(dest).equals(body)).toBe(true);
        await downloadVerified({ url: 'https://x/a', sha256: sha(body), dest, fetchImpl: okFetch });
        expect(okFetch).toHaveBeenCalledTimes(1);
    });

    test('aborts on a hash mismatch and leaves no file behind', async () => {
        const dest = path.join(root, 'cache/b.bin');
        await expect(downloadVerified({ url: 'https://x/b', sha256: 'a'.repeat(64), dest, fetchImpl: okFetch })).rejects.toThrow(/SHA256 校验失败/);
        expect(fs.existsSync(dest)).toBe(false);
        expect(fs.existsSync(`${dest}.partial`)).toBe(false);
    });

    test('replaces a poisoned cache entry, rejects http errors and missing hashes', async () => {
        const dest = path.join(root, 'cache/c.bin');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'tampered');
        await downloadVerified({ url: 'https://x/c', sha256: sha(body), dest, fetchImpl: okFetch });
        expect(fs.readFileSync(dest).equals(body)).toBe(true);
        await expect(downloadVerified({ url: 'u', sha256: sha(body), dest: path.join(root, 'd'), fetchImpl: async () => new Response('x', { status: 404 }) })).rejects.toThrow(/404/);
        await expect(downloadVerified({ url: 'u', sha256: '', dest: path.join(root, 'e'), fetchImpl: okFetch })).rejects.toThrow(/SHA256/);
    });
});

describe('.run packaging', () => {
    async function makeRun(name = 'pkg', volumeBytes = 0, bulkBytes = 0) {
        const src = path.join(root, 'src');
        fs.mkdirSync(path.join(src, 'install'), { recursive: true });
        fs.writeFileSync(path.join(src, 'install/install.sh'), '#!/bin/sh\necho "installer ran with: $*"\n', { mode: 0o755 });
        fs.writeFileSync(path.join(src, 'data.txt'), 'payload data\n');
        // 不可压缩的填充，让分卷远大于头部（头必须完整落在第一卷里）
        if (bulkBytes) fs.writeFileSync(path.join(src, 'bulk.bin'), Buffer.concat(Array.from({ length: Math.ceil(bulkBytes / 32) }, (_, i) => require('crypto').createHash('sha256').update(String(i)).digest())).subarray(0, bulkBytes));
        const payload = path.join(root, 'payload.tar.gz');
        tar('-czf', payload, '-C', src, '.');
        const runPath = path.join(root, `${name}.run`);
        await writeRunFile({ payloadPath: payload, outPath: runPath, name, volumeBytes });
        return runPath;
    }
    const sh = (...args) => spawnSync('sh', args, { encoding: 'utf-8' });

    test('the generated header has no $VAR directly followed by a non-ASCII character (macOS bash 3.2 as sh)', () => {
        const header = renderRunHeader({ name: 'pkg', sha256: 'a'.repeat(64) });
        expect(header.split('\n').filter(line => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line))).toEqual([]);
        expect(header).toContain('${PAYLOAD_SHA256}');
    });

    test('header validates its inputs', () => {
        expect(() => renderRunHeader({ name: 'x', sha256: 'bad' })).toThrow(/SHA256/);
        expect(() => renderRunHeader({ name: 'a b', sha256: 'a'.repeat(64) })).toThrow(/name/);
    });

    test('sh can --check, --list, --extract and run the installer from the payload', async () => {
        const run = await makeRun();
        expect(fs.statSync(run).mode & 0o111).not.toBe(0);
        expect((await verifyRunFile(run)).ok).toBe(true);
        expect(sh(run, '--check').status).toBe(0);
        expect(sh(run, '--list').stdout).toContain('install/install.sh');
        const out = path.join(root, 'extracted');
        expect(sh(run, '--extract', out).status).toBe(0);
        expect(fs.readFileSync(path.join(out, 'data.txt'), 'utf8')).toBe('payload data\n');
        const installed = sh(run, '--yes', 'x');
        expect(installed.stdout).toContain('installer ran with: --yes x');
        expect(sh(run, '--help').stdout).toContain('--check');
    });

    test('a modified payload fails the self-check and never runs the installer', async () => {
        const run = await makeRun();
        const bytes = fs.readFileSync(run);
        bytes[bytes.length - 20] ^= 0xff;
        fs.writeFileSync(run, bytes);
        expect((await verifyRunFile(run)).ok).toBe(false);
        const result = sh(run);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('校验失败');
        expect(result.stdout).not.toContain('installer ran');
        expect(() => verifyRunFile(path.join(root, 'nope.run'))).rejects.toThrow();
    });

    test('volumes split, join back byte-for-byte, and the joined file still verifies', async () => {
        const run = await makeRun('vol');
        const original = fs.readFileSync(run);
        const parts = await splitFile(run, Math.ceil(original.length / 3));
        expect(parts.map(p => path.basename(p))).toEqual(['vol.run.001', 'vol.run.002', 'vol.run.003']);
        expect(fs.existsSync(run)).toBe(false);
        const joined = await joinVolumes(parts, path.join(root, 'joined.run'));
        expect(fs.readFileSync(joined).equals(original)).toBe(true);
        expect(sh(joined, '--check').status).toBe(0);
    });

    describe('running a split package directly from .run.001', () => {
        async function makeSplit(name = 'vsp', parts = 3) {
            const probe = fs.readFileSync(await makeRun(name, 0, 60000));
            // 正式包的头部（VOLUMES 字段等）比探测包略长几个字节：留出余量，避免恰好多出一卷而偶发失败
            const volumeBytes = Math.ceil((probe.length + 1024) / parts);
            const run = await makeRun(name, volumeBytes, 60000);
            const original = fs.readFileSync(run);
            const files = await splitFile(run, volumeBytes);
            return { original, files, first: files[0] };
        }

        test('sh pkg.run.001 verifies across all volumes and runs the installer without merging', async () => {
            const { files, first } = await makeSplit();
            expect(files).toHaveLength(3);
            expect(sh(first, '--check').status).toBe(0);
            expect(sh(first, '--list').stdout).toContain('install/install.sh');
            const out = sh(first, '--yes', 'y');
            expect(out.status).toBe(0);
            expect(out.stdout).toContain('installer ran with: --yes y');
            // 没有产生合并文件
            expect(fs.readdirSync(root).filter(n => /^vsp\.run$/.test(n))).toEqual([]);
        });

        test('a missing volume stops with cause and next step, and the installer never runs', async () => {
            const { files, first } = await makeSplit();
            fs.rmSync(files[1]);
            const result = sh(first);
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain('缺少分卷');
            expect(result.stderr).toContain('vsp.run.002');
            expect(result.stdout).not.toContain('installer ran');
            fs.rmSync(files[2]);
            expect(sh(first).stderr).toContain('缺少分卷');
        });

        test('a wrongly sized or tampered volume is rejected', async () => {
            const { files, first } = await makeSplit();
            const bytes = fs.readFileSync(files[1]);
            fs.writeFileSync(files[1], bytes.subarray(0, bytes.length - 5));
            const sized = sh(first);
            expect(sized.status).not.toBe(0);
            expect(sized.stderr).toContain('大小不对');
            expect(sized.stdout).not.toContain('installer ran');

            fs.writeFileSync(files[1], bytes);
            const last = fs.readFileSync(files[2]);
            last[last.length - 3] ^= 0xff;
            fs.writeFileSync(files[2], last);
            const tampered = sh(first);
            expect(tampered.status).toBe(1);
            expect(tampered.stderr).toContain('校验失败');
            expect(tampered.stdout).not.toContain('installer ran');
        });

        test('a truncated last volume is caught by the recorded volume size / checksum', async () => {
            const { files, first } = await makeSplit();
            const last = fs.readFileSync(files[2]);
            fs.writeFileSync(files[2], last.subarray(0, last.length - 4));
            const result = sh(first);
            expect(result.status).not.toBe(0);
            expect(result.stdout).not.toContain('installer ran');
        });

        test('manual cat-merge still works and is byte-identical to the unsplit package', async () => {
            const { original, files } = await makeSplit();
            const joined = await joinVolumes(files, path.join(root, 'joined2.run'));
            const merged = fs.readFileSync(joined);
            expect(merged.equals(original)).toBe(true);
            expect(sh(joined, '--check').status).toBe(0);
            expect(sh(joined, '--yes').stdout).toContain('installer ran with: --yes');
            expect((await verifyRunFile(joined)).ok).toBe(true);
        });

        test('header keeps the single-file layout when not split (VOLUMES=0001) and has no $VAR before non-ASCII', () => {
            const header = renderRunHeader({ name: 'pkg', sha256: 'a'.repeat(64) });
            expect(header).toMatch(/^VOLUMES=0001$/m);
            expect(renderRunHeader({ name: 'pkg', sha256: 'a'.repeat(64), volumes: 3 })).toMatch(/^VOLUMES=0003$/m);
            expect(renderRunHeader({ name: 'pkg', sha256: 'a'.repeat(64), volumes: 3 }).length).toBe(header.length);
            expect(header.split('\n').filter(line => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line))).toEqual([]);
        });
    });

    test('a file under the limit is not split', async () => {
        const run = await makeRun('small');
        expect(await splitFile(run, 10 * 1024 * 1024)).toEqual([run]);
    });
});

describe('manifest', () => {
    test('inventory is sorted, hashed and deterministic; manifest omits builtAt unless given', async () => {
        fs.mkdirSync(path.join(root, 'tree/b'), { recursive: true });
        fs.writeFileSync(path.join(root, 'tree/z.txt'), 'z');
        fs.writeFileSync(path.join(root, 'tree/b/a.sh'), 'a', { mode: 0o755 });
        fs.symlinkSync('z.txt', path.join(root, 'tree/link'));
        const files = await inventoryDir(path.join(root, 'tree'));
        expect(files.map(f => f.path)).toEqual(['b/a.sh', 'link', 'z.txt']);
        expect(files[0]).toEqual({ path: 'b/a.sh', size: 1, sha256: sha('a'), executable: true });
        expect(files[1]).toEqual({ path: 'link', symlink: 'z.txt' });
        const manifest = buildManifest({ version: '1.0.0', imageVersion: '1.0.0-common', arch: 'arm64', kind: 'full', components: {}, files });
        expect('builtAt' in manifest).toBe(false);
        expect(buildManifest({ version: '1', imageVersion: 'i', arch: 'x64', kind: 'lite', components: {}, files, builtAt: '2020-01-01T00:00:00.000Z' }).builtAt).toBe('2020-01-01T00:00:00.000Z');
        expect(formatSha256Sums([{ sha256: 'a'.repeat(64), name: 'f' }])).toBe(`${'a'.repeat(64)}  f\n`);
    });
});

describe('stage helpers', () => {
    test('podman file filter drops AppleDouble files and docs, and the arm64-only krunkit stack on x64', () => {
        expect(shouldKeepPodmanFile('./podman/bin/podman', 'arm64')).toBe(true);
        expect(shouldKeepPodmanFile('./podman/bin/._krunkit', 'arm64')).toBe(false);
        expect(shouldKeepPodmanFile('./podman/docs/man/man1/podman.1', 'arm64')).toBe(false);
        expect(shouldKeepPodmanFile('./podman/lib/libkrun.dylib', 'arm64')).toBe(true);
        expect(shouldKeepPodmanFile('./podman/lib/libkrun.dylib', 'x64')).toBe(false);
        expect(shouldKeepPodmanFile('./podman/bin/krunkit', 'x64')).toBe(false);
        expect(shouldKeepPodmanFile('./podman/bin/vfkit', 'x64')).toBe(true);
    });

    function fakePodmanDir() {
        const dir = path.join(root, 'podman');
        fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'bin/krunkit'), 'k', { mode: 0o755 });
        fs.writeFileSync(path.join(dir, 'lib/libkrun.dylib'), 'l');
        return dir;
    }

    test('krunkit patch: extract entitlements, add the relative rpath, ad-hoc re-sign with them, verify', () => {
        const calls = [];
        const run = (cmd, args) => {
            calls.push([cmd, ...args]);
            if (cmd === 'codesign' && args[0] === '-d') return '<plist><key>com.apple.security.hypervisor</key><true/></plist>';
            if (cmd === 'otool') return 'path @executable_path/../lib (offset 12)';
            return '';
        };
        const record = patchKrunkit({ podmanDir: fakePodmanDir(), run, tmpRoot: root });
        expect(record).toEqual(expect.objectContaining({ rpath: '@executable_path/../lib', signature: 'ad-hoc' }));
        expect(calls.map(c => c[0])).toEqual(['codesign', 'install_name_tool', 'codesign', 'codesign', 'otool']);
        expect(calls[1]).toEqual(['install_name_tool', '-add_rpath', '@executable_path/../lib', expect.stringMatching(/bin\/krunkit$/)]);
        const sign = calls[2];
        expect(sign).toEqual(expect.arrayContaining(['--force', '--sign', '-', '--options', 'runtime', '--entitlements']));
    });

    test('krunkit patch refuses to re-sign without the hypervisor entitlement, or when the patch did not take', () => {
        expect(() => patchKrunkit({ podmanDir: fakePodmanDir(), run: () => '<plist/>', tmpRoot: root })).toThrow(/hypervisor/);
        const run = cmd => (cmd === 'codesign' ? 'com.apple.security.hypervisor' : cmd === 'otool' ? 'no rpath here' : '');
        expect(() => patchKrunkit({ podmanDir: fakePodmanDir(), run, tmpRoot: root })).toThrow(/rpath|@executable_path/);
    });

    test('krunkit patch is a no-op when there is no krunkit, and fails loudly when libkrun is missing', () => {
        const empty = path.join(root, 'empty');
        fs.mkdirSync(path.join(empty, 'bin'), { recursive: true });
        expect(patchKrunkit({ podmanDir: empty, run: () => { throw new Error('should not run'); }, tmpRoot: root })).toBeNull();
        const noLib = path.join(root, 'nolib');
        fs.mkdirSync(path.join(noLib, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(noLib, 'bin/krunkit'), 'k');
        expect(() => patchKrunkit({ podmanDir: noLib, run: () => '', tmpRoot: root })).toThrow(/libkrun/);
    });

    test('VM disk comes from machine init in a throwaway XDG tree', () => {
        const podmanDir = path.join(root, 'p');
        fs.mkdirSync(path.join(podmanDir, 'bin'), { recursive: true });
        let seenEnv;
        let confText = '';
        const run = (cmd, args, opts) => {
            seenEnv = opts.env;
            confText = fs.readFileSync(opts.env.CONTAINERS_CONF, 'utf8');
            expect(args.slice(0, 2)).toEqual(['machine', 'init']);
            const cache = path.join(opts.env.XDG_DATA_HOME, 'containers/podman/machine/libkrun/cache');
            fs.mkdirSync(cache, { recursive: true });
            fs.writeFileSync(path.join(cache, 'abc.raw.zst'), 'disk-bytes');
            return '';
        };
        const result = fetchVmDisk({ podmanDir, run, tmpRoot: root });
        expect(fs.readFileSync(result.path, 'utf8')).toBe('disk-bytes');
        expect(result.fileName).toBe('abc.raw.zst');
        expect(seenEnv.XDG_DATA_HOME.startsWith(root)).toBe(true);
        expect(confText).toContain('helper_binaries_dir');
        expect(fs.existsSync(seenEnv.XDG_DATA_HOME)).toBe(false); // 临时目录已清理
        expect(() => fetchVmDisk({ podmanDir, run: () => '', tmpRoot: root })).toThrow(/没有找到/);
        expect(findVmDiskFile(root)).toBe(''); // 只认 cache 目录里的 raw 磁盘
    });

    test('VM disk cache dir: a hit skips machine init, a miss fills the cache', () => {
        const podmanDir = path.join(root, 'p2');
        fs.mkdirSync(path.join(podmanDir, 'bin'), { recursive: true });
        const cacheDir = path.join(root, 'vm-cache');
        let calls = 0;
        const run = (cmd, args, opts) => {
            calls += 1;
            const cache = path.join(opts.env.XDG_DATA_HOME, 'containers/podman/machine/libkrun/cache');
            fs.mkdirSync(cache, { recursive: true });
            fs.writeFileSync(path.join(cache, 'abc.raw.zst'), 'disk-bytes');
            return '';
        };
        const miss = fetchVmDisk({ podmanDir, run, tmpRoot: root, cacheDir });
        expect(calls).toBe(1);
        expect(fs.readFileSync(path.join(cacheDir, 'abc.raw.zst'), 'utf8')).toBe('disk-bytes');
        expect(miss.fileName).toBe('abc.raw.zst');
        const hit = fetchVmDisk({ podmanDir, run, tmpRoot: root, cacheDir });
        expect(calls).toBe(1);
        expect(hit.fileName).toBe('abc.raw.zst');
        expect(fs.readFileSync(hit.path, 'utf8')).toBe('disk-bytes');
        expect(hit.path).not.toBe(path.join(cacheDir, 'abc.raw.zst')); // 返回副本，build 会把它删掉
        expect(fs.existsSync(path.join(cacheDir, 'abc.raw.zst'))).toBe(true);
    });
});

describe('full assembly with stand-in components', () => {
    const IMAGE_BYTES = Buffer.from('fake image archive');

    function makeRepo() {
        const repo = path.join(root, 'repo');
        fs.mkdirSync(repo, { recursive: true });
        fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: '@x/manyoyo', version: '9.9.9', imageVersion: '9.9.9-common' }));
        fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}');
        return repo;
    }

    function makeFixtures() {
        const nodeSrc = path.join(root, 'node-src/node-v24-darwin');
        fs.mkdirSync(path.join(nodeSrc, 'bin'), { recursive: true });
        fs.mkdirSync(path.join(nodeSrc, 'lib/node_modules/npm'), { recursive: true });
        fs.mkdirSync(path.join(nodeSrc, 'include'), { recursive: true });
        fs.writeFileSync(path.join(nodeSrc, 'bin/node'), 'node-binary', { mode: 0o755 });
        fs.writeFileSync(path.join(nodeSrc, 'bin/npm'), 'npm');
        fs.writeFileSync(path.join(nodeSrc, 'lib/node_modules/npm/.npmrc'), 'x');
        fs.writeFileSync(path.join(nodeSrc, 'include/node.h'), 'h');
        fs.writeFileSync(path.join(nodeSrc, 'LICENSE'), 'MIT');
        const nodeTgz = path.join(root, 'node.tar.gz');
        tar('-czf', nodeTgz, '-C', path.join(root, 'node-src'), 'node-v24-darwin');
        const pkg = path.join(root, 'podman.pkg');
        fs.writeFileSync(pkg, buildPkg([
            { name: './podman', type: 'dir' },
            { name: './podman/bin/podman', mode: 0o755, data: 'podman-bin' },
            { name: './podman/bin/gvproxy', mode: 0o755, data: 'gvproxy' },
            { name: './podman/bin/vfkit', mode: 0o755, data: 'vfkit' },
            { name: './podman/bin/krunkit', mode: 0o755, data: 'krunkit' },
            { name: './podman/bin/._krunkit', data: 'appledouble' },
            { name: './podman/lib/libkrun.dylib', data: 'libkrun' },
            { name: './podman/share/krunkit/KRUN_EFI.fd', data: 'efi' },
            { name: './podman/docs/man/man1/podman.1', data: 'man' }
        ]));
        const image = path.join(root, 'image.tar.gz');
        fs.writeFileSync(image, IMAGE_BYTES);
        return { nodeTgz, pkg, image };
    }

    function makeRun(repo) {
        return (cmd, args, opts = {}) => {
            if (cmd === 'tar') {
                const r = spawnSync('tar', args, { encoding: 'utf-8' });
                if (r.status !== 0) throw new Error(r.stderr);
                return r.stdout;
            }
            if (cmd === 'npm' && args[0] === 'pack') {
                const dest = args[args.indexOf('--pack-destination') + 1];
                const pkgDir = path.join(root, 'npm-pack/package');
                fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
                fs.writeFileSync(path.join(pkgDir, 'package.json'), '{"name":"@x/manyoyo"}');
                fs.writeFileSync(path.join(pkgDir, 'lib/app.js'), 'module.exports = 1');
                tar('-czf', path.join(dest, 'x-manyoyo-9.9.9.tgz'), '-C', path.join(root, 'npm-pack'), 'package');
                return 'x-manyoyo-9.9.9.tgz\n';
            }
            if (cmd === 'npm' && args[0] === 'ci') {
                fs.mkdirSync(path.join(opts.cwd, 'node_modules/dep'), { recursive: true });
                fs.writeFileSync(path.join(opts.cwd, 'node_modules/dep/index.js'), 'dep');
                return '';
            }
            if (cmd === 'codesign' && args[0] === '-d') return '<plist><key>com.apple.security.hypervisor</key><true/></plist>';
            if (cmd === 'otool') return 'path @executable_path/../lib (offset 12)';
            return '';
        };
    }

    async function build(arch, out, extra = {}) {
        const repo = makeRepo();
        const fixtures = makeFixtures();
        const deps = {
            run: makeRun(repo),
            log: () => {},
            download: async ({ url }) => (url.includes('nodejs.org') ? fixtures.nodeTgz : fixtures.pkg),
            fetchVmDisk: async ({ tmpRoot }) => {
                const disk = path.join(tmpRoot, 'disk.raw.zst');
                fs.writeFileSync(disk, 'vm-disk');
                return { path: disk, fileName: 'abc123.raw.zst' };
            }
        };
        return buildOfflinePackages({ arch, repoRoot: repo, outDir: out, imageArchive: fixtures.image, ...extra }, deps);
    }

    const extract = (runFile, dir) => {
        const r = spawnSync('sh', [runFile, '--extract', dir], { encoding: 'utf-8' });
        if (r.status !== 0) throw new Error(r.stderr);
        return dir;
    };
    const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);

    test('arm64: produces the full package and the app package (no lite, no release-manifest) with the documented layout, checksums and patch record', async () => {
        const out = path.join(root, 'out');
        const result = await build('arm64', out);
        const names = result.files.map(f => f.name).sort();
        expect(names).toEqual([
            'FILES-macos-arm64.txt'.replace('FILES-', 'SHA256SUMS-').replace('.txt', ''),
            'manyoyo-9.9.9-macos-arm64-app.tar.gz',
            'manyoyo-9.9.9-macos-arm64.run'
        ].sort());
        expect(fs.existsSync(path.join(out, 'manyoyo-9.9.9-macos-arm64-lite.run'))).toBe(false);
        expect(fs.readdirSync(out).filter(name => name.startsWith('release-manifest'))).toEqual([]);

        // SHA256SUMS 与真实文件一致
        const sums = fs.readFileSync(path.join(out, 'SHA256SUMS-macos-arm64'), 'utf8').trim().split('\n');
        expect(sums).toHaveLength(2);
        for (const line of sums) {
            const [hash, name] = line.split('  ');
            expect(await sha256File(path.join(out, name))).toBe(hash);
        }
        expect(fs.readFileSync(path.join(out, 'FILES-macos-arm64.txt'), 'utf8').trim().split('\n')).toHaveLength(3);

        // full：解开校验目录结构
        const full = extract(path.join(out, 'manyoyo-9.9.9-macos-arm64.run'), path.join(root, 'x-full'));
        const fullFiles = walk(full);
        expect(fullFiles).toEqual(expect.arrayContaining([
            'manifest.json', 'install/install.sh', 'app/node/bin/node', 'app/node/LICENSE',
            'app/manyoyo/lib/app.js', 'app/manyoyo/node_modules/dep/index.js',
            'runtime/podman/bin/podman', 'runtime/podman/bin/krunkit', 'runtime/podman/lib/libkrun.dylib',
            'vm/abc123.raw.zst', 'images/manyoyo-9.9.9-common-arm64.tar.gz'
        ]));
        expect(fullFiles.filter(f => /(^|\/)\._/.test(f))).toEqual([]);                 // 无 AppleDouble
        expect(fullFiles.some(f => f.startsWith('runtime/podman/docs/'))).toBe(false);
        expect(fullFiles.some(f => f.includes('npm') || f.endsWith('.npmrc') || f.startsWith('app/node/include'))).toBe(false);
        expect(fullFiles.some(f => f.includes('package-lock.json'))).toBe(false);
        const manifest = JSON.parse(fs.readFileSync(path.join(full, 'manifest.json'), 'utf8'));
        expect(manifest).toEqual(expect.objectContaining({ version: '9.9.9', imageVersion: '9.9.9-common', arch: 'arm64', kind: 'full' }));
        expect(manifest.components.podman.patches[0]).toEqual(expect.objectContaining({ target: 'bin/krunkit', rpath: '@executable_path/../lib' }));
        expect(manifest.components.vmDisk.sha256).toBe(sha('vm-disk'));
        expect(manifest.components.image.sha256).toBe(sha(IMAGE_BYTES));
        expect(manifest.components.node.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(manifest.files.find(f => f.path === 'install/install.sh').executable).toBe(true);
        expect(fullFiles).toEqual(expect.arrayContaining(['install/finish-import.sh', 'install/env.sh']));
        const env = fs.readFileSync(path.join(full, 'install/env.sh'), 'utf8');
        expect(env).toContain("MANYOYO_KIND='full'");
        expect(env).toContain("MANYOYO_VM_FILE='vm/abc123.raw.zst'");
        expect(env).toContain("MANYOYO_MACHINE_NAME='podman-machine-manyoyo'");
        expect(env).toContain(`MANYOYO_IMAGE_SHA='${sha(IMAGE_BYTES)}'`);
        // 打包出来的 install.sh 就是仓库里的那份（不是占位）
        expect(fs.readFileSync(path.join(full, 'install/install.sh'), 'utf8')).toBe(fs.readFileSync(path.join(__dirname, '../scripts/offline/install.sh'), 'utf8'));

        // app：只有 Node + manyoyo
        const appDir = path.join(root, 'x-app');
        fs.mkdirSync(appDir);
        tar('-xzf', path.join(out, 'manyoyo-9.9.9-macos-arm64-app.tar.gz'), '-C', appDir);
        const appFiles = walk(appDir);
        expect(appFiles).toEqual(expect.arrayContaining(['manifest.json', 'node/bin/node', 'manyoyo/lib/app.js']));
        expect(appFiles.some(f => f.startsWith('install/') || f.startsWith('runtime/') || f.startsWith('vm/') || f.startsWith('images/'))).toBe(false);
        // 升级时 manyoyo update 据此提示 Podman / 虚拟机磁盘有变化（取代原来的 release-manifest）
        const appManifest = JSON.parse(fs.readFileSync(path.join(appDir, 'manifest.json'), 'utf8'));
        expect(appManifest.runtime).toEqual({ podmanVersion: result.componentInfo.podman.version, vmDiskSha256: sha('vm-disk') });
    });

    test('tar metadata is normalized: root-owned entries and a fixed mtime', async () => {
        const out = path.join(root, 'out');
        await build('arm64', out);
        const listing = tar('-tvzf', path.join(out, 'manyoyo-9.9.9-macos-arm64-app.tar.gz'), '--numeric-owner');
        listing.trim().split('\n').forEach(line => {
            expect(line).toMatch(/\b0\/0\b/);
            expect(line).toContain('2020-01-01');
        });
    });

    test('the same inputs give byte-identical artifacts (reproducible)', async () => {
        const a = await build('arm64', path.join(root, 'out-a'));
        const b = await build('arm64', path.join(root, 'out-b'));
        const hashes = r => r.files.filter(f => !f.name.startsWith('FILES')).map(f => `${f.name}:${f.sha256}`).sort();
        expect(hashes(a)).toEqual(hashes(b));
    });

    test('x64: no krunkit stack, no patch, applehv stays usable', async () => {
        const out = path.join(root, 'out');
        const result = await build('x64', out);
        const full = extract(path.join(out, 'manyoyo-9.9.9-macos-x64.run'), path.join(root, 'x64-full'));
        const files = walk(full);
        expect(files).toEqual(expect.arrayContaining(['runtime/podman/bin/podman', 'runtime/podman/bin/vfkit', 'runtime/podman/bin/gvproxy']));
        expect(files.some(f => f.includes('krunkit') || f.endsWith('libkrun.dylib'))).toBe(false);
        expect(result.componentInfo.podman.patches).toEqual([]);
        expect(result.componentInfo.podman.machineProvider).toBe('applehv');
    });

    test('linux: one package without Podman / VM disk, linux file names, os recorded, no Podman download', async () => {
        const out = path.join(root, 'out-linux');
        const repo = makeRepo();
        const fixtures = makeFixtures();
        const downloads = [];
        const result = await buildOfflinePackages({ arch: 'x64', platform: 'linux', repoRoot: repo, outDir: out, imageArchive: fixtures.image }, {
            run: makeRun(repo),
            log: () => {},
            download: async ({ url }) => { downloads.push(url); return fixtures.nodeTgz; },
            fetchVmDisk: async () => { throw new Error('linux 包不应获取 VM 磁盘'); },
            stagePodman: async () => { throw new Error('linux 包不应暂存 Podman'); }
        });
        expect(downloads).toHaveLength(1);
        expect(downloads[0]).toContain('linux-x64');
        expect(result.files.map(f => f.name).sort()).toEqual([
            'SHA256SUMS-linux-x64',
            'manyoyo-9.9.9-linux-x64-app.tar.gz',
            'manyoyo-9.9.9-linux-x64.run'
        ]);
        const dir = extract(path.join(out, 'manyoyo-9.9.9-linux-x64.run'), path.join(root, 'x-linux'));
        const files = walk(dir);
        expect(files.some(f => f.startsWith('runtime/') || f.startsWith('vm/'))).toBe(false);
        expect(files).toEqual(expect.arrayContaining(['install/install.sh', 'app/node/bin/node', 'images/manyoyo-9.9.9-common-x64.tar.gz']));
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        expect(manifest).toEqual(expect.objectContaining({ os: 'linux', arch: 'x64', kind: 'lite' }));
        expect(manifest.components.podman).toBeUndefined();
        const env = fs.readFileSync(path.join(dir, 'install/env.sh'), 'utf8');
        expect(env).toContain("MANYOYO_OS='linux'");
        expect(env).toContain("MANYOYO_KIND='lite'");
        expect(env).toMatch(/MANYOYO_MIN_GLIBC='2\.\d+'/);
        const appManifest = (() => {
            const appDir = path.join(root, 'x-linux-app');
            fs.mkdirSync(appDir);
            tar('-xzf', path.join(out, 'manyoyo-9.9.9-linux-x64-app.tar.gz'), '-C', appDir);
            return JSON.parse(fs.readFileSync(path.join(appDir, 'manifest.json'), 'utf8'));
        })();
        expect(appManifest).toEqual(expect.objectContaining({ os: 'linux', arch: 'x64', kind: 'app' }));
        expect(appManifest.runtime).toBeUndefined(); // Linux 包不带 Podman / 虚拟机磁盘
        expect(resolveLock('arm64', 'linux').node.url).toContain('linux-arm64');
        expect(resolveLock('arm64', 'linux').podman).toBeUndefined();
        expect(() => resolveLock('arm64', 'windows')).toThrow(/不支持的平台/);
    });

    test('splits an oversized .run into volumes that join back to a valid installer', async () => {
        const out = path.join(root, 'out');
        const result = await build('arm64', out, { volumeBytes: 2048 });
        const volumes = result.files.map(f => f.name).filter(name => /\.run\.\d{3}$/.test(name));
        expect(volumes.length).toBeGreaterThan(2);
        const joined = await joinVolumes(volumes.map(name => path.join(out, name)), path.join(root, 'joined.run'));
        expect(spawnSync('sh', [joined, '--check'], { encoding: 'utf-8' }).status).toBe(0);
    });

    test('the default volume size keeps the biggest package (x64, ~2.0 GB) in one file under the GitHub 2 GiB asset limit', () => {
        const { DEFAULT_VOLUME_BYTES } = require('../scripts/offline/pack');
        expect(DEFAULT_VOLUME_BYTES).toBe(2100000000);
        expect(DEFAULT_VOLUME_BYTES).toBeGreaterThan(2000007070);
        expect(DEFAULT_VOLUME_BYTES).toBeLessThan(2 * 1024 ** 3);
    });

    test('refuses to build without an image archive, with a hint to run the image workflow', async () => {
        const repo = makeRepo();
        await expect(buildOfflinePackages({ arch: 'arm64', repoRoot: repo, outDir: path.join(root, 'o'), imageArchive: path.join(root, 'missing.tar.gz') }, { log: () => {} }))
            .rejects.toThrow(/镜像归档/);
        expect(parseArgs(['--arch', 'x64', '--image-archive', 'a.tgz', '--no-patch'])).toEqual({ arch: 'x64', imageArchive: 'a.tgz', patchKrunkit: false });
    });
});

describe('scan allowlists and offline workflow', () => {
    const { validateAllowlist, scanTargets } = require('../scripts/scan-release-artifacts');
    const readJson = rel => JSON.parse(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));

    test.each(['scripts/offline/scan-allowlist.json', 'scripts/offline/scan-allowlist-linux.json', 'scripts/offline/scan-allowlist-image.json'])('%s is narrow, justified and compiles', rel => {
        const entries = readJson(rel);
        expect(() => validateAllowlist(entries)).not.toThrow();
        entries.forEach(entry => {
            expect(entry.rule).not.toBe('*');
            ['pathPattern', 'valuePattern'].forEach(key => { if (entry[key]) expect(() => new RegExp(entry[key])).not.toThrow(); });
        });
    });

    test('the package allowlist never waves through manyoyo\'s own files', async () => {
        const tree = path.join(root, 'full');
        fs.mkdirSync(path.join(tree, 'app/manyoyo/lib'), { recursive: true });
        fs.mkdirSync(path.join(tree, 'app/manyoyo/node_modules/dep'), { recursive: true });
        fs.writeFileSync(path.join(tree, 'app/manyoyo/lib/own.js'), '// built in /Users/alice/work and mailed to alice@example.com');
        fs.writeFileSync(path.join(tree, 'app/manyoyo/node_modules/dep/README.md'), 'by bob@example.com');
        const result = await scanTargets([tree], { allowlist: readJson('scripts/offline/scan-allowlist.json') });
        expect(result.hits.map(h => `${h.rule}:${h.file}`).sort()).toEqual([
            'email:full/app/manyoyo/lib/own.js',
            'local-path:full/app/manyoyo/lib/own.js'
        ]);
    });

    test('the linux package allowlist is anchored to lite/, pins the local-path values, and never waves through manyoyo\'s own files', async () => {
        const entries = readJson('scripts/offline/scan-allowlist-linux.json');
        entries.forEach(entry => expect(entry.pathPattern).toMatch(/^\^lite\//));
        entries.filter(entry => entry.rule === 'local-path').forEach(entry => expect(entry.valuePattern).toBeTruthy());

        const tree = path.join(root, 'lite');
        fs.mkdirSync(path.join(tree, 'app/node/bin'), { recursive: true });
        fs.mkdirSync(path.join(tree, 'app/manyoyo/lib'), { recursive: true });
        fs.writeFileSync(path.join(tree, 'app/node/bin/node'), 'built at /home/iojs/x and /home/alice/y');
        fs.writeFileSync(path.join(tree, 'app/manyoyo/lib/own.js'), '// /home/iojs/work alice@example.com');
        const result = await scanTargets([tree], { allowlist: entries });
        expect(result.hits.map(h => `${h.rule}:${h.file}`).sort()).toEqual([
            'email:lite/app/manyoyo/lib/own.js',
            'local-path:lite/app/manyoyo/lib/own.js',
            'local-path:lite/app/node/bin/node'
        ]);
        // 同样的内容放在别的根目录下不会被放行（路径锚定）
        const other = path.join(root, 'other/app/node/bin');
        fs.mkdirSync(other, { recursive: true });
        fs.writeFileSync(path.join(other, 'node'), 'built at /home/iojs/x');
        expect((await scanTargets([path.join(root, 'other')], { allowlist: entries })).hits).toHaveLength(1);
    });

    test('the image allowlist only waves through the known third-party PEM strings, not private keys elsewhere (e.g. /opt, /root/.local, own code)', async () => {
        const layer = path.join(root, 'layer-pk');
        fs.mkdirSync(path.join(layer, 'opt/app'), { recursive: true });
        fs.mkdirSync(path.join(layer, 'usr/bin'), { recursive: true });
        fs.writeFileSync(path.join(layer, 'opt/app/id_key'), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
        fs.writeFileSync(path.join(layer, 'usr/bin/ssh'), 'strings: -----BEGIN OPENSSH PRIVATE KEY-----');
        const tarPath = path.join(root, 'img-pk.tar');
        tar('-cf', tarPath, '-C', layer, '.');
        const result = await scanTargets([tarPath], { allowlist: readJson('scripts/offline/scan-allowlist-image.json') });
        expect(result.hits.map(h => `${h.rule}:${h.file.split('!/').pop()}`)).toEqual(['private-key:opt/app/id_key']);
    });

    test('the image allowlist never covers the image config/history (outside the layer file trees)', async () => {
        const dir = path.join(root, 'img');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ history: [{ created_by: 'RUN echo /Users/alice/build ; mail alice@example.com' }] }));
        const result = await scanTargets([dir], { allowlist: readJson('scripts/offline/scan-allowlist-image.json') });
        expect(result.hits.map(h => h.rule).sort()).toEqual(['email', 'local-path']);
    });

    test('the image allowlist understands OCI blob layers, still flags SSH host keys, and keeps the config blob unallowed', async () => {
        const layer = path.join(root, 'layer-src');
        fs.mkdirSync(path.join(layer, 'etc/ssh'), { recursive: true });
        fs.mkdirSync(path.join(layer, 'usr/share/doc/pkg'), { recursive: true });
        fs.writeFileSync(path.join(layer, 'etc/ssh/ssh_host_rsa_key'), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
        fs.writeFileSync(path.join(layer, 'usr/share/doc/pkg/copyright'), 'Maintainer: Someone <someone@example.org>');
        const blobs = path.join(root, 'img/blobs/sha256');
        fs.mkdirSync(blobs, { recursive: true });
        const layerBlob = path.join(blobs, 'a'.repeat(64));
        tar('-cf', layerBlob, '-C', layer, '.');
        fs.writeFileSync(path.join(blobs, 'b'.repeat(64)), JSON.stringify({ history: [{ created_by: 'RUN echo /Users/alice' }] }));
        const result = await scanTargets([path.join(root, 'img')], { allowlist: readJson('scripts/offline/scan-allowlist-image.json') });
        const hits = result.hits.map(h => `${h.rule}:${h.file.split('!/').slice(1).join('!/') || h.file.split('/').pop().slice(0, 3)}`).sort();
        expect(hits).toEqual(['local-path:bbb', 'private-key:etc/ssh/ssh_host_rsa_key'].sort());
        expect(result.allowed.some(a => a.rule === 'email')).toBe(true);
    });
});
