'use strict';

// 离线包安装的 manyoyo 的增量升级：只下载 -app.tar.gz（Node + manyoyo，数十 MB），校验后放进 app/<版本>/，
// 原子切换 app/current，保留上一版本以便回滚。npm 安装的用户走原来的 npm 逻辑，不经过这里。
// 所有网络与进程副作用都从参数注入，便于用本地 HTTP 服务替身做测试。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { downloadVerified, sha256File } = require('./download-verified');

const REPO = 'xcanwin/manyoyo';
const API_BASE = 'https://api.github.com';
// 不依赖 PATH 查找 tar（macOS 与常见 Linux 都在 /usr/bin）
const TAR_COMMAND = fs.existsSync('/usr/bin/tar') ? '/usr/bin/tar' : 'tar';
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const FETCH_TIMEOUT_MS = 15000;

class UpdateError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function parseVersion(text) {
    const match = String(text || '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) return 0;
    for (let i = 0; i < 3; i += 1) {
        if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
    }
    return 0;
}

/**
 * 程序真实路径在 ~/.manyoyo/app/<版本>/ 下 → 离线包安装；否则按 npm 安装处理。
 */
function detectInstallMode({ scriptPath, homeDir = os.homedir() }) {
    let real = scriptPath;
    try {
        real = fs.realpathSync(scriptPath);
    } catch (error) {
        // 路径不存在就按原样比较
    }
    const appRoot = path.join(homeDir, '.manyoyo', 'app');
    const relative = path.relative(appRoot, real);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        const version = relative.split(path.sep)[0];
        if (VERSION_PATTERN.test(version)) {
            return { mode: 'offline', appRoot, version };
        }
    }
    return { mode: 'npm' };
}

function arch() {
    return process.arch === 'arm64' ? 'arm64' : 'x64';
}

// Release 资产名里的平台段：macos | linux
function platformOs() {
    return process.platform === 'linux' ? 'linux' : 'macos';
}

async function request(fetchImpl, url, options = {}) {
    try {
        return await fetchImpl(url, {
            redirect: 'follow',
            // 下载整包不能套短超时（慢网络下几十 MB 要好一会儿），查询类请求才限时
            signal: options.noTimeout ? undefined : AbortSignal.timeout(FETCH_TIMEOUT_MS),
            ...options,
            // 固定的请求头，不附带任何本机信息（用户名、主机名、版本之外的任何东西）
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'manyoyo-update', ...(options.headers || {}) }
        });
    } catch (error) {
        throw new UpdateError('NETWORK', `无法连接 GitHub（${error && error.cause && error.cause.code || error.name || '网络错误'}）。请检查网络或代理后重试。`);
    }
}

/**
 * 查询最新 Release（匿名 API）。返回 { version, tag, assets: { name: url } }。
 */
