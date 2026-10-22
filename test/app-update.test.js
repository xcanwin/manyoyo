'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const appUpdate = require('../lib/app-update');
const { createUpdateChecker } = require('../lib/update-check');

const { detectInstallMode, fetchLatestRelease, installAppUpdate, rollbackApp, compareVersions, describeRuntimeChange, findOutdatedContainers, isAppVersion, installFromArchive, switchInstalled, UpdateError } = appUpdate;
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const ARCH = appUpdate.arch();

let root;
let home;
let appRoot;
let server;
let base;
let state;

function buildAppTarball(version, { arch = ARCH, kind = 'app', skip = [], osName, runtime } = {}) {
    const dir = path.join(root, `pkg-${version}-${kind}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'node/bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'manyoyo/bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node/bin/node'), 'node');
    fs.writeFileSync(path.join(dir, 'manyoyo/bin/manyoyo.js'), `// ${version}`);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version, kind, arch, imageVersion: `${version}-common`, ...(osName ? { os: osName } : {}), ...(runtime ? { runtime } : {}) }));
    skip.forEach(rel => fs.rmSync(path.join(dir, rel), { recursive: true, force: true }));
    const tgz = path.join(root, `pkg-${version}-${kind}.tar.gz`);
    const r = spawnSync('tar', ['-czf', tgz, '-C', dir, ...fs.readdirSync(dir)]);
    if (r.status !== 0) throw new Error('tar failed');
    return fs.readFileSync(tgz);
}

// 本地替身 GitHub 网页（不是 API）：releases/latest 302 跳到 releases/tag/v<版本>，releases/download/v<版本>/<文件> 是下载站。
// 每个请求都记下来，便于断言“没发请求 / 没调 API / 请求头里没有本机信息”
function startServer(handlerOverrides = {}) {
    state = { hits: [], files: {}, latestTag: null, rateLimit: false, status: null };
    server = http.createServer((req, res) => {
        state.hits.push({ method: req.method, url: req.url, headers: req.headers });
        if (handlerOverrides.all) return handlerOverrides.all(req, res);
        if (req.url === '/xcanwin/manyoyo/releases/latest') {
            if (state.rateLimit) { res.writeHead(429); return res.end('Too Many Requests'); }
            if (state.status) { res.writeHead(state.status); return res.end(''); }
            // 没有任何 Release 时，GitHub 把 latest 跳到 Release 列表页
            const location = state.latestTag ? `${base}/xcanwin/manyoyo/releases/tag/${state.latestTag}` : `${base}/xcanwin/manyoyo/releases`;
            res.writeHead(302, { location });
            return res.end();
        }
        // 已安装的旧客户端（≤8.6.3）仍然走 API：兼容性用例要用到
        if (req.url === '/repos/xcanwin/manyoyo/releases/latest') {
            if (!state.latestTag) { res.writeHead(404); return res.end('{}'); }
            const assets = Object.keys(state.files).map(name => ({ name, browser_download_url: `${base}/xcanwin/manyoyo/releases/download/${state.latestTag}/${encodeURIComponent(name)}` }));
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ tag_name: state.latestTag, assets }));
        }
        const m = /^\/xcanwin\/manyoyo\/releases\/download\/[^/]+\/(.+)$/.exec(req.url);
        const name = m ? decodeURIComponent(m[1]) : '';
        if (name && state.files[name] !== undefined) { res.writeHead(200); return res.end(state.files[name]); }
        res.writeHead(404);
        return res.end();
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
    }));
}

function publish(version, { tamperSums = false, tarball, extraAssets = {}, arch = ARCH, osName } = {}) {
    const names = appUpdate.releaseAssetNames(version, arch, osName || 'macos');
    const data = tarball || buildAppTarball(version, { arch, osName });
    state.files[names.app] = data;
    // 真实 Release 只有一个 SHA256SUMS，列出全部安装包与升级包
    state.files[names.sums] = `${'a'.repeat(64)}  manyoyo-${version}-macos-${arch}.run\n${tamperSums ? 'f'.repeat(64) : sha(data)}  ${names.app}\n`;
    Object.assign(state.files, extraAssets);
    state.latestTag = `v${version}`;
}

