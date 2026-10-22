'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const appUpdate = require('../lib/app-update');
const codeUpdate = require('../lib/code-update');

const { codeTagForBranch, isValidBranch, codeAssetName, validateCodeInfo, fetchCodeInfo, installCodeUpdate, isCodeVersion, latestReleaseNotice, formatBuiltAt } = codeUpdate;
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const ARCH = appUpdate.arch();
const OS = 'linux';
const COMMIT = 'abc1234def5678901234567890abcdef12345678';
const SHA7 = COMMIT.slice(0, 7);
const VERSION = `8.6.9+${SHA7}`;
const IMAGE = '2.2.0-common';

let root;
let home;
let appRoot;
let server;
let downloadBase;
let hits;
let files;

function buildArchive(version, { arch = ARCH, osName = OS, kind = 'app' } = {}) {
    const dir = path.join(root, `pkg-${version}-${osName}-${arch}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'node/bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'manyoyo/bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node/bin/node'), 'node');
    fs.writeFileSync(path.join(dir, 'manyoyo/bin/manyoyo.js'), `// ${version}`);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version, kind, arch, os: osName, imageVersion: IMAGE, source: { branch: 'main', commit: COMMIT } }));
    const tgz = `${dir}.tar.gz`;
    const r = spawnSync('tar', ['-czf', tgz, '-C', dir, ...fs.readdirSync(dir)]);
    if (r.status !== 0) throw new Error('tar failed');
    return fs.readFileSync(tgz);
}

function makeInfo(overrides = {}, { data = buildArchive(VERSION) } = {}) {
    const name = codeAssetName(COMMIT, OS, ARCH);
    const info = {
        schemaVersion: 1,
        branch: 'main',
        commit: COMMIT,
        subject: '新增代码版升级',
        version: VERSION,
        imageVersion: IMAGE,
        imageReady: true,
        builtAt: '2026-10-23T00:00:00Z',
        assets: { [`${OS}-${ARCH}`]: { name, sha256: sha(data), size: data.length } },
        ...overrides
    };
    return { info, data, name };
}

// tag 为 code-main 的下载站替身；CODE.json 与包都按真实命名放在 /<repo>/releases/download/<tag>/ 下
function publishCode(overrides = {}, options = {}) {
    const { info, data, name } = makeInfo(overrides, options);
    const tag = options.tag || 'code-main';
    files[`${tag}/${name}`] = data;
    files[`${tag}/CODE.json`] = JSON.stringify(info);
    return info;
}

function startServer() {
    hits = [];
    files = {};
    server = http.createServer((req, res) => {
        hits.push({ method: req.method, url: req.url, headers: req.headers });
        const m = /^\/xcanwin\/manyoyo\/releases\/download\/(.+)$/.exec(req.url);
        const key = m ? decodeURIComponent(m[1]) : '';
        if (key && files[key] !== undefined) { res.writeHead(200, { 'content-length': Buffer.byteLength(files[key]) }); return res.end(req.method === 'HEAD' ? undefined : files[key]); }
        res.writeHead(404);
        return res.end();
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        downloadBase = `http://127.0.0.1:${server.address().port}/xcanwin/manyoyo/releases/download/`;
        resolve();
    }));
}

function seedInstalled(version) {
    fs.mkdirSync(path.join(appRoot, version, 'manyoyo/bin'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, version, 'manyoyo/bin/manyoyo.js'), `// ${version}`);
    fs.writeFileSync(path.join(appRoot, version, '.installed'), 'old');
    fs.rmSync(path.join(appRoot, 'current'), { force: true });
    fs.symlinkSync(version, path.join(appRoot, 'current'));
}

