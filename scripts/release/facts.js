'use strict';

// 发布控制台的“事实”采集：只读（git / gh / npm / ghcr），不改任何东西。
// 所有外部调用都经 ctx.read(cmd, args) 注入（同步，返回 { status, stdout, stderr }），测试用假实现。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseReleaseVersion, compareReleaseVersions } = require('./versions');

const WORKFLOWS = {
    ci: 'ci.yml',
    packages: 'build-packages.yml',
    image: 'image-publish.yml',
    npm: 'npm-publish.yml',
    assets: 'release-offline.yml',
    verify: 'release-verify.yml'
};
const NPM_PACKAGE = '@xcanwin/manyoyo';
const IMAGE_REPO = 'xcanwin/manyoyo';

// 网络类探测（gh / npm / ghcr）并行且不阻塞事件循环；没有注入 readAsync 时退回同步 read
function readAsync(ctx) {
    return ctx.readAsync || (async (cmd, args) => ctx.read(cmd, args));
}

function out(result) {
    return result && result.status === 0 ? String(result.stdout || '').trim() : '';
}

function parseJson(text, fallback) {
    try {
        return JSON.parse(text);
    } catch (error) {
        return fallback;
    }
}

// git status --porcelain：XY 路径（重命名为 "旧 -> 新"，取新路径）
function parsePorcelain(text) {
    return String(text || '').split('\n').filter(Boolean).map(line => {
        const code = line.slice(0, 2);
        let file = line.slice(3);
        if (file.includes(' -> ')) file = file.split(' -> ').pop();
        return { code: code.trim() || '?', path: file.replace(/^"|"$/g, '') };
    });
}

const PLATFORMS = [['macos', 'arm64'], ['macos', 'x64'], ['linux', 'arm64'], ['linux', 'x64']];

/**
 * 资产是否齐全：SHA256SUMS + 4 个 -app.tar.gz + 每个平台“单个 .run 或从 001 连续的 .run.NNN 分卷”。
 * 给了 SHA256SUMS 的内容（文件名列表）时，还要求清单与实际资产完全一致。
 * @returns {{ok:boolean, missing:string[], extra:string[]}}
 */
