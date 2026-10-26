'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable, Writable } = require('stream');
const { execFileSync } = require('child_process');
const { encodeEntryHeader, readTarEntries, END_BLOCKS, pad } = require('../lib/archive/tar');
const { exportArchive, addHostTree, TarWriter, zstdAvailable } = require('../lib/archive/export');
const containerState = require('../lib/container-state');

function tarOf(entries) {
    const parts = [];
    for (const e of entries) {
        const body = Buffer.from(e.content || '');
        parts.push(encodeEntryHeader({ name: e.name, type: e.type || 'file', size: body.length, linkname: e.linkname }), body, Buffer.alloc(pad(body.length)));
    }
    parts.push(END_BLOCKS);
    return Buffer.concat(parts);
}

function collectingSink() {
    const chunks = [];
    const sink = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
    return { sink, buffer: () => Buffer.concat(chunks) };
}

async function readArchive(buffer) {
    const raw = zstdAvailable() ? zlib.zstdDecompressSync(buffer) : zlib.gunzipSync(buffer);
    const out = {};
    for await (const { meta, body } of readTarEntries(Readable.from([raw]))) {
        const parts = [];
        for await (const piece of body) parts.push(piece);
        out[meta.name] = { type: meta.type, content: Buffer.concat(parts).toString(), linkname: meta.linkname };
    }
    return out;
}

describe('lib/archive/export 宿主机遍历', () => {
    let base;
    beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-exp-')); });
    afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

    async function walk(root, hooks) {
        const { sink, buffer } = collectingSink();
        const writer = new TarWriter(sink);
        const stats = {};
        await addHostTree(writer, root, 'w/0', stats, hooks);
        await writer.finish();
        const entries = {};
        for await (const { meta, body } of readTarEntries(Readable.from([buffer()]))) {
            const parts = [];
            for await (const piece of body) parts.push(piece);
            entries[meta.name] = { type: meta.type, content: Buffer.concat(parts).toString(), linkname: meta.linkname };
        }
        return { entries, stats };
    }

    test('符号链接按链接本身存、哨兵内容不在归档里；FIFO 不卡住（5 秒内完成）', async () => {
        const work = path.join(base, 'work');
        fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(work, 'a.txt'), 'hello');
        fs.writeFileSync(path.join(base, 'sentinel.txt'), 'TOP-SECRET-SENTINEL');
        fs.symlinkSync(path.join(base, 'sentinel.txt'), path.join(work, 'link'));
        fs.symlinkSync(base, path.join(work, 'dirlink'));
        execFileSync('mkfifo', [path.join(work, 'sub', 'pipe')]);
        const started = Date.now();
        const { entries, stats } = await walk(work);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(entries['w/0/a.txt'].content).toBe('hello');
        expect(entries['w/0/link']).toMatchObject({ type: 'symlink', linkname: path.join(base, 'sentinel.txt') });
        expect(entries['w/0/dirlink'].type).toBe('symlink');
        expect(JSON.stringify(entries)).not.toContain('TOP-SECRET-SENTINEL');
        expect(entries['w/0/sub/pipe']).toBeUndefined();
        expect(stats.skippedSpecial).toBe(1);
    });

    test('子目录在另一个文件系统（st_dev 不同）时不进入', async () => {
        const work = path.join(base, 'work');
        fs.mkdirSync(path.join(work, 'mnt'), { recursive: true });
        fs.writeFileSync(path.join(work, 'mnt', 'inside.txt'), 'other-fs');
        fs.writeFileSync(path.join(work, 'ok.txt'), 'ok');
        const mntPath = path.join(work, 'mnt');
        const lstat = p => {
            const st = fs.lstatSync(p);
            return p === mntPath ? Object.create(st, { dev: { value: st.dev + 1 } }) : st;
        };
        const { entries, stats } = await walk(work, { lstat });
        expect(entries['w/0/ok.txt']).toBeTruthy();
        expect(entries['w/0/mnt/inside.txt']).toBeUndefined();
        expect(stats.skippedOtherFs).toBe(1);
    });
});

