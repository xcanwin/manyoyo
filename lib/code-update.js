'use strict';

// 代码版升级：`manyoyo update --code [分支]`。
// 目标机器没有 git / npm，所以构建在 CI 里做（.github/workflows/code-packages.yml、scripts/offline/build-code.js），
// 这里只下载 CODE.json → 校验 → 下载本机平台的 -app.tar.gz → SHA256 校验 → 复用 installFromArchive 切换 current。
// 网络与副作用都从参数注入。CODE.json 来自网络，每个字段都严格校验：资产名要“等于”按提交与平台拼出的名字，不是匹配某个正则。

const fs = require('fs');
const os = require('os');
const path = require('path');
const appUpdate = require('./app-update');
const { downloadVerified, sha256File } = require('./download-verified');

const { UpdateError, compareVersions, networkError, request, installFromArchive, switchInstalled } = appUpdate;

const DOWNLOAD_BASE = 'https://github.com/xcanwin/manyoyo/releases/download/';
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
const IMAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+-[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PLATFORMS = ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64'];
const MAX_CODE_JSON_CHARS = 64 * 1024;
const SUBJECT_MAX_CHARS = 200;

function isValidBranch(branch) {
    return typeof branch === 'string' && BRANCH_PATTERN.test(branch) && !branch.includes('--') && !branch.includes('..') && !branch.includes('//') && !branch.endsWith('/');
}

/** 分支 → 滚动预发布的 tag：code-<分支>，/ 换成 --（分支名不允许含 --，所以映射不会冲突）。CI 脚本与客户端共用。 */
function codeTagForBranch(branch) {
    if (!isValidBranch(branch)) {
        throw new UpdateError('BAD_BRANCH', `分支名不合法: ${String(branch).slice(0, 60)}（只能用字母、数字、. _ - /，不能以符号开头，不能含 -- / .. / //）`);
    }
    return `code-${branch.replace(/\//g, '--')}`;
}

function codeAssetName(commit, targetOs, targetArch) {
    return `manyoyo-code-${String(commit).slice(0, 7)}-${targetOs}-${targetArch}-app.tar.gz`;
}

function bad(message) {
    return new UpdateError('BAD_CODE_INFO', `代码版信息（CODE.json）不合法：${message}，已中止。`);
}

/** 校验 CODE.json；返回规范化后的副本（subject 已清洗）。 */
function validateCodeInfo(info, { branch }) {
    if (!info || typeof info !== 'object' || Array.isArray(info)) throw bad('不是对象');
    if (info.schemaVersion !== 1) throw bad('schemaVersion 不支持');
    if (info.branch !== branch) throw bad(`分支不符（期望 ${branch}）`);
    if (typeof info.commit !== 'string' || !/^[0-9a-f]{40}$/.test(info.commit)) throw bad('commit 格式不对');
    if (typeof info.version !== 'string' || !/^\d+\.\d+\.\d+\+[0-9a-f]{7}$/.test(info.version) || !info.version.endsWith(`+${info.commit.slice(0, 7)}`)) throw bad('version 与 commit 不符');
    if (typeof info.imageVersion !== 'string' || !IMAGE_VERSION_PATTERN.test(info.imageVersion)) throw bad('imageVersion 格式不对');
    if (typeof info.imageReady !== 'boolean') throw bad('imageReady 必须是布尔值');
    if (!info.assets || typeof info.assets !== 'object' || Array.isArray(info.assets)) throw bad('缺少 assets');
    const assets = {};
    for (const [key, asset] of Object.entries(info.assets)) {
        if (!PLATFORMS.includes(key)) throw bad(`未知平台 ${key.slice(0, 40)}`);
        const [targetOs, targetArch] = key.split('-');
        if (!asset || typeof asset !== 'object') throw bad(`${key} 条目不是对象`);
        if (asset.name !== codeAssetName(info.commit, targetOs, targetArch)) throw bad(`${key} 的文件名不符合命名规则`);
        if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)) throw bad(`${key} 的 sha256 格式不对`);
        if (!Number.isInteger(asset.size) || asset.size <= 0) throw bad(`${key} 的 size 不对`);
        assets[key] = { name: asset.name, sha256: asset.sha256, size: asset.size };
    }
    // 只用于打印：去掉控制字符并截断
    const subject = String(info.subject || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SUBJECT_MAX_CHARS);
    return {
        schemaVersion: 1, branch, commit: info.commit, subject, version: info.version,
        imageVersion: info.imageVersion, imageReady: info.imageReady, builtAt: typeof info.builtAt === 'string' ? info.builtAt.slice(0, 40) : '', assets
    };
}

