const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/web/history-store');

const identity = raw => raw;
const ser = value => JSON.stringify(value);

describe('web history store', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-history-store-'));
    });
    afterEach(() => {
        jest.useRealTimers();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('写入后读取返回缓存对象，磁盘内容是紧凑 JSON 且权限 0600', () => {
        const file = path.join(dir, 'a.json');
        const value = { n: 1 };
        store.write(file, value, ser);
        expect(store.read(file, identity).value).toBe(value);
        expect(fs.readFileSync(file, 'utf-8')).toBe('{"n":1}');
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    test('文件被别的进程改写（原子替换）后读取到新内容', () => {
        const file = path.join(dir, 'a.json');
        const FIXED = 1700000000;
        store.write(file, { n: 1 }, ser);
        fs.utimesSync(file, FIXED, FIXED);
        const before = store.read(file, identity);
        expect(before.value).toEqual({ n: 1 });
        const tmp = `${file}.x`;
        fs.writeFileSync(tmp, '{"n":2}');
        // 大小、mtime 都与原文件相同，只有 inode 不同：原子替换也必须被认出来
        fs.utimesSync(tmp, FIXED, FIXED);
        fs.renameSync(tmp, file);
        expect(fs.statSync(file).mtimeMs).toBe(FIXED * 1000);
        const after = store.read(file, identity);
        expect(after.value).toEqual({ n: 2 });
        expect(after.version).not.toBe(before.version);
    });

    test('同一毫秒内写入大小相同的内容，版本号也不同', () => {
        const file = path.join(dir, 'a.json');
        const v1 = store.write(file, { n: 1 }, ser);
        const v2 = store.write(file, { n: 2 }, ser);
        expect(v2).toBeGreaterThan(v1);
        expect(store.getVersion(file)).toBe(v2);
    });

    test('写到一半失败时原文件保持完整（原子替换）', () => {
        const file = path.join(dir, 'a.json');
        store.write(file, { n: 1 }, ser);
        const spy = jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('rename boom'); });
        try {
            expect(() => store.write(file, { n: 2 }, ser)).toThrow('rename boom');
        } finally {
            spy.mockRestore();
        }
        expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ n: 1 });
        expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
        expect(store.read(file, identity).value).toEqual({ n: 1 });
    });

    test('序列化失败时原文件保持完整', () => {
        const file = path.join(dir, 'a.json');
        store.write(file, { n: 1 }, ser);
        expect(() => store.write(file, { n: 2 }, () => { throw new Error('boom'); })).toThrow('boom');
        expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ n: 1 });
    });

    test('defer 写入只改内存，最迟 1 秒后落盘；读取看到的是最新内容', () => {
        jest.useFakeTimers();
        const file = path.join(dir, 'a.json');
        store.write(file, { n: 1 }, ser);
        store.write(file, { n: 2 }, ser, { defer: true });
        store.write(file, { n: 3 }, ser, { defer: true });
        expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ n: 1 });
        expect(store.read(file, identity).value).toEqual({ n: 3 });
        jest.advanceTimersByTime(1000);
        expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ n: 3 });
    });

    test('非 defer 写入会带上之前攒着的内容', () => {
        const file = path.join(dir, 'a.json');
        const value = { n: 1 };
        store.write(file, value, ser);
        value.n = 2;
        store.write(file, value, ser, { defer: true });
        store.write(file, value, ser);
        expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ n: 2 });
        expect(store.read(file, identity).value).toBe(value);
    });

    test('flushAll 写出待写内容；目录已被删除时放弃，不重新建目录', () => {
        const file = path.join(dir, 'sub', 'a.json');
        fs.mkdirSync(path.dirname(file));
        store.write(file, { n: 1 }, ser, { defer: true });
        store.flushAll();
        expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ n: 1 });

        const gone = path.join(dir, 'gone', 'b.json');
        fs.mkdirSync(path.dirname(gone));
        store.write(gone, { n: 1 }, ser, { defer: true });
        fs.rmSync(path.dirname(gone), { recursive: true });
        store.flushAll();
        expect(fs.existsSync(path.dirname(gone))).toBe(false);
    });

    test('文件损坏时返回 null 并留下备份，不会被空历史覆盖前丢失原文', () => {
        const file = path.join(dir, 'a.json');
        fs.writeFileSync(file, '{"n":');
        expect(store.read(file, identity)).toBeNull();
        const backups = fs.readdirSync(dir).filter(name => name.startsWith('a.json.corrupt-'));
        expect(backups).toHaveLength(1);
        expect(fs.readFileSync(path.join(dir, backups[0]), 'utf-8')).toBe('{"n":');
    });

    test('文件不存在返回 null，remove 后缓存清空', () => {
        const file = path.join(dir, 'a.json');
        expect(store.read(file, identity)).toBeNull();
        store.write(file, { n: 1 }, ser);
        store.remove(file);
        expect(store.getVersion(file)).toBe(0);
    });
});

describe('web history store 边界', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-history-store2-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('损坏的文件被反复读取时只备份一次', () => {
        const file = path.join(dir, 'a.json');
        fs.writeFileSync(file, '{"n":');
        for (let i = 0; i < 5; i++) {
            expect(store.read(file, identity)).toBeNull();
        }
        expect(fs.readdirSync(dir).filter(name => name.startsWith('a.json.corrupt-'))).toHaveLength(1);
    });

    test('缓存条目被淘汰后版本号不会回到 0', () => {
        const file = path.join(dir, 'a.json');
        const v = store.write(file, { n: 1 }, ser);
        expect(store.getVersion(file)).toBe(v);
        expect(store.getVersion(file)).toBeGreaterThan(0);
    });
});