async function fetchLatestRelease({ fetchImpl = fetch, apiBase = API_BASE, now = Date.now } = {}) {
    const response = await request(fetchImpl, `${apiBase}/repos/${REPO}/releases/latest`);
    if (response.status === 403 || response.status === 429) {
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (response.status === 429 || remaining === '0') {
            const reset = Number(response.headers.get('x-ratelimit-reset'));
            const when = reset > 0 ? new Date(reset * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : '';
            throw new UpdateError('RATE_LIMIT', `GitHub 对匿名请求做了频率限制，${when ? `请在 ${when} 之后重试` : '请稍后重试'}。`);
        }
    }
    if (response.status === 404) throw new UpdateError('NO_RELEASE', '仓库还没有发布的 Release，暂时无法升级。');
    if (!response.ok) throw new UpdateError('HTTP', `查询最新版本失败（HTTP ${response.status}）。`);
    let release;
    try {
        release = await response.json();
    } catch (error) {
        throw new UpdateError('HTTP', '查询最新版本失败（返回内容不是有效的 JSON）。');
    }
    const version = String(release.tag_name || '').replace(/^v/, '');
    if (!VERSION_PATTERN.test(version)) throw new UpdateError('HTTP', `最新 Release 的版本号无法识别: ${release.tag_name}`);
    // 默认 API 下，下载地址必须在本仓库的 Release 下载路径内（测试注入自定义 apiBase 时不限制）
    const allowedPrefix = apiBase === API_BASE ? `https://github.com/${REPO}/releases/download/` : '';
    const assets = {};
    for (const asset of Array.isArray(release.assets) ? release.assets : []) {
        if (asset && typeof asset.name === 'string' && typeof asset.browser_download_url === 'string' && asset.browser_download_url.startsWith(allowedPrefix)) assets[asset.name] = asset.browser_download_url;
    }
    return { version, tag: release.tag_name, assets };
}

function parseSha256Sums(text) {
    const result = {};
    for (const line of String(text).split('\n')) {
        const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
        if (match) result[match[2].trim()] = match[1].toLowerCase();
    }
    return result;
}

function releaseAssetNames(version, targetArch, targetOs = 'macos') {
    return {
        app: `manyoyo-${version}-${targetOs}-${targetArch}-app.tar.gz`,
        sums: `SHA256SUMS-${targetOs}-${targetArch}`,
        manifest: `release-manifest-${targetOs}-${targetArch}.json`
    };
}

async function fetchText(fetchImpl, url) {
    const response = await request(fetchImpl, url);
    if (!response.ok) throw new UpdateError('HTTP', `下载 ${url.split('/').pop()} 失败（HTTP ${response.status}）。`);
    return response.text();
}

function switchCurrent(appRoot, version) {
    const link = path.join(appRoot, 'current');
    const staging = path.join(appRoot, `.current.${process.pid}.tmp`);
    fs.rmSync(staging, { force: true });
    fs.symlinkSync(version, staging);
    try {
        if (fs.existsSync(link) && !fs.lstatSync(link).isSymbolicLink()) {
            throw new UpdateError('BAD_LAYOUT', `${link} 不是符号链接，拒绝覆盖。`);
        }
        fs.renameSync(staging, link); // rename 覆盖符号链接是原子的
    } catch (error) {
        fs.rmSync(staging, { force: true });
        throw error;
    }
}

function currentVersion(appRoot) {
    try {
        return path.basename(fs.readlinkSync(path.join(appRoot, 'current')));
    } catch (error) {
        return '';
    }
}

function writeUpdateRecord(appRoot, record) {
    fs.writeFileSync(path.join(appRoot, '.update.json'), `${JSON.stringify(record)}\n`);
}

function readUpdateRecord(appRoot) {
    try {
        return JSON.parse(fs.readFileSync(path.join(appRoot, '.update.json'), 'utf-8'));
    } catch (error) {
        return {};
    }
}

// 只保留当前与上一版本，其它版本目录与残留的临时目录一起清掉
function pruneApps(appRoot, keep) {
    for (const name of fs.readdirSync(appRoot)) {
        if (keep.includes(name) || name === 'current' || name === '.update.json') continue;
        if (VERSION_PATTERN.test(name) || name.startsWith('.tmp-')) fs.rmSync(path.join(appRoot, name), { recursive: true, force: true });
    }
}

/**
 * 下载并安装 -app.tar.gz，成功后切换 current。校验失败/包不完整都在切换前中止，不留半成品。
 */
async function installAppUpdate({ appRoot, release, fetchImpl = fetch, targetArch = arch(), targetOs = 'macos', run = defaultRun, log = () => {}, tmpRoot = os.tmpdir() }) {
    const names = releaseAssetNames(release.version, targetArch, targetOs);
    const appUrl = release.assets[names.app];
    const sumsUrl = release.assets[names.sums] || release.assets.SHA256SUMS;
    if (!appUrl || !sumsUrl) {
        throw new UpdateError('NO_ASSET', `Release ${release.version} 里没有适合这台机器（${targetOs}-${targetArch}）的升级包（需要 ${names.app} 与 ${names.sums}）。`);
    }

    log(`校验清单: ${names.sums}`);
    const sums = parseSha256Sums(await fetchText(fetchImpl, sumsUrl));
    const expected = sums[names.app];
    if (!expected) throw new UpdateError('CHECKSUM', `校验清单里没有 ${names.app}，已中止升级。`);

    const workDir = fs.mkdtempSync(path.join(tmpRoot, 'manyoyo-update-'));
    const staging = path.join(appRoot, `.tmp-${release.version}-${process.pid}`);
    try {
        log(`下载升级包: ${names.app}`);
        const archive = path.join(workDir, names.app);
        try {
            await downloadVerified({ url: appUrl, sha256: expected, dest: archive, fetchImpl: (url, options) => request(fetchImpl, url, { ...options, noTimeout: true }), log });
        } catch (error) {
            if (/SHA256 校验失败/.test(error.message)) throw new UpdateError('CHECKSUM', `升级包 SHA256 校验失败，已中止升级，当前版本不受影响。`);
            if (error instanceof UpdateError) throw error;
            throw new UpdateError('NETWORK', `下载升级包失败：${error.message}`);
        }

        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });
        run(TAR_COMMAND, ['-xzf', archive, '-C', staging]);

        for (const required of ['node/bin/node', 'manyoyo/bin/manyoyo.js', 'manifest.json']) {
            if (!fs.existsSync(path.join(staging, required))) throw new UpdateError('BAD_PACKAGE', `升级包不完整（缺少 ${required}），已中止升级。`);
        }
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf-8'));
        } catch (error) {
            throw new UpdateError('BAD_PACKAGE', '升级包的 manifest.json 无法解析，已中止升级。');
        }
        if (manifest.version !== release.version || manifest.kind !== 'app' || manifest.arch !== targetArch || (manifest.os && manifest.os !== targetOs)) {
            throw new UpdateError('BAD_PACKAGE', `升级包内容与预期不符（版本 ${manifest.version}、类型 ${manifest.kind}、架构 ${manifest.arch}、系统 ${manifest.os || targetOs}），已中止升级。`);
        }
        fs.writeFileSync(path.join(staging, '.installed'), await sha256File(path.join(staging, 'manifest.json')));

        const previous = currentVersion(appRoot);
        const target = path.join(appRoot, release.version);
        if (release.version !== previous) fs.rmSync(target, { recursive: true, force: true });
        if (release.version !== previous) fs.renameSync(staging, target);
        switchCurrent(appRoot, release.version);
        writeUpdateRecord(appRoot, { previous: previous && previous !== release.version ? previous : readUpdateRecord(appRoot).previous || '', current: release.version, updatedAt: new Date().toISOString() });
        const record = readUpdateRecord(appRoot);
        pruneApps(appRoot, [release.version, record.previous].filter(Boolean));
        return { version: release.version, previous: record.previous || '', manifest };
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