const install = (overrides = {}) => installCodeUpdate({
    notFoundRetryMs: 0, appRoot, branch: 'main', installed: '8.6.9', downloadBase, targetArch: ARCH, targetOs: OS, tmpRoot: root, ...overrides
});
// 当前正式版的 package.json 里的 gitHead（正式包构建时写入）
function setGitHead(head, version = '8.6.9') {
    const file = path.join(appRoot, version, 'manyoyo', 'package.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(head === undefined ? { version } : { version, gitHead: head }));
}

// 本地已有的代码版目录（上一次安装留下的）：与 installFromArchive 安装出来的一致
function seedLocalCopy({ version = VERSION, commit = COMMIT, arch = ARCH, osName = OS, skip = [], manifest } = {}) {
    const dir = path.join(appRoot, version);
    fs.mkdirSync(path.join(dir, 'node/bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'manyoyo/bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node/bin/node'), 'node');
    fs.writeFileSync(path.join(dir, 'manyoyo/bin/manyoyo.js'), `// local ${version}`);
    const text = manifest !== undefined ? manifest : JSON.stringify({ version, kind: 'app', arch, os: osName, imageVersion: IMAGE, source: { branch: 'main', commit } });
    fs.writeFileSync(path.join(dir, 'manifest.json'), text);
    fs.writeFileSync(path.join(dir, '.installed'), sha(Buffer.from(text)));
    skip.forEach(rel => fs.rmSync(path.join(dir, rel), { recursive: true, force: true }));
    return dir;
}

const tarHits = () => hits.filter(h => h.url.endsWith('.tar.gz'));

const NO_WAIT = { notFoundRetryMs: 0 };
const rejects = async (promise, code, text) => {
    const error = await promise.then(() => null, e => e);
    expect(error).toBeInstanceOf(appUpdate.UpdateError);
    expect(error.code).toBe(code);
    if (text) expect(error.message).toContain(text);
    return error;
};
const leftovers = () => fs.readdirSync(appRoot).filter(name => name.startsWith('.tmp-'));

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-codeupdate-'));
    home = path.join(root, 'home');
    appRoot = path.join(home, '.manyoyo', 'app');
    fs.mkdirSync(appRoot, { recursive: true });
    server = null;
});
afterEach(async () => {
    if (server && server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
});

describe('分支名与 tag 映射', () => {
    test('code-<分支>，/ 换成 --', () => {
        expect(codeTagForBranch('main')).toBe('code-main');
        expect(codeTagForBranch('feat/x')).toBe('code-feat--x');
        expect(codeTagForBranch('release-1.2_a')).toBe('code-release-1.2_a');
    });

    test('非法分支名一律拒绝（含 -- 防映射冲突、路径穿越、空白、超长）', () => {
        ['', '-x', '.x', 'a--b', 'a b', 'a;b', '../x', 'a/../b', 'a//b', 'a/', 'a\nb', 'x'.repeat(102), undefined, 3].forEach(name => {
            expect(isValidBranch(name)).toBe(false);
            expect(() => codeTagForBranch(name)).toThrow(appUpdate.UpdateError);
        });
        expect(isValidBranch('x'.repeat(101))).toBe(true);
    });

    test('资产名按提交与平台拼出', () => {
        expect(codeAssetName(COMMIT, 'macos', 'arm64')).toBe(`manyoyo-code-${SHA7}-macos-arm64-app.tar.gz`);
    });
});

describe('CODE.json 校验', () => {
    const valid = () => makeInfo().info;
    const check = info => validateCodeInfo(info, { branch: 'main' });

    test('合法内容通过', () => {
        expect(check(valid())).toMatchObject({ commit: COMMIT, version: VERSION });
    });

    test.each([
        ['schemaVersion 不是 1', { schemaVersion: 2 }],
        ['branch 与请求不符', { branch: 'dev' }],
        ['commit 不是 40 位小写 hex', { commit: 'ABC1234DEF5678901234567890ABCDEF12345678' }],
        ['commit 太短', { commit: 'abc1234' }],
        ['version 与 commit 不符', { version: '8.6.9+0000000' }],
        ['version 没有 sha', { version: '8.6.9' }],
        ['imageVersion 格式不对', { imageVersion: 'latest' }],
        ['imageReady 不是布尔', { imageReady: 'true' }],
        ['assets 缺失', { assets: undefined }]
    ])('%s → 拒绝', (_, patch) => {
        expect(() => check({ ...valid(), ...patch })).toThrow(appUpdate.UpdateError);
    });

    test.each([
        ['资产名带 ../', `../../${codeAssetName(COMMIT, OS, ARCH)}`],
        ['资产名是别的提交', codeAssetName('1'.repeat(40), OS, ARCH)],
        ['资产名多了路径', `x/${codeAssetName(COMMIT, OS, ARCH)}`],
        ['资产名宽松匹配（多一段）', `${codeAssetName(COMMIT, OS, ARCH)}.exe`]
    ])('%s → 拒绝', (_, name) => {
        const info = valid();
        info.assets[`${OS}-${ARCH}`].name = name;
        expect(() => check(info)).toThrow(appUpdate.UpdateError);
    });

    test('sha256 不是 64 位 hex → 拒绝；size 不是正整数 → 拒绝', () => {
        let info = valid();
        info.assets[`${OS}-${ARCH}`].sha256 = 'z'.repeat(64);
        expect(() => check(info)).toThrow(appUpdate.UpdateError);
        info = valid();
        info.assets[`${OS}-${ARCH}`].size = -1;
        expect(() => check(info)).toThrow(appUpdate.UpdateError);
    });

    test('subject 只用于打印：去掉控制字符并截断到 200 字符', () => {
        const info = check({ ...valid(), subject: `a\u001b[31m${'x'.repeat(300)}\n` });
        expect(info.subject).not.toMatch(/[\u0000-\u001f]/);
        expect(info.subject.length).toBeLessThanOrEqual(200);
    });
});

describe('fetchCodeInfo', () => {
    test('读到并校验 CODE.json，请求不带本机信息', async () => {
        await startServer();
        publishCode();
        const info = await fetchCodeInfo({ branch: 'main', downloadBase });
        expect(info.version).toBe(VERSION);
        expect(hits.map(h => h.url)).toEqual(['/xcanwin/manyoyo/releases/download/code-main/CODE.json']);
        expect(hits[0].headers['user-agent']).toBe('manyoyo-update');
        ['authorization', 'cookie', 'x-forwarded-for', 'referer'].forEach(name => expect(hits[0].headers[name]).toBeUndefined());
        expect(JSON.stringify(hits[0].headers)).not.toContain(os.hostname());
    });

    test('404 → 说明这个分支没有代码版，以及下一步', async () => {
        await startServer();
        const error = await rejects(fetchCodeInfo({ branch: 'feat/x', downloadBase, ...NO_WAIT }), 'NO_CODE_BUILD', 'feat/x');
        expect(error.message).toContain('手动触发');
    });

    test('CODE.json 正在被替换（先 404 一次）：等一下再确认，能读到就当没事', async () => {
        await startServer();
        publishCode();
        let calls = 0;
        const info = await fetchCodeInfo({
            branch: 'main', downloadBase, notFoundRetryMs: 0,
            fetchImpl: (url, options) => { calls += 1; return calls === 1 ? Promise.resolve(new Response('', { status: 404 })) : fetch(url, options); }
        });
        expect(calls).toBe(2);
        expect(info.version).toBe(VERSION);
    });

    test('一直 404 才说没有代码版（共请求两次）', async () => {
        let calls = 0;
        await rejects(fetchCodeInfo({ branch: 'main', downloadBase, notFoundRetryMs: 0, fetchImpl: () => { calls += 1; return Promise.resolve(new Response('', { status: 404 })); } }), 'NO_CODE_BUILD');
        expect(calls).toBe(2);
    });

    test('声明的长度就超限：不读内容直接拒绝', async () => {
        const response = { status: 200, ok: true, headers: new Headers({ 'content-length': String(10 * 1024 * 1024) }), text: () => { throw new Error('不应该读取'); } };
        await rejects(fetchCodeInfo({ branch: 'main', downloadBase, fetchImpl: () => Promise.resolve(response) }), 'BAD_CODE_INFO', '过大');
    });

    test('CODE.json 不是 JSON、过大 → 拒绝', async () => {
        await startServer();
        files['code-main/CODE.json'] = 'not json';
        await rejects(fetchCodeInfo({ branch: 'main', downloadBase }), 'BAD_CODE_INFO');
        files['code-main/CODE.json'] = ' '.repeat(70 * 1024);
        await rejects(fetchCodeInfo({ branch: 'main', downloadBase }), 'BAD_CODE_INFO');
    });

    test('经注入的 fetch 发出（代理由它决定）', async () => {
        await startServer();
        publishCode();
        const seen = [];
        await fetchCodeInfo({ branch: 'main', downloadBase, fetchImpl: (url, options) => { seen.push(url); return fetch(url, options); } });
        expect(seen).toHaveLength(1);
    });

    test('网络不通 → NETWORK 并带地址', async () => {
        const error = await rejects(fetchCodeInfo({ branch: 'main', downloadBase: 'http://127.0.0.1:9/', fetchImpl: () => Promise.reject(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } })) }), 'NETWORK');
        expect(error.message).toContain('http://127.0.0.1:9/code-main/CODE.json');
    });
});

