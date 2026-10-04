'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scanTargets, mask, validateAllowlist, parseArgs } = require('../scripts/scan-release-artifacts');
const { createNormalizedTar, buildNormalizedTarArgs } = require('../scripts/normalized-tar');

const SCRIPT = path.join(__dirname, '../scripts/scan-release-artifacts.js');
const FAKE_TOKEN = 'sk-ant-FAKEFAKEFAKEFAKEFAKE1234567890';
const FAKE_GHP = `ghp_${'a'.repeat(36)}`;

describe('scan-release-artifacts', () => {
    let root;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-scan-test-')); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    const write = (rel, content) => {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        return file;
    };
    const rules = result => result.hits.map(hit => hit.rule).sort();

    test('finds tokens, local paths, emails, private key headers and build identity', async () => {
        write('pkg/a.txt', `key=${FAKE_TOKEN}\nhome=/Users/xxx/project\nmail=dev@example.com\n${FAKE_GHP}\nAKIAABCDEFGHIJKLMNOP\n`);
        write('pkg/key.txt', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
        write('pkg/meta.json', '{"built_on":"secret-build-host"}');
        const result = await scanTargets([path.join(root, 'pkg')], { denyStrings: ['secret-build-host'] });

        expect(rules(result)).toEqual(['build-identity', 'email', 'local-path', 'private-key', 'token', 'token', 'token']);
        expect(result.hits.find(h => h.rule === 'local-path').file).toBe('pkg/a.txt');
    });

    test('fails closed: unreadable compressed archive is reported as unscanned and exits 1', async () => {
        write('pkg/broken.tar.xz', Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), Buffer.from('not really xz data')]));
        const result = await scanTargets([path.join(root, 'pkg')]);
        expect(result.hits).toEqual([]);
        expect(result.unscanned.map(item => item.file)).toEqual(['pkg/broken.tar.xz']);
        const cli = spawnSync('node', [SCRIPT, path.join(root, 'pkg'), '--no-inventory'], { encoding: 'utf-8' });
        expect(cli.status).toBe(1);
        expect(cli.stdout).toContain('未能扫描');
    });

    test('gzip beyond max depth is still stream-scanned instead of skipped', async () => {
        const zlib = require('zlib');
        write('pkg/deep.txt.gz', zlib.gzipSync(`leak=${FAKE_TOKEN}\n`));
        const result = await scanTargets([path.join(root, 'pkg')], { maxDepth: 1 });
        expect(rules(result)).toEqual(['token']);
        expect(result.unscanned).toEqual([]);
    });

    test('--exclude patterns must be anchored with ^', () => {
        expect(() => parseArgs([root, '--exclude', 'images'])).toThrow(/\^/);
        expect(parseArgs([root, '--exclude', '^full/images(/|$)']).excludes).toEqual(['^full/images(/|$)']);
    });

    test('output never contains a full matched secret', async () => {
        write('pkg/a.txt', `${FAKE_TOKEN} ${FAKE_GHP} /Users/alicewonderland/x`);
        const result = await scanTargets([path.join(root, 'pkg')]);
        const dump = JSON.stringify(result);
        expect(dump).not.toContain(FAKE_TOKEN);
        expect(dump).not.toContain(FAKE_GHP);
        expect(dump).not.toContain('alicewonderland');
        expect(result.hits.every(hit => !('raw' in hit))).toBe(true);
        expect(mask('abcdefghijkl')).toBe('abc…kl(12字符)');
        expect(mask('short')).toBe('*****');

        const cli = spawnSync('node', [SCRIPT, path.join(root, 'pkg'), '--no-inventory'], { encoding: 'utf-8' });
        expect(cli.status).toBe(1);
        expect(cli.stdout + cli.stderr).not.toContain(FAKE_TOKEN);
        expect(cli.stdout + cli.stderr).not.toContain('alicewonderland');
    });

    test('flags sensitive file names, AppleDouble files and .git directories', async () => {
        write('pkg/.env', 'A=1');
        write('pkg/.env.local', 'A=1');
        write('pkg/.npmrc', 'x');
        write('pkg/manyoyo.json', '{}');
        write('pkg/manyoyo.example.json', '{}');
        write('pkg/id_rsa', 'x');
        write('pkg/server.pem', 'x');
        write('pkg/._resource', 'x');
        write('pkg/.git/config', 'x');
        const result = await scanTargets([path.join(root, 'pkg')]);
        const files = result.hits.map(h => h.file).sort();
        expect(files).toEqual([
            'pkg/.env', 'pkg/.env.local', 'pkg/.git', 'pkg/.npmrc', 'pkg/._resource',
            'pkg/id_rsa', 'pkg/manyoyo.json', 'pkg/server.pem'
        ].sort());
        expect(files).not.toContain('pkg/manyoyo.example.json');
    });

    test('a clean tree passes and lists every file with size and sha256', async () => {
        write('pkg/a.txt', 'hello');
        write('pkg/sub/b.bin', Buffer.from([0, 1, 2, 3]));
        const result = await scanTargets([path.join(root, 'pkg')]);
        expect(result.hits).toEqual([]);
        expect(result.inventory).toEqual([
            { path: 'pkg/a.txt', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
            { path: 'pkg/sub/b.bin', size: 4, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }
        ]);
    });

    test('scans inside tar.gz archives and binary files, and reports the archive-relative path', async () => {
        write('src/app/readme.txt', `see /home/builder/dev and ${FAKE_TOKEN}`);
        write('src/app/tool.bin', Buffer.concat([Buffer.from([0, 255, 0, 1]), Buffer.from('/Users/carol/go/pkg'), Buffer.from([0, 0])]));
        const archive = path.join(root, 'out.tar.gz');
        expect(spawnSync('tar', ['-czf', archive, '-C', path.join(root, 'src'), 'app']).status).toBe(0);

        const result = await scanTargets([archive]);
        const files = result.hits.map(h => h.file);
        expect(files).toEqual(expect.arrayContaining(['out.tar.gz!/app/readme.txt', 'out.tar.gz!/app/tool.bin']));
        expect(rules(result)).toEqual(expect.arrayContaining(['local-path', 'token']));
        expect(result.inventory.map(i => i.path)).toEqual(expect.arrayContaining(['out.tar.gz', 'out.tar.gz!/app/readme.txt']));
    });

    test('unpacks image archives layer by layer (layers and config are scanned)', async () => {
        write('layer/etc/leak.txt', `token ${FAKE_TOKEN}`);
        const layerTar = path.join(root, 'image/blobs/layer1.tar');
        fs.mkdirSync(path.dirname(layerTar), { recursive: true });
        expect(spawnSync('tar', ['-cf', layerTar, '-C', path.join(root, 'layer'), 'etc']).status).toBe(0);
        write('image/manifest.json', JSON.stringify([{ Config: 'config.json', Layers: ['blobs/layer1.tar'] }]));
        write('image/config.json', JSON.stringify({ history: [{ created_by: 'RUN echo /Users/dave/build' }] }));
        const imageTar = path.join(root, 'image.tar');
        expect(spawnSync('tar', ['-cf', imageTar, '-C', path.join(root, 'image'), '.']).status).toBe(0);

        const result = await scanTargets([imageTar]);
        const files = result.hits.map(h => h.file);
        expect(files.some(f => f.endsWith('blobs/layer1.tar!/etc/leak.txt'))).toBe(true);
        expect(files.some(f => f.endsWith('config.json'))).toBe(true);
    });

    test('a match inside an expanded archive is reported once, at the inner path (not again for the archive itself)', async () => {
        write('src/app/leak.txt', `token ${FAKE_TOKEN}`);
        const archive = path.join(root, 'plain.tar');
        expect(spawnSync('tar', ['-cf', archive, '-C', path.join(root, 'src'), 'app']).status).toBe(0);
        const result = await scanTargets([archive]);
        expect(result.hits.map(h => h.file)).toEqual(['plain.tar!/app/leak.txt']);
    });

    test('detects a match that straddles the read-chunk boundary', async () => {
        const CHUNK = 4 * 1024 * 1024;
        const padding = Buffer.alloc(CHUNK - 10, 'x');
        write('pkg/big.bin', Buffer.concat([padding, Buffer.from(FAKE_TOKEN), Buffer.alloc(100, 'y')]));
        const result = await scanTargets([path.join(root, 'pkg')]);
        expect(result.hits.filter(h => h.rule === 'token')).toHaveLength(1);
    });

    test('allowlist entries suppress matching hits, need a reason, and must be narrow', async () => {
        write('pkg/node_modules/dep/doc.md', 'see /home/user/example');
        write('pkg/a.txt', 'see /home/realperson/x');
        const allowlist = [{ rule: 'local-path', path: 'node_modules/dep/', reason: '第三方文档里的示例路径' }];
        const result = await scanTargets([path.join(root, 'pkg')], { allowlist });
        expect(result.hits.map(h => h.file)).toEqual(['pkg/a.txt']);
        expect(result.allowed).toEqual([expect.objectContaining({ file: 'pkg/node_modules/dep/doc.md', reason: '第三方文档里的示例路径' })]);

        expect(() => validateAllowlist([{ rule: 'email', value: 'a@b.co' }])).toThrow(/reason/);
        expect(() => validateAllowlist([{ rule: 'email', reason: 'x' }])).toThrow(/不允许整条规则放行/);
        expect(() => validateAllowlist([{ reason: 'x', value: 'y' }])).toThrow(/rule/);
        expect(() => validateAllowlist([{ rule: 'email', value: 'a@b.co', reason: '公开联系邮箱' }])).not.toThrow();
    });

    test('--exclude skips matching paths (reported as skipped) but still scans the rest', async () => {
        write('pkg/images/big.txt', FAKE_TOKEN);
        write('pkg/app/own.txt', FAKE_TOKEN);
        const result = await scanTargets([path.join(root, 'pkg')], { excludes: ['^pkg/images(/|$)'] });
        expect(result.hits.map(h => h.file)).toEqual(['pkg/app/own.txt']);
        expect(result.skipped).toEqual(['pkg/images']);
        const cli = spawnSync('node', [SCRIPT, path.join(root, 'pkg'), '--no-inventory', '--exclude', '^pkg/(images|app)(/|$)'], { encoding: 'utf-8' });
        expect(cli.status).toBe(0);
        expect(cli.stdout).toContain('跳过 2 项');
    });

    test('directories extracted from archives with restrictive modes are still readable', async () => {
        write('src/locked/secret.txt', FAKE_TOKEN);
        fs.chmodSync(path.join(root, 'src/locked'), 0o500);
        const archive = path.join(root, 'locked.tar');
        expect(spawnSync('tar', ['-cf', archive, '-C', path.join(root, 'src'), 'locked']).status).toBe(0);
        fs.chmodSync(path.join(root, 'src/locked'), 0o700);
        const result = await scanTargets([archive]);
        expect(result.hits.map(h => h.file)).toEqual(['locked.tar!/locked/secret.txt']);
    });

    test('CLI exit codes: 0 clean, 1 hits, 2 usage errors', () => {
        write('clean/a.txt', 'nothing here');
        write('dirty/a.txt', FAKE_TOKEN);
        const run = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf-8' });
        expect(run(path.join(root, 'clean')).status).toBe(0);
        expect(run(path.join(root, 'dirty')).status).toBe(1);
        expect(run(path.join(root, 'missing')).status).toBe(2);
        expect(run().status).toBe(2);
        expect(run('--bogus', root).status).toBe(2);
        const allow = path.join(root, 'allow.json');
        fs.writeFileSync(allow, JSON.stringify([{ rule: 'token', path: 'dirty/', reason: '测试假数据' }]));
        expect(run('--allowlist', allow, path.join(root, 'dirty')).status).toBe(0);
        expect(parseArgs(['--build-user', 'alice', '--build-host', 'mbp', root]).denyStrings).toEqual(['alice', 'mbp']);
    });
});