function rollbackApp({ appRoot }) {
    const current = currentVersion(appRoot);
    const record = readUpdateRecord(appRoot);
    let previous = record.previous;
    if (!previous || !VERSION_PATTERN.test(previous) || !fs.existsSync(path.join(appRoot, previous))) {
        const candidates = fs.existsSync(appRoot) ? fs.readdirSync(appRoot).filter(name => VERSION_PATTERN.test(name) && name !== current && fs.existsSync(path.join(appRoot, name, 'manyoyo', 'bin', 'manyoyo.js'))) : [];
        candidates.sort((a, b) => compareVersions(b, a));
        previous = candidates[0];
    }
    if (!previous) throw new UpdateError('NO_PREVIOUS', '没有可回滚的上一版本。');
    switchCurrent(appRoot, previous);
    writeUpdateRecord(appRoot, { previous: current, current: previous, updatedAt: new Date().toISOString() });
    return { from: current, to: previous };
}

/**
 * Podman / VM 磁盘版本变化只提示，不自动替换（需要下载新的完整包）。
 * installed：安装器写的 ~/.manyoyo/.install/installed.json；remoteManifest：Release 里的 release-manifest（含完整包 manifest）。
 */
function describeRuntimeChange(installed, remoteManifest) {
    const remote = remoteManifest && remoteManifest.manifest && remoteManifest.manifest.components;
    if (!installed || !installed.podmanVersion || !remote || !remote.podman) return '';
    const podmanChanged = remote.podman.version !== installed.podmanVersion;
    const vmChanged = Boolean(installed.vmDiskSha256) && remote.vmDisk && remote.vmDisk.sha256 !== installed.vmDiskSha256;
    if (!podmanChanged && !vmChanged) return '';
    const parts = [];
    if (podmanChanged) parts.push(`Podman ${installed.podmanVersion} → ${remote.podman.version}`);
    if (vmChanged) parts.push('虚拟机磁盘有更新');
    return `新版本捆绑的运行环境有变化（${parts.join('，')}）。本次只升级了 manyoyo 本体；要换 Podman / 虚拟机，请下载新的完整安装包重新安装。`;
}

function readInstalledRecord(homeDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(homeDir, '.manyoyo', '.install', 'installed.json'), 'utf-8'));
    } catch (error) {
        return null;
    }
}

/** 仍在使用旧镜像的 manyoyo 容器（ref 为新版本要求的镜像）。 */
function findOutdatedContainers({ run, runtime, imageRef }) {
    let output = '';
    try {
        output = String(run(runtime.command, ['ps', '-a', '--filter', 'label=manyoyo.default_cmd', '--format', '{{.Names}}\t{{.Image}}'], { env: runtime.env }));
    } catch (error) {
        return [];
    }
    return output.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        const [name, image] = line.split('\t');
        return { name, image: image || '' };
    }).filter(item => item.name && item.image && item.image !== imageRef);
}

function defaultRun(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf-8', env: options.env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(String(result.stderr || '').trim() || `${command} 退出码 ${result.status}`);
    return result.stdout || '';
}

module.exports = {
    UpdateError,
    parseVersion,
    compareVersions,
    detectInstallMode,
    fetchLatestRelease,
    parseSha256Sums,
    releaseAssetNames,
    installAppUpdate,
    rollbackApp,
    currentVersion,
    describeRuntimeChange,
    readInstalledRecord,
    findOutdatedContainers,
    fetchText,
    arch,
    platformOs
};