function tagBase(downloadBase, branch) {
    return `${downloadBase}${encodeURIComponent(codeTagForBranch(branch))}/`;
}

// notFoundRetryMs：CI 替换 CODE.json 时（gh 的 --clobber 是先删后传）有一小段时间它不存在，404 先等一下再确认一次
async function fetchCodeInfo({ branch, fetchImpl = fetch, downloadBase = DOWNLOAD_BASE, notFoundRetryMs = 2000 }) {
    const url = `${tagBase(downloadBase, branch)}CODE.json`;
    let response = await request(fetchImpl, url, { headers: { Accept: 'application/json' } });
    if (response.status === 404) {
        await new Promise(resolve => setTimeout(resolve, notFoundRetryMs));
        response = await request(fetchImpl, url, { headers: { Accept: 'application/json' } });
    }
    if (response.status === 404) {
        throw new UpdateError('NO_CODE_BUILD', `分支 ${branch} 还没有代码版（也可能正在更新）。main 分支在推送后会自动构建（需要几分钟，稍后再试）；其他分支需要维护者手动触发构建。`);
    }
    if (!response.ok) throw new UpdateError('HTTP', `查询代码版信息失败（HTTP ${response.status}）。\n   地址: ${url}`, { url });
    // 声明的长度就超限的，不读内容
    if (Number(response.headers.get('content-length')) > MAX_CODE_JSON_CHARS) throw bad('内容过大');
    let text;
    try {
        text = await response.text();
    } catch (error) {
        throw networkError(url, error, '读取中断，连不上');
    }
    if (text.length > MAX_CODE_JSON_CHARS) throw bad('内容过大');
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw bad('不是合法的 JSON');
    }
    return validateCodeInfo(parsed, { branch });
}

// 当前版本的 manyoyo/package.json 里的 gitHead（正式包与代码版包构建时写入）；读不到或格式不对当作没有
function readCurrentGitHead(appRoot) {
    try {
        const head = JSON.parse(fs.readFileSync(path.join(appRoot, 'current', 'manyoyo', 'package.json'), 'utf-8')).gitHead;
        return typeof head === 'string' && /^[0-9a-f]{40}$/.test(head) ? head : '';
    } catch (error) {
        return '';
    }
}

/**
 * 本地 app/<版本>/ 已经是这个代码版时返回它的 manifest，否则 null（调用方照常下载，不报错）。
 * --rollback 直接切到本地目录，所以这里的检查不能比它宽松：目录结构完整，并额外核对 manifest 与 .installed、提交号。
 */
