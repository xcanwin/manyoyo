'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { SafeExtractor, UnsafeEntryError, splitEntryPath } = require('../lib/archive/safe-extract');

const bodyOf = text => Readable.from([Buffer.from(text)]);

describe('lib/archive/safe-extract（导入解包的安全规则）', () => {
    let base;
    let root;
    let outside;
    beforeEach(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-safe-'));
        root = path.join(base, 'root');
        outside = path.join(base, 'outside');
        fs.mkdirSync(root);
        fs.mkdirSync(outside);
    });
    afterEach(() => fs.rmSync(base, { recursive: true, force: true }));
    const outsideEntries = () => fs.readdirSync(outside);

    test.each([
        ['绝对路径', '/etc/passwd'],
        ['../', '../escape'],
        ['a/../../escape', 'a/../../escape'],
        ['中间的 ..', 'a/../b'],
        ['点段', 'a/./b'],
        ['空段', 'a//b'],
        ['NUL', 'a\0b'],
        ['反斜杠', 'a\\b'],
        ['空名字', '']
    ])('拒绝 %s', async (label, name) => {
        const extractor = new SafeExtractor(root);
        await expect(extractor.addFile(name, 0o644, bodyOf('x'), 1)).rejects.toThrow(UnsafeEntryError);
        expect(() => splitEntryPath(name)).toThrow(UnsafeEntryError);
        expect(outsideEntries()).toEqual([]);
        expect(fs.readdirSync(root)).toEqual([]);
    });

    test('先来一个符号链接 a -> 外部目录，再写 a/x：链接不创建，文件落在 root 内的真实目录里，外部没有任何新文件', async () => {
        const extractor = new SafeExtractor(root);
        extractor.addSymlink('a', outside);
        await extractor.addFile('a/x', 0o644, bodyOf('payload'), 7);
        extractor.finalizeSymlinks();
        expect(outsideEntries()).toEqual([]);
        expect(fs.lstatSync(path.join(root, 'a')).isDirectory()).toBe(true);
        expect(fs.readFileSync(path.join(root, 'a', 'x'), 'utf8')).toBe('payload');
        expect(extractor.skippedLinks).toBe(1);
    });

    test('root 里预先存在的符号链接（不是本次新建）不会被当作父目录写进去', async () => {
        fs.symlinkSync(outside, path.join(root, 'planted'));
        const extractor = new SafeExtractor(root);
        await expect(extractor.addFile('planted/x', 0o644, bodyOf('x'), 1)).rejects.toThrow(UnsafeEntryError);
        expect(outsideEntries()).toEqual([]);
    });

    test('目标位置已是符号链接：O_NOFOLLOW + O_EXCL 拒绝写穿', async () => {
        fs.writeFileSync(path.join(outside, 'victim'), 'orig');
        fs.symlinkSync(path.join(outside, 'victim'), path.join(root, 'f'));
        const extractor = new SafeExtractor(root);
        await expect(extractor.addFile('f', 0o644, bodyOf('pwn'), 3)).rejects.toThrow();
        expect(fs.readFileSync(path.join(outside, 'victim'), 'utf8')).toBe('orig');
    });

    test('符号链接：只创建相对且解析后仍在 root 内的，指向外部或绝对路径的跳过并计数', async () => {
        const extractor = new SafeExtractor(root);
        await extractor.addFile('dir/target.txt', 0o644, bodyOf('t'), 1);
        extractor.addSymlink('dir/ok', 'target.txt');
        extractor.addSymlink('dir/up', '../../outside');
        extractor.addSymlink('dir/abs', '/etc/passwd');
        extractor.addSymlink('dir/deep', '../../../etc');
        expect(extractor.finalizeSymlinks()).toBe(1);
        expect(fs.readlinkSync(path.join(root, 'dir', 'ok'))).toBe('target.txt');
        expect(fs.existsSync(path.join(root, 'dir', 'up'))).toBe(false);
        expect(extractor.skippedLinks).toBe(3);
    });

    test('去掉 setuid / setgid / sticky', async () => {
        const extractor = new SafeExtractor(root);
        await extractor.addFile('suid', 0o6755, bodyOf('x'), 1);
        extractor.addDir('d', 0o1777);
        expect(fs.statSync(path.join(root, 'suid')).mode & 0o7777).toBe(0o755);
        expect(fs.statSync(path.join(root, 'd')).mode & 0o7000).toBe(0);
    });

    test('解包大小与条目数量上限', async () => {
        const small = new SafeExtractor(root, { maxBytes: 5 });
        await expect(small.addFile('big', 0o644, bodyOf('0123456789'), 10)).rejects.toThrow(/上限/);
        const few = new SafeExtractor(fs.mkdtempSync(path.join(base, 'r2-')), { maxFiles: 1 });
        await few.addFile('a', 0o644, bodyOf('x'), 1);
        await expect(few.addFile('b', 0o644, bodyOf('x'), 1)).rejects.toThrow(/上限/);
    });

    test('文件当目录用：先写文件 a，再写 a/x 报错', async () => {
        const extractor = new SafeExtractor(root);
        await extractor.addFile('a', 0o644, bodyOf('x'), 1);
        await expect(extractor.addFile('a/x', 0o644, bodyOf('x'), 1)).rejects.toThrow(UnsafeEntryError);
    });
});
