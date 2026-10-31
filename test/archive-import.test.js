'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable, Writable } = require('stream');
const { encodeEntryHeader, END_BLOCKS, pad, readTarEntries } = require('../lib/archive/tar');
const { exportArchive } = require('../lib/archive/export');
const { importArchive, inspectArchiveHead } = require('../lib/archive/import');
const { createJobRegistry, JobCancelled } = require('../lib/web/container-jobs');
const containerState = require('../lib/container-state');

function tar(entries, { end = true } = {}) {
    const parts = [];
    for (const e of entries) {
        const body = Buffer.from(e.content || '');
        const size = (e.type || 'file') === 'file' ? body.length : 0;
        parts.push(encodeEntryHeader({ name: e.name, type: e.type || 'file', size, linkname: e.linkname, mode: e.mode, uid: e.uid, gid: e.gid }), size ? body : Buffer.alloc(0), Buffer.alloc(size ? pad(size) : 0));
    }
    if (end) parts.push(END_BLOCKS);
    return Buffer.concat(parts);
}
const gz = buffer => zlib.gzipSync(buffer);
const MANIFEST = (over = {}) => ({
    format: 1, manyoyoVersion: 't', createdAt: 'x', items: ['history', 'agentSessions', 'settings', 'uploads', 'agentExtras', 'workdir', 'systemLayer'], tier: 'full', includeSecrets: true,
    containers: [{ idx: 0, name: 'box1', remark: '', image: 'img:1', containerPath: '/workspace', hostPath: '/old/path', fidelity: 'full', work: 0, exists: true }],
    workdirs: [{ n: 0, hostPath: '/old/path' }], ...over
});
// 按 END.json 的条目数规则拼一个完整归档
function archive(manifest, entries, { endOverride } = {}) {
    const all = [{ name: 'manifest.json', content: JSON.stringify(manifest) }, ...entries];
    const total = all.length + 1;
    return gz(tar([...all, { name: 'END.json', content: JSON.stringify({ entries: endOverride === undefined ? total : endOverride }) }]));
}

