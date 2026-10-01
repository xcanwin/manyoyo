'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { downloadVerified, sha256File } = require('../scripts/offline/download');
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
    async function makeRun(name = 'pkg') {
        const src = path.join(root, 'src');
        fs.mkdirSync(path.join(src, 'install'), { recursive: true });
        fs.writeFileSync(path.join(src, 'install/install.sh'), '#!/bin/sh\necho "installer ran with: $*"\n', { mode: 0o755 });
        fs.writeFileSync(path.join(src, 'data.txt'), 'payload data\n');
        const payload = path.join(root, 'payload.tar.gz');
        tar('-czf', payload, '-C', src, '.');
        const runPath = path.join(root, `${name}.run`);
        await writeRunFile({ payloadPath: payload, outPath: runPath, name });
        return runPath;
    }
    const sh = (...args) => spawnSync('sh', args, { encoding: 'utf-8' });

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

    test('arm64: produces full/lite/app packages with the documented layout, checksums and patch record', async () => {
        const out = path.join(root, 'out');
        const result = await build('arm64', out);
        const names = result.files.map(f => f.name).sort();
        expect(names).toEqual([
            'FILES-macos-arm64.txt'.replace('FILES-', 'SHA256SUMS-').replace('.txt', ''),
            'manyoyo-9.9.9-macos-arm64-app.tar.gz',
            'manyoyo-9.9.9-macos-arm64-lite.run',
            'manyoyo-9.9.9-macos-arm64.run',
            'release-manifest-macos-arm64.json'
        ].sort());

        // SHA256SUMS 与真实文件一致
        const sums = fs.readFileSync(path.join(out, 'SHA256SUMS-macos-arm64'), 'utf8').trim().split('\n');
        expect(sums).toHaveLength(3);
        for (const line of sums) {
            const [hash, name] = line.split('  ');
            expect(await sha256File(path.join(out, name))).toBe(hash);
        }
        expect(fs.readFileSync(path.join(out, 'FILES-macos-arm64.txt'), 'utf8').trim().split('\n')).toHaveLength(5);

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

        // lite：没有 Podman 与 VM 磁盘，但有镜像
        const lite = extract(path.join(out, 'manyoyo-9.9.9-macos-arm64-lite.run'), path.join(root, 'x-lite'));
        const liteFiles = walk(lite);
        expect(liteFiles.some(f => f.startsWith('runtime/') || f.startsWith('vm/'))).toBe(false);
        expect(liteFiles).toEqual(expect.arrayContaining(['images/manyoyo-9.9.9-common-arm64.tar.gz', 'app/node/bin/node']));
        expect(JSON.parse(fs.readFileSync(path.join(lite, 'manifest.json'), 'utf8')).components.podman).toBeUndefined();

        // app：只有 Node + manyoyo
        const appDir = path.join(root, 'x-app');
        fs.mkdirSync(appDir);
        tar('-xzf', path.join(out, 'manyoyo-9.9.9-macos-arm64-app.tar.gz'), '-C', appDir);
        const appFiles = walk(appDir);
        expect(appFiles).toEqual(expect.arrayContaining(['manifest.json', 'node/bin/node', 'manyoyo/lib/app.js']));
        expect(appFiles.some(f => f.startsWith('install/') || f.startsWith('runtime/') || f.startsWith('vm/') || f.startsWith('images/'))).toBe(false);
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

    test('splits an oversized .run into volumes that join back to a valid installer', async () => {
        const out = path.join(root, 'out');
        const result = await build('arm64', out, { volumeBytes: 2048 });
        const volumes = result.files.map(f => f.name).filter(name => /\.run\.\d{3}$/.test(name));
        expect(volumes.length).toBeGreaterThan(2);
        const fullParts = volumes.filter(name => !name.includes('-lite')).map(name => path.join(out, name));
        const joined = await joinVolumes(fullParts, path.join(root, 'joined.run'));
        expect(spawnSync('sh', [joined, '--check'], { encoding: 'utf-8' }).status).toBe(0);
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

    test.each(['scripts/offline/scan-allowlist.json', 'scripts/offline/scan-allowlist-image.json'])('%s is narrow, justified and compiles', rel => {
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

    test('the image allowlist never covers the image config/history (outside the layer file trees)', async () => {
        const dir = path.join(root, 'img');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ history: [{ created_by: 'RUN echo /Users/alice/build ; mail alice@example.com' }] }));
        const result = await scanTargets([dir], { allowlist: readJson('scripts/offline/scan-allowlist-image.json') });
        expect(result.hits.map(h => h.rule).sort()).toEqual(['email', 'local-path']);
    });

    test('workflow: manual only, scans before uploading, explicit file list, no secrets, no Release', () => {
        const text = fs.readFileSync(path.join(__dirname, '../.github/workflows/offline-macos.yml'), 'utf8');
        const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\nenv:'));
        expect(onBlock).toContain('workflow_dispatch:');
        expect(onBlock).not.toMatch(/^\s*(push|pull_request|schedule|release):/m);
        expect(text.indexOf('scripts/scan-release-artifacts.js')).toBeLessThan(text.indexOf('actions/upload-artifact@v4', text.indexOf('name: Build packages')));
        expect(text).toContain('scan-allowlist.json');
        expect(text).toContain('scan-allowlist-image.json');
        expect(text).toContain('steps.files.outputs.list');
        expect(text).not.toMatch(/secrets\./);
        expect(text).not.toMatch(/gh release|softprops|action-gh-release|npm publish|docker push/);
        expect(text).toContain('packages: read');
        expect(text).toContain('brew install gnu-tar');
        expect(text).toContain('macos-15-intel');
    });
});