function seedInstalled(version) {
    fs.mkdirSync(path.join(appRoot, version, 'manyoyo/bin'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, version, 'manyoyo/bin/manyoyo.js'), `// ${version}`);
    fs.writeFileSync(path.join(appRoot, version, '.installed'), 'old');
    fs.rmSync(path.join(appRoot, 'current'), { force: true });
    fs.symlinkSync(version, path.join(appRoot, 'current'));
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-appupdate-'));
    home = path.join(root, 'home');
    appRoot = path.join(home, '.manyoyo', 'app');
    fs.mkdirSync(appRoot, { recursive: true });
    server = null;
});
afterEach(async () => {
    if (server && server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
});

describe('install mode detection', () => {
    test('a script under ~/.manyoyo/app/<version>/ means an offline-package install, anything else is npm', () => {
        seedInstalled('1.2.3');
        const script = path.join(appRoot, '1.2.3', 'manyoyo/bin/manyoyo.js');
        expect(detectInstallMode({ scriptPath: script, homeDir: home })).toEqual({ mode: 'offline', appRoot, version: '1.2.3' });
        expect(detectInstallMode({ scriptPath: '/usr/local/lib/node_modules/@xcanwin/manyoyo/bin/manyoyo.js', homeDir: home })).toEqual({ mode: 'npm' });
        expect(detectInstallMode({ scriptPath: path.join(appRoot, 'not-a-version', 'x.js'), homeDir: home })).toEqual({ mode: 'npm' });
    });

    test('symlinks are resolved, so a link pointing into app/ counts and a look-alike path outside does not', () => {
        seedInstalled('2.0.0');
        const link = path.join(root, 'bin-link.js');
        fs.symlinkSync(path.join(appRoot, '2.0.0', 'manyoyo/bin/manyoyo.js'), link);
        expect(detectInstallMode({ scriptPath: link, homeDir: home }).mode).toBe('offline');
        const decoy = path.join(root, 'other', '.manyoyo', 'app', '2.0.0', 'x.js');
        fs.mkdirSync(path.dirname(decoy), { recursive: true });
        fs.writeFileSync(decoy, '');
        expect(detectInstallMode({ scriptPath: decoy, homeDir: home }).mode).toBe('npm');
    });
});

describe('代码版版本号（x.y.z+sha7）', () => {
    const CODE_A = '8.6.9+aaaaaaa';
    const CODE_B = '8.6.9+bbbbbbb';

    function writeArchive(version) {
        const file = path.join(root, `code-${version}.tar.gz`);
        fs.writeFileSync(file, buildAppTarball(version));
        return file;
    }

    test('isAppVersion 只认 x.y.z 与 x.y.z+<7 位小写 hex>，目录名里的其它写法一律不是版本', () => {
        ['1.2.3', '8.6.9+abc1234', '10.0.12+0123456'].forEach(v => expect(isAppVersion(v)).toBe(true));
        ['1.2', '1.2.3+abc', '1.2.3+ABC1234', '1.2.3+abc12345', '1.2.3-x', '../1.2.3', '1.2.3+abc1234/..', '', undefined].forEach(v => expect(isAppVersion(v)).toBe(false));
    });

    test('比较：同一 x.y.z 的代码版与正式版相等，更新的正式版更大', () => {
        expect(compareVersions(CODE_A, '8.6.9')).toBe(0);
        expect(compareVersions('8.6.9', CODE_A)).toBe(0);
        expect(compareVersions(CODE_A, CODE_B)).toBe(0);
        expect(compareVersions('8.6.10', CODE_A)).toBe(1);
        expect(compareVersions(CODE_A, '8.6.10')).toBe(-1);
    });

    test('detectInstallMode 认得 app/<x.y.z+sha7>/ 下的程序', () => {
        seedInstalled(CODE_A);
        const script = path.join(appRoot, CODE_A, 'manyoyo/bin/manyoyo.js');
        expect(detectInstallMode({ scriptPath: script, homeDir: home })).toEqual({ mode: 'offline', appRoot, version: CODE_A });
    });

    test('连装两次代码版后，最新的正式版目录仍保留（可回滚、可重装）', async () => {
        seedInstalled('8.6.9');
        await installFromArchive({ appRoot, archive: writeArchive(CODE_A), version: CODE_A, targetArch: ARCH, targetOs: 'macos' });
        await installFromArchive({ appRoot, archive: writeArchive(CODE_B), version: CODE_B, targetArch: ARCH, targetOs: 'macos' });
        expect(fs.readdirSync(appRoot).filter(n => !n.startsWith('.')).sort()).toEqual(['8.6.9', CODE_A, CODE_B, 'current'].sort());
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe(CODE_B);
    });

    test('清理不留旧代码版：第三次安装后只剩当前、上一个与最新正式版', async () => {
        seedInstalled('8.6.9');
        for (const v of [CODE_A, CODE_B, '8.6.9+ccccccc']) {
            await installFromArchive({ appRoot, archive: writeArchive(v), version: v, targetArch: ARCH, targetOs: 'macos' });
        }
        expect(fs.readdirSync(appRoot).filter(n => !n.startsWith('.')).sort()).toEqual(['8.6.9', CODE_B, '8.6.9+ccccccc', 'current'].sort());
    });

    test('回滚能回到上一个代码版；记录里的上一版本是代码版也认', async () => {
        seedInstalled('8.6.9');
        await installFromArchive({ appRoot, archive: writeArchive(CODE_A), version: CODE_A, targetArch: ARCH, targetOs: 'macos' });
        await installFromArchive({ appRoot, archive: writeArchive(CODE_B), version: CODE_B, targetArch: ARCH, targetOs: 'macos' });
        expect(rollbackApp({ appRoot })).toEqual({ from: CODE_B, to: CODE_A });
    });

    test('没有记录时回退候选：同一 x.y.z 下正式版排在代码版前面', () => {
        seedInstalled(CODE_A);
        seedInstalled('8.6.9');
        seedInstalled(CODE_B);
        fs.rmSync(path.join(appRoot, '.update.json'), { force: true });
        expect(rollbackApp({ appRoot })).toEqual({ from: CODE_B, to: '8.6.9' });
    });

    test('旧客户端写的 .update.json（只有 x.y.z）照常可读', () => {
        seedInstalled('8.6.8');
        seedInstalled(CODE_A);
        fs.writeFileSync(path.join(appRoot, '.update.json'), JSON.stringify({ previous: '8.6.8', current: '8.6.9' }));
        expect(rollbackApp({ appRoot })).toEqual({ from: CODE_A, to: '8.6.8' });
    });
});

describe('switchInstalled（切换 current、写记录、清理旧版本；installFromArchive 与本地复用共用）', () => {
    test('切换到已存在的目录，记下上一版本，返回值带 manifest', () => {
        seedInstalled('8.6.8');
        seedInstalled('8.6.9');
        fs.rmSync(path.join(appRoot, 'current'), { force: true });
        fs.symlinkSync('8.6.8', path.join(appRoot, 'current'));
        const manifest = { version: '8.6.9', kind: 'app' };
        expect(switchInstalled({ appRoot, version: '8.6.9', manifest })).toEqual({ version: '8.6.9', previous: '8.6.8', manifest });
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('8.6.9');
        expect(JSON.parse(fs.readFileSync(path.join(appRoot, '.update.json'), 'utf-8'))).toMatchObject({ previous: '8.6.8', current: '8.6.9' });
    });

    test('清理：只留当前、上一版本和最新的正式版，残留的临时目录一起清掉', () => {
        ['8.6.5', '8.6.6', '8.6.7', '8.6.8'].forEach(v => seedInstalled(v));
        fs.mkdirSync(path.join(appRoot, '.tmp-8.6.7-1'));
        fs.rmSync(path.join(appRoot, 'current'), { force: true });
        fs.symlinkSync('8.6.7', path.join(appRoot, 'current'));
        switchInstalled({ appRoot, version: '8.6.6' });
        expect(fs.readdirSync(appRoot).filter(n => n !== '.update.json').sort()).toEqual(['8.6.6', '8.6.7', '8.6.8', 'current']);
    });

    test('切到当前已经是的版本：上一版本记录不被冲掉', () => {
        seedInstalled('8.6.8');
        seedInstalled('8.6.9');
        switchInstalled({ appRoot, version: '8.6.8' });
        switchInstalled({ appRoot, version: '8.6.9' });
        switchInstalled({ appRoot, version: '8.6.9' });
        expect(JSON.parse(fs.readFileSync(path.join(appRoot, '.update.json'), 'utf-8')).previous).toBe('8.6.8');
    });
});

describe('versions', () => {
    test('compareVersions orders semver numerically', () => {
        expect(compareVersions('8.0.0', '7.1.6')).toBe(1);
        expect(compareVersions('7.10.0', '7.9.9')).toBe(1);
        expect(compareVersions('v7.1.6', '7.1.6')).toBe(0);
        expect(compareVersions('7.1.5', '7.1.6')).toBe(-1);
    });
});

describe('fetchLatestRelease', () => {
    test('跟随 releases/latest 的跳转取版本，不调 GitHub API（匿名 API 按 IP 限流，共享出口的用户和 CI 经常撞上）；请求头不带本机信息', async () => {
        await startServer();
        publish('9.0.0');
        const release = await fetchLatestRelease({ webBase: base });
        expect(release.version).toBe('9.0.0');
        expect(state.hits.map(hit => hit.url)).toEqual(['/xcanwin/manyoyo/releases/latest']);
        expect(state.hits.some(hit => hit.url.startsWith('/repos/'))).toBe(false);
        const headers = state.hits[0].headers;
        expect(headers['user-agent']).toBe('manyoyo-update');
        expect(headers.authorization).toBeUndefined();
        expect(headers.cookie).toBeUndefined();
    });

    test('下载地址按固定命名拼在本仓库的 Release 下载路径下，不会指向别处', async () => {
        await startServer();
        publish('9.0.0');
        const release = await fetchLatestRelease({ webBase: base });
        const names = appUpdate.releaseAssetNames('9.0.0', ARCH, 'macos');
        expect(release.assets[names.app]).toBe(`${base}/xcanwin/manyoyo/releases/download/v9.0.0/${names.app}`);
        expect(release.assets[names.sums]).toBe(`${base}/xcanwin/manyoyo/releases/download/v9.0.0/SHA256SUMS`);
        expect(Object.values(release.assets).every(url => url.startsWith(`${base}/xcanwin/manyoyo/releases/download/v9.0.0/`))).toBe(true);
    });

    test('频率限制、没有 Release、版本号无法识别、服务端错误都给出带编码的友好提示', async () => {
        await startServer();
        publish('9.0.0');
        state.rateLimit = true;
        await expect(fetchLatestRelease({ webBase: base })).rejects.toMatchObject({ code: 'RATE_LIMIT', message: expect.stringContaining('频率') });
        state.rateLimit = false;
        state.latestTag = null;
        await expect(fetchLatestRelease({ webBase: base })).rejects.toMatchObject({ code: 'NO_RELEASE' });
        state.status = 500;
        await expect(fetchLatestRelease({ webBase: base })).rejects.toMatchObject({ code: 'HTTP', message: expect.stringContaining('500') });
        state.status = null;
        state.latestTag = 'nightly';
        await expect(fetchLatestRelease({ webBase: base })).rejects.toMatchObject({ code: 'HTTP', message: expect.stringContaining('无法识别') });
    });

    test('a network failure explains what to check', async () => {
        await startServer();
        const dead = base;
        await new Promise(resolve => server.close(resolve));
        await expect(fetchLatestRelease({ webBase: dead })).rejects.toMatchObject({ code: 'NETWORK', message: expect.stringContaining('连不上') });
    });
});

describe('installAppUpdate / rollbackApp', () => {
    test('downloads only the app package, verifies it, lands in app/<version> and atomically switches current', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0');
        const release = await fetchLatestRelease({ webBase: base });
        const result = await installAppUpdate({ appRoot, release, fetchImpl: fetch, tmpRoot: root });

        expect(result).toEqual(expect.objectContaining({ version: '9.0.0', previous: '1.0.0' }));
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('9.0.0');
        expect(fs.existsSync(path.join(appRoot, '9.0.0/node/bin/node'))).toBe(true);
        expect(fs.readFileSync(path.join(appRoot, '9.0.0/.installed'), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
        expect(fs.existsSync(path.join(appRoot, '1.0.0/manyoyo/bin/manyoyo.js'))).toBe(true); // 上一版本保留
        expect(JSON.parse(fs.readFileSync(path.join(appRoot, '.update.json'), 'utf8'))).toEqual(expect.objectContaining({ previous: '1.0.0', current: '9.0.0' }));
        // 只下载了 app 包与校验清单，没有碰完整包
        const downloaded = state.hits.filter(h => h.method === 'GET').map(h => decodeURIComponent(h.url)).filter(u => u.includes('/releases/download/')).map(u => u.replace(/^.*\/releases\/download\/[^/]+\//, '')).sort();
        expect(downloaded).toEqual(['SHA256SUMS', `manyoyo-9.0.0-macos-${ARCH}-app.tar.gz`].sort());
        expect(fs.readdirSync(appRoot).filter(n => n.startsWith('.tmp-') || n.startsWith('.current.'))).toEqual([]);
    });

    test('linux: looks for the linux-named assets only and accepts a linux manifest', async () => {
        expect(appUpdate.releaseAssetNames('9.0.0', 'x64', 'linux')).toEqual({
            app: 'manyoyo-9.0.0-linux-x64-app.tar.gz',
            sums: 'SHA256SUMS'
        });
        expect(appUpdate.releaseAssetNames('9.0.0', 'arm64').app).toBe('manyoyo-9.0.0-macos-arm64-app.tar.gz'); // 默认仍是 macOS
        expect(appUpdate.platformOs()).toBe(process.platform === 'linux' ? 'linux' : 'macos');

        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0', { osName: 'linux' });
        const release = await fetchLatestRelease({ webBase: base });
        const result = await installAppUpdate({ appRoot, release, fetchImpl: fetch, tmpRoot: root, targetOs: 'linux' });
        expect(result.version).toBe('9.0.0');
        const downloaded = state.hits.filter(h => h.method === 'GET').map(h => decodeURIComponent(h.url)).filter(u => u.includes('/releases/download/')).map(u => u.replace(/^.*\/releases\/download\/[^/]+\//, '')).sort();
        expect(downloaded).toEqual(['SHA256SUMS', `manyoyo-9.0.0-linux-${ARCH}-app.tar.gz`].sort());
    });

    test('a release that only has macOS assets gives a clear error on linux, and a mismatching manifest os is refused', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0'); // 只有 macos 资产
        const release = await fetchLatestRelease({ webBase: base });
        await expect(installAppUpdate({ appRoot, release, fetchImpl: fetch, tmpRoot: root, targetOs: 'linux' }))
            .rejects.toMatchObject({ code: 'NO_ASSET', message: expect.stringContaining(`linux-${ARCH}`) });

        // 资产名是 linux，但包里的 manifest 声明是 macos：拒绝
        const names = appUpdate.releaseAssetNames('9.0.1', ARCH, 'linux');
        const wrong = buildAppTarball('9.0.1', { osName: 'macos' });
        state.files[names.app] = wrong;
        state.files[names.sums] = `${sha(wrong)}  ${names.app}\n`;
        state.latestTag = 'v9.0.1';
        await expect(installAppUpdate({ appRoot, release: await fetchLatestRelease({ webBase: base }), fetchImpl: fetch, tmpRoot: root, targetOs: 'linux' }))
            .rejects.toMatchObject({ code: 'BAD_PACKAGE' });
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('1.0.0');
    });

    test('only the current and the previous version are kept; older ones and stale temp dirs are cleaned', async () => {
        seedInstalled('1.0.0');
        fs.mkdirSync(path.join(appRoot, '0.9.0'));
        fs.mkdirSync(path.join(appRoot, '.tmp-8.0.0-1234'));
        await startServer();
        publish('9.0.0');
        await installAppUpdate({ appRoot, release: await fetchLatestRelease({ webBase: base }), fetchImpl: fetch, tmpRoot: root });
        expect(fs.readdirSync(appRoot).filter(n => !n.startsWith('.update')).sort()).toEqual(['1.0.0', '9.0.0', 'current']);
    });

    test('a checksum mismatch aborts before anything is switched or left behind', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0', { tamperSums: true });
        await expect(installAppUpdate({ appRoot, release: await fetchLatestRelease({ webBase: base }), fetchImpl: fetch, tmpRoot: root }))
            .rejects.toMatchObject({ code: 'CHECKSUM', message: expect.stringContaining('当前版本不受影响') });
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('1.0.0');
        expect(fs.existsSync(path.join(appRoot, '9.0.0'))).toBe(false);
        expect(fs.readdirSync(appRoot).filter(n => n.startsWith('.tmp-'))).toEqual([]);
    });

    test('a checksum file that does not list the package aborts too', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0');
        state.files.SHA256SUMS = `${'a'.repeat(64)}  something-else.tar.gz\n`;
        await expect(installAppUpdate({ appRoot, release: await fetchLatestRelease({ webBase: base }), fetchImpl: fetch, tmpRoot: root }))
            .rejects.toMatchObject({ code: 'CHECKSUM' });
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('1.0.0');
    });

    test.each([
        ['an incomplete package', { skip: ['node/bin/node'] }, /缺少 node\/bin\/node/],
        ['a package for the wrong architecture', { arch: ARCH === 'arm64' ? 'x64' : 'arm64' }, /架构/],
        ['a package of the wrong kind', { kind: 'full' }, /类型 full/]
    ])('%s is rejected even when its checksum is right, and nothing is switched', async (_name, options, message) => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0', { tarball: buildAppTarball('9.0.0', options) });
        await expect(installAppUpdate({ appRoot, release: await fetchLatestRelease({ webBase: base }), fetchImpl: fetch, tmpRoot: root }))
            .rejects.toMatchObject({ code: 'BAD_PACKAGE', message: expect.stringMatching(message) });
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('1.0.0');
        expect(fs.existsSync(path.join(appRoot, '9.0.0'))).toBe(false);
    });

    test('a package whose manifest version differs from the release tag is rejected', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0', { tarball: buildAppTarball('8.5.0') });
        await expect(installAppUpdate({ appRoot, release: await fetchLatestRelease({ webBase: base }), fetchImpl: fetch, tmpRoot: root }))
            .rejects.toMatchObject({ code: 'BAD_PACKAGE' });
    });

    test('a release without a package for this architecture says so', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0', { arch: ARCH === 'arm64' ? 'x64' : 'arm64' });
        await expect(installAppUpdate({ appRoot, release: await fetchLatestRelease({ webBase: base }), fetchImpl: fetch, tmpRoot: root }))
            .rejects.toMatchObject({ code: 'NO_ASSET', message: expect.stringContaining(ARCH) });
    });

    test('rollback switches back to the previous version, and rolling back again returns to the newer one', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0');
        await installAppUpdate({ appRoot, release: await fetchLatestRelease({ webBase: base }), fetchImpl: fetch, tmpRoot: root });

        expect(rollbackApp({ appRoot })).toEqual({ from: '9.0.0', to: '1.0.0' });
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('1.0.0');
        expect(rollbackApp({ appRoot })).toEqual({ from: '1.0.0', to: '9.0.0' });
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('9.0.0');
    });

    test('rollback without any other version fails clearly; without a record it falls back to the newest other version', () => {
        seedInstalled('1.0.0');
        expect(() => rollbackApp({ appRoot })).toThrow(UpdateError);
        expect(() => rollbackApp({ appRoot })).toThrow(/没有可回滚/);
        seedInstalled('2.0.0');
        expect(rollbackApp({ appRoot })).toEqual({ from: '2.0.0', to: '1.0.0' });
    });

    test('updating twice in a row then rolling back keeps working (previous always tracks the version before)', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('2.0.0');
        await installAppUpdate({ appRoot, release: await fetchLatestRelease({ webBase: base }), fetchImpl: fetch, tmpRoot: root });
        publish('3.0.0');
        await installAppUpdate({ appRoot, release: await fetchLatestRelease({ webBase: base }), fetchImpl: fetch, tmpRoot: root });
        expect(fs.readdirSync(appRoot).filter(n => /^\d/.test(n)).sort()).toEqual(['2.0.0', '3.0.0']);
        expect(rollbackApp({ appRoot })).toEqual({ from: '3.0.0', to: '2.0.0' });
    });
});