describe('代码版上执行普通 update', () => {
    test('isCodeVersion 只认 x.y.z+sha7', () => {
        expect(isCodeVersion(VERSION)).toBe(true);
        ['8.6.9', '', undefined, '8.6.9+abc'].forEach(v => expect(isCodeVersion(v)).toBe(false));
    });

    test('正式版不更新时：代码版提示怎么换回正式版，正式版仍说“已是最新”', () => {
        expect(latestReleaseNotice(VERSION, '8.6.9')).toContain('当前是代码版');
        expect(latestReleaseNotice(VERSION, '8.6.9')).toContain('重新运行安装命令');
        expect(latestReleaseNotice('8.6.9', '8.6.9')).toBe('已是最新版本 8.6.9');
    });
});

describe('构建时间显示', () => {
    test('按指定时区显示成 YYYY-MM-DD HH:mm', () => {
        expect(formatBuiltAt('2026-10-23T01:30:07.103Z', 'Asia/Shanghai')).toBe('2026-10-23 09:30');
        expect(formatBuiltAt('2026-10-23T01:30:07.103Z', 'UTC')).toBe('2026-10-23 01:30');
        expect(formatBuiltAt('2026-10-23T01:30:07.103Z', 'America/Los_Angeles')).toBe('2026-10-22 18:30');
        // 午夜不能显示成 24:00
        expect(formatBuiltAt('2026-10-23T16:00:00Z', 'Asia/Shanghai')).toBe('2026-10-24 00:00');
    });

    test('解析不了就显示“未知时间”', () => {
        ['', undefined, null, 'not a date', '2026-13-45'].forEach(value => expect(formatBuiltAt(value, 'UTC')).toBe('未知时间'));
    });
});

