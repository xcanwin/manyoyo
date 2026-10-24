const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('../lib/web/storage');

function setup() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-storage-'));
    const workRoot = path.join(home, 'work');
    const historyDir = path.join(home, 'web-history');
    fs.mkdirSync(workRoot, { recursive: true });
    fs.mkdirSync(path.join(historyDir, 'events'), { recursive: true });
    return { home, workRoot, historyDir };
}

function writeHistory(historyDir, name, hostPath) {
    fs.writeFileSync(path.join(historyDir, `${name}.json`), JSON.stringify({ applied: { hostPath } }));
}

// 假运行时：containers = { 名字: { state, mounts } }
function fakeDocker(containers, fail = false) {
    return async args => {
        if (fail) throw new Error('daemon down');
        if (args[0] === 'ps') return Object.entries(containers).map(([name, item]) => `${name}\t${item.state}`).join('\n');
        if (args[0] === 'inspect') {
            return args.slice(3).map(name => `/${name}${containers[name].mounts.map(mount => `\t${mount}`).join('')}`).join('\n');
        }
        return '';
    };
}

describe('web storage', () => {
    test('按宿主机目录一行：使用中 / 仅剩历史 / 无人使用', async () => {
        const { workRoot, historyDir } = setup();
        const used = path.join(workRoot, 'a');
        const gone = path.join(workRoot, 'b');
        const orphan = path.join(workRoot, 'c');
        [used, gone, orphan].forEach(dir => fs.mkdirSync(dir));
        writeHistory(historyDir, 'live-1', used);
        writeHistory(historyDir, 'dead-1', gone);
        const listing = await storage.buildStorageListing({
            workRoot,
            historyDir,
            dockerExecAsync: fakeDocker({ 'live-1': { state: 'running', mounts: [used] } })
        });
        const byPath = Object.fromEntries(listing.rows.map(row => [path.basename(row.path), row]));
        expect(byPath.a.status).toBe('in-use');
        expect(byPath.a.deletable).toBe(false);
        expect(byPath.b.status).toBe('history-only');
        expect(byPath.b.sessions).toEqual([{ name: 'dead-1', state: 'deleted' }]);
        expect(byPath.b.deletable).toBe(true);
        expect(byPath.c.status).toBe('unused');
        expect(listing.deletedHistories.map(item => item.name)).toEqual(['dead-1']);
    });

    test('没有历史的容器靠挂载关系判定在用，挂载上级目录也算', async () => {
        const { workRoot, historyDir } = setup();
        const dir = path.join(workRoot, 'cli');
        fs.mkdirSync(dir);
        const listing = await storage.buildStorageListing({
            workRoot,
            historyDir,
            dockerExecAsync: fakeDocker({ 'cli-box': { state: 'exited', mounts: [workRoot] } })
        });
        expect(listing.rows[0].status).toBe('in-use');
        expect(listing.rows[0].deletable).toBe(false);
    });

    test('同一目录被多个会话引用，只要有一个容器在就不可删', async () => {
        const { workRoot, historyDir } = setup();
        const dir = path.join(workRoot, 'shared');
        fs.mkdirSync(dir);
        writeHistory(historyDir, 'one', dir);
        writeHistory(historyDir, 'two', dir);
        const listing = await storage.buildStorageListing({
            workRoot,
            historyDir,
            dockerExecAsync: fakeDocker({ two: { state: 'exited', mounts: [] } })
        });
        expect(listing.rows).toHaveLength(1);
        expect(listing.rows[0].sessions.map(item => `${item.name}:${item.state}`)).toEqual(['one:deleted', 'two:stopped']);
        expect(listing.rows[0].deletable).toBe(false);
    });

    test('用户自己的项目目录只展示，不可删', async () => {
        const { home, workRoot, historyDir } = setup();
        const project = path.join(home, 'project');
        fs.mkdirSync(project);
        writeHistory(historyDir, 'gone', project);
        const listing = await storage.buildStorageListing({ workRoot, historyDir, dockerExecAsync: fakeDocker({}) });
        expect(listing.rows[0].managed).toBe(false);
        expect(listing.rows[0].deletable).toBe(false);
        const removed = await storage.removeManagedDirectory(listing, listing.rows[0].path);
        expect(removed).toMatchObject({ ok: false, status: 409 });
        expect(fs.existsSync(project)).toBe(true);
    });

    test('运行时不可用时列表抛错，不会把所有目录当成没人用', async () => {
        const { workRoot, historyDir } = setup();
        await expect(storage.buildStorageListing({ workRoot, historyDir, dockerExecAsync: fakeDocker({}, true) })).rejects.toThrow('daemon down');
    });

    test('删除只作用于列表里的无人使用目录', async () => {
        const { workRoot, historyDir } = setup();
        const dir = path.join(workRoot, 'x');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'hello');
        const listing = await storage.buildStorageListing({ workRoot, historyDir, dockerExecAsync: fakeDocker({}) });
        expect(await storage.removeManagedDirectory(listing, path.join(workRoot, '..'))).toMatchObject({ ok: false, status: 404 });
        expect(await storage.removeManagedDirectory(listing, listing.rows[0].path)).toEqual({ ok: true });
        expect(fs.existsSync(dir)).toBe(false);
    });

    test('清理已删除容器的历史：json 与事件日志一起删，容器还在的拒绝', async () => {
        const { workRoot, historyDir } = setup();
        writeHistory(historyDir, 'dead', '');
        writeHistory(historyDir, 'alive', '');
        fs.writeFileSync(path.join(historyDir, 'events', 'dead.jsonl'), '{}\n');
        fs.writeFileSync(path.join(historyDir, 'events', 'dead~agent-2.jsonl'), '{}\n');
        fs.writeFileSync(path.join(historyDir, 'events', 'dead-other.jsonl'), '{}\n');
        const listing = await storage.buildStorageListing({
            workRoot,
            historyDir,
            dockerExecAsync: fakeDocker({ alive: { state: 'running', mounts: [] } })
        });
        const removeFile = name => fs.rmSync(path.join(historyDir, `${name}.json`), { force: true });
        expect(await storage.removeDeletedHistory(historyDir, listing, 'alive', removeFile)).toMatchObject({ ok: false, status: 404 });
        expect(await storage.removeDeletedHistory(historyDir, listing, 'dead', removeFile)).toEqual({ ok: true });
        expect(fs.readdirSync(path.join(historyDir, 'events'))).toEqual(['dead-other.jsonl']);
        expect(fs.existsSync(path.join(historyDir, 'alive.json'))).toBe(true);
    });

    test('查看目录内容：挡住 .. 和符号链接逃逸', async () => {
        const { home, workRoot } = setup();
        const dir = path.join(workRoot, 'x');
        fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'a.txt'), 'abc');
        fs.mkdirSync(path.join(home, 'secret'));
        fs.symlinkSync(path.join(home, 'secret'), path.join(dir, 'escape'));
        const top = await storage.listDirectory(dir, '');
        expect(top.entries.map(item => `${item.type}:${item.name}`)).toEqual(['dir:sub', 'file:a.txt', 'link:escape']);
        expect(await storage.listDirectory(dir, '..')).toMatchObject({ ok: false, status: 400 });
        expect(await storage.listDirectory(dir, 'escape')).toMatchObject({ ok: false, status: 400 });
    });

    test('目录体积用 du 的真实占用', async () => {
        const { workRoot } = setup();
        const dir = path.join(workRoot, 'big');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'f'), Buffer.alloc(300 * 1024));
        const size = await storage.directorySize(dir);
        expect(size.bytes).toBeGreaterThanOrEqual(300 * 1024);
    });
});