async function findLocalCopy({ appRoot, info, targetArch, targetOs }) {
    const dir = path.join(appRoot, info.version);
    try {
        for (const required of ['node/bin/node', 'manyoyo/bin/manyoyo.js', 'manifest.json', '.installed']) {
            if (!fs.existsSync(path.join(dir, required))) return null;
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
        if (!manifest || manifest.version !== info.version || manifest.kind !== 'app' || manifest.arch !== targetArch || manifest.os !== targetOs) return null;
        if (!manifest.source || manifest.source.commit !== info.commit) return null;
        // installFromArchive 安装时把 manifest.json 的哈希写进 .installed：对得上才说明目录没被动过
        if (fs.readFileSync(path.join(dir, '.installed'), 'utf-8').trim() !== await sha256File(path.join(dir, 'manifest.json'))) return null;
        return manifest;
    } catch (error) {
        return null;
    }
}

// 构建时间按本机时区显示成 YYYY-MM-DD HH:mm；timeZone 可注入（测试不依赖运行机器的时区）
function formatBuiltAt(builtAt, timeZone) {
    const date = new Date(builtAt);
    if (typeof builtAt !== 'string' || !builtAt || Number.isNaN(date.getTime())) return '未知时间';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * 安装某个分支的代码版。installed 是当前版本号。
 * 返回：{ status: 'same', info }（已是这个版本）、{ status: 'same-release', info }（与当前正式版同一个提交）、
 * { status: 'reused' | 'installed', info, version, previous, manifest }（本地已有就直接切换 / 下载安装）。
 * 校验失败 / 镜像未发布 / 版本更旧都在下载与切换之前中止，current 不变。
 * onInfo(info)：全部校验通过后、下载或切换之前调用，让调用方先告诉用户装的是哪个提交。
 */
async function installCodeUpdate({ appRoot, branch, installed, fetchImpl = fetch, downloadBase = DOWNLOAD_BASE, notFoundRetryMs, onInfo, targetArch = appUpdate.arch(), targetOs = appUpdate.platformOs(), run, log = () => {}, tmpRoot = os.tmpdir() }) {
    const info = await fetchCodeInfo({ branch, fetchImpl, downloadBase, notFoundRetryMs });
    if (info.version === installed) return { status: 'same', info };
    if (readCurrentGitHead(appRoot) === info.commit) return { status: 'same-release', info };
    if (compareVersions(info.version, installed) < 0) {
        throw new UpdateError('OLDER', `分支 ${branch} 的代码版是 ${info.version}，比当前的 ${installed} 旧。${branch} 的最新提交可能还在构建，稍后再试；要换回正式版请用 manyoyo update --rollback 或重新运行安装命令。`);
    }
    if (!info.imageReady) {
        throw new UpdateError('IMAGE_NOT_READY', `这个代码版需要镜像 ${info.imageVersion}，但它还没有发布，现在升级会让容器拉不到镜像。请等镜像发布后再试，或换一个分支。`);
    }
    // 降级与镜像检查都排在本地复用之前，否则本地留着旧目录时会绕过它们
    const local = await findLocalCopy({ appRoot, info, targetArch, targetOs });
    const asset = info.assets[`${targetOs}-${targetArch}`];
    if (!local && !asset) throw new UpdateError('NO_ASSET', `代码版 ${info.version} 里没有适合这台机器（${targetOs}-${targetArch}）的升级包。`);
    if (typeof onInfo === 'function') onInfo(info);
    if (local) return { status: 'reused', info, ...switchInstalled({ appRoot, version: info.version, manifest: local }) };
    const url = `${tagBase(downloadBase, branch)}${asset.name}`;
    // 包是按 CODE.json 里的固定命名拼出来的：先确认确实存在（404 就是没有）
    const probe = await request(fetchImpl, url, { method: 'HEAD' });
    if (probe.status === 404) throw new UpdateError('NO_ASSET', `代码版 ${info.version} 的升级包 ${asset.name} 还没有上传完整，请稍后再试。`);

    const workDir = fs.mkdtempSync(path.join(tmpRoot, 'manyoyo-code-update-'));
    try {
        const archive = path.join(workDir, asset.name);
        try {
            // 服务端声明的大小与 CODE.json 不符就直接中止，不把磁盘写满再校验哈希
            const guarded = async (target, options) => {
                const response = await request(fetchImpl, target, { ...options, noTimeout: true });
                const declared = response.headers.get('content-length');
                if (response.ok && declared !== null && Number(declared) !== asset.size) {
                    // status 让 downloadVerified 当作明确的拒绝，不做重试
                    throw new UpdateError('CHECKSUM', `代码版升级包大小与 CODE.json 不符（${declared} ≠ ${asset.size}），已中止升级，当前版本不受影响。`, { status: response.status });
                }
                return response;
            };
            await downloadVerified({ url, sha256: asset.sha256, dest: archive, fetchImpl: guarded, log });
        } catch (error) {
            if (/SHA256 校验失败/.test(error.message)) throw new UpdateError('CHECKSUM', '代码版升级包 SHA256 校验失败，已中止升级，当前版本不受影响。');
            if (error instanceof UpdateError) throw error;
            throw networkError(url, error, '下载中断，连不上');
        }
        const result = await installFromArchive({ appRoot, archive, version: info.version, targetArch, targetOs, run });
        return { status: 'installed', info, ...result };
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

function isCodeVersion(version) {
    return typeof version === 'string' && /^\d+\.\d+\.\d+\+[0-9a-f]{7}$/.test(version);
}

/** 普通 `update` 发现最新正式版不比当前新时说的话：代码版要特别说明怎么换回正式版。 */
function latestReleaseNotice(installed, latest) {
    if (isCodeVersion(installed)) {
        return `当前是代码版 ${installed}，最新正式版 ${latest} 不比它新。要换回正式版，请重新运行安装命令（或 manyoyo update --rollback 回到上一个版本）。`;
    }
    return `已是最新版本 ${installed}`;
}

module.exports = { formatBuiltAt, isCodeVersion, latestReleaseNotice, DOWNLOAD_BASE, isValidBranch, codeTagForBranch, codeAssetName, validateCodeInfo, fetchCodeInfo, installCodeUpdate };