describe('installCodeUpdate', () => {
    test('下载、校验并切换 current，旧版本保留可回滚', async () => {
        await startServer();
        seedInstalled('8.6.9');
        publishCode();
        const result = await install();
        expect(result.status).toBe('installed');
        expect(result.version).toBe(VERSION);
        expect(result.previous).toBe('8.6.9');
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe(VERSION);
        expect(fs.existsSync(path.join(appRoot, '8.6.9'))).toBe(true);
        expect(appUpdate.rollbackApp({ appRoot })).toEqual({ from: VERSION, to: '8.6.9' });
        expect(leftovers()).toEqual([]);
    });

    test('已经是这个提交：不下载包', async () => {
        await startServer();
        seedInstalled(VERSION);
        publishCode();
        const result = await install({ installed: VERSION });
        expect(result.status).toBe('same');
        expect(hits.filter(h => h.url.endsWith('.tar.gz'))).toEqual([]);
        expect(hits.some(h => h.method === 'HEAD')).toBe(false);
    });

    test('代码版比当前版本旧 → 拒绝，current 不变', async () => {
        await startServer();
        seedInstalled('8.7.0');
        publishCode();
        await rejects(install({ installed: '8.7.0' }), 'OLDER', '8.7.0');
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('8.7.0');
        expect(hits.filter(h => h.url.endsWith('.tar.gz'))).toEqual([]);
    });

    test('镜像还没发布（imageReady=false）→ 拒绝，不下载，current 不变', async () => {
        await startServer();
        seedInstalled('8.6.9');
        publishCode({ imageReady: false });
        await rejects(install(), 'IMAGE_NOT_READY', IMAGE);
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('8.6.9');
        expect(hits.filter(h => h.url.endsWith('.tar.gz'))).toEqual([]);
    });

    test('包的 SHA256 与 CODE.json 不符 → 中止，不留临时目录', async () => {
        await startServer();
        seedInstalled('8.6.9');
        const info = publishCode();
        // 长度与 CODE.json 里一致、内容不同：只能靠 SHA256 发现
        files[`code-main/${info.assets[`${OS}-${ARCH}`].name}`] = Buffer.alloc(info.assets[`${OS}-${ARCH}`].size, 1);
        await rejects(install(), 'CHECKSUM', 'SHA256');
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('8.6.9');
        expect(leftovers()).toEqual([]);
        expect(fs.readdirSync(appRoot).sort()).toEqual(['.update.json'].filter(n => fs.existsSync(path.join(appRoot, n))).concat(['8.6.9', 'current']).sort());
    });

    test('服务端的大小与 CODE.json 不符 → 在读完内容之前中止（不靠写满磁盘再校验）', async () => {
        await startServer();
        seedInstalled('8.6.9');
        const info = publishCode();
        files[`code-main/${info.assets[`${OS}-${ARCH}`].name}`] = Buffer.from('tampered');
        await rejects(install(), 'CHECKSUM', '大小');
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('8.6.9');
        expect(leftovers()).toEqual([]);
    });

    test('包里 manifest 的版本与 CODE.json 不符 → 中止', async () => {
        await startServer();
        seedInstalled('8.6.9');
        const wrong = buildArchive('8.6.9+0000000');
        publishCode({}, { data: wrong });
        await rejects(install(), 'BAD_PACKAGE');
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('8.6.9');
    });

    test('CODE.json 里没有本机平台的包 → NO_ASSET', async () => {
        await startServer();
        seedInstalled('8.6.9');
        publishCode();
        await rejects(install({ targetOs: 'macos' }), 'NO_ASSET', 'macos');
    });

    test('包 404（CODE.json 已更新但包还没传完等异常）→ NO_ASSET', async () => {
        await startServer();
        seedInstalled('8.6.9');
        const info = publishCode();
        delete files[`code-main/${info.assets[`${OS}-${ARCH}`].name}`];
        await rejects(install(), 'NO_ASSET');
    });

    test('包下载走注入的 fetch', async () => {
        await startServer();
        seedInstalled('8.6.9');
        publishCode();
        const seen = [];
        await install({ fetchImpl: (url, options) => { seen.push(url); return fetch(url, options); } });
        expect(seen.some(url => url.endsWith('.tar.gz'))).toBe(true);
    });
});