describe('lib/archive/import', () => {
    let home, historyDir, outside, dest, registry, deps, calls;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-imp-'));
        historyDir = path.join(home, '.manyoyo', 'web-history');
        outside = path.join(home, 'outside');
        dest = path.join(home, 'newwork');
        fs.mkdirSync(historyDir, { recursive: true });
        fs.mkdirSync(outside);
        registry = createJobRegistry({ homeDir: home });
        calls = { created: [], removed: [], layer: [], saved: [] };
        deps = {
            homeDir: home,
            webHistoryDir: historyDir,
            containerState,
            runtime: {
                inspect: () => ({ mounts: ['/workspace', '/run/manyoyo'], image: 'img:1' }),
                cpIn: name => {
                    const chunks = [];
                    const stdin = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
                    const done = new Promise(resolve => stdin.on('finish', () => { calls.layer.push({ name, chunks }); resolve({ code: 0, stderr: '' }); }));
                    return { stdin, done, kill: () => stdin.destroy() };
                }
            },
            createContainer: async args => {
                const state = containerState.createState({ homeDir: home, id: 'cccccccccccccccc', envLines: [] });
                calls.created.push(args);
                return { containerName: args.newName, id: 'cccccccccccccccc', paths: state };
            },
            removeContainer: async (name, id) => { calls.removed.push([name, id]); },
            saveHistory: async (name, history) => { calls.saved.push(name); fs.writeFileSync(path.join(historyDir, `${name}.json`), JSON.stringify(history)); }
        };
    });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

    const planOf = (over = {}) => ({ containers: { 0: { name: 'box2', hostPath: dest, imageMode: 'same', confirm: {}, ...over } } });
    const run = (buffer, planOver, extraDeps) => {
        const job = registry.create({ type: 'import', containers: ['box2'] });
        return { job, promise: importArchive({ source: Readable.from([buffer]), plan: planOf(planOver), deps: { ...deps, ...extraDeps }, job }) };
    };
    const expectNothingLeft = () => {
        expect(fs.readdirSync(outside)).toEqual([]);
        expect(fs.existsSync(dest)).toBe(false);
        expect(fs.readdirSync(historyDir).filter(f => f.includes('box2'))).toEqual([]);
        expect(fs.existsSync(path.join(home, '.manyoyo', 'tmp')) ? fs.readdirSync(path.join(home, '.manyoyo', 'tmp')) : []).toEqual([]);
    };

    const goodEntries = () => [
        { name: 'c/0/history.json', content: JSON.stringify({ containerName: 'box1', remark: '备注', pinned: true, agents: { default: { agentId: 'default', engineSessionId: 'sess-1', messages: [] } } }) },
        { name: 'c/0/events/box1.jsonl', content: `${JSON.stringify({ aggregateId: 'box1', sessionId: 'box1', seq: 1, type: 'session.ready' })}\n` },
        { name: `c/0/events/box1${encodeURIComponent('~')}agent-2.jsonl`, content: `${JSON.stringify({ aggregateId: 'box1~agent-2', sessionId: 'box1~agent-2', seq: 1, type: 'session.ready' })}\n` },
        { name: 'c/0/projections/box1.json', content: JSON.stringify({ aggregateId: 'box1', status: 'idle', lastSeq: 1 }) },
        { name: 'c/0/state/env', content: 'A=1\n' },
        { name: 'c/0/box/uploads/a.png', content: 'PNG' },
        { name: 'c/0/layer/root/.codex/sessions/s.jsonl', content: 'SESSION' },
        { name: 'c/0/layer/usr/local/bin/mytool', content: 'BIN' },
        { name: 'c/0/layer/workspace/in-mount', content: 'NO' },
        { name: 'c/0/layer/tmp/cache', content: 'NO' },
        { name: 'c/0/layer/root/badln', type: 'symlink', linkname: '/workspace' },
        { name: 'c/0/layer/root/ln', type: 'symlink', linkname: '/root/data' },
        { name: 'c/0/layer/root/ln/evil', content: 'NO' },
        { name: 'w/0', type: 'dir' },
        { name: 'w/0/main.py', content: 'print(1)' },
        { name: 'w/0/evil', type: 'symlink', linkname: outside },
        { name: 'w/0/ok', type: 'symlink', linkname: 'main.py' }
    ];
    async function layerEntries() {
        const out = {};
        const buffer = Buffer.concat([...calls.layer.flatMap(item => item.chunks)]);
        for await (const { meta, body } of readTarEntries(Readable.from([buffer]))) {
            const parts = []; for await (const p of body) parts.push(p);
            out[meta.name] = Buffer.concat(parts).toString();
        }
        return out;
    }

    test('读清单：只看文件开头，不是 manyoyo 文件或清单坏了会给出明确的错误', async () => {
        const manifest = await inspectArchiveHead(archive(MANIFEST(), []));
        expect(manifest.containers[0].name).toBe('box1');
        await expect(inspectArchiveHead(Buffer.from('hello world, not an archive'))).rejects.toThrow(/不是 manyoyo/);
        await expect(inspectArchiveHead(gz(tar([{ name: 'other.txt', content: 'x' }])))).rejects.toThrow(/第一条不是清单/);
        await expect(inspectArchiveHead(archive(MANIFEST({ format: 9 }), []))).rejects.toThrow(/不支持的导出格式/);
        await expect(inspectArchiveHead(archive(MANIFEST({ containers: [{ idx: 0, name: '../x' }] }), []))).rejects.toThrow(/容器名不合法/);
    });

    test('完整导入：改名后历史文件名、事件文件名、aggregateId 都对；图片、工作目录就位；挂载点 / 缓存 / 链接绕行的 layer 条目被丢弃；工作目录里指向外部的链接不创建', async () => {
        const { promise } = run(archive(MANIFEST(), goodEntries()));
        const result = await promise;
        expect(result.containers).toEqual(['box2']);
        expect(calls.created[0]).toMatchObject({ oldName: 'box1', newName: 'box2', hostPath: dest, imageMode: 'same' });
        expect(fs.existsSync(path.join(historyDir, 'box2.json'))).toBe(true);
        const events = fs.readFileSync(path.join(historyDir, 'events', 'box2.jsonl'), 'utf8');
        expect(JSON.parse(events.trim())).toMatchObject({ aggregateId: 'box2', sessionId: 'box2' });
        const agentEvents = fs.readFileSync(path.join(historyDir, 'events', `box2${encodeURIComponent('~')}agent-2.jsonl`), 'utf8');
        expect(JSON.parse(agentEvents.trim())).toMatchObject({ aggregateId: 'box2~agent-2' });
        expect(JSON.parse(fs.readFileSync(path.join(historyDir, 'projections', 'box2.json'), 'utf8')).aggregateId).toBe('box2');
        expect(fs.existsSync(path.join(historyDir, 'events', 'box1.jsonl'))).toBe(false);
        expect(fs.readFileSync(path.join(containerState.paths(home, 'cccccccccccccccc').box, 'uploads', 'a.png'), 'utf8')).toBe('PNG');
        expect(fs.readFileSync(path.join(dest, 'main.py'), 'utf8')).toBe('print(1)');
        expect(fs.readlinkSync(path.join(dest, 'ok'))).toBe('main.py');
        expect(fs.existsSync(path.join(dest, 'evil'))).toBe(false);
        expect(fs.readdirSync(outside)).toEqual([]);
        const layer = await layerEntries();
        expect(Object.keys(layer).sort()).toEqual(['root/.codex/sessions/s.jsonl', 'root/ln', 'usr/local/bin/mytool']);
        expect(layer['root/.codex/sessions/s.jsonl']).toBe('SESSION');
        expect(fs.existsSync(path.join(home, '.manyoyo', 'tmp', `import-${registry.list()[0].id}`))).toBe(false);
    });

    test('镜像不同（用本机默认版本）：系统层改动被跳过，Agent 记录照常', async () => {
        const { promise } = run(archive(MANIFEST(), goodEntries()), {}, { runtime: { ...deps.runtime, inspect: () => ({ mounts: ['/workspace'], image: 'img:2' }) } });
        await promise;
        const layer = await layerEntries();
        expect(layer['root/.codex/sessions/s.jsonl']).toBe('SESSION');
        expect(layer['usr/local/bin/mytool']).toBeUndefined();
    });

    test('截断的归档：报错，新建的容器、目录、历史文件、临时目录全部撤销', async () => {
        const full = archive(MANIFEST(), goodEntries());
        for (const cut of [0.5, 0.8, 0.95]) {
            const { promise } = run(full.subarray(0, Math.floor(full.length * cut)));
            await expect(promise).rejects.toThrow();
        }
        expectNothingLeft();
    });

    test('缺 END.json、条目数对不上、结束标记后还有内容：整体撤销', async () => {
        const noEnd = gz(tar([{ name: 'manifest.json', content: JSON.stringify(MANIFEST()) }, ...goodEntries()]));
        await expect(run(noEnd).promise).rejects.toThrow(/不完整|结束标记/);
        await expect(run(archive(MANIFEST(), goodEntries(), { endOverride: 3 })).promise).rejects.toThrow(/条目数/);
        expectNothingLeft();
        expect(calls.removed.length).toBeGreaterThan(0);
    });

    test.each([
        ['绝对路径', { name: '/etc/passwd', content: 'x' }],
        ['../ 逃逸', { name: 'c/0/../../../outside/pwn', content: 'x' }],
        ['a/../../ 逃逸', { name: 'w/0/a/../../../../outside/pwn', content: 'x' }],
        ['不认识的路径', { name: 'evil/file', content: 'x' }],
        ['清单没列出的容器', { name: 'c/7/history.json', content: '{}' }]
    ])('恶意归档：%s → 拒绝，宿主机哨兵目录没有新文件，已建的东西撤销', async (label, bad) => {
        const entries = [goodEntries()[0], bad, ...goodEntries().slice(1)];
        await expect(run(archive(MANIFEST(), entries), {}, {}).promise).rejects.toThrow();
        expectNothingLeft();
    });

    test('硬链接、设备文件：拒绝', async () => {
        for (const typeflag of ['1', '3', '6']) {
            const header = Buffer.from(encodeEntryHeader({ name: 'w/0/h', type: 'file', size: 0 }));
            header[156] = typeflag.charCodeAt(0);
            header.fill(0x20, 148, 156);
            let sum = 0; for (let i = 0; i < 512; i++) sum += header[i];
            header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii'); header[154] = 0; header[155] = 0x20;
            const first = tar([{ name: 'manifest.json', content: JSON.stringify(MANIFEST()) }, goodEntries()[0]], { end: false });
            const buffer = gz(Buffer.concat([first, header, END_BLOCKS]));
            await expect(run(buffer).promise).rejects.toThrow(/不允许的条目类型/);
        }
        expectNothingLeft();
    });

    test('先符号链接 w/0/a -> 外部目录，再写 w/0/a/x：落在工作目录内的真实目录，外部没有文件', async () => {
        const entries = [goodEntries()[0], { name: 'w/0/a', type: 'symlink', linkname: outside }, { name: 'w/0/a/x', content: 'payload' }];
        await run(archive(MANIFEST(), entries)).promise;
        expect(fs.readdirSync(outside)).toEqual([]);
        expect(fs.readFileSync(path.join(dest, 'a', 'x'), 'utf8')).toBe('payload');
    });

    test('工作目录已存在且不为空：拒绝，不动已有内容', async () => {
        fs.mkdirSync(dest);
        fs.writeFileSync(path.join(dest, 'mine.txt'), 'keep');
        await expect(run(archive(MANIFEST(), goodEntries())).promise).rejects.toThrow(/已存在且不为空/);
        expect(fs.readFileSync(path.join(dest, 'mine.txt'), 'utf8')).toBe('keep');
        expect(fs.readdirSync(dest)).toEqual(['mine.txt']);
    });

    test('两个不同的工作目录导入到同一个位置：拒绝（会互相覆盖）；建容器中途失败：已建出来的容器也要撤销', async () => {
        const manifest = MANIFEST({
            containers: [
                { idx: 0, name: 'box1', image: 'img:1', containerPath: '/w', hostPath: '/old', work: 0 },
                { idx: 1, name: 'box3', image: 'img:1', containerPath: '/w2', hostPath: '/old2', work: 1 }
            ],
            workdirs: [{ n: 0 }, { n: 1 }]
        });
        const entries = [{ name: 'c/0/history.json', content: '{}' }, { name: 'c/0/layer/root/.codex/sessions/a.jsonl', content: 'x' }, { name: 'c/1/history.json', content: '{}' }, { name: 'c/1/layer/root/.codex/sessions/b.jsonl', content: 'y' }];
        const job = registry.create({ type: 'import', containers: ['box2', 'box4'] });
        await expect(importArchive({
            source: Readable.from([archive(manifest, entries)]),
            plan: { containers: { 0: { name: 'box2', hostPath: dest, imageMode: 'same', confirm: {} }, 1: { name: 'box4', hostPath: dest, imageMode: 'same', confirm: {} } } },
            deps, job
        })).rejects.toThrow(/同一个位置/);
        expect(calls.removed.map(x => x[0])).toContain('box2');
        expectNothingLeft();

        // 建容器时抛错，但容器已经建出来（onCreated 已回调）：撤销时要把它删掉
        const failing = { ...deps, createContainer: async args => { args.onCreated('box2', 'cccccccccccccccc'); throw new Error('建容器后续步骤失败'); } };
        const job2 = registry.create({ type: 'import', containers: ['box2'] });
        await expect(importArchive({ source: Readable.from([archive(MANIFEST(), goodEntries())]), plan: planOf(), deps: failing, job: job2 })).rejects.toThrow(/后续步骤失败/);
        expect(calls.removed.some(x => x[0] === 'box2' && x[1] === 'cccccccccccccccc')).toBe(true);
        expectNothingLeft();
    });

    test('取消：任务被取消时整体撤销', async () => {
        const job = registry.create({ type: 'import', containers: ['box2'] });
        let n = 0;
        const origCheck = job.check;
        job.check = () => { if (++n > 6) { job.cancelRequested = true; } return origCheck.call(job); };
        await expect(importArchive({ source: Readable.from([archive(MANIFEST(), goodEntries())]), plan: planOf(), deps, job })).rejects.toThrow(JobCancelled);
        expectNothingLeft();
    });

    test('导出再导入的往返（真实 export 产物）', async () => {
        const work = path.join(home, 'work');
        fs.mkdirSync(work);
        fs.writeFileSync(path.join(work, 'f.txt'), 'round');
        const state = containerState.createState({ homeDir: home, id: 'aaaaaaaaaaaaaaaa', envLines: ['K=v'] });
        fs.mkdirSync(path.join(state.box, 'uploads'));
        fs.writeFileSync(path.join(state.box, 'uploads', 'u.png'), 'IMG');
        const chunks = [];
        const sink = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
        const history = { containerName: 'box1', remark: 'r', applied: { hostPath: work, containerPath: '/workspace' }, runtimeSnapshot: { hostPath: work, containerPath: '/workspace', env: {} }, agents: {} };
        const runtime = {
            inspect: () => ({ id: 'aaaaaaaaaaaaaaaa', image: 'img:1', status: 'stopped', mounts: ['/workspace'] }),
            pause() {}, unpause() {}, diff: () => '',
            cp: () => ({ stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve({ code: 1, stderr: 'no such file' }) })
        };
        await exportArchive({ out: sink, containers: [{ name: 'box1' }], items: ['history', 'settings', 'uploads', 'workdir'], includeSecrets: true, compression: 'fast', deps: { homeDir: home, webHistoryDir: historyDir, runtime, containerState, version: 't', loadHistory: () => history } });
        const { promise } = run(Buffer.concat(chunks));
        await promise;
        expect(fs.readFileSync(path.join(dest, 'f.txt'), 'utf8')).toBe('round');
        expect(JSON.parse(fs.readFileSync(path.join(historyDir, 'box2.json'), 'utf8')).remark).toBe('r');
        expect(calls.created[0].stateFiles.env).toContain('K=v');
    });

    describe('源容器里删掉的系统层文件（layer-deleted.json）', () => {
        const withDeleted = list => [
            { name: 'c/0/history.json', content: JSON.stringify({ containerName: 'box1', agents: {} }) },
            { name: 'c/0/layer/usr/local/bin/mytool', content: 'BIN' },
            { name: 'c/0/layer/usr/lib/lnk', type: 'symlink', linkname: '/usr/lib/real' },
            { name: 'c/0/layer-deleted.json', content: JSON.stringify(list) },
            { name: 'w/0', type: 'dir' }
        ];

        test('镜像相同时按路径过滤后应用：只认系统层、挂载点下的、临时目录、经过归档里符号链接的、相对路径一律不删', async () => {
            const applied = [];
            const list = ['/etc/issue', '/usr/share/old', '/workspace/secret', '/tmp/x', '/root/.cache/y', '/usr/lib/lnk/inside', '../etc/shadow', 'etc/relative', '/proc/1', '/'];
            const { promise } = run(archive(MANIFEST(), withDeleted(list)), {}, { applyDeleted: async (name, paths) => { applied.push({ name, paths }); } });
            const result = await promise;
            expect(applied).toEqual([{ name: 'box2', paths: ['/etc/issue', '/usr/share/old'] }]);
            expect(result.details[0].dropped).toEqual([]);
        });

        test('归档来自别人：系统目录本身和账号 / 动态链接配置一律不删（/usr、/usr/bin、/etc/passwd、/usr/local 这类），深一层的才放行', async () => {
            const applied = [];
            const list = ['/usr', '/bin', '/etc', '/usr/bin', '/usr/local', '/var/lib', '/etc/passwd', '/etc/shadow', '/etc/apt', '/etc/issue', '/opt/old-tool', '/usr/local/bin/old', '/var/lib/dpkg/info/x'];
            const { promise } = run(archive(MANIFEST(), withDeleted(list)), {}, { applyDeleted: async (name, paths) => { applied.push(...paths); } });
            await promise;
            expect(applied).toEqual(['/etc/issue', '/opt/old-tool', '/usr/local/bin/old', '/var/lib/dpkg/info/x']);
        });

        test('镜像不同（用了默认镜像）不应用；应用失败不让导入失败，记进“没能还原”', async () => {
            const applied = [];
            const other = run(archive(MANIFEST(), withDeleted(['/etc/issue'])), {}, { runtime: { ...deps.runtime, inspect: () => ({ mounts: [], image: 'other:2' }) }, applyDeleted: async (...a) => { applied.push(a); } });
            await other.promise;
            expect(applied).toEqual([]);
            fs.rmSync(dest, { recursive: true, force: true });
            const failing = run(archive(MANIFEST(), withDeleted(['/etc/issue'])), { name: 'box3' }, { applyDeleted: async () => { throw new Error('exec 失败'); } });
            const result = await failing.promise;
            expect(result.details[0].dropped.join('|')).toContain('没能还原');
        });
    });

    test('导入结果里每个容器带着没能还原的东西：未确认的风险项、用了默认镜像时跳过的系统层', async () => {
        deps.createContainer = async args => {
            const state = containerState.createState({ homeDir: home, id: 'cccccccccccccccc', envLines: [] });
            return { containerName: args.newName, id: 'cccccccccccccccc', paths: state, dropped: ['挂载 /a:/b 未确认'] };
        };
        const buf = archive(MANIFEST(), [
            { name: 'c/0/history.json', content: JSON.stringify({ containerName: 'box1', agents: {} }) },
            { name: 'c/0/layer/usr/local/bin/mytool', content: 'BIN' },
            { name: 'c/0/layer/usr/local/bin/other', content: 'BIN2' },
            { name: 'w/0', type: 'dir' }
        ]);
        const { promise } = run(buf, {}, { runtime: { ...deps.runtime, inspect: () => ({ mounts: [], image: 'localhost/xcanwin/manyoyo:2.3.1-common' }) } });
        const result = await promise;
        expect(result.details).toEqual([expect.objectContaining({ name: 'box2', oldName: 'box1', dropped: ['挂载 /a:/b 未确认'], layerSkippedSystem: 2, sameImage: false, imageUsed: 'localhost/xcanwin/manyoyo:2.3.1-common' })]);
        expect(result.containers).toEqual(['box2']);
    });

    test('请求体收完（归档完整）时先通知上传请求可以答复，收尾（写进容器、放置工作目录）还在后面', async () => {
        const order = [];
        const buf = archive(MANIFEST(), goodEntries());
        const job = registry.create({ type: 'import', containers: ['box2'] });
        const result = await importArchive({
            source: Readable.from([buf]), plan: planOf(), job, deps,
            onBodyComplete: () => order.push(`body-complete(workdir-placed=${fs.existsSync(path.join(dest, 'main.py'))})`)
        });
        // 工作目录是请求体收完之后才放到位的
        expect(order).toEqual(['body-complete(workdir-placed=false)']);
        expect(fs.readFileSync(path.join(dest, 'main.py'), 'utf8')).toBe('print(1)');
        expect(result.containers).toEqual(['box2']);
        // 归档不完整时不会通知
        const never = [];
        const cut = registry.create({ type: 'import', containers: ['box3'] });
        fs.rmSync(dest, { recursive: true, force: true });
        await expect(importArchive({ source: Readable.from([buf.subarray(0, buf.length - 40)]), plan: planOf({ name: 'box3' }), job: cut, deps, onBodyComplete: () => never.push(1) })).rejects.toThrow();
        expect(never).toEqual([]);
    });

    test('容器层条目的属主 / 权限写回时原样带上', async () => {
        const buf = archive(MANIFEST(), [
            { name: 'c/0/history.json', content: JSON.stringify({ containerName: 'box1', agents: {} }) },
            { name: 'c/0/layer/usr/local/bin/mytool', content: 'BIN', mode: 0o755, uid: 1001, gid: 1002 },
            { name: 'w/0', type: 'dir' }
        ]);
        await run(buf).promise;
        const raw = Buffer.concat(calls.layer.flatMap(item => item.chunks));
        let seen = null;
        for await (const { meta, body } of readTarEntries(Readable.from([raw]))) { for await (const p of body) void p; if (meta.name === 'usr/local/bin/mytool') seen = meta; }
        expect(seen).toMatchObject({ uid: 1001, gid: 1002, mode: 0o755 });
    });
});
