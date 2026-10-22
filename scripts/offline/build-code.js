#!/usr/bin/env node
'use strict';

// 代码版升级包构建（只在 CI 里运行，见 .github/workflows/code-packages.yml）：
// 一次 npm pack + npm ci --omit=dev 得到 manyoyo 本体（运行时依赖没有平台相关包），四个平台各自配自己锁定的 Node，
// 产出 manyoyo-code-<sha7>-<os>-<arch>-app.tar.gz 与 CODE.json（客户端 lib/code-update.js 按同一套规则校验）。
// 用法: node scripts/offline/build-code.js --branch main --commit <40 位 sha> --subject <提交标题> --image-ready true|false --out <目录>

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveLock } = require('./lock');
const { downloadVerified, sha256File } = require('../../lib/download-verified');
const stage = require('./stage');
const { inventoryDir, buildManifest } = require('./manifest');
const { createNormalizedTar } = require('../normalized-tar');
const { isValidBranch, codeAssetName } = require('../../lib/code-update');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PLATFORMS = [['linux', 'x64'], ['linux', 'arm64'], ['macos', 'x64'], ['macos', 'arm64']];

function defaultRun(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} 失败 (${result.status}): ${String(result.stderr || '').trim().slice(0, 500)}`);
    }
    return result.stdout || '';
}

function linkTree(source, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name);
        const to = path.join(dest, entry.name);
        if (entry.isDirectory()) linkTree(from, to);
        else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
        else fs.linkSync(from, to);
    }
}

async function buildCodePackages(options, injected = {}) {
    const deps = { run: defaultRun, download: downloadVerified, stageNode: stage.stageNode, stageManyoyo: stage.stageManyoyo, log: message => console.log(message), ...injected };
    const { branch, commit } = options;
    if (!isValidBranch(branch)) throw new Error(`分支名不合法: ${branch}（规则见 lib/code-update.js）`);
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('commit 必须是 40 位小写 hex 的完整提交 sha');
    const repoRoot = options.repoRoot || REPO_ROOT;
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    const version = `${pkg.version}+${commit.slice(0, 7)}`;
    const imageVersion = pkg.imageVersion;
    const outDir = path.resolve(options.outDir || path.join(repoRoot, 'dist-code'));
    const workDir = path.resolve(options.workDir || path.join(outDir, '..', 'code-work'));
    const cacheDir = path.resolve(options.cacheDir || path.join(workDir, 'cache'));
    const builtAt = options.builtAt || (process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : new Date().toISOString());

    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmpRoot = path.join(workDir, 'tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });

    // 1. manyoyo 本体只暂存一次（npm pack + npm ci --omit=dev）。version 在 npm ci 之后才改写：
    //    npm 在安装阶段对带 + 的版本号怎么处理没有验证过，不让它碰
    deps.log(`[1/3] 暂存 manyoyo ${version}`);
    const shared = path.join(workDir, 'shared', 'manyoyo');
    const manyoyoStage = deps.stageManyoyo({ repoRoot, destDir: shared, run: deps.run, tmpRoot });
    const sharedPkgPath = path.join(shared, 'package.json');
    const sharedPkg = JSON.parse(fs.readFileSync(sharedPkgPath, 'utf-8'));
    sharedPkg.version = version;
    fs.writeFileSync(sharedPkgPath, `${JSON.stringify(sharedPkg, null, 2)}\n`);

    // 2. 四个平台：各自的 Node + 共享的 manyoyo → manifest.json → 规范化打包
    const assets = {};
    for (const [platform, arch] of PLATFORMS) {
        deps.log(`[2/3] 组装 ${platform}-${arch}`);
        const lock = resolveLock(arch, platform);
        const nodeArchive = await deps.download({ url: lock.node.url, sha256: lock.node.sha256, dest: path.join(cacheDir, lock.node.file), log: deps.log });
        const tree = path.join(workDir, 'staging', `${platform}-${arch}`);
        deps.stageNode({ archivePath: nodeArchive, destDir: path.join(tree, 'node'), run: deps.run, tmpRoot });
        linkTree(shared, path.join(tree, 'manyoyo'));
        const components = {
            node: { version: lock.node.version, url: lock.node.url, sha256: lock.node.sha256, pruned: ['npm', 'corepack', 'include', 'share'] },
            manyoyo: { version, package: manyoyoStage.tgz }
        };
        const manifest = buildManifest({ version, imageVersion, arch, kind: 'app', components, files: await inventoryDir(tree), builtAt, platform });
        manifest.source = { branch, commit };
        // 换 Podman 时 `manyoyo update` 据此提示；代码版不带虚拟机磁盘，所以只有 podmanVersion
        if (platform === 'macos') manifest.runtime = { podmanVersion: lock.podman.version };
        fs.writeFileSync(path.join(tree, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

        const name = codeAssetName(commit, platform, arch);
        const output = path.join(outDir, name);
        createNormalizedTar({ output, cwd: tree, entries: fs.readdirSync(tree).sort(), compression: 'gzip', mtime: builtAt });
        assets[`${platform}-${arch}`] = { name, sha256: await sha256File(output), size: fs.statSync(output).size };
    }

    // 3. CODE.json 最后写：客户端以它为准，它出现时四个包都已经就绪
    deps.log('[3/3] 生成 CODE.json');
    const info = {
        schemaVersion: 1,
        branch,
        commit,
        subject: String(options.subject || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
        version,
        imageVersion,
        imageReady: options.imageReady === true,
        builtAt,
        assets
    };
    fs.writeFileSync(path.join(outDir, 'CODE.json'), `${JSON.stringify(info, null, 2)}\n`);
    return { info, outDir, workDir };
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        if (!key.startsWith('--')) throw new Error(`未知参数: ${key}`);
        args[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    }
    return args;
}

if (require.main === module) {
    const args = parseArgs(process.argv.slice(2));
    buildCodePackages({
        branch: args.branch, commit: args.commit, subject: args.subject, imageReady: args.imageReady === 'true',
        outDir: args.out, workDir: args.work, cacheDir: args.cache
    }).then(result => {
        console.log(JSON.stringify(result.info, null, 2));
    }).catch(error => {
        console.error(`构建失败: ${error.message}`);
        process.exit(1);
    });
}

module.exports = { buildCodePackages, parseArgs, PLATFORMS };