describe('与当前正式版同一个提交', () => {
    test('当前版本的 gitHead 等于 CODE.json 的提交：不下载，说明与正式版一致', async () => {
        await startServer();
        seedInstalled('8.6.9');
        setGitHead(COMMIT);
        publishCode();
        const result = await install();
        expect(result.status).toBe('same-release');
        expect(result.info.commit).toBe(COMMIT);
        expect(tarHits()).toEqual([]);
        expect(hits.some(h => h.method === 'HEAD')).toBe(false);
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('8.6.9');
    });

    test.each([
        ['gitHead 是别的提交', 'f'.repeat(40)],
        ['只有前 7 位相同', `${SHA7}${'0'.repeat(33)}`],
        ['缺失', undefined],
        ['格式非法（太短）', SHA7],
        ['格式非法（大写）', COMMIT.toUpperCase()],
        ['格式非法（不是字符串）', 12345]
    ])('gitHead %s → 照常下载安装', async (_, head) => {
        await startServer();
        seedInstalled('8.6.9');
        setGitHead(head);
        publishCode();
        const result = await install();
        expect(result.status).toBe('installed');
        expect(tarHits().length).toBeGreaterThan(0);
    });

    test('package.json 读不到 / 不是 JSON → 照常下载安装', async () => {
        await startServer();
        seedInstalled('8.6.9');
        fs.mkdirSync(path.join(appRoot, '8.6.9/manyoyo'), { recursive: true });
        fs.writeFileSync(path.join(appRoot, '8.6.9/manyoyo/package.json'), '{not json');
        publishCode();
        expect((await install()).status).toBe('installed');
    });
});

