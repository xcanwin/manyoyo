'use strict';

// 最小 tar 读写器（ustar + pax）。只认普通文件 / 目录 / 符号链接，硬链接和其余类型由读端标出来、交给调用方拒绝。
// 不引入第三方依赖：宿主机侧解包的安全规则要完全受控。

const BLOCK = 512;
const MAX_OCTAL_SIZE = 0o77777777777; // ustar size 字段能表示的上限（8GiB - 1），更大的走 pax size
const MAX_PAX_BYTES = 1024 * 1024;

const TYPES = {
    '0': 'file',
    '\0': 'file',
    '5': 'dir',
    '2': 'symlink',
    '1': 'hardlink'
};

class TarError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TarError';
    }
}

function writeString(buf, value, offset, length) {
    const bytes = Buffer.from(value, 'utf8');
    bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
}

function writeOctal(buf, value, offset, length) {
    const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
    buf.write(text.slice(-(length - 1)), offset, length - 1, 'ascii');
    buf[offset + length - 1] = 0;
}

function isPlainAscii(text) {
    return /^[\x20-\x7e]*$/.test(text);
}

function pad(size) {
    const rest = size % BLOCK;
    return rest === 0 ? 0 : BLOCK - rest;
}

function paxRecord(key, value) {
    const body = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(body);
    // 长度字段本身也算在内
    let total = length + String(length).length;
    if (String(total).length !== String(length).length) total += 1;
    return Buffer.from(`${total}${body}`, 'utf8');
}

function buildBlock({ name, mode = 0o644, size = 0, mtime = 0, type = '0', linkname = '', uid = 0, gid = 0 }) {
    const block = Buffer.alloc(BLOCK);
    writeString(block, name, 0, 100);
    writeOctal(block, mode & 0o7777, 100, 8);
    writeOctal(block, uid, 108, 8);
    writeOctal(block, gid, 116, 8);
    writeOctal(block, Math.min(size, MAX_OCTAL_SIZE), 124, 12);
    writeOctal(block, mtime, 136, 12);
    block.fill(0x20, 148, 156);
    block.write(type, 156, 1, 'ascii');
    writeString(block, linkname, 157, 100);
    block.write('ustar\0', 257, 6, 'latin1');
    block.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += block[i];
    const text = sum.toString(8).padStart(6, '0');
    block.write(text, 148, 6, 'ascii');
    block[154] = 0;
    block[155] = 0x20;
    return block;
}

/**
 * 一个条目的头部（必要时前面带 pax 扩展头）。meta：{ name, type: 'file'|'dir'|'symlink', size, mode, mtime, linkname }
 * 名字超过 100 字节、含非 ASCII、size 超过 8GiB-1 都走 pax。
 */
function encodeEntryHeader(meta) {
    const type = meta.type === 'dir' ? '5' : meta.type === 'symlink' ? '2' : '0';
    const name = meta.type === 'dir' && !meta.name.endsWith('/') ? `${meta.name}/` : meta.name;
    const size = meta.type === 'file' ? Number(meta.size || 0) : 0;
    const linkname = meta.linkname || '';
    const records = [];
    if (Buffer.byteLength(name) > 100 || !isPlainAscii(name)) records.push(paxRecord('path', name));
    if (Buffer.byteLength(linkname) > 100 || !isPlainAscii(linkname)) records.push(paxRecord('linkpath', linkname));
    if (size > MAX_OCTAL_SIZE) records.push(paxRecord('size', String(size)));
    const parts = [];
    if (records.length) {
        const body = Buffer.concat(records);
        parts.push(buildBlock({ name: 'PaxHeader', type: 'x', size: body.length, mode: 0o644 }));
        parts.push(body, Buffer.alloc(pad(body.length)));
    }
    const plainName = Buffer.byteLength(name) > 100 || !isPlainAscii(name) ? 'long-name' : name;
    const plainLink = Buffer.byteLength(linkname) > 100 || !isPlainAscii(linkname) ? 'long-link' : linkname;
    parts.push(buildBlock({
        name: plainName,
        mode: meta.mode === undefined ? (type === '5' ? 0o755 : 0o644) : meta.mode,
        size,
        mtime: Math.floor(meta.mtime || 0),
        type,
        linkname: plainLink,
        uid: meta.uid || 0,
        gid: meta.gid || 0
    }));
    return Buffer.concat(parts);
}

