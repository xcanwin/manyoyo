'use strict';

const { Readable } = require('stream');
const { encodeEntryHeader, decodeEntryHeader, readTarEntries, END_BLOCKS, pad, TarError } = require('../lib/archive/tar');

function entry(meta, content = Buffer.alloc(0)) {
    const body = Buffer.from(content);
    return Buffer.concat([encodeEntryHeader({ ...meta, size: meta.type === 'file' || !meta.type ? body.length : 0 }), body, Buffer.alloc(pad(body.length))]);
}

async function collect(buffer, { chunk = 7, options } = {}) {
    const pieces = [];
    for (let i = 0; i < buffer.length; i += chunk) pieces.push(buffer.subarray(i, i + chunk));
    const out = [];
    for await (const { meta, body } of readTarEntries(Readable.from(pieces), options)) {
        const parts = [];
        for await (const piece of body) parts.push(piece);
        out.push({ meta, content: Buffer.concat(parts) });
    }
    return out;
}

describe('lib/archive/tar', () => {
    test('往返：普通文件、中文名、长名（pax）、空文件、目录、符号链接', async () => {
        const longName = `${'目录'.repeat(40)}/${'a'.repeat(120)}.txt`;
        const archive = Buffer.concat([
            entry({ name: 'manifest.json', type: 'file' }, '{"format":1}'),
            entry({ name: '中文/文件.txt', type: 'file' }, 'héllo 你好'),
            entry({ name: longName, type: 'file' }, 'long'),
            entry({ name: 'empty', type: 'file' }, ''),
            entry({ name: 'dir', type: 'dir' }),
            entry({ name: 'link', type: 'symlink', linkname: `../${'x'.repeat(150)}` }),
            END_BLOCKS
        ]);
        const result = await collect(archive);
        expect(result.map(item => [item.meta.type, item.meta.name])).toEqual([
            ['file', 'manifest.json'], ['file', '中文/文件.txt'], ['file', longName], ['file', 'empty'], ['dir', 'dir'], ['symlink', 'link']
        ]);
        expect(result[0].content.toString()).toBe('{"format":1}');
        expect(result[1].content.toString()).toBe('héllo 你好');
        expect(result[2].content.toString()).toBe('long');
        expect(result[3].content.length).toBe(0);
        expect(result[5].meta.linkname).toBe(`../${'x'.repeat(150)}`);
    });

    test('超过 8GiB 的文件用 pax size 写出且能读回头部（用伪造头部，不生成真文件）', () => {
        const size = 9 * 1024 * 1024 * 1024 + 123;
        const header = encodeEntryHeader({ name: 'big.bin', type: 'file', size });
        const { meta } = decodeEntryHeader(header);
        expect(meta.size).toBe(size);
        expect(meta.name).toBe('big.bin');
    });

    test('没读完正文就进入下一个条目：剩余部分被跳过', async () => {
        const archive = Buffer.concat([entry({ name: 'a', type: 'file' }, 'x'.repeat(2000)), entry({ name: 'b', type: 'file' }, 'second'), END_BLOCKS]);
        const names = [];
        for await (const { meta, body } of readTarEntries(Readable.from([archive]))) {
            names.push(meta.name);
            if (meta.name === 'b') { const parts = []; for await (const p of body) parts.push(p); expect(Buffer.concat(parts).toString()).toBe('second'); }
        }
        expect(names).toEqual(['a', 'b']);
    });

    test('截断的流报错：正文中途、头部中途；条目边界干净结束（没有结束块）视为正常', async () => {
        const full = Buffer.concat([entry({ name: 'a', type: 'file' }, 'hello world'), END_BLOCKS]);
        await expect(collect(full.subarray(0, 520))).rejects.toThrow(/截断/);
        await expect(collect(full.subarray(0, 100))).rejects.toThrow(/截断/);
        const noEnd = entry({ name: 'a', type: 'file' }, 'hello');
        expect((await collect(noEnd)).length).toBe(1);
    });

    test('结束块之后的补零会被读完（上游进程才能正常退出）', async () => {
        const archive = Buffer.concat([entry({ name: 'a', type: 'file' }, 'x'), END_BLOCKS, Buffer.alloc(100000)]);
        let consumed = 0;
        const source = (async function* () { for (let i = 0; i < archive.length; i += 4096) { consumed = Math.min(archive.length, i + 4096); yield archive.subarray(i, i + 4096); } })();
        for await (const item of readTarEntries(source)) { for await (const piece of item.body) void piece; }
        expect(consumed).toBe(archive.length);
    });

    test('硬链接、设备等类型被标出来交给调用方（不会当普通文件）', async () => {
        const hard = Buffer.concat([encodeEntryHeader({ name: 'h', type: 'file', size: 0 })]);
        hard[156] = '1'.charCodeAt(0);
        // 重新算校验和
        hard.fill(0x20, 148, 156);
        let sum = 0; for (let i = 0; i < 512; i++) sum += hard[i];
        hard.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii'); hard[154] = 0; hard[155] = 0x20;
        const dev = Buffer.from(hard); dev[156] = '3'.charCodeAt(0);
        dev.fill(0x20, 148, 156); sum = 0; for (let i = 0; i < 512; i++) sum += dev[i];
        dev.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii'); dev[154] = 0; dev[155] = 0x20;
        const result = await collect(Buffer.concat([hard, dev, END_BLOCKS]));
        expect(result.map(item => item.meta.type)).toEqual(['hardlink', 'other']);
    });

    test('头部校验和不符、条目超过上限都报错', async () => {
        const archive = Buffer.concat([entry({ name: 'a', type: 'file' }, 'hi'), END_BLOCKS]);
        const broken = Buffer.from(archive); broken[0] ^= 0xff;
        await expect(collect(broken)).rejects.toThrow(TarError);
        await expect(collect(archive, { options: { maxEntrySize: 1 } })).rejects.toThrow(/过大/);
    });
});