describe('runtime change hint and outdated containers', () => {
    // 升级包 manifest.json 里的 runtime 字段（由构建写入，仅 macOS 完整包有 Podman / 虚拟机磁盘）
    const runtime = { podmanVersion: '6.2.0', vmDiskSha256: 'n'.repeat(64) };

    test('only a changed Podman or VM disk produces a hint, and the hint says to download the full package', () => {
        const installed = { podmanVersion: '6.1.3', vmDiskSha256: 'o'.repeat(64) };
        const hint = describeRuntimeChange(installed, runtime);
        expect(hint).toContain('Podman 6.1.3 → 6.2.0');
        expect(hint).toContain('虚拟机磁盘有更新');
        expect(hint).toContain('完整安装包');
        expect(describeRuntimeChange({ podmanVersion: '6.2.0', vmDiskSha256: 'n'.repeat(64) }, runtime)).toBe('');
        expect(describeRuntimeChange(null, runtime)).toBe('');
        expect(describeRuntimeChange({ podmanVersion: '', vmDiskSha256: '' }, runtime)).toBe(''); // 复用外部运行时：没装过
        expect(describeRuntimeChange(installed, undefined)).toBe(''); // 升级包没有 runtime 字段（Linux 或旧包）
        expect(describeRuntimeChange(installed, {})).toBe('');
    });

    test('the same runtime hint is shown only once, a newer runtime shows it again', () => {
        const first = { podmanVersion: '6.2.0', vmDiskSha256: 'n'.repeat(64) };
        expect(appUpdate.markRuntimeHintShown(home, first)).toBe(true);
        expect(appUpdate.markRuntimeHintShown(home, first)).toBe(false);
        expect(appUpdate.markRuntimeHintShown(home, { ...first, podmanVersion: '6.3.0' })).toBe(true);
        expect(appUpdate.markRuntimeHintShown(home, { ...first, podmanVersion: '6.3.0' })).toBe(false);
        // 记录文件损坏时按“没提示过”处理，不抛错
        fs.writeFileSync(path.join(home, '.manyoyo', '.install', 'runtime-hint.json'), '{bad');
        expect(appUpdate.markRuntimeHintShown(home, first)).toBe(true);
    });

    test('installAppUpdate hands back the package manifest so the caller can read manifest.runtime', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0', { tarball: buildAppTarball('9.0.0', { runtime }) });
        const result = await installAppUpdate({ appRoot, release: await fetchLatestRelease({ webBase: base }), fetchImpl: fetch, tmpRoot: root });
        expect(result.manifest.runtime).toEqual(runtime);
        expect(describeRuntimeChange({ podmanVersion: '6.1.3', vmDiskSha256: '' }, result.manifest.runtime)).toContain('Podman 6.1.3 → 6.2.0');
    });

    test('lists only manyoyo containers whose image is not the one the new version needs', () => {
        const run = jest.fn(() => 'a\tghcr.io/xcanwin/manyoyo:1.0.0-common\nb\tghcr.io/xcanwin/manyoyo:2.0.0-common\nc\tlocalhost/xcanwin/manyoyo:1.0.0-common\n');
        const outdated = findOutdatedContainers({ run, runtime: { command: 'podman', env: { X: '1' } }, imageRef: 'ghcr.io/xcanwin/manyoyo:2.0.0-common' });
        expect(outdated.map(c => c.name)).toEqual(['a', 'c']);
        expect(run.mock.calls[0][1]).toEqual(['ps', '-a', '--filter', 'label=manyoyo.default_cmd', '--format', '{{.Names}}\t{{.Image}}']);
        expect(findOutdatedContainers({ run: () => { throw new Error('daemon down'); }, runtime: { command: 'docker' }, imageRef: 'x' })).toEqual([]);
    });
});