const END_BLOCKS = Buffer.alloc(BLOCK * 2);

function readString(block, offset, length) {
    let end = offset;
    const limit = offset + length;
    while (end < limit && block[end] !== 0) end++;
    return block.toString('utf8', offset, end);
}

function readNumber(block, offset, length) {
    // base-256（GNU 对超大数的编码）：最高位为 1
    if (block[offset] & 0x80) {
        let value = block[offset] & 0x7f;
        for (let i = 1; i < length; i++) value = value * 256 + block[offset + i];
        return value;
    }
    const text = readString(block, offset, length).trim();
    if (text === '') return 0;
    if (!/^[0-7]+$/.test(text)) throw new TarError('tar 头部数字字段非法');
    return parseInt(text, 8);
}

function isZeroBlock(block) {
    for (let i = 0; i < BLOCK; i++) if (block[i] !== 0) return false;
    return true;
}

function verifyChecksum(block) {
    const expected = readNumber(block, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 0x20 : block[i];
    if (sum !== expected) throw new TarError('tar 头部校验和不符');
}

function parsePax(body) {
    const out = {};
    let pos = 0;
    while (pos < body.length) {
        const space = body.indexOf(0x20, pos);
        if (space < 0) throw new TarError('pax 记录非法');
        const length = parseInt(body.toString('ascii', pos, space), 10);
        if (!Number.isInteger(length) || length <= 0 || pos + length > body.length) throw new TarError('pax 记录长度非法');
        const record = body.toString('utf8', space + 1, pos + length - 1);
        const eq = record.indexOf('=');
        if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
        pos += length;
    }
    return out;
}

function metaFromBlock(block, pax) {
    const prefix = readString(block, 345, 155);
    let name = readString(block, 0, 100);
    if (prefix && block.toString('ascii', 257, 262) === 'ustar') name = `${prefix}/${name}`;
    const typeflag = String.fromCharCode(block[156]);
    const meta = {
        name,
        type: TYPES[typeflag] || 'other',
        typeflag,
        size: readNumber(block, 124, 12),
        mode: readNumber(block, 100, 8),
        uid: readNumber(block, 108, 8),
        gid: readNumber(block, 116, 8),
        mtime: readNumber(block, 136, 12),
        linkname: readString(block, 157, 100)
    };
    if (pax.path !== undefined) meta.name = pax.path;
    if (pax.linkpath !== undefined) meta.linkname = pax.linkpath;
    if (pax.size !== undefined) {
        const size = Number(pax.size);
        if (!Number.isSafeInteger(size) || size < 0) throw new TarError('pax size 非法');
        meta.size = size;
    }
    if (meta.type === 'dir' && meta.name.endsWith('/')) meta.name = meta.name.slice(0, -1);
    return meta;
}

/**
 * 只解析内存里的头部（可含 pax 扩展头，不含正文）：用于测试和快速探测。
 * 返回 { meta, consumed }，meta 为 null 表示读到了结束块。
 */
function decodeEntryHeader(buffer) {
    let pos = 0;
    let pax = {};
    for (;;) {
        if (buffer.length - pos < BLOCK) throw new TarError('tar 头部不完整');
        const block = buffer.subarray(pos, pos + BLOCK);
        if (isZeroBlock(block)) return { meta: null, consumed: pos + BLOCK };
        verifyChecksum(block);
        const typeflag = String.fromCharCode(block[156]);
        if (typeflag === 'x' || typeflag === 'g') {
            const size = readNumber(block, 124, 12);
            if (size > MAX_PAX_BYTES) throw new TarError('pax 扩展头过大');
            const bodyEnd = pos + BLOCK + size;
            if (buffer.length < bodyEnd) throw new TarError('tar 头部不完整');
            if (typeflag === 'x') pax = { ...pax, ...parsePax(buffer.subarray(pos + BLOCK, bodyEnd)) };
            pos = bodyEnd + pad(size);
            continue;
        }
        return { meta: metaFromBlock(block, pax), consumed: pos + BLOCK };
    }
}

// 按需从异步字节源里取定长数据
class ByteReader {
    constructor(source) {
        this.iterator = source[Symbol.asyncIterator]();
        this.buffer = Buffer.alloc(0);
        this.done = false;
    }

    async fill() {
        if (this.done) return false;
        const { value, done } = await this.iterator.next();
        if (done) {
            this.done = true;
            return false;
        }
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        return true;
    }

    // 恰好 n 字节；一个字节都没有就到了流尾返回 null；中途断了抛截断错误
    async readExact(n) {
        while (this.buffer.length < n) {
            if (!(await this.fill())) {
                if (this.buffer.length === 0) return null;
                throw new TarError('tar 流被截断');
            }
        }
        const out = this.buffer.subarray(0, n);
        this.buffer = this.buffer.subarray(n);
        return out;
    }

    // 分块取 n 字节（不一次性放进内存）
    async *chunks(n) {
        let left = n;
        while (left > 0) {
            if (this.buffer.length === 0 && !(await this.fill())) throw new TarError('tar 流被截断');
            const take = Math.min(left, this.buffer.length);
            const piece = this.buffer.subarray(0, take);
            this.buffer = this.buffer.subarray(take);
            left -= take;
            yield piece;
        }
    }

    // 读掉剩下的所有字节（tar 结束块之后上游可能还有补零；不读掉，上游进程会堵在写管道上不退出）
    async drain() {
        try {
            while (await this.fill()) this.buffer = Buffer.alloc(0);
        } catch (error) {
            // 结束块之后的错误不影响已经读到的内容
        }
    }

    async skip(n) {
        for await (const piece of this.chunks(n)) void piece;
    }
}

/**
 * 流式读端（拉取式，天然带背压）：
 *   for await (const { meta, body } of readTarEntries(stream)) { for await (const chunk of body) ... }
 * body 是该条目正文的异步迭代器（目录 / 链接为空）；没读完的部分在进入下一个条目前自动跳过。
 * meta.type 为 'other' / 'hardlink' 由调用方决定怎么处理（导入一律拒绝）。
 * 流在条目中途结束会抛 TarError('tar 流被截断')；在条目边界干净结束视为正常。
 */
async function* readTarEntries(source, options = {}) {
    const maxEntrySize = options.maxEntrySize || Infinity;
    const reader = new ByteReader(source);
    let pax = {};
    for (;;) {
        const block = await reader.readExact(BLOCK);
        if (block === null) return;
        if (isZeroBlock(block)) {
            await reader.drain();
            return;
        }
        verifyChecksum(block);
        const typeflag = String.fromCharCode(block[156]);
        if (typeflag === 'x' || typeflag === 'g') {
            const size = readNumber(block, 124, 12);
            if (size > MAX_PAX_BYTES) throw new TarError('pax 扩展头过大');
            const parts = [];
            for await (const piece of reader.chunks(size)) parts.push(piece);
            await reader.skip(pad(size));
            if (typeflag === 'x') pax = { ...pax, ...parsePax(Buffer.concat(parts)) };
            continue;
        }
        const meta = metaFromBlock(block, pax);
        pax = {};
        if (meta.size > maxEntrySize) throw new TarError(`条目过大: ${meta.name}`);
        const size = meta.type === 'file' ? meta.size : 0;
        let consumed = 0;
        const body = (async function* () {
            for await (const piece of reader.chunks(size)) {
                consumed += piece.length;
                yield piece;
            }
        })();
        yield { meta, body };
        // 调用方没读完：丢弃剩余正文
        if (consumed < size) {
            await reader.skip(size - consumed);
        }
        await reader.skip(pad(size));
    }
}

module.exports = {
    BLOCK,
    MAX_OCTAL_SIZE,
    END_BLOCKS,
    TarError,
    readTarEntries,
    encodeEntryHeader,
    decodeEntryHeader,
    pad
};
