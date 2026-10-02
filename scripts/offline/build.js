#!/usr/bin/env node
'use strict';

// 离线包构建（在 CI 的干净 macOS runner 上运行，不要在维护者本机构建并发布）。
// 产物：完整包 .run、-app.tar.gz、SHA256SUMS-<os>-<arch>（只供 release-offline 合并成 Release 的唯一 SHA256SUMS，不单独上传）、FILES.txt。
// Linux 包（--platform linux，在 Linux runner 上构建）：只有 Node + manyoyo + 镜像归档，不带 Podman 与虚拟机磁盘，一种形态（内部 kind 为 lite）。
// 用法: node scripts/offline/build.js --arch arm64|x64 --image-archive <manyoyo 镜像 tar.gz> [--platform macos|linux] [--out dist-offline]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveLock } = require('./lock');
const { downloadVerified, sha256File } = require('../../lib/download-verified');
const stage = require('./stage');
const { inventoryDir, buildManifest, formatSha256Sums } = require('./manifest');
const { writeRunFile, splitFile, DEFAULT_VOLUME_BYTES } = require('./pack');
const { renderInstallEnv } = require('./install-env');
const { createNormalizedTar } = require('../normalized-tar');

const REPO_ROOT = path.join(__dirname, '..', '..');

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

async function fileRecord(name, filePath) {
    return { name, path: filePath, size: fs.statSync(filePath).size, sha256: await sha256File(filePath) };
}