describe('本地已有这个代码版时直接切换', () => {
    const OTHER = 'f'.repeat(40);

    test('目录齐全且与 CODE.json 对得上：不下载，current 切过去，上一版本记在 .update.json 里', async () => {
        await startServer();
        seedInstalled('8.6.9');
        const dir = seedLocalCopy();
        publishCode();
        const result = await install();
        expect(result.status).toBe('reused');
        expect(result.version).toBe(VERSION);
        expect(result.previous).toBe('8.6.9');
        expect(result.manifest).toMatchObject({ version: VERSION, kind: 'app' });
        expect(tarHits()).toEqual([]);
        expect(hits.some(h => h.method === 'HEAD')).toBe(false);
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe(VERSION);
        expect(JSON.parse(fs.readFileSync(path.join(appRoot, '.update.json'), 'utf-8'))).toMatchObject({ previous: '8.6.9', current: VERSION });
        expect(fs.readFileSync(path.join(dir, 'manyoyo/bin/manyoyo.js'), 'utf-8')).toBe(`// local ${VERSION}`);
        expect(appUpdate.rollbackApp({ appRoot })).toEqual({ from: VERSION, to: '8.6.9' });
    });

    test.each([
        ['缺 node/bin/node', { skip: ['node/bin/node'] }],
        ['缺 manyoyo/bin/manyoyo.js', { skip: ['manyoyo/bin/manyoyo.js'] }],
        ['缺 manifest.json', { skip: ['manifest.json', '.installed'] }],
        ['manifest 不是 JSON', { manifest: '{broken' }],
        ['manifest 的提交不同', { commit: OTHER }],
        ['manifest 的版本不同', { manifest: JSON.stringify({ version: '8.6.9+0000000', kind: 'app', arch: ARCH, os: OS, source: { commit: COMMIT } }) }],
        ['manifest 的类型不是 app', { manifest: JSON.stringify({ version: VERSION, kind: 'lite', arch: ARCH, os: OS, source: { commit: COMMIT } }) }],
        ['架构不符', { arch: ARCH === 'x64' ? 'arm64' : 'x64' }],
        ['系统不符', { osName: 'macos' }],
        ['manifest 没有 source.commit', { manifest: JSON.stringify({ version: VERSION, kind: 'app', arch: ARCH, os: OS }) }]
    ])('%s → 不复用，照常下载并装好', async (_, options) => {
        await startServer();
        seedInstalled('8.6.9');
        seedLocalCopy(options);
        publishCode();
        const result = await install();
        expect(result.status).toBe('installed');
        expect(tarHits().length).toBeGreaterThan(0);
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe(VERSION);
        // 下载安装之后目录是完整的
        expect(fs.existsSync(path.join(appRoot, VERSION, 'node/bin/node'))).toBe(true);
    });

    test('.installed 与 manifest.json 的哈希不符（目录被改过）→ 不复用，照常下载', async () => {
        await startServer();
        seedInstalled('8.6.9');
        const dir = seedLocalCopy();
        fs.writeFileSync(path.join(dir, '.installed'), 'f'.repeat(64));
        publishCode();
        expect((await install()).status).toBe('installed');
        expect(tarHits().length).toBeGreaterThan(0);
    });

    test('没有 .installed → 不复用', async () => {
        await startServer();
        seedInstalled('8.6.9');
        const dir = seedLocalCopy();
        fs.rmSync(path.join(dir, '.installed'));
        publishCode();
        expect((await install()).status).toBe('installed');
    });

    test('顺序：本地有这个代码版目录，但 CODE.json 比当前版本旧 → 仍然拒绝，current 不变', async () => {
        await startServer();
        seedInstalled('8.7.0');
        seedLocalCopy();
        publishCode();
        await rejects(install({ installed: '8.7.0' }), 'OLDER');
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('8.7.0');
    });

    test('顺序：本地有这个代码版目录，但镜像没发布 → 仍然拒绝，current 不变', async () => {
        await startServer();
        seedInstalled('8.6.9');
        seedLocalCopy();
        publishCode({ imageReady: false });
        await rejects(install(), 'IMAGE_NOT_READY');
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('8.6.9');
    });

    test('顺序：与当前正式版同提交的判断排在本地复用之前', async () => {
        await startServer();
        seedInstalled('8.6.9');
        setGitHead(COMMIT);
        seedLocalCopy();
        publishCode();
        expect((await install()).status).toBe('same-release');
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('8.6.9');
    });
});