function checkAssets(version, assetNames, sums = null) {
    const have = new Set(assetNames);
    const known = new Set(['SHA256SUMS']);
    const missing = [];
    if (!have.has('SHA256SUMS')) missing.push('SHA256SUMS');
    for (const [os, arch] of PLATFORMS) {
        const prefix = `manyoyo-${version}-${os}-${arch}`;
        const app = `${prefix}-app.tar.gz`;
        known.add(app);
        if (!have.has(app)) missing.push(app);
        if (have.has(`${prefix}.run`)) {
            known.add(`${prefix}.run`);
            continue;
        }
        const volumes = assetNames.filter(name => name.startsWith(`${prefix}.run.`)).sort();
        volumes.forEach(name => known.add(name));
        const contiguous = volumes.length > 0 && volumes.every((name, index) => name === `${prefix}.run.${String(index + 1).padStart(3, '0')}`);
        if (!contiguous) missing.push(volumes.length > 0 ? `${prefix}.run.001…（分卷不连续）` : `${prefix}.run`);
    }
    const extra = assetNames.filter(name => !known.has(name));
    if (sums) {
        const listed = new Set(sums);
        for (const name of assetNames) if (name !== 'SHA256SUMS' && !listed.has(name)) extra.push(`${name}（不在 SHA256SUMS 里）`);
        for (const name of listed) if (!have.has(name)) missing.push(`${name}（SHA256SUMS 里有但 Release 没有）`);
    }
    return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

/** SHA256SUMS 文本 → 文件名列表（sha256sum 格式：<哈希>  <文件名>，二进制模式带 *） */
function parseSums(text) {
    return String(text || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => line.replace(/^[0-9a-fA-F]+\s+\*?/, ''));
}

async function latestRun(ctx, workflow, extra = []) {
    const list = parseJson(out(await readAsync(ctx)('gh', ['run', 'list', '--workflow', workflow, '-L', '10', '--json', 'databaseId,status,conclusion,headSha,headBranch,createdAt', ...extra])), []);
    return Array.isArray(list) ? list : [];
}

async function imageExists(ctx, imageVersion) {
    if (!ctx.fetchJson || !imageVersion) return null;
    try {
        const token = await ctx.fetchJson(`https://ghcr.io/token?scope=repository:${IMAGE_REPO}:pull`);
        if (!token || !token.token) return null;
        const response = await ctx.fetchStatus(`https://ghcr.io/v2/${IMAGE_REPO}/manifests/${imageVersion}`, {
            Authorization: `Bearer ${token.token}`,
            Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'
        });
        // 只有明确的 404 才是“不存在”；401 / 429 / 5xx 都只是“暂时无法确认”
        if (response === 200) return true;
        return response === 404 ? false : null;
    } catch (error) {
        return null;
    }
}

// 当前代码树的指纹（HEAD + 未提交改动 + 未跟踪文件的内容），预检结果只对同一份代码有效
function treeFingerprint(read, repoRoot) {
    const headSha = out(read('git', ['rev-parse', 'HEAD']));
    const status = String(read('git', ['status', '--porcelain']).stdout || '');
    const diffText = String(read('git', ['diff', 'HEAD']).stdout || '');
    const hash = crypto.createHash('sha1').update(`${headSha}\n${status}\n${diffText}`);
    const untracked = String(read('git', ['ls-files', '-o', '--exclude-standard']).stdout || '').split('\n').filter(Boolean).sort();
    for (const file of untracked) {
        hash.update(`\n${file}\n`);
        try {
            const full = path.join(repoRoot, file);
            const stat = fs.statSync(full);
            // 大文件（下载的产物、虚拟机磁盘等）只看大小与修改时间，别在每次刷新状态时整个读进内存
            if (stat.size > 5 * 1024 * 1024) hash.update(`${stat.size}:${stat.mtimeMs}`);
            else hash.update(fs.readFileSync(full));
        } catch (error) {
            hash.update('(unreadable)');
        }
    }
    return hash.digest('hex');
}

/**
 * 采集当前仓库与远端状态。网络类探测失败时对应字段为 null（表示“未知”），不抛错。
 */
async function collectFacts(ctx) {
    const { read, repoRoot } = ctx;
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    const version = pkg.version;
    const tag = `v${version}`;

    const branch = out(read('git', ['branch', '--show-current']));
    const headSha = out(read('git', ['rev-parse', 'HEAD']));
    // 不能 trim：porcelain 每行以两位状态码开头，第一行的前导空格是有意义的
    const dirty = parsePorcelain(String(read('git', ['status', '--porcelain']).stdout || ''));
    const fingerprint = treeFingerprint(read, repoRoot);

    const hasOrigin = out(read('git', ['remote'])).split('\n').includes('origin');
    const originMainSha = hasOrigin ? out(read('git', ['rev-parse', '--verify', '-q', 'origin/main'])) : '';
    const mergedIntoOriginMain = Boolean(originMainSha) && read('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']).status === 0;
    const ahead = hasOrigin && branch ? Number(out(read('git', ['rev-list', '--count', `origin/${branch}..HEAD`])) || 0) : 0;

    const tags = out(read('git', ['tag', '--list', 'v*'])).split('\n').filter(item => parseReleaseVersion(item.replace(/^v/, '')));
    tags.sort((a, b) => compareReleaseVersions(b.replace(/^v/, ''), a.replace(/^v/, '')));
    const latestTag = tags[0] || null;

    // 最近一次发布以来改了什么（决定是否需要新镜像）
    let imageChangedSinceTag = false;
    let dockerChangedSinceTag = false;
    let imageVersionChanged = false;
    let changedFiles = [];
    let commitsSinceTag = [];
    if (latestTag) {
        changedFiles = out(read('git', ['diff', '--name-only', `${latestTag}..HEAD`])).split('\n').filter(Boolean);
        dockerChangedSinceTag = changedFiles.some(file => file.startsWith('docker/'));
        const oldPkg = parseJson(out(read('git', ['show', `${latestTag}:package.json`])), {});
        imageVersionChanged = Boolean(oldPkg.imageVersion) && oldPkg.imageVersion !== pkg.imageVersion;
        imageChangedSinceTag = dockerChangedSinceTag || imageVersionChanged;
        commitsSinceTag = out(read('git', ['log', '--format=%s', `${latestTag}..HEAD`])).split('\n').filter(Boolean);
    }

    const slow = readAsync(ctx);
    const ghOk = (await slow('gh', ['auth', 'status'])).status === 0;
    const facts = {
        pkg: { version, imageVersion: pkg.imageVersion },
        tag,
        git: { branch, headSha, dirty, fingerprint, hasOrigin, originMainSha, mergedIntoOriginMain, ahead, latestTag, imageChangedSinceTag, dockerChangedSinceTag, imageVersionChanged, changedFiles, commitsSinceTag },
        gh: { ok: ghOk },
        release: { exists: false, draft: false, assets: [], sums: null, createdAt: '', url: '' },
        npm: { version: null },
        image: { exists: null },
        runs: {}
    };
    if (!ghOk) return facts;

    const [releaseRaw, npmRaw, imageOk, ci, packages, image, npmRuns, assets, verify] = await Promise.all([
        slow('gh', ['release', 'view', tag, '--json', 'assets,createdAt,url,isDraft']),
        slow('npm', ['view', NPM_PACKAGE, 'version', '--prefer-online']),
        imageExists(ctx, pkg.imageVersion),
        latestRun(ctx, WORKFLOWS.ci, ['-b', branch]),
        latestRun(ctx, WORKFLOWS.packages, ['-b', 'main']),
        latestRun(ctx, WORKFLOWS.image, ['-b', 'main']),
        latestRun(ctx, WORKFLOWS.npm),
        latestRun(ctx, WORKFLOWS.assets, ['-b', 'main']),
        latestRun(ctx, WORKFLOWS.verify, ['-b', 'main'])
    ]);
    const release = parseJson(out(releaseRaw), null);
    if (release) {
        facts.release = { exists: true, draft: release.isDraft === true, assets: (release.assets || []).map(item => item.name).sort(), sums: null, createdAt: release.createdAt || '', url: release.url || '' };
        // 结构齐全时再读 SHA256SUMS，核对清单与资产完全一致（草稿也能下载）
        if (facts.release.assets.includes('SHA256SUMS') && checkAssets(version, facts.release.assets).ok) {
            const sums = await slow('gh', ['release', 'download', tag, '-p', 'SHA256SUMS', '-O', '-']);
            if (sums.status === 0) facts.release.sums = parseSums(sums.stdout);
        }
    }
    facts.npm.version = out(npmRaw) || null;
    facts.image.exists = imageOk;
    facts.runs = { ci, packages, image, npm: npmRuns, assets, verify };
    return facts;
}

module.exports = { collectFacts, treeFingerprint, parsePorcelain, checkAssets, parseSums, WORKFLOWS, NPM_PACKAGE };