async function buildOfflinePackages(options, injected = {}) {
    const deps = {
        run: defaultRun,
        download: downloadVerified,
        stageNode: stage.stageNode,
        stageManyoyo: stage.stageManyoyo,
        stagePodman: stage.stagePodman,
        fetchVmDisk: stage.fetchVmDisk,
        log: message => console.log(message),
        ...injected
    };
    const { arch } = options;
    const platform = options.platform || 'macos';
    const lock = resolveLock(arch, platform);
    const isLinux = platform === 'linux';
    const repoRoot = options.repoRoot || REPO_ROOT;
    const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    const version = options.version || pkgJson.version;
    const imageVersion = options.imageVersion || pkgJson.imageVersion;
    const outDir = path.resolve(options.outDir || path.join(repoRoot, 'dist-offline'));
    const workDir = path.resolve(options.workDir || path.join(outDir, 'work'));
    const cacheDir = path.resolve(options.cacheDir || path.join(outDir, 'cache'));
    const volumeBytes = options.volumeBytes || DEFAULT_VOLUME_BYTES;
    if (!options.imageArchive || !fs.existsSync(options.imageArchive)) {
        throw new Error('缺少 manyoyo 镜像归档（--image-archive），请先运行镜像发布 workflow 并取其按架构的归档');
    }

    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    const tmpRoot = path.join(workDir, 'tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const base = `manyoyo-${version}-${platform}-${arch}`;

    // 1. 组件：下载 + 校验 + 暂存
    const components = path.join(workDir, 'components');
    deps.log(`[1/5] 组装组件 (${arch})`);
    const nodeArchive = await deps.download({ url: lock.node.url, sha256: lock.node.sha256, dest: path.join(cacheDir, lock.node.file), log: deps.log });
    deps.stageNode({ archivePath: nodeArchive, destDir: path.join(components, 'app', 'node'), run: deps.run, tmpRoot });
    const manyoyoStage = deps.stageManyoyo({ repoRoot, destDir: path.join(components, 'app', 'manyoyo'), run: deps.run, tmpRoot });

    let podmanResult = null;
    let vm = null;
    let vmSha = '';
    if (!isLinux) {
        const podmanArchive = await deps.download({ url: lock.podman.url, sha256: lock.podman.sha256, dest: path.join(cacheDir, lock.podman.file), log: deps.log });
        podmanResult = await deps.stagePodman({
            pkgPath: podmanArchive, destDir: path.join(components, 'runtime', 'podman'), arch, run: deps.run, patch: options.patchKrunkit !== false, tmpRoot
        });

        deps.log('[2/5] 获取 VM 磁盘（未启动过的官方 machine-os）');
        vm = await deps.fetchVmDisk({ podmanDir: path.join(components, 'runtime', 'podman'), run: deps.run, tmpRoot });
        vmSha = await sha256File(vm.path);
        fs.mkdirSync(path.join(components, 'vm'), { recursive: true });
        fs.copyFileSync(vm.path, path.join(components, 'vm', vm.fileName));
        fs.rmSync(vm.path, { force: true });
    }

    const imageName = `manyoyo-${imageVersion}-${arch}.tar.gz`;
    fs.mkdirSync(path.join(components, 'images'), { recursive: true });
    fs.copyFileSync(options.imageArchive, path.join(components, 'images', imageName));
    const imageSha = await sha256File(path.join(components, 'images', imageName));

    const componentInfo = {
        node: { version: lock.node.version, url: lock.node.url, sha256: lock.node.sha256, pruned: ['npm', 'corepack', 'include', 'share'] },
        manyoyo: { version, package: manyoyoStage.tgz },
        image: { ref: `ghcr.io/xcanwin/manyoyo:${imageVersion}`, file: `images/${imageName}`, sha256: imageSha }
    };
    if (!isLinux) {
        componentInfo.podman = {
            version: lock.podman.version, url: lock.podman.url, sha256: lock.podman.sha256,
            machineProvider: lock.podman.machineProvider, patches: podmanResult.patches
        };
        componentInfo.vmDisk = { file: `vm/${vm.fileName}`, sha256: vmSha, source: 'podman machine init（官方 quay.io/podman/machine-os，未启动过）' };
    }

    // 2. 三种目录树（硬链接，不复制大文件）
    deps.log('[3/5] 生成目录树（macOS: full / app；Linux: lite / app）');
    const staging = path.join(workDir, 'staging');
    const trees = {};
    const kinds = isLinux ? ['lite', 'app'] : ['full', 'app'];
    for (const kind of kinds) {
        const tree = path.join(staging, kind);
        trees[kind] = tree;
        if (kind === 'app') {
            linkTree(path.join(components, 'app'), tree);
            continue;
        }
        linkTree(path.join(components, 'app'), path.join(tree, 'app'));
        linkTree(path.join(components, 'images'), path.join(tree, 'images'));
        if (kind === 'full') {
            linkTree(path.join(components, 'runtime'), path.join(tree, 'runtime'));
            linkTree(path.join(components, 'vm'), path.join(tree, 'vm'));
        }
        fs.mkdirSync(path.join(tree, 'install'), { recursive: true });
        for (const script of ['install.sh', 'finish-import.sh']) {
            fs.copyFileSync(path.join(__dirname, script), path.join(tree, 'install', script));
            fs.chmodSync(path.join(tree, 'install', script), 0o755);
        }
        fs.writeFileSync(path.join(tree, 'install', 'env.sh'), renderInstallEnv({ version, imageVersion, arch, kind, componentInfo, platform }));
    }

    const builtAt = process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : '';
    const manifests = {};
    for (const kind of kinds) {
        const kindComponents = { ...componentInfo };
        if (kind !== 'full') { delete kindComponents.podman; delete kindComponents.vmDisk; }
        if (kind === 'app') delete kindComponents.image;
        const files = await inventoryDir(trees[kind]);
        manifests[kind] = buildManifest({ version, imageVersion, arch, kind, components: kindComponents, files, builtAt, platform });
        // manyoyo update 据此提示 Podman / 虚拟机磁盘有变化（只 macOS 有）
        if (kind === 'app' && !isLinux) manifests[kind].runtime = { podmanVersion: lock.podman.version, vmDiskSha256: vmSha };
        fs.writeFileSync(path.join(trees[kind], 'manifest.json'), `${JSON.stringify(manifests[kind], null, 2)}\n`);
    }

    // 3. 规范化打包
    deps.log('[4/5] 规范化打包');
    const outputs = [];
    const mtime = builtAt || undefined;
    for (const [kind, suffix] of (isLinux ? [['lite', '']] : [['full', '']])) {
        const payload = path.join(workDir, `payload-${kind}.tar.gz`);
        createNormalizedTar({ output: payload, cwd: trees[kind], entries: fs.readdirSync(trees[kind]).sort(), compression: 'gzip', mtime });
        const runPath = path.join(outDir, `${base}${suffix}.run`);
        await writeRunFile({ payloadPath: payload, outPath: runPath, name: `${base}${suffix}`, volumeBytes });
        fs.rmSync(payload, { force: true });
        for (const part of await splitFile(runPath, volumeBytes)) outputs.push(await fileRecord(path.basename(part), part));
    }
    const appTar = path.join(outDir, `${base}-app.tar.gz`);
    createNormalizedTar({ output: appTar, cwd: trees.app, entries: fs.readdirSync(trees.app).sort(), compression: 'gzip', mtime });
    outputs.push(await fileRecord(path.basename(appTar), appTar));

    // 4. 校验和与清单
    deps.log('[5/5] 生成 SHA256SUMS');
    const sumsPath = path.join(outDir, `SHA256SUMS-${platform}-${arch}`);
    fs.writeFileSync(sumsPath, formatSha256Sums(outputs));
    const deliverables = [...outputs, await fileRecord(path.basename(sumsPath), sumsPath)];
    fs.writeFileSync(path.join(outDir, `FILES-${platform}-${arch}.txt`), `${deliverables.map(item => path.relative(process.cwd(), item.path)).join('\n')}\n`);

    return { version, imageVersion, arch, outDir, workDir, files: deliverables, trees, manifests, componentInfo };
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        if (!key.startsWith('--')) throw new Error(`未知参数: ${key}`);
        const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (name === 'noPatch') { args.patchKrunkit = false; continue; }
        args[name] = argv[++i];
    }
    return args;
}

if (require.main === module) {
    const args = parseArgs(process.argv.slice(2));
    buildOfflinePackages({
        arch: args.arch, imageArchive: args.imageArchive, outDir: args.out, workDir: args.work, cacheDir: args.cache,
        version: args.version, imageVersion: args.imageVersion, patchKrunkit: args.patchKrunkit, platform: args.platform
    }).then(result => {
        result.files.forEach(file => console.log(`${file.sha256}  ${String(file.size).padStart(11)}  ${file.name}`));
    }).catch(error => {
        console.error(`构建失败: ${error.message}`);
        if (error.stack) console.error(error.stack);
        process.exit(1);
    });
}

module.exports = { buildOfflinePackages, parseArgs, linkTree };
