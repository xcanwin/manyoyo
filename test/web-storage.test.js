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
        const used = path.join(workRoot, '20261001-000001');
        const gone = path.join(workRoot, '20261001-000002');
        const orphan = path.join(workRoot, '20261001-000003');
        [used, gone, orphan].forEach(dir => fs.mkdirSync(dir));
        writeHistory(historyDir, 'live-1', used);
        writeHistory(historyDir, 'dead-1', gone);
        const listing = await storage.buildStorageListing({
            workRoots: [workRoot],
            historyDir,
            dockerExecAsync: fakeDocker({ 'live-1': { state: 'running', mounts: [used] } })
        });
        const byPath = Object.fromEntries(listing.rows.map(row => [path.basename(row.path), row]));
        expect(byPath['20261001-000001'].status).toBe('in-use');
        expect(byPath['20261001-000001'].deletable).toBe(false);
        expect(byPath['20261001-000002'].status).toBe('history-only');
        expect(byPath['20261001-000002'].sessions).toEqual([{ name: 'dead-1', state: 'deleted' }]);
        expect(byPath['20261001-000002'].deletable).toBe(true);
        expect(byPath['20261001-000003'].status).toBe('unused');
        expect(listing.deletedHistories.map(item => item.name)).toEqual(['dead-1']);
    });

    test('没有历史的容器靠挂载关系判定在用：挂了子目录算在用，挂了上级目录（如整个 /root）不算', async () => {
        const { workRoot, historyDir } = setup();
        const used = path.join(workRoot, '20261001-000004');
        const free = path.join(workRoot, '20261001-000005');
        fs.mkdirSync(path.join(used, 'inner'), { recursive: true });
        fs.mkdirSync(free);
        const listing = await storage.buildStorageListing({
            workRoots: [workRoot],
            historyDir,
            dockerExecAsync: fakeDocker({
                'cli-box': { state: 'exited', mounts: [path.join(used, 'inner')] },
                'whole-home': { state: 'running', mounts: [path.dirname(workRoot)] }
            })
        });
        const byName = Object.fromEntries(listing.rows.map(row => [path.basename(row.path), row]));
        expect(byName['20261001-000004']).toMatchObject({ status: 'in-use', deletable: false });
        expect(byName['20261001-000004'].sessions.map(item => item.name)).toEqual(['cli-box']);
        expect(byName['20261001-000005']).toMatchObject({ status: 'unused', deletable: true, sessions: [] });
    });

    test('默认工作目录里任何名字的子目录都算自己的（点开头的除外）', async () => {
        const { workRoot, historyDir } = setup();
        fs.mkdirSync(path.join(workRoot, 'temp1234'));
        fs.mkdirSync(path.join(workRoot, '.cache'));
        const listing = await storage.buildStorageListing({ workRoots: [workRoot], historyDir, dockerExecAsync: fakeDocker({}) });
        expect(listing.rows.map(row => path.basename(row.path))).toEqual(['temp1234']);
        expect(listing.rows[0]).toMatchObject({ managed: true, deletable: true });
    });

    test('快捷对话目录：历史里记过的时间戳目录才算自己的，名字不是时间戳的不算', async () => {
        const { home, workRoot, historyDir } = setup();
        const quick = path.join(home, 'manyoyo_work');
        fs.mkdirSync(path.join(quick, '20261001-000007'), { recursive: true });
        fs.mkdirSync(path.join(quick, '20261001-000008'));
        fs.mkdirSync(path.join(quick, 'my-notes'));
        writeHistory(historyDir, 'gone', path.join(quick, '20261001-000007'));
        const listing = await storage.buildStorageListing({ workRoots: [workRoot], extraWorkRoots: [quick], homeDir: home, historyDir, dockerExecAsync: fakeDocker({}) });
        const byName = Object.fromEntries(listing.rows.map(row => [path.basename(row.path), row]));
        expect(Object.keys(byName).sort()).toEqual(['20261001-000007', '20261001-000008']);
        expect(byName['20261001-000007']).toMatchObject({ managed: true, deletable: true });
        expect(byName['20261001-000008']).toMatchObject({ managed: false, deletable: false });
    });

    test('快捷对话目录里全是时间戳目录（专用目录）：没有历史记录的也算自己的，可删', async () => {
        const { home, workRoot, historyDir } = setup();
        const quick = path.join(home, 'manyoyo_work');
        fs.mkdirSync(path.join(quick, '20261001-000020'), { recursive: true });
        fs.mkdirSync(path.join(quick, '20261001-000021'));
        fs.writeFileSync(path.join(quick, '.DS_Store'), '');
        const listing = await storage.buildStorageListing({ workRoots: [workRoot], extraWorkRoots: [quick], homeDir: home, historyDir, dockerExecAsync: fakeDocker({}) });
        expect(listing.rows).toHaveLength(2);
        expect(listing.rows.every(row => row.managed && row.deletable)).toBe(true);
    });

    test('快捷对话目录配成 /、HOME、HOME 的上级或相对路径时忽略', async () => {
        const { home, workRoot, historyDir } = setup();
        fs.mkdirSync(path.join(home, '20261001-000009'));
        writeHistory(historyDir, 'gone', path.join(home, '20261001-000009'));
        const listing = await storage.buildStorageListing({
            workRoots: [workRoot],
            extraWorkRoots: [home, path.dirname(home), '/', 'relative/dir'],
            homeDir: home,
            historyDir,
            dockerExecAsync: fakeDocker({})
        });
        expect(listing.rows.every(row => !row.managed)).toBe(true);
    });

    test('容器还在时历史路径也算在用：挂载写法对不上（如 /private/var 与 /var）时不能判成可删', async () => {
        const { workRoot, historyDir } = setup();
        const dir = path.join(workRoot, '20261001-000010');
        fs.mkdirSync(dir);
        writeHistory(historyDir, 'same-name', dir);
        const listing = await storage.buildStorageListing({
            workRoots: [workRoot],
            historyDir,
            dockerExecAsync: fakeDocker({ 'same-name': { state: 'exited', mounts: ['/nonexistent/other/spelling'] } })
        });
        expect(listing.rows[0]).toMatchObject({ status: 'in-use', deletable: false });
        expect(listing.rows[0].sessions.map(item => item.name)).toEqual(['same-name']);
    });

    test('配置里写死的 hostPath（全局 / runs）指向的目录不可删，没有容器也一样', async () => {
        const { workRoot, historyDir } = setup();
        const fixed = path.join(workRoot, '20261001-000050');
        const inner = path.join(workRoot, '20261001-000051');
        const free = path.join(workRoot, '20261001-000052');
        fs.mkdirSync(fixed);
        fs.mkdirSync(path.join(inner, 'sub'), { recursive: true });
        fs.mkdirSync(free);
        const listing = await storage.buildStorageListing({
            workRoots: [workRoot],
            historyDir,
            configHostPaths: [fixed, path.join(inner, 'sub')],
            dockerExecAsync: fakeDocker({})
        });
        const byName = Object.fromEntries(listing.rows.map(row => [path.basename(row.path), row]));
        expect(byName['20261001-000050']).toMatchObject({ status: 'in-use', deletable: false });
        expect(byName['20261001-000051']).toMatchObject({ status: 'in-use', deletable: false });
        expect(byName['20261001-000052']).toMatchObject({ status: 'unused', deletable: true });
    });

    test('目录里有别的磁盘（st_dev 不同）的条目：整体拒绝，什么都没删', async () => {
        const { workRoot, historyDir } = setup();
        const dir = path.join(workRoot, '20261001-000053');
        fs.mkdirSync(path.join(dir, 'mnt'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
        fs.writeFileSync(path.join(dir, 'mnt', 'b.txt'), 'b');
        const listing = await storage.buildStorageListing({ workRoots: [workRoot], historyDir, dockerExecAsync: fakeDocker({}) });
        const lstat = async target => {
            const stat = await fs.promises.lstat(target);
            return path.basename(target) === 'mnt' ? { isDirectory: () => true, isSymbolicLink: () => false, dev: stat.dev + 1 } : stat;
        };
        const removed = await storage.removeManagedDirectory(listing, listing.rows[0].path, { lstat });
        expect(removed).toMatchObject({ ok: false, status: 409 });
        expect(removed.error).toContain('挂载');
        expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'mnt', 'b.txt'))).toBe(true);
    });

    test('目录里无法 lstat 的条目：同样整体拒绝', async () => {
        const { workRoot, historyDir } = setup();
        const dir = path.join(workRoot, '20261001-000054');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
        const listing = await storage.buildStorageListing({ workRoots: [workRoot], historyDir, dockerExecAsync: fakeDocker({}) });
        const lstat = async target => {
            if (path.basename(target) === 'a.txt') throw new Error('EACCES');
            return fs.promises.lstat(target);
        };
        expect(await storage.removeManagedDirectory(listing, listing.rows[0].path, { lstat })).toMatchObject({ ok: false, status: 409 });
        expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(true);
    });

    test('守卫：目录里的符号链接只删链接，指向目录外的目标还在', async () => {
        const { home, workRoot, historyDir } = setup();
        const dir = path.join(workRoot, '20261001-000055');
        const outside = path.join(home, 'outside');
        fs.mkdirSync(dir);
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
        fs.symlinkSync(outside, path.join(dir, 'link'));
        const listing = await storage.buildStorageListing({ workRoots: [workRoot], historyDir, dockerExecAsync: fakeDocker({}) });
        expect(await storage.removeManagedDirectory(listing, listing.rows[0].path)).toEqual({ ok: true });
        expect(fs.existsSync(dir)).toBe(false);
        expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    });

    test('容器查不到挂载时退回历史路径，宁可当成在用', async () => {
        const { workRoot, historyDir } = setup();
        const dir = path.join(workRoot, '20261001-000011');
        fs.mkdirSync(dir);
        writeHistory(historyDir, 'no-mounts', dir);
        const listing = await storage.buildStorageListing({ workRoots: [workRoot], historyDir, dockerExecAsync: fakeDocker({ 'no-mounts': { state: 'exited', mounts: [] } }) });
        expect(listing.rows[0]).toMatchObject({ status: 'in-use', deletable: false });
    });

    test('容器挂的正好是工作目录根：根下所有子目录都算在用', async () => {
        const { workRoot, historyDir } = setup();
        fs.mkdirSync(path.join(workRoot, '20261001-000012'));
        const listing = await storage.buildStorageListing({
            workRoots: [workRoot],
            historyDir,
            dockerExecAsync: fakeDocker({ 'run-r': { state: 'running', mounts: [workRoot] } })
        });
        expect(listing.rows[0]).toMatchObject({ status: 'in-use', deletable: false });
    });

    test('ps 有容器但 inspect 失败时整体报错', async () => {
        const { workRoot, historyDir } = setup();
        const docker = async args => {
            if (args[0] === 'ps') return 'a\trunning';
            throw new Error('No such object');
        };
        await expect(storage.buildStorageListing({ workRoots: [workRoot], historyDir, dockerExecAsync: docker })).rejects.toThrow('No such object');
    });

    test('已删除历史：容器 a 不会命中 a-1 的事件日志', async () => {
        const { workRoot, historyDir } = setup();
        writeHistory(historyDir, 'a', '');
        fs.writeFileSync(path.join(historyDir, 'events', 'a-1.jsonl'), '{}\n');
        const listing = await storage.buildStorageListing({ workRoots: [workRoot], historyDir, dockerExecAsync: fakeDocker({}) });
        const removeFile = name => fs.rmSync(path.join(historyDir, `${name}.json`), { force: true });
        await storage.removeDeletedHistory(historyDir, listing, 'a', removeFile);
        expect(fs.readdirSync(path.join(historyDir, 'events'))).toEqual(['a-1.jsonl']);
    });

    test('查看目录内容：目录不存在返回 404，不退回字面路径', async () => {
        const { workRoot } = setup();
        const dir = path.join(workRoot, '20261001-000013');
        fs.mkdirSync(dir);
        expect(await storage.listDirectory(dir, 'nope')).toMatchObject({ ok: false, status: 404 });
        expect(await storage.listDirectory(path.join(workRoot, 'missing'), '')).toMatchObject({ ok: false, status: 404 });
    });

    test('同一目录同时算体积只跑一次 du', async () => {
        const { workRoot } = setup();
        const dir = path.join(workRoot, 'dup');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'f'), 'x');
        const [a, b] = await Promise.all([storage.directorySize(dir), storage.directorySize(dir)]);
        expect(a).toBe(b);
    });

    test('同一目录被多个会话引用，只要有一个容器在就不可删', async () => {
        const { workRoot, historyDir } = setup();
        const dir = path.join(workRoot, '20261001-000005');
        fs.mkdirSync(dir);
        writeHistory(historyDir, 'one', dir);
        writeHistory(historyDir, 'two', dir);
        const listing = await storage.buildStorageListing({
            workRoots: [workRoot],
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
        const listing = await storage.buildStorageListing({ workRoots: [workRoot], historyDir, dockerExecAsync: fakeDocker({}) });
        expect(listing.rows[0].managed).toBe(false);
        expect(listing.rows[0].deletable).toBe(false);
        const removed = await storage.removeManagedDirectory(listing, listing.rows[0].path);
        expect(removed).toMatchObject({ ok: false, status: 409 });
        expect(fs.existsSync(project)).toBe(true);
    });

    test('运行时不可用时列表抛错，不会把所有目录当成没人用', async () => {
        const { workRoot, historyDir } = setup();
        await expect(storage.buildStorageListing({ workRoots: [workRoot], historyDir, dockerExecAsync: fakeDocker({}, true) })).rejects.toThrow('daemon down');
    });

    test('删除只作用于列表里的无人使用目录', async () => {
        const { workRoot, historyDir } = setup();
        const dir = path.join(workRoot, '20261001-000006');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'f.txt'), 'hello');
        const listing = await storage.buildStorageListing({ workRoots: [workRoot], historyDir, dockerExecAsync: fakeDocker({}) });
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
            workRoots: [workRoot],
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

    test('列表标出空目录；emptyOnly 只删空目录，非空的拒绝且不动文件', async () => {
        const { workRoot, historyDir } = setup();
        const empty = path.join(workRoot, '20261001-000030');
        const full = path.join(workRoot, '20261001-000031');
        fs.mkdirSync(empty);
        fs.mkdirSync(full);
        fs.writeFileSync(path.join(full, '.hidden'), 'x');
        const listing = await storage.buildStorageListing({ workRoots: [workRoot], historyDir, dockerExecAsync: fakeDocker({}) });
        const byName = Object.fromEntries(listing.rows.map(row => [path.basename(row.path), row]));
        expect(byName['20261001-000030'].empty).toBe(true);
        expect(byName['20261001-000031'].empty).toBe(false);
        expect(await storage.removeManagedDirectory(listing, full, { emptyOnly: true })).toMatchObject({ ok: false, status: 409 });
        expect(fs.existsSync(path.join(full, '.hidden'))).toBe(true);
        expect(await storage.removeManagedDirectory(listing, empty, { emptyOnly: true })).toEqual({ ok: true });
        expect(fs.existsSync(empty)).toBe(false);
    });

    describe('removeEmptyWorkDir', () => {
        const base = (workRoot, extra = {}) => ({ workRoots: [workRoot], extraWorkRoots: [], homeDir: '/nonexistent-home', dockerExecAsync: fakeDocker({}), ...extra });

        test('工作目录根里的空时间戳目录被删掉', async () => {
            const { workRoot } = setup();
            const dir = path.join(workRoot, '20261001-000040');
            fs.mkdirSync(dir);
            expect(await storage.removeEmptyWorkDir({ hostPath: dir, ...base(workRoot) })).toBe(true);
            expect(fs.existsSync(dir)).toBe(false);
            expect(fs.existsSync(workRoot)).toBe(true);
        });

        test('非空（含隐藏文件）不删；不在工作目录根里的不删；根本身不删', async () => {
            const { home, workRoot } = setup();
            const full = path.join(workRoot, '20261001-000041');
            fs.mkdirSync(full);
            fs.writeFileSync(path.join(full, '.env'), 'x');
            const outside = path.join(home, 'project');
            fs.mkdirSync(outside);
            expect(await storage.removeEmptyWorkDir({ hostPath: full, ...base(workRoot) })).toBe(false);
            expect(await storage.removeEmptyWorkDir({ hostPath: outside, ...base(workRoot) })).toBe(false);
            expect(await storage.removeEmptyWorkDir({ hostPath: workRoot, ...base(workRoot) })).toBe(false);
            expect([full, outside, workRoot].every(item => fs.existsSync(item))).toBe(true);
        });

        test('快捷对话目录里的空时间戳目录也删（名字不是时间戳的不删）；别的容器还挂着它就不删', async () => {
            const { home, workRoot } = setup();
            const quick = path.join(home, 'manyoyo_work');
            const dir = path.join(quick, '20261001-000042');
            const busy = path.join(quick, '20261001-000043');
            fs.mkdirSync(dir, { recursive: true });
            fs.mkdirSync(busy);
            const extra = { extraWorkRoots: [quick], homeDir: home };
            expect(await storage.removeEmptyWorkDir({ hostPath: busy, ...base(workRoot, { ...extra, dockerExecAsync: fakeDocker({ other: { state: 'running', mounts: [busy] } }) }) })).toBe(false);
            expect(await storage.removeEmptyWorkDir({ hostPath: dir, ...base(workRoot, extra) })).toBe(true);
            expect(fs.existsSync(busy)).toBe(true);
            const notes = path.join(quick, 'notes');
            fs.mkdirSync(notes);
            expect(await storage.removeEmptyWorkDir({ hostPath: notes, ...base(workRoot, extra) })).toBe(false);
        });

        test('默认工作目录里名字不是时间戳的空目录也删', async () => {
            const { workRoot } = setup();
            const dir = path.join(workRoot, 'temp1234');
            fs.mkdirSync(dir);
            expect(await storage.removeEmptyWorkDir({ hostPath: dir, ...base(workRoot) })).toBe(true);
        });

        test('运行时不可用时不删', async () => {
            const { workRoot } = setup();
            const dir = path.join(workRoot, '20261001-000044');
            fs.mkdirSync(dir);
            expect(await storage.removeEmptyWorkDir({ hostPath: dir, ...base(workRoot, { dockerExecAsync: fakeDocker({}, true) }) })).toBe(false);
            expect(fs.existsSync(dir)).toBe(true);
        });
    });
});