describe('onInfo：校验通过后、下载或切换之前告诉调用方装的是哪个提交', () => {
    test('下载前被调用（此时还没有任何包请求），只调用一次', async () => {
        await startServer();
        seedInstalled('8.6.9');
        publishCode();
        const seen = [];
        await install({ onInfo: info => seen.push({ commit: info.commit, packageRequests: tarHits().length }) });
        expect(seen).toEqual([{ commit: COMMIT, packageRequests: 0 }]);
    });

    test('本地复用时也在切换之前调用', async () => {
        await startServer();
        seedInstalled('8.6.9');
        seedLocalCopy();
        publishCode();
        const seen = [];
        await install({ onInfo: () => seen.push(fs.readlinkSync(path.join(appRoot, 'current'))) });
        expect(seen).toEqual(['8.6.9']);
    });

    test('校验没通过（CODE.json 非法 / 版本更旧 / 镜像未发布）时不调用', async () => {
        await startServer();
        seedInstalled('8.6.9');
        const calls = [];
        const onInfo = () => calls.push(1);
        files['code-main/CODE.json'] = 'not json';
        await rejects(install({ onInfo }), 'BAD_CODE_INFO');
        publishCode({ imageReady: false });
        await rejects(install({ onInfo }), 'IMAGE_NOT_READY');
        seedInstalled('8.7.0');
        publishCode();
        await rejects(install({ onInfo, installed: '8.7.0' }), 'OLDER');
        expect(calls).toEqual([]);
    });

    test('已是同一个版本 / 与正式版同提交时不调用', async () => {
        await startServer();
        seedInstalled('8.6.9');
        publishCode();
        const calls = [];
        await install({ onInfo: () => calls.push(1), installed: VERSION });
        setGitHead(COMMIT);
        await install({ onInfo: () => calls.push(2) });
        expect(calls).toEqual([]);
    });
});