describe('update check (serve banner)', () => {
    function checker(extra = {}) {
        return createUpdateChecker({
            homeDir: home,
            currentVersion: '7.1.6',
            installMode: 'offline',
            enabled: true,
            fetchLatest: () => fetchLatestRelease({ webBase: base }),
            ...extra
        });
    }

    test('updateCheck=false never sends a request and never writes a cache', async () => {
        await startServer();
        publish('9.0.0');
        const c = checker({ enabled: false });
        expect(c.getInfo()).toEqual(expect.objectContaining({ enabled: false, updateAvailable: false, latest: '' }));
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(state.hits).toEqual([]);
        expect(fs.existsSync(path.join(home, '.manyoyo/serve/update-check.json'))).toBe(false);
    });

    test('the first call refreshes in the background; later calls within a day use the cache without a request', async () => {
        await startServer();
        publish('9.0.0');
        let clock = 1_000_000;
        const c = checker({ now: () => clock });
        expect(c.getInfo().latest).toBe(''); // 立即返回缓存（还没有），后台刷新
        await c.refresh();
        expect(c.getInfo()).toEqual(expect.objectContaining({ latest: '9.0.0', current: '7.1.6', updateAvailable: true, installMode: 'offline' }));
        const afterFirst = state.hits.length;
        clock += 23 * 60 * 60 * 1000;
        c.getInfo();
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(state.hits.length).toBe(afterFirst); // 23 小时内不再请求
        clock += 2 * 60 * 60 * 1000;
        c.getInfo();
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(state.hits.length).toBe(afterFirst + 1); // 过了一天再问一次
    });

    test('an up-to-date install shows no banner', async () => {
        await startServer();
        publish('7.1.6');
        const c = checker();
        await c.refresh();
        expect(c.getInfo().updateAvailable).toBe(false);
    });

    test('a failed check is remembered (no hammering) and keeps the last known version', async () => {
        await startServer();
        publish('9.0.0');
        let clock = 5_000_000;
        const c = checker({ now: () => clock });
        await c.refresh();
        state.rateLimit = true;
        clock += 25 * 60 * 60 * 1000;
        await c.refresh();
        const failed = c.snapshot();
        expect(failed.error).toContain('频率限制');
        expect(failed.latest).toBe('9.0.0');
        const hits = state.hits.length;
        clock += 30 * 60 * 1000;
        c.getInfo();
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(state.hits.length).toBe(hits); // 失败后 1 小时内不重试
        clock += 40 * 60 * 1000;
        state.rateLimit = false;
        c.getInfo();
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(c.snapshot().error).toBe('');
    });

    test('the request carries nothing about this machine', async () => {
        await startServer();
        publish('9.0.0');
        await checker().refresh();
        const raw = JSON.stringify(state.hits[0].headers);
        expect(raw).not.toContain(os.userInfo().username === 'root' ? 'toor' : os.userInfo().username);
        expect(raw).not.toContain(os.hostname());
        expect(state.hits[0].headers['user-agent']).toBe('manyoyo-update');
    });
});

