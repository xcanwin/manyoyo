'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const appUpdate = require('../lib/app-update');
const { createUpdateChecker } = require('../lib/update-check');

const { detectInstallMode, fetchLatestRelease, installAppUpdate, rollbackApp, compareVersions, describeRuntimeChange, findOutdatedContainers, UpdateError } = appUpdate;
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const ARCH = appUpdate.arch();

let root;
let home;
let appRoot;
let server;
let base;
let state;

function buildAppTarball(version, { arch = ARCH, kind = 'app', skip = [] } = {}) {
    const dir = path.join(root, `pkg-${version}-${kind}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'node/bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'manyoyo/bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node/bin/node'), 'node');
    fs.writeFileSync(path.join(dir, 'manyoyo/bin/manyoyo.js'), `// ${version}`);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version, kind, arch, imageVersion: `${version}-common` }));
    skip.forEach(rel => fs.rmSync(path.join(dir, rel), { recursive: true, force: true }));
    const tgz = path.join(root, `pkg-${version}-${kind}.tar.gz`);
    const r = spawnSync('tar', ['-czf', tgz, '-C', dir, ...fs.readdirSync(dir)]);
    if (r.status !== 0) throw new Error('tar failed');
    return fs.readFileSync(tgz);
}

// 本地替身 Release：同一个 HTTP 服务既当 API 又当下载站；每个请求都记下来，便于断言“没发请求 / 请求头里没有本机信息”
function startServer(handlerOverrides = {}) {
    state = { hits: [], files: {}, release: null, rateLimit: false, status: null };
    server = http.createServer((req, res) => {
        state.hits.push({ url: req.url, headers: req.headers });
        if (handlerOverrides.all) return handlerOverrides.all(req, res);
        if (req.url === '/repos/xcanwin/manyoyo/releases/latest') {
            if (state.rateLimit) {
                res.writeHead(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
                return res.end('{"message":"API rate limit exceeded"}');
            }
            if (state.status) { res.writeHead(state.status); return res.end('{}'); }
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(state.release));
        }
        const name = decodeURIComponent(req.url.replace(/^\/dl\//, ''));
        if (state.files[name] !== undefined) { res.writeHead(200); return res.end(state.files[name]); }
        res.writeHead(404);
        return res.end();
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
    }));
}

function publish(version, { tamperSums = false, tarball, extraAssets = {}, arch = ARCH } = {}) {
    const names = appUpdate.releaseAssetNames(version, arch);
    const data = tarball || buildAppTarball(version, { arch });
    state.files[names.app] = data;
    state.files[names.sums] = `${tamperSums ? 'f'.repeat(64) : sha(data)}  ${names.app}\n`;
    const assets = [names.app, names.sums, ...Object.keys(extraAssets)].map(name => ({ name, browser_download_url: `${base}/dl/${encodeURIComponent(name)}` }));
    Object.assign(state.files, extraAssets);
    state.release = { tag_name: `v${version}`, assets };
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

describe('versions', () => {
    test('compareVersions orders semver numerically', () => {
        expect(compareVersions('8.0.0', '7.1.6')).toBe(1);
        expect(compareVersions('7.10.0', '7.9.9')).toBe(1);
        expect(compareVersions('v7.1.6', '7.1.6')).toBe(0);
        expect(compareVersions('7.1.5', '7.1.6')).toBe(-1);
    });
});

describe('fetchLatestRelease asset URL allowlist', () => {
    test('with the default API base, assets outside this repo\'s release path are ignored', async () => {
        const body = { tag_name: 'v9.9.9', assets: [
            { name: 'a.tar.gz', browser_download_url: 'https://github.com/xcanwin/manyoyo/releases/download/v9.9.9/a.tar.gz' },
            { name: 'evil.tar.gz', browser_download_url: 'https://evil.example.com/evil.tar.gz' }
        ] };
        const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
        const release = await fetchLatestRelease({ fetchImpl });
        expect(Object.keys(release.assets)).toEqual(['a.tar.gz']);
    });
});

describe('fetchLatestRelease', () => {
    test('reads the tag and assets with a fixed header set that carries no local information', async () => {
        await startServer();
        publish('9.0.0');
        const release = await fetchLatestRelease({ apiBase: base });
        expect(release.version).toBe('9.0.0');
        expect(Object.keys(release.assets)).toContain(`manyoyo-9.0.0-macos-${ARCH}-app.tar.gz`);
        const headers = state.hits[0].headers;
        expect(headers['user-agent']).toBe('manyoyo-update');
        expect(headers.authorization).toBeUndefined();
        expect(headers.cookie).toBeUndefined();
        expect(Object.keys(headers).sort()).toEqual(['accept', 'accept-encoding', 'accept-language', 'connection', 'host', 'sec-fetch-mode', 'user-agent'].filter(k => k in headers).sort());
    });

    test('rate limiting, missing releases, bad tags and server errors give friendly, coded errors', async () => {
        await startServer();
        publish('9.0.0');
        state.rateLimit = true;
        await expect(fetchLatestRelease({ apiBase: base })).rejects.toMatchObject({ code: 'RATE_LIMIT', message: expect.stringContaining('频率限制') });
        state.rateLimit = false;
        state.status = 404;
        await expect(fetchLatestRelease({ apiBase: base })).rejects.toMatchObject({ code: 'NO_RELEASE' });
        state.status = 500;
        await expect(fetchLatestRelease({ apiBase: base })).rejects.toMatchObject({ code: 'HTTP', message: expect.stringContaining('500') });
        state.status = null;
        state.release = { tag_name: 'nightly', assets: [] };
        await expect(fetchLatestRelease({ apiBase: base })).rejects.toMatchObject({ code: 'HTTP', message: expect.stringContaining('无法识别') });
    });

    test('a network failure explains what to check', async () => {
        await startServer();
        const dead = base;
        await new Promise(resolve => server.close(resolve));
        await expect(fetchLatestRelease({ apiBase: dead })).rejects.toMatchObject({ code: 'NETWORK', message: expect.stringContaining('网络') });
    });
});

describe('installAppUpdate / rollbackApp', () => {
    test('downloads only the app package, verifies it, lands in app/<version> and atomically switches current', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0');
        const release = await fetchLatestRelease({ apiBase: base });
        const result = await installAppUpdate({ appRoot, release, fetchImpl: fetch, tmpRoot: root });

        expect(result).toEqual(expect.objectContaining({ version: '9.0.0', previous: '1.0.0' }));
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('9.0.0');
        expect(fs.existsSync(path.join(appRoot, '9.0.0/node/bin/node'))).toBe(true);
        expect(fs.readFileSync(path.join(appRoot, '9.0.0/.installed'), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
        expect(fs.existsSync(path.join(appRoot, '1.0.0/manyoyo/bin/manyoyo.js'))).toBe(true); // 上一版本保留
        expect(JSON.parse(fs.readFileSync(path.join(appRoot, '.update.json'), 'utf8'))).toEqual(expect.objectContaining({ previous: '1.0.0', current: '9.0.0' }));
        // 只下载了 app 包与校验清单，没有碰完整包
        const downloaded = state.hits.map(h => decodeURIComponent(h.url)).filter(u => u.startsWith('/dl/')).map(u => u.slice(4)).sort();
        expect(downloaded).toEqual([`SHA256SUMS-macos-${ARCH}`, `manyoyo-9.0.0-macos-${ARCH}-app.tar.gz`].sort());
        expect(fs.readdirSync(appRoot).filter(n => n.startsWith('.tmp-') || n.startsWith('.current.'))).toEqual([]);
    });

    test('only the current and the previous version are kept; older ones and stale temp dirs are cleaned', async () => {
        seedInstalled('1.0.0');
        fs.mkdirSync(path.join(appRoot, '0.9.0'));
        fs.mkdirSync(path.join(appRoot, '.tmp-8.0.0-1234'));
        await startServer();
        publish('9.0.0');
        await installAppUpdate({ appRoot, release: await fetchLatestRelease({ apiBase: base }), fetchImpl: fetch, tmpRoot: root });
        expect(fs.readdirSync(appRoot).filter(n => !n.startsWith('.update')).sort()).toEqual(['1.0.0', '9.0.0', 'current']);
    });

    test('a checksum mismatch aborts before anything is switched or left behind', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0', { tamperSums: true });
        await expect(installAppUpdate({ appRoot, release: await fetchLatestRelease({ apiBase: base }), fetchImpl: fetch, tmpRoot: root }))
            .rejects.toMatchObject({ code: 'CHECKSUM', message: expect.stringContaining('当前版本不受影响') });
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('1.0.0');
        expect(fs.existsSync(path.join(appRoot, '9.0.0'))).toBe(false);
        expect(fs.readdirSync(appRoot).filter(n => n.startsWith('.tmp-'))).toEqual([]);
    });

    test('a checksum file that does not list the package aborts too', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0');
        state.files[`SHA256SUMS-macos-${ARCH}`] = `${'a'.repeat(64)}  something-else.tar.gz\n`;
        await expect(installAppUpdate({ appRoot, release: await fetchLatestRelease({ apiBase: base }), fetchImpl: fetch, tmpRoot: root }))
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
        await expect(installAppUpdate({ appRoot, release: await fetchLatestRelease({ apiBase: base }), fetchImpl: fetch, tmpRoot: root }))
            .rejects.toMatchObject({ code: 'BAD_PACKAGE', message: expect.stringMatching(message) });
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('1.0.0');
        expect(fs.existsSync(path.join(appRoot, '9.0.0'))).toBe(false);
    });

    test('a package whose manifest version differs from the release tag is rejected', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0', { tarball: buildAppTarball('8.5.0') });
        await expect(installAppUpdate({ appRoot, release: await fetchLatestRelease({ apiBase: base }), fetchImpl: fetch, tmpRoot: root }))
            .rejects.toMatchObject({ code: 'BAD_PACKAGE' });
    });

    test('a release without a package for this architecture says so', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0', { arch: ARCH === 'arm64' ? 'x64' : 'arm64' });
        await expect(installAppUpdate({ appRoot, release: await fetchLatestRelease({ apiBase: base }), fetchImpl: fetch, tmpRoot: root }))
            .rejects.toMatchObject({ code: 'NO_ASSET', message: expect.stringContaining(ARCH) });
    });

    test('rollback switches back to the previous version, and rolling back again returns to the newer one', async () => {
        seedInstalled('1.0.0');
        await startServer();
        publish('9.0.0');
        await installAppUpdate({ appRoot, release: await fetchLatestRelease({ apiBase: base }), fetchImpl: fetch, tmpRoot: root });

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
        await installAppUpdate({ appRoot, release: await fetchLatestRelease({ apiBase: base }), fetchImpl: fetch, tmpRoot: root });
        publish('3.0.0');
        await installAppUpdate({ appRoot, release: await fetchLatestRelease({ apiBase: base }), fetchImpl: fetch, tmpRoot: root });
        expect(fs.readdirSync(appRoot).filter(n => /^\d/.test(n)).sort()).toEqual(['2.0.0', '3.0.0']);
        expect(rollbackApp({ appRoot })).toEqual({ from: '3.0.0', to: '2.0.0' });
    });
});

describe('runtime change hint and outdated containers', () => {
    const remote = { manifest: { components: { podman: { version: '6.2.0' }, vmDisk: { sha256: 'n'.repeat(64) } } } };

    test('only a changed Podman or VM disk produces a hint, and the hint says to download the full package', () => {
        const installed = { podmanVersion: '6.1.3', vmDiskSha256: 'o'.repeat(64) };
        const hint = describeRuntimeChange(installed, remote);
        expect(hint).toContain('Podman 6.1.3 → 6.2.0');
        expect(hint).toContain('虚拟机磁盘有更新');
        expect(hint).toContain('完整安装包');
        expect(describeRuntimeChange({ podmanVersion: '6.2.0', vmDiskSha256: 'n'.repeat(64) }, remote)).toBe('');
        expect(describeRuntimeChange(null, remote)).toBe('');
        expect(describeRuntimeChange({ podmanVersion: '', vmDiskSha256: '' }, remote)).toBe(''); // 复用外部运行时：没装过
        expect(describeRuntimeChange(installed, {})).toBe('');
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
            fetchLatest: () => fetchLatestRelease({ apiBase: base }),
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
