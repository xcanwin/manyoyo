'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { resolveLock } = require('../scripts/offline/lock');
const { buildCodePackages, parseArgs } = require('../scripts/offline/build-code');
const { validateCodeInfo, codeAssetName } = require('../lib/code-update');

const COMMIT = 'abc1234def5678901234567890abcdef12345678';
const SHA7 = COMMIT.slice(0, 7);
const BASE_VERSION = '8.6.9';
const PLATFORMS = [['linux', 'x64'], ['linux', 'arm64'], ['macos', 'x64'], ['macos', 'arm64']];

let root;
let repoRoot;
let calls;

function makeRepo() {
    repoRoot = path.join(root, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: '@xcanwin/manyoyo', version: BASE_VERSION, imageVersion: '2.2.0-common' }));
}

function fakes() {
    return {
        log: () => {},
        run: (command, args) => { calls.push(['run', command, ...args]); return ''; },
        download: async ({ url, dest }) => {
            calls.push(['download', path.basename(dest), url]);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, 'archive');
            return dest;
        },
        // 暂存目录里放占位文件，内容里带上它来自哪个压缩包，便于断言各平台用的是各自的 Node
        stageNode: ({ archivePath, destDir }) => {
            calls.push(['stageNode', path.basename(archivePath)]);
            fs.mkdirSync(path.join(destDir, 'bin'), { recursive: true });
            fs.writeFileSync(path.join(destDir, 'bin', 'node'), `node from ${path.basename(archivePath)}`, { mode: 0o755 });
        },
        stageManyoyo: ({ destDir }) => {
            calls.push(['stageManyoyo']);
            fs.mkdirSync(path.join(destDir, 'bin'), { recursive: true });
            fs.writeFileSync(path.join(destDir, 'bin', 'manyoyo.js'), '// manyoyo');
            fs.writeFileSync(path.join(destDir, 'package.json'), JSON.stringify({ name: '@xcanwin/manyoyo', version: BASE_VERSION }));
            return { tgz: 'xcanwin-manyoyo-8.6.9.tgz' };
        }
    };
}

const build = (extra = {}, injected = {}) => buildCodePackages({
    branch: 'main', commit: COMMIT, subject: '新增代码版升级', imageReady: true, builtAt: '2026-10-23T00:00:00.000Z',
    repoRoot, outDir: path.join(root, 'out'), workDir: path.join(root, 'work'), cacheDir: path.join(root, 'cache'), ...extra
}, { ...fakes(), ...injected });

function listTar(file) {
    return spawnSync('tar', ['-tzf', file], { encoding: 'utf-8' }).stdout.split('\n').filter(Boolean);
}

function extract(file) {
    const dir = fs.mkdtempSync(path.join(root, 'x-'));
    expect(spawnSync('tar', ['-xzf', file, '-C', dir]).status).toBe(0);
    return dir;
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-codebuild-'));
    calls = [];
    makeRepo();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('build-code：构建四个平台的代码版升级包', () => {
    test('只暂存一次 manyoyo 本体，四个平台各用自己锁定的 Node', async () => {
        await build();
        expect(calls.filter(c => c[0] === 'stageManyoyo')).toHaveLength(1);
        const used = calls.filter(c => c[0] === 'stageNode').map(c => c[1]).sort();
        const expected = PLATFORMS.map(([platform, arch]) => resolveLock(arch, platform).node.file).sort();
        expect(used).toEqual(expected);
    });

    test('产出四个带 sha7 的包与 CODE.json，CODE.json 通过客户端的同一套校验', async () => {
        const result = await build();
        const names = fs.readdirSync(path.join(root, 'out')).sort();
        const expected = PLATFORMS.map(([platform, arch]) => codeAssetName(COMMIT, platform, arch));
        expect(names).toEqual([...expected, 'CODE.json'].sort());
        const info = JSON.parse(fs.readFileSync(path.join(root, 'out', 'CODE.json'), 'utf-8'));
        const checked = validateCodeInfo(info, { branch: 'main' });
        expect(checked.version).toBe(`${BASE_VERSION}+${SHA7}`);
        expect(checked.imageVersion).toBe('2.2.0-common');
        expect(checked.imageReady).toBe(true);
        expect(checked.subject).toBe('新增代码版升级');
        for (const [platform, arch] of PLATFORMS) {
            const asset = info.assets[`${platform}-${arch}`];
            const file = path.join(root, 'out', asset.name);
            expect(asset.sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
            expect(asset.size).toBe(fs.statSync(file).size);
        }
        expect(result.info.version).toBe(`${BASE_VERSION}+${SHA7}`);
    });

    test('package.json 的 version 在 manyoyo 暂存完成之后改写成 x.y.z+sha7，仓库里的文件不动', async () => {
        await build();
        const dir = extract(path.join(root, 'out', codeAssetName(COMMIT, 'linux', 'x64')));
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'manyoyo', 'package.json'), 'utf-8')).version).toBe(`${BASE_VERSION}+${SHA7}`);
        expect(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')).version).toBe(BASE_VERSION);
    });

    test('包里 manyoyo/package.json 的 gitHead 等于提交（与 version 一起改写）', async () => {
        await build();
        for (const [platform, arch] of PLATFORMS) {
            const dir = extract(path.join(root, 'out', codeAssetName(COMMIT, platform, arch)));
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'manyoyo', 'package.json'), 'utf-8'));
            expect(pkg.gitHead).toBe(COMMIT);
            expect(pkg.version).toBe(`${BASE_VERSION}+${SHA7}`);
        }
    });

    test('包内容：node、manyoyo、manifest.json；manifest 与安装逻辑要求的字段一致', async () => {
        await build();
        for (const [platform, arch] of PLATFORMS) {
            const file = path.join(root, 'out', codeAssetName(COMMIT, platform, arch));
            const entries = listTar(file);
            expect(entries).toEqual(expect.arrayContaining(['manifest.json', 'node/bin/node', 'manyoyo/bin/manyoyo.js']));
            const dir = extract(file);
            const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
            expect(manifest).toMatchObject({ version: `${BASE_VERSION}+${SHA7}`, kind: 'app', os: platform, arch, imageVersion: '2.2.0-common', source: { branch: 'main', commit: COMMIT } });
            expect(fs.readFileSync(path.join(dir, 'node/bin/node'), 'utf-8')).toBe(`node from ${resolveLock(arch, platform).node.file}`);
            if (platform === 'macos') {
                expect(manifest.runtime).toEqual({ podmanVersion: resolveLock(arch, 'macos').podman.version });
            } else {
                expect(manifest.runtime).toBeUndefined();
            }
        }
    });

    test('imageReady=false 如实写进 CODE.json', async () => {
        await build({ imageReady: false });
        expect(JSON.parse(fs.readFileSync(path.join(root, 'out', 'CODE.json'), 'utf-8')).imageReady).toBe(false);
    });

    test('分支非法、提交不是 40 位 hex 一律在构建前拒绝', async () => {
        await expect(build({ branch: 'a--b' })).rejects.toThrow('分支名不合法');
        await expect(build({ commit: 'abc' })).rejects.toThrow('commit');
        expect(calls).toEqual([]);
    });

    test('命令行参数解析', () => {
        expect(parseArgs(['--branch', 'main', '--commit', COMMIT, '--image-ready', 'true', '--out', 'o', '--subject', 'x y'])).toMatchObject({ branch: 'main', commit: COMMIT, imageReady: 'true', out: 'o', subject: 'x y' });
        expect(() => parseArgs(['main'])).toThrow('未知参数');
    });
});