describe('manyoyo update (CLI)', () => {
    const repo = path.join(__dirname, '..');

    // 把 bin/lib/package.json 拷到临时 HOME 的 app/1.0.0/manyoyo 下，模拟离线包安装（node_modules 用符号链接共享）
    function installCopyOfCli(version) {
        const dir = path.join(appRoot, version, 'manyoyo');
        fs.mkdirSync(dir, { recursive: true });
        for (const name of ['bin', 'lib', 'package.json']) fs.cpSync(path.join(repo, name), path.join(dir, name), { recursive: true });
        fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'));
        fs.mkdirSync(path.join(appRoot, version, 'node/bin'), { recursive: true });
        return path.join(dir, 'bin/manyoyo.js');
    }

    const runCli = (script, args) => spawnSync('node', [script, ...args], { encoding: 'utf-8', env: { ...process.env, HOME: home } });

    test('--rollback from an offline install switches back and says so', () => {
        const script = installCopyOfCli('1.0.0');
        installCopyOfCli('2.0.0');
        fs.rmSync(path.join(appRoot, 'current'), { force: true });
        fs.symlinkSync('2.0.0', path.join(appRoot, 'current'));
        fs.writeFileSync(path.join(appRoot, '.update.json'), JSON.stringify({ previous: '1.0.0', current: '2.0.0' }));
        const result = runCli(path.join(appRoot, '2.0.0/manyoyo/bin/manyoyo.js'), ['update', '--rollback']);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('已回滚: 2.0.0 → 1.0.0');
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('1.0.0');
        expect(script).toContain('1.0.0');
    });

    test('--rollback with nothing to roll back to exits non-zero with a clear message', () => {
        installCopyOfCli('1.0.0');
        fs.symlinkSync('1.0.0', path.join(appRoot, 'current'));
        const result = runCli(path.join(appRoot, '1.0.0/manyoyo/bin/manyoyo.js'), ['update', '--rollback']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('没有可回滚的上一版本');
    });

    test('--rollback from an npm install is refused with the npm way to go back', () => {
        const result = runCli(path.join(repo, 'bin/manyoyo.js'), ['update', '--rollback']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('只适用于离线包安装');
    });

    test('update --help documents --rollback', () => {
        expect(runCli(path.join(repo, 'bin/manyoyo.js'), ['update', '--help']).stdout).toContain('--rollback');
    });
});

describe('compatibility with the 8.0.1 client', () => {
    // 已安装 8.0.1 的用户跑 manyoyo update：旧版代码先找 SHA256SUMS-<os>-<arch>，找不到回退到 SHA256SUMS；
    // 精简后的 Release 只有 SHA256SUMS、没有 release-manifest，旧客户端必须照样升级成功。
    // 旧版模块原样存放在 test/fixtures/app-update-8.0.1/（来自 git tag v8.0.1；CI 浅克隆拿不到 tag，所以不用 git show）
    const oldUpdate = require('./fixtures/app-update-8.0.1/app-update.js');

    test.each([['macos'], ['linux']])('the old app-update.js upgrades (%s) from a Release that only has the app package and SHA256SUMS', async osName => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0', { osName });
        expect(Object.keys(state.files).sort()).toEqual(['SHA256SUMS', `manyoyo-9.0.0-${osName}-${ARCH}-app.tar.gz`].sort());
        const release = await oldUpdate.fetchLatestRelease({ apiBase: base });
        const result = await oldUpdate.installAppUpdate({ appRoot, release, fetchImpl: fetch, tmpRoot: root, targetOs: osName });
        expect(result.version).toBe('9.0.0');
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('9.0.0');
        // 旧客户端对不存在的 release-manifest 直接跳过提示
        const names = oldUpdate.releaseAssetNames('9.0.0', ARCH, osName);
        expect(release.assets[names.manifest]).toBeUndefined();
    });
});

describe('网络错误带地址与中文原因', () => {
    test('NETWORK 错误含主机名、中文原因与完整 URL', () => {
        const timeout = Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
        const error = appUpdate.networkError('https://github.com/xcanwin/manyoyo/releases/download/v8.5.0/SHA256SUMS', timeout);
        expect(error.code).toBe('NETWORK');
        expect(error.message).toContain('github.com');
        expect(error.message).toContain('连接超时');
        expect(error.message).toContain('https://github.com/xcanwin/manyoyo/releases/download/v8.5.0/SHA256SUMS');
        expect(appUpdate.networkError('http://x/y', { code: 'ECONNRESET' }).message).toContain('连接被重置');
        expect(appUpdate.networkError('http://x/y', { code: 'WEIRD' }).message).toContain('WEIRD');
    });

    test('下载升级包中断时也带升级包地址', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0');
        const release = await fetchLatestRelease({ webBase: base });
        const reset = (url, options) => (/\/releases\/download\/[^/]+\/manyoyo-/.test(url) ? Promise.reject(Object.assign(new Error('x'), { code: 'ECONNRESET' })) : fetch(url, options));
        await expect(installAppUpdate({ appRoot, release, fetchImpl: reset, tmpRoot: root }))
            .rejects.toMatchObject({ code: 'NETWORK', message: expect.stringContaining(`/releases/download/v9.0.0/manyoyo-9.0.0-macos-${ARCH}-app.tar.gz`) });
    });
});

