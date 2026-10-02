'use strict';

// 发布控制台的“事实”采集：只读（git / gh / npm / ghcr），不改任何东西。
// 所有外部调用都经 ctx.read(cmd, args) 注入（同步，返回 { status, stdout, stderr }），测试用假实现。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseReleaseVersion, compareReleaseVersions } = require('./versions');

const WORKFLOWS = {
    macos: 'offline-macos.yml',
    linux: 'offline-linux.yml',
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

function expectedAssetNames(version) {
    const names = [];
    for (const os of ['macos', 'linux']) {
        for (const arch of ['arm64', 'x64']) {
            names.push(`manyoyo-${version}-${os}-${arch}.run`, `manyoyo-${version}-${os}-${arch}-app.tar.gz`);
        }
    }
    names.push('SHA256SUMS');
    return names.sort();
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

// 当前代码树的指纹（HEAD + 未提交改动），预检结果只对同一份代码有效
function treeFingerprint(read) {
    const headSha = out(read('git', ['rev-parse', 'HEAD']));
    const status = String(read('git', ['status', '--porcelain']).stdout || '');
    const diffText = String(read('git', ['diff', 'HEAD']).stdout || '');
    return crypto.createHash('sha1').update(`${headSha}\n${status}\n${diffText}`).digest('hex');
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
    const fingerprint = treeFingerprint(read);

    const hasOrigin = out(read('git', ['remote'])).split('\n').includes('origin');
    const originMainSha = hasOrigin ? out(read('git', ['rev-parse', '--verify', '-q', 'origin/main'])) : '';
    const mergedIntoOriginMain = Boolean(originMainSha) && read('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']).status === 0;
    const ahead = hasOrigin && branch ? Number(out(read('git', ['rev-list', '--count', `origin/${branch}..HEAD`])) || 0) : 0;

    const tags = out(read('git', ['tag', '--list', 'v*'])).split('\n').filter(item => parseReleaseVersion(item.replace(/^v/, '')));
    tags.sort((a, b) => compareReleaseVersions(b.replace(/^v/, ''), a.replace(/^v/, '')));
    const latestTag = tags[0] || null;

    // 最近一次发布以来改了什么（决定是否需要新镜像）
    let imageChangedSinceTag = false;
    let commitsSinceTag = [];
    if (latestTag) {
        const names = out(read('git', ['diff', '--name-only', `${latestTag}..HEAD`, '--', 'docker/'])).split('\n').filter(Boolean);
        const oldPkg = parseJson(out(read('git', ['show', `${latestTag}:package.json`])), {});
        imageChangedSinceTag = names.length > 0 || (oldPkg.imageVersion && oldPkg.imageVersion !== pkg.imageVersion);
        commitsSinceTag = out(read('git', ['log', '--format=%s', `${latestTag}..HEAD`])).split('\n').filter(Boolean);
    }

    const slow = readAsync(ctx);
    const ghOk = (await slow('gh', ['auth', 'status'])).status === 0;
    const facts = {
        pkg: { version, imageVersion: pkg.imageVersion },
        tag,
        git: { branch, headSha, dirty, fingerprint, hasOrigin, originMainSha, mergedIntoOriginMain, ahead, latestTag, imageChangedSinceTag, commitsSinceTag },
        gh: { ok: ghOk },
        release: { exists: false, assets: [], createdAt: '', url: '' },
        npm: { version: null },
        image: { exists: null },
        runs: {}
    };
    if (!ghOk) return facts;

    const [releaseRaw, npmRaw, imageOk, macos, linux, image, npmRuns, assets, verify] = await Promise.all([
        slow('gh', ['release', 'view', tag, '--json', 'assets,createdAt,url']),
        slow('npm', ['view', NPM_PACKAGE, 'version', '--prefer-online']),
        imageExists(ctx, pkg.imageVersion),
        latestRun(ctx, WORKFLOWS.macos, ['-b', 'main']),
        latestRun(ctx, WORKFLOWS.linux, ['-b', 'main']),
        latestRun(ctx, WORKFLOWS.image, ['-b', 'main']),
        latestRun(ctx, WORKFLOWS.npm),
        latestRun(ctx, WORKFLOWS.assets, ['-b', 'main']),
        latestRun(ctx, WORKFLOWS.verify, ['-b', 'main'])
    ]);
    const release = parseJson(out(releaseRaw), null);
    if (release) {
        facts.release = { exists: true, assets: (release.assets || []).map(item => item.name).sort(), createdAt: release.createdAt || '', url: release.url || '' };
    }
    facts.npm.version = out(npmRaw) || null;
    facts.image.exists = imageOk;
    facts.runs = { macos, linux, image, npm: npmRuns, assets, verify };
    return facts;
}

module.exports = { collectFacts, treeFingerprint, parsePorcelain, expectedAssetNames, WORKFLOWS, NPM_PACKAGE };