describe('lib/archive/export 整体', () => {
    let home;
    let historyDir;
    let work;
    let sentinel;
    const ID = 'aaaaaaaaaaaaaaaa';
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-exp-home-'));
        historyDir = path.join(home, '.manyoyo', 'web-history');
        work = path.join(home, 'work');
        fs.mkdirSync(path.join(historyDir, 'events'), { recursive: true });
        fs.mkdirSync(path.join(historyDir, 'projections'), { recursive: true });
        fs.mkdirSync(work, { recursive: true });
        fs.writeFileSync(path.join(work, 'main.py'), 'print(1)');
        sentinel = path.join(home, 'sentinel.txt');
        fs.writeFileSync(sentinel, 'SENTINEL-DATA');
        fs.symlinkSync(sentinel, path.join(work, 'evil'));
        const state = containerState.createState({ homeDir: home, id: ID, envLines: ['ANTHROPIC_AUTH_TOKEN=sk-secret-1234', 'ANTHROPIC_MODEL=m'], autostart: 'API_KEY=sk-inline-secret echo hi' });
        fs.mkdirSync(path.join(state.box, 'uploads'));
        fs.writeFileSync(path.join(state.box, 'uploads', 'a.png'), 'PNG');
        fs.writeFileSync(path.join(historyDir, 'box1.json'), '{}');
        fs.writeFileSync(path.join(historyDir, 'events', 'box1.jsonl'), '{"seq":1}\n');
        fs.writeFileSync(path.join(historyDir, 'events', `box1${encodeURIComponent('~')}agent-2.jsonl`), '{"seq":1}\n');
        fs.writeFileSync(path.join(historyDir, 'events', 'box10.jsonl'), 'other container');
    });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

    function fakeRuntime(over = {}) {
        const calls = { pause: [], unpause: [], cp: [] };
        const diff = over.diff || [
            'A /usr/local/bin/mytool', 'A /root/.codex/sessions/s.jsonl', 'A /root/.codex/.tmp/big', 'A /root/.codex/skills/x.md',
            'A /root/.claude/projects/p/abc.jsonl', 'A /tmp/junk', 'A /workspace/in-mount', 'D /etc/old.conf',
            'A /root/.codex/auth.json', 'A /root/.claude/.credentials.json'
        ].join('\n');
        const trees = {
            '/usr/local': [{ name: 'local', type: 'dir' }, { name: 'local/bin/mytool', content: 'BIN' }, { name: 'local/bin/not-in-diff', content: 'IMAGE-FILE' }],
            '/root/.codex': [{ name: '.codex/sessions/s.jsonl', content: 'SESSION' }, { name: '.codex/.tmp/big', content: 'CACHE' }, { name: '.codex/skills/x.md', content: 'SKILL' }, { name: '.codex/image-own', content: 'FROM-IMAGE' }, { name: '.codex/auth.json', content: 'OAUTH-REFRESH-TOKEN' }],
            '/root/.claude/projects': [{ name: 'projects/p/abc.jsonl', content: 'CLAUDE-SESSION' }],
            '/root/.claude': [{ name: '.claude/projects/p/abc.jsonl', content: 'CLAUDE-SESSION' }, { name: '.claude/.credentials.json', content: 'OAUTH-CLAUDE' }],
            '/workspace': [{ name: 'workspace/in-mount', content: 'MOUNTED' }],
            '/workspace/in-mount': [{ name: 'in-mount', content: 'MOUNTED' }]
        };
        return {
            calls,
            inspect: () => ({ id: ID, image: 'img:1', status: over.status || 'running', mounts: ['/workspace', '/run/manyoyo'] }),
            pause: name => calls.pause.push(name),
            unpause: name => calls.unpause.push(name),
            diff: () => diff,
            cp: (name, scope) => {
                calls.cp.push(scope);
                const entries = trees[scope];
                if (!entries) return { stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve({ code: 1, stderr: 'no such file' }) };
                return { stream: Readable.from([tarOf(entries)]), done: Promise.resolve({ code: 0, stderr: '' }) };
            }
        };
    }

    async function doExport(items, extra = {}) {
        const runtime = extra.runtime || fakeRuntime();
        const { sink, buffer } = collectingSink();
        const history = { containerName: 'box1', remark: '备注', applied: { hostPath: work, containerPath: '/workspace' }, runtimeSnapshot: { hostPath: work, containerPath: '/workspace', agentPromptCommand: 'ANTHROPIC_AUTH_TOKEN=sk-cmd-secret claude -p {prompt}', env: { ANTHROPIC_AUTH_TOKEN: 'sk-secret-1234', ANTHROPIC_MODEL: 'm' } }, agents: {} };
        const result = await exportArchive({
            out: sink,
            containers: [{ name: 'box1' }],
            items,
            includeSecrets: extra.includeSecrets !== false,
            compression: 'fast',
            deps: { homeDir: home, webHistoryDir: historyDir, runtime, containerState, version: 'test', loadHistory: () => history },
            hooks: extra.hooks
        });
        return { entries: await readArchive(buffer()), runtime, result };
    }

    test('完整档：只带 diff 里的、范围内的、非缓存、非挂载点的内容；哨兵与 FIFO 不在里面', async () => {
        const { entries } = await doExport(['history', 'agentSessions', 'settings', 'uploads', 'agentExtras', 'workdir', 'systemLayer']);
        const names = Object.keys(entries);
        expect(names[0]).toBe('manifest.json');
        expect(names[names.length - 1]).toBe('END.json');
        expect(entries['c/0/layer/usr/local/bin/mytool'].content).toBe('BIN');
        expect(entries['c/0/layer/root/.codex/sessions/s.jsonl'].content).toBe('SESSION');
        expect(entries['c/0/layer/root/.codex/skills/x.md'].content).toBe('SKILL');
        expect(entries['c/0/layer/root/.claude/projects/p/abc.jsonl'].content).toBe('CLAUDE-SESSION');
        // 过滤：不在 diff 里（镜像自带）、缓存、挂载点
        expect(names.some(n => n.includes('not-in-diff'))).toBe(false);
        expect(names.some(n => n.includes('image-own'))).toBe(false);
        expect(names.some(n => n.includes('.codex/.tmp'))).toBe(false);
        expect(names.some(n => n.includes('in-mount'))).toBe(false);
        expect(JSON.parse(entries['c/0/layer-deleted.json'].content)).toEqual(['/etc/old.conf']);
        // 宿主机侧
        expect(entries['w/0/main.py'].content).toBe('print(1)');
        expect(entries['w/0/evil'].type).toBe('symlink');
        expect(JSON.stringify(entries)).not.toContain('SENTINEL-DATA');
        expect(entries['c/0/box/uploads/a.png'].content).toBe('PNG');
        expect(entries['c/0/events/box1.jsonl']).toBeTruthy();
        expect(entries[`c/0/events/box1${encodeURIComponent('~')}agent-2.jsonl`]).toBeTruthy();
        expect(names.some(n => n.includes('box10'))).toBe(false);
    });

    test('轻量档：只有聊天记录、会话记录、设置；没有 Agent 其余改动、系统层、图片、工作目录', async () => {
        const { entries } = await doExport(['history', 'agentSessions', 'settings']);
        const names = Object.keys(entries);
        expect(names).toContain('c/0/history.json');
        expect(names).toContain('c/0/layer/root/.codex/sessions/s.jsonl');
        expect(names).toContain('c/0/state/env');
        expect(names.some(n => n.includes('skills/x.md'))).toBe(false);
        expect(names.some(n => n.includes('mytool'))).toBe(false);
        expect(names.some(n => n.startsWith('w/'))).toBe(false);
        expect(names.some(n => n.includes('uploads'))).toBe(false);
        expect(names.some(n => n.includes('layer-deleted'))).toBe(false);
    });

    test('不含密钥：历史快照与 box/env 里名字含 KEY/TOKEN 的值被清空，其它保留', async () => {
        const { entries } = await doExport(['history', 'settings'], { includeSecrets: false });
        expect(entries['c/0/state/env'].content).not.toContain('sk-secret-1234');
        expect(entries['c/0/state/env'].content).toContain('ANTHROPIC_MODEL=m');
        const history = JSON.parse(entries['c/0/history.json'].content);
        expect(history.runtimeSnapshot.env.ANTHROPIC_AUTH_TOKEN).toBe('');
        expect(history.runtimeSnapshot.env.ANTHROPIC_MODEL).toBe('m');
        const withSecrets = await doExport(['history', 'settings'], { includeSecrets: true });
        expect(withSecrets.entries['c/0/state/env'].content).toContain('sk-secret-1234');
    });

    test('运行中的容器导出期间暂停、结束后恢复；已停止的不动；出错也恢复', async () => {
        const running = await doExport(['history', 'agentSessions']);
        expect(running.runtime.calls.pause).toEqual(['box1']);
        expect(running.runtime.calls.unpause).toEqual(['box1']);
        const stopped = await doExport(['history', 'agentSessions'], { runtime: fakeRuntime({ status: 'stopped' }) });
        expect(stopped.runtime.calls.pause).toEqual([]);

        const broken = fakeRuntime();
        broken.cp = () => { throw new Error('boom'); };
        await expect(doExport(['history', 'agentSessions'], { runtime: broken })).rejects.toThrow('boom');
        expect(broken.calls.unpause).toEqual(['box1']);
    });

    test('暂停不可用时退回“停止 → 导出 → 启动”，并在任务记录里标明是 stop', async () => {
        const runtime = fakeRuntime();
        runtime.pause = () => { throw new Error('cgroup 不支持暂停'); };
        runtime.calls.stop = [];
        runtime.calls.start = [];
        runtime.stop = name => runtime.calls.stop.push(name);
        runtime.start = name => runtime.calls.start.push(name);
        const how = [];
        await doExport(['history', 'agentSessions'], { runtime, hooks: { onPause: (name, info, h) => how.push(h) } });
        expect(runtime.calls.stop).toEqual(['box1']);
        expect(runtime.calls.start).toEqual(['box1']);
        expect(runtime.calls.unpause).toEqual([]);
        expect(how).toEqual(['pause', 'stop']);
    });

    test('暂停后读不到容器文件：立刻恢复运行，改成不暂停直接读，数据照样带全', async () => {
        const runtime = fakeRuntime();
        runtime.canRead = () => false;
        const { entries, result } = await doExport(['history', 'agentSessions'], { runtime });
        expect(runtime.calls.pause).toEqual(['box1']);
        expect(runtime.calls.unpause).toEqual(['box1']);
        expect(result.stats.pauseUnusable).toBe(1);
        expect(entries['c/0/layer/root/.codex/sessions/s.jsonl'].content).toBe('SESSION');
    });

    test('取消：check 抛错时中止并恢复暂停', async () => {
        let n = 0;
        const runtime = fakeRuntime();
        await expect(doExport(['history', 'agentSessions'], { runtime, hooks: { check: () => { if (++n > 5) throw new Error('已取消'); } } })).rejects.toThrow('已取消');
        expect(runtime.calls.unpause).toEqual(['box1']);
    });
});