describe('manyoyo update --code (CLI)', () => {
    const repo = path.join(__dirname, '..');

    // 把 bin/lib/package.json 拷到临时 HOME 的 app/<版本>/manyoyo 下，模拟离线包安装
    function installCopyOfCli(version) {
        const dir = path.join(appRoot, version, 'manyoyo');
        fs.mkdirSync(dir, { recursive: true });
        for (const name of ['bin', 'lib', 'package.json']) fs.cpSync(path.join(repo, name), path.join(dir, name), { recursive: true });
        fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'));
        fs.mkdirSync(path.join(appRoot, version, 'node/bin'), { recursive: true });
        fs.symlinkSync(version, path.join(appRoot, 'current'));
        return path.join(dir, 'bin/manyoyo.js');
    }

    // 假的容器运行时：升级收尾会检查 / 拉取镜像，测试里绝不能碰真实的 docker / podman
    function fakeRuntimeEnv() {
        const bin = path.join(root, 'fakebin');
        fs.mkdirSync(bin, { recursive: true });
        // 被调用就写一个标记文件，用来断言“升级收尾（拉镜像等）执行过 / 没执行”
        fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\ntouch "$MANYOYO_TEST_DOCKER_MARK"\nexit 0\n', { mode: 0o755 });
        return { PATH: `${bin}${path.delimiter}${process.env.PATH}`, MANYOYO_TEST_DOCKER_MARK: path.join(root, 'docker-called') };
    }

    // 本机的代理变量会让访问 127.0.0.1 替身的请求被代理接走
    const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(key)));

    // spawn（异步）：本进程里的 HTTP 替身在同步子进程运行期间无法响应
    const runCli = (script, args, extraEnv = {}) => new Promise(resolve => {
        const child = require('child_process').spawn(process.execPath, [script, ...args], {
            env: { ...cleanEnv(), HOME: home, ...fakeRuntimeEnv(), ...extraEnv }
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.on('close', status => resolve({ status, stdout, stderr }));
    });

    test('update --help 写明 --code', async () => {
        const result = await runCli(path.join(repo, 'bin/manyoyo.js'), ['update', '--help']);
        expect(result.stdout).toContain('--code');
    });

    test('--code 与 --file / --rollback 互斥', async () => {
        const script = installCopyOfCli('8.6.9');
        for (const extra of [['--file', '/tmp/x.tar.gz'], ['--rollback']]) {
            const result = await runCli(script, ['update', '--code', ...extra]);
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('不能同时使用');
        }
    });

    test('npm 安装的 manyoyo 拒绝 --code，并说明', async () => {
        const result = await runCli(path.join(repo, 'bin/manyoyo.js'), ['update', '--code']);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('只适用于离线包安装');
    });

    test('端到端：从替身下载站安装代码版，current 切换并提示回滚办法', async () => {
        await startServer();
        const script = installCopyOfCli('8.6.9');
        publishCode();
        const result = await runCli(script, ['update', '--code'], { MANYOYO_TEST_CODE_BASE: downloadBase });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`main@${SHA7}`);
        expect(result.stdout).toContain('新增代码版升级');
        expect(result.stdout).toContain(`8.6.9 → ${VERSION}`);
        expect(result.stdout).toContain('update --rollback');
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe(VERSION);
    });

    test('先打印装的是哪个提交（本地时区的构建时间），再打印下载地址；收尾照常执行', async () => {
        await startServer();
        const script = installCopyOfCli('8.6.9');
        publishCode();
        const result = await runCli(script, ['update', '--code'], { MANYOYO_TEST_CODE_BASE: downloadBase });
        expect(result.status).toBe(0);
        const info = result.stdout.indexOf(`main@${SHA7}`);
        const download = result.stdout.indexOf('下载:');
        expect(info).toBeGreaterThan(-1);
        expect(download).toBeGreaterThan(info);
        expect(result.stdout).toMatch(/构建于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）/);
        expect(result.stdout).not.toContain('2026-10-23T00:00:00Z');
        expect(fs.existsSync(path.join(root, 'docker-called'))).toBe(true);
    });

    test('本地已有这个代码版（回滚之后再 --code）：不下载，说明使用本地的，收尾照常执行', async () => {
        await startServer();
        const script = installCopyOfCli('8.6.9');
        publishCode();
        await runCli(script, ['update', '--code'], { MANYOYO_TEST_CODE_BASE: downloadBase });
        expect(appUpdate.rollbackApp({ appRoot })).toEqual({ from: VERSION, to: '8.6.9' });
        fs.rmSync(path.join(root, 'docker-called'), { force: true });
        const before = hits.length;
        const again = await runCli(script, ['update', '--code'], { MANYOYO_TEST_CODE_BASE: downloadBase });
        expect(again.status).toBe(0);
        expect(again.stdout).toContain(`使用本地已有的 ${VERSION}，无需下载`);
        expect(again.stdout).toContain(`8.6.9 → ${VERSION}`);
        expect(hits.slice(before).filter(h => h.url.endsWith('.tar.gz'))).toEqual([]);
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe(VERSION);
        expect(fs.existsSync(path.join(root, 'docker-called'))).toBe(true);
    });

    test('当前正式版就是这个提交（package.json 的 gitHead）：说明一致，不下载，不执行收尾', async () => {
        await startServer();
        const script = installCopyOfCli('8.6.9');
        const pkgFile = path.join(appRoot, '8.6.9/manyoyo/package.json');
        fs.writeFileSync(pkgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(pkgFile, 'utf-8')), gitHead: COMMIT }));
        publishCode();
        const result = await runCli(script, ['update', '--code'], { MANYOYO_TEST_CODE_BASE: downloadBase });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`main@${SHA7} 就是当前正式版 8.6.9 的代码，无需更新`);
        expect(tarHits()).toEqual([]);
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('8.6.9');
        expect(fs.existsSync(path.join(root, 'docker-called'))).toBe(false);
    });

    test('再执行一次：已是这个提交，不再下载', async () => {
        await startServer();
        const script = installCopyOfCli('8.6.9');
        publishCode();
        await runCli(script, ['update', '--code'], { MANYOYO_TEST_CODE_BASE: downloadBase });
        const before = hits.length;
        // 包里的程序是占位文件：换成真实的 CLI 才能再跑一次
        const dir = path.join(appRoot, VERSION, 'manyoyo');
        for (const name of ['bin', 'lib', 'package.json']) fs.cpSync(path.join(repo, name), path.join(dir, name), { recursive: true });
        fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'));
        const again = await runCli(path.join(appRoot, VERSION, 'manyoyo/bin/manyoyo.js'), ['update', '--code', 'main'], { MANYOYO_TEST_CODE_BASE: downloadBase });
        expect(again.status).toBe(0);
        expect(again.stdout).toContain(`已是 main@${SHA7}`);
        expect(hits.slice(before).filter(h => h.url.endsWith('.tar.gz'))).toEqual([]);
    });

    test('分支没有代码版：给出原因和下一步，退出码 1', async () => {
        await startServer();
        const script = installCopyOfCli('8.6.9');
        const result = await runCli(script, ['update', '--code', 'feat/x'], { MANYOYO_TEST_CODE_BASE: downloadBase });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('feat/x');
        expect(result.stderr).toContain('手动触发');
        expect(fs.readlinkSync(path.join(appRoot, 'current'))).toBe('8.6.9');
    });

    test('非法分支名在联网之前拒绝', async () => {
        await startServer();
        const script = installCopyOfCli('8.6.9');
        const result = await runCli(script, ['update', '--code', 'a--b'], { MANYOYO_TEST_CODE_BASE: downloadBase });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('分支名不合法');
        expect(hits).toEqual([]);
    });
});