describe('normalized tar', () => {
    let root;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ntar-')); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('produces root-owned, fixed-mtime archives without ._ files, reproducibly', () => {
        fs.mkdirSync(path.join(root, 'src/app'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src/app/b.txt'), 'b');
        fs.writeFileSync(path.join(root, 'src/app/a.txt'), 'a');
        fs.writeFileSync(path.join(root, 'src/app/._a.txt'), 'appledouble');
        fs.writeFileSync(path.join(root, 'src/.DS_Store'), 'x');

        const one = path.join(root, 'one.tar.gz');
        const two = path.join(root, 'two.tar.gz');
        createNormalizedTar({ output: one, cwd: path.join(root, 'src'), entries: ['app', '.DS_Store'], compression: 'gzip' });
        // 改变源文件的 mtime 后再打一次，结果必须一致
        fs.utimesSync(path.join(root, 'src/app/a.txt'), new Date(2001, 1, 1), new Date(2001, 1, 1));
        createNormalizedTar({ output: two, cwd: path.join(root, 'src'), entries: ['app', '.DS_Store'], compression: 'gzip' });

        expect(fs.readFileSync(one).equals(fs.readFileSync(two))).toBe(true);
        const listing = spawnSync('tar', ['-tvzf', one, '--numeric-owner'], { encoding: 'utf-8' }).stdout;
        expect(listing).not.toContain('._a.txt');
        expect(listing).not.toContain('.DS_Store');
        expect(listing).toContain('app/a.txt');
        listing.trim().split('\n').forEach(line => {
            expect(line).toMatch(/\b0\/0\b/);
            expect(line).toContain('2020-01-01');
        });
        expect(listing.indexOf('app/a.txt')).toBeLessThan(listing.indexOf('app/b.txt'));
    });

    test('gzip-fast uses compression level 1 (for payloads that are already compressed), is still reproducible and readable by tar -xzf', () => {
        const gnu = buildNormalizedTarArgs({ output: 'o.tar.gz', cwd: '/c', entries: ['x'], flavor: 'gnu', compression: 'gzip-fast' }).args;
        expect(gnu).toEqual(expect.arrayContaining(['--use-compress-program', 'gzip -n -1']));
        const bsd = buildNormalizedTarArgs({ output: 'o.tar.gz', cwd: '/c', entries: ['x'], flavor: 'bsd', compression: 'gzip-fast' }).args;
        expect(bsd).toEqual(expect.arrayContaining(['--gzip', '--options', 'gzip:compression-level=1']));

        fs.mkdirSync(path.join(root, 'src/app'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src/app/a.txt'), 'a'.repeat(4096));
        const one = path.join(root, 'fast-one.tar.gz');
        const two = path.join(root, 'fast-two.tar.gz');
        createNormalizedTar({ output: one, cwd: path.join(root, 'src'), entries: ['app'], compression: 'gzip-fast' });
        createNormalizedTar({ output: two, cwd: path.join(root, 'src'), entries: ['app'], compression: 'gzip-fast' });
        expect(fs.readFileSync(one).equals(fs.readFileSync(two))).toBe(true);
        const dest = path.join(root, 'fast-out');
        fs.mkdirSync(dest);
        expect(spawnSync('tar', ['-xzf', one, '-C', dest]).status).toBe(0);
        expect(fs.readFileSync(path.join(dest, 'app/a.txt'), 'utf8')).toBe('a'.repeat(4096));
    });

    test('builds the expected flags for both tar flavors and validates input', () => {
        const gnu = buildNormalizedTarArgs({ output: 'o.tar', cwd: '/c', entries: ['x'], flavor: 'gnu' }).args;
        expect(gnu).toEqual(expect.arrayContaining(['--owner=0', '--group=0', '--numeric-owner', '--no-xattrs', '--sort=name', '--exclude=._*']));
        const bsd = buildNormalizedTarArgs({ output: 'o.tar', cwd: '/c', entries: ['x'], flavor: 'bsd' }).args;
        expect(bsd).toEqual(expect.arrayContaining(['--uid', '--gid', '--no-xattrs', '--no-mac-metadata', '--exclude=._*']));
        expect(() => buildNormalizedTarArgs({ output: 'o.tar', cwd: '/c', entries: [] })).toThrow(/entries/);
        expect(() => buildNormalizedTarArgs({ output: 'o.tar', cwd: '/c', entries: ['x'], compression: 'lzma', flavor: 'gnu' })).toThrow(/压缩/);
    });
});