describe('installAppFile（update --file）', () => {
    function stage(version, { osName = 'linux', sums = true, tamper = false } = {}) {
        const dir = path.join(root, 'manual');
        fs.mkdirSync(dir, { recursive: true });
        const names = appUpdate.releaseAssetNames(version, ARCH, osName);
        const data = buildAppTarball(version, { osName });
        fs.writeFileSync(path.join(dir, names.app), data);
        if (sums) fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${tamper ? 'f'.repeat(64) : sha(data)}  ${names.app}\n`);
        return path.join(dir, names.app);
    }
    const install = file => appUpdate.installAppFile({ appRoot, file, targetOs: 'linux' });

    test('文件名解析', () => {
        expect(appUpdate.parseAppFileName(`/tmp/manyoyo-9.0.0-linux-${ARCH}-app.tar.gz`)).toEqual({ version: '9.0.0', os: 'linux', arch: ARCH });
        expect(appUpdate.parseAppFileName('manyoyo-9.0.0.run')).toBeNull();
    });

    test('合规时切换 current 并保留上一版本', async () => {
        seedInstalled('1.0.0');
        const result = await install(stage('9.0.0'));
        expect(result).toEqual(expect.objectContaining({ version: '9.0.0', previous: '1.0.0' }));
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('9.0.0');
        expect(fs.existsSync(path.join(appRoot, '1.0.0'))).toBe(true);
    });

    test('文件名不合规、缺 SHA256SUMS、哈希不符都拒绝且 current 不变', async () => {
        seedInstalled('1.0.0');
        const bad = path.join(root, 'foo.tar.gz');
        fs.writeFileSync(bad, 'x');
        await expect(install(bad)).rejects.toMatchObject({ code: 'BAD_FILE' });
        await expect(install(stage('9.0.0', { sums: false }))).rejects.toMatchObject({ code: 'CHECKSUM', message: expect.stringContaining('releases/download/v9.0.0/SHA256SUMS') });
        await expect(install(stage('9.0.0', { tamper: true }))).rejects.toMatchObject({ code: 'CHECKSUM' });
        await expect(install(stage('9.0.0', { osName: 'macos' }))).rejects.toMatchObject({ code: 'BAD_FILE' });
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('1.0.0');
        expect(fs.existsSync(path.join(appRoot, '9.0.0'))).toBe(false);
    });
});
