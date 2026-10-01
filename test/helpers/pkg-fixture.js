'use strict';

// 构造最小的 xar（.pkg）与 cpio 负载，用来在单测里不下载真实文件就覆盖解包逻辑。
const zlib = require('zlib');

function octal(value, width) {
    return value.toString(8).padStart(width, '0');
}

// entries: [{ name, type: 'file'|'dir'|'symlink', mode?, data? }]
function buildCpio(entries, format = 'odc') {
    const parts = [];
    const push = (name, mode, data) => {
        const nameBuf = Buffer.from(`${name}\0`);
        if (format === 'odc') {
            const header = `070707${octal(0, 6)}${octal(1, 6)}${octal(mode, 6)}${octal(0, 6)}${octal(0, 6)}${octal(1, 6)}${octal(0, 6)}${octal(0, 11)}${octal(nameBuf.length, 6)}${octal(data.length, 11)}`;
            parts.push(Buffer.from(header), nameBuf, data);
            return;
        }
        const hex = value => value.toString(16).padStart(8, '0');
        const header = `070701${hex(1)}${hex(mode)}${hex(0)}${hex(0)}${hex(1)}${hex(0)}${hex(data.length)}${hex(0)}${hex(0)}${hex(0)}${hex(0)}${hex(nameBuf.length)}${hex(0)}`;
        const headerAndName = Buffer.concat([Buffer.from(header), nameBuf]);
        parts.push(headerAndName, Buffer.alloc((4 - (headerAndName.length % 4)) % 4), data, Buffer.alloc((4 - (data.length % 4)) % 4));
    };
    for (const entry of entries) {
        const data = Buffer.from(entry.data || '');
        if (entry.type === 'dir') push(entry.name, 0o040755, Buffer.alloc(0));
        else if (entry.type === 'symlink') push(entry.name, 0o120777, data);
        else push(entry.name, 0o100000 | (entry.mode || 0o644), data);
    }
    push('TRAILER!!!', 0, Buffer.alloc(0));
    return Buffer.concat(parts);
}

function xmlEscape(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// files: [{ path: 'podman.pkg/Payload', data: Buffer, gzip?: boolean }]；目录由路径自动补出
function buildXar(files) {
    let heap = Buffer.alloc(0);
    const tree = { children: new Map() };
    for (const file of files) {
        const encoded = file.gzip ? zlib.deflateSync(file.data) : file.data;
        const record = { offset: heap.length, length: encoded.length, size: file.data.length, gzip: Boolean(file.gzip) };
        heap = Buffer.concat([heap, encoded]);
        const segments = file.path.split('/');
        let node = tree;
        segments.forEach((segment, index) => {
            if (!node.children.has(segment)) node.children.set(segment, { children: new Map() });
            node = node.children.get(segment);
            if (index === segments.length - 1) node.record = record;
        });
    }
    let id = 0;
    const render = node => [...node.children.entries()].map(([name, child]) => {
        id += 1;
        const own = id;
        const data = child.record
            ? `<data><offset>${child.record.offset}</offset><length>${child.record.length}</length><size>${child.record.size}</size><encoding style="${child.record.gzip ? 'application/x-gzip' : 'application/octet-stream'}"/></data>`
            : '';
        return `<file id="${own}"><name>${xmlEscape(name)}</name><type>${child.record ? 'file' : 'directory'}</type>${data}${render(child)}</file>`;
    }).join('');
    const toc = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><xar><toc>${render(tree)}</toc></xar>`);
    const tocCompressed = zlib.deflateSync(toc);
    const header = Buffer.alloc(28);
    header.writeUInt32BE(0x78617221, 0);
    header.writeUInt16BE(28, 4);
    header.writeUInt16BE(1, 6);
    header.writeBigUInt64BE(BigInt(tocCompressed.length), 8);
    header.writeBigUInt64BE(BigInt(toc.length), 16);
    header.writeUInt32BE(0, 24);
    return Buffer.concat([header, tocCompressed, heap]);
}

function buildPkg(entries, format = 'odc') {
    const payload = zlib.gzipSync(buildCpio(entries, format));
    return buildXar([
        { path: 'Distribution', data: Buffer.from('<installer-gui-script/>'), gzip: true },
        { path: 'podman.pkg/Payload', data: payload },
        { path: 'podman.pkg/Scripts', data: Buffer.from('should-never-run') }
    ]);
}

module.exports = { buildCpio, buildXar, buildPkg };
