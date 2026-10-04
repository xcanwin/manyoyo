'use strict';

// 组装各组件到暂存目录。所有外部命令通过 run(cmd, args, opts) 注入，便于测试。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractPkgPayload } = require('./xar');

const NODE_KEEP = ['bin/node', 'LICENSE'];
// x64 的官方 pkg 里 krunkit / libkrun 及其依赖都是 arm64 二进制，Intel 上用 applehv（vfkit），整套丢掉
const X64_DROP = [/^bin\/krunkit$/, /^lib(\/|$)/, /^share\/krunkit(\/|$)/];

function copyFile(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, fs.statSync(from).mode & 0o777);
}

// 私有 Node 只保留运行时：不带 npm / corepack / 头文件 / 文档（用户侧不再访问 npm，也少一批第三方噪声）
function stageNode({ archivePath, destDir, run, tmpRoot = os.tmpdir() }) {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'manyoyo-node-'));
    try {
        run('tar', ['-xzf', archivePath, '-C', tmp, '--strip-components=1']);
        for (const rel of NODE_KEEP) {
            const source = path.join(tmp, rel);
            if (!fs.existsSync(source)) throw new Error(`Node 压缩包里缺少 ${rel}`);
            copyFile(source, path.join(destDir, rel));
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// manyoyo 本体：只用 npm pack 产物（受 package.json 的 files 白名单约束），生产依赖在暂存目录里 npm ci，
// 绝不复制仓库工作目录
function stageManyoyo({ repoRoot, destDir, run, tmpRoot = os.tmpdir() }) {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'manyoyo-pack-'));
    try {
        const packed = String(run('npm', ['pack', '--pack-destination', tmp, '--silent'], { cwd: repoRoot })).trim().split('\n').pop();
        const tgz = path.join(tmp, packed);
        if (!packed || !fs.existsSync(tgz)) throw new Error('npm pack 没有产出 tgz');
        fs.mkdirSync(destDir, { recursive: true });
        run('tar', ['-xzf', tgz, '-C', destDir, '--strip-components=1']);
        fs.copyFileSync(path.join(repoRoot, 'package-lock.json'), path.join(destDir, 'package-lock.json'));
        run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: destDir });
        fs.rmSync(path.join(destDir, 'package-lock.json'), { force: true });
        return { tgz: packed };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function shouldKeepPodmanFile(name, arch) {
    const relative = name.replace(/^\.\//, '').replace(/^podman\/?/, '');
    if (!relative) return true;
    const base = path.posix.basename(relative);
    if (base.startsWith('._') || base === '.DS_Store') return false; // AppleDouble（官方 pkg 里就带有）
    if (relative === 'docs' || relative.startsWith('docs/')) return false;
    if (arch === 'x64' && X64_DROP.some(pattern => pattern.test(relative))) return false;
    return true;
}

/**
 * krunkit 写死只在 /opt/homebrew/lib、/opt/podman/lib 找 libkrun.dylib（M01 V1 实测），
 * 私有目录下会 abort trap。补上相对 rpath 并 ad-hoc 重签（保留 hypervisor 等 entitlements）。
 * install_name_tool 属于 Xcode CLT，所以必须在 CI 里做，不能放到用户机器上。
 */
function patchKrunkit({ podmanDir, run, tmpRoot = os.tmpdir() }) {
    const krunkit = path.join(podmanDir, 'bin', 'krunkit');
    if (!fs.existsSync(krunkit)) return null;
    if (!fs.existsSync(path.join(podmanDir, 'lib', 'libkrun.dylib'))) {
        throw new Error('krunkit 存在但 lib/libkrun.dylib 缺失，无法打补丁');
    }
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'manyoyo-krunkit-'));
    try {
        const entitlements = path.join(tmp, 'krunkit.entitlements');
        const xml = run('codesign', ['-d', '--entitlements', ':-', krunkit]);
        if (!String(xml).includes('com.apple.security.hypervisor')) {
            throw new Error('krunkit 的 entitlements 里没有 com.apple.security.hypervisor，拒绝重签');
        }
        fs.writeFileSync(entitlements, xml);
        run('install_name_tool', ['-add_rpath', '@executable_path/../lib', krunkit]);
        run('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, krunkit]);
        run('codesign', ['--verify', '--strict', krunkit]);
        const rpaths = String(run('otool', ['-l', krunkit]));
        if (!rpaths.includes('@executable_path/../lib')) throw new Error('补丁后 krunkit 仍没有 @executable_path/../lib');
        return { target: 'bin/krunkit', rpath: '@executable_path/../lib', signature: 'ad-hoc', entitlements: ['com.apple.security.hypervisor'] };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

async function stagePodman({ pkgPath, destDir, arch, run, patch = true, tmpRoot = os.tmpdir() }) {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'manyoyo-podman-'));
    try {
        const { files } = await extractPkgPayload(pkgPath, tmp, name => shouldKeepPodmanFile(name, arch));
        const source = path.join(tmp, 'podman');
        if (!fs.existsSync(path.join(source, 'bin', 'podman'))) throw new Error('pkg 里没有 podman/bin/podman');
        fs.rmSync(destDir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(destDir), { recursive: true });
        fs.renameSync(source, destDir);
        const patches = [];
        if (arch === 'arm64' && patch) {
            const record = patchKrunkit({ podmanDir: destDir, run, tmpRoot });
            if (record) patches.push(record);
        }
        return { files, patches };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function findVmDiskFile(dataDir) {
    const candidates = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (path.basename(dir) === 'cache' && /\.raw(\.(zst|xz|gz))?$/.test(entry.name)) candidates.push(full);
        }
    };
    walk(dataDir);
    candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    return candidates[0] || '';
}

/**
 * 取“未启动过”的官方 machine-os 磁盘：用所带 Podman 执行一次 `machine init`（不启动），
 * 它下载的压缩磁盘就缓存在 <data>/containers/podman/machine/<provider>/cache/（M01 V2 实测可直接 `--image` 使用）。
 * 在临时 XDG 目录里执行，不碰任何真实用户数据。
 */
function fetchVmDisk({ podmanDir, run, tmpRoot = os.tmpdir(), cacheDir = '' }) {
    // 缓存目录里已有磁盘（CI 按 Podman 版本 + 架构 + 周缓存）就直接用，省掉重新下载
    if (cacheDir && fs.existsSync(cacheDir)) {
        const hit = fs.readdirSync(cacheDir).find(name => /\.raw(\.(zst|xz|gz))?$/.test(name));
        if (hit) {
            const kept = path.join(tmpRoot, `manyoyo-vm-disk-${process.pid}-${hit}`);
            fs.copyFileSync(path.join(cacheDir, hit), kept);
            return { path: kept, fileName: hit };
        }
    }
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'manyoyo-vm-'));
    try {
        const config = path.join(tmp, 'config');
        const data = path.join(tmp, 'data');
        fs.mkdirSync(path.join(config, 'containers'), { recursive: true });
        fs.mkdirSync(data, { recursive: true });
        const conf = path.join(config, 'containers', 'containers.conf');
        fs.writeFileSync(conf, `[engine]\nhelper_binaries_dir = [${JSON.stringify(path.join(podmanDir, 'bin'))}]\n`);
        run(path.join(podmanDir, 'bin', 'podman'), ['machine', 'init', '--disk-size', '10', 'manyoyo-fetch'], {
            env: { ...process.env, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, CONTAINERS_CONF: conf, TMPDIR: tmp }
        });
        const found = findVmDiskFile(data);
        if (!found) throw new Error('machine init 之后没有找到缓存的 VM 磁盘（cache/*.raw*）');
        const kept = path.join(tmpRoot, `manyoyo-vm-disk-${process.pid}-${path.basename(found)}`);
        fs.copyFileSync(found, kept);
        if (cacheDir) {
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.copyFileSync(found, path.join(cacheDir, path.basename(found)));
        }
        return { path: kept, fileName: path.basename(found) };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

module.exports = {
    fetchVmDisk,
    findVmDiskFile,
    stageNode,
    stageManyoyo,
    stagePodman,
    patchKrunkit,
    shouldKeepPodmanFile
};
