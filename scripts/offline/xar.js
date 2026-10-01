'use strict';

// 不依赖 pkgutil / xar / cpio 的 macOS .pkg 解包：xar 容器 → gzip 压缩的 cpio（odc / newc）负载。
// 只做“把文件解到目录”，不执行 pkg 里的任何脚本。输入视为不可信：拒绝绝对路径与 ..。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const XAR_MAGIC = 0x78617221;

function readRange(fd, start, length) {
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
        const read = fs.readSync(fd, buffer, done, length - done, start + done);
        if (read === 0) throw new Error('xar 文件被截断');
        done += read;
    }
    return buffer;
}

function decodeXmlText(text) {
    return text
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// TOC 的 XML 结构固定且很小，这里只解析需要的子集（file 嵌套、name/type/data/offset/length/size/encoding）
function parseToc(xml) {
    const tokenRe = /<(\/?)([A-Za-z_][\w:-]*)([^>]*?)(\/?)>|([^<]+)/g;
    const root = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    let match;
    while ((match = tokenRe.exec(xml)) !== null) {
        if (match[5] !== undefined) {
            stack[stack.length - 1].text += match[5];
            continue;
        }
        const [, closing, name, rawAttrs, selfClosing] = match;
        if (closing) {
            stack.pop();
            continue;
        }
        const attrs = {};
        rawAttrs.replace(/([\w:-]+)="([^"]*)"/g, (_, key, value) => { attrs[key] = decodeXmlText(value); return ''; });
        const node = { name, attrs, children: [], text: '' };
        stack[stack.length - 1].children.push(node);
        if (!selfClosing) stack.push(node);
    }
    return root;
}

const child = (node, name) => node.children.find(item => item.name === name);
const childText = (node, name) => {
    const found = child(node, name);
    return found ? decodeXmlText(found.text.trim()) : '';
};

function collectFiles(node, prefix, out) {
    for (const item of node.children.filter(entry => entry.name === 'file')) {
        const name = childText(item, 'name');
        if (!name || name.includes('/') || name === '.' || name === '..') {
            throw new Error(`xar 条目名不合法: ${name}`);
        }
        const fullPath = prefix ? `${prefix}/${name}` : name;
        const type = childText(item, 'type') || 'file';
        const data = child(item, 'data');
        out.push({
            path: fullPath,
            type,
            offset: data ? Number(childText(data, 'offset')) : 0,
            length: data ? Number(childText(data, 'length')) : 0,
            size: data ? Number(childText(data, 'size')) : 0,
            encoding: data && child(data, 'encoding') ? child(data, 'encoding').attrs.style || '' : ''
        });
        collectFiles(item, fullPath, out);
    }
}

function openXar(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const header = readRange(fd, 0, 28);
        if (header.readUInt32BE(0) !== XAR_MAGIC) throw new Error('不是 xar 文件（.pkg）');
        const headerSize = header.readUInt16BE(4);
        const tocLength = Number(header.readBigUInt64BE(8));
        const toc = zlib.inflateSync(readRange(fd, headerSize, tocLength));
        const tocNode = child(child(parseToc(toc.toString('utf-8')), 'xar') || { children: [] }, 'toc');
        if (!tocNode) throw new Error('xar TOC 结构异常');
        const entries = [];
        collectFiles(tocNode, '', entries);
        return { entries, heapStart: headerSize + tocLength };
    } finally {
        fs.closeSync(fd);
    }
}

function entryStream(filePath, xar, entry) {
    const start = xar.heapStart + entry.offset;
    const raw = fs.createReadStream(filePath, { start, end: start + entry.length - 1 });
    return entry.encoding.includes('gzip') || entry.encoding.includes('zlib') ? raw.pipe(zlib.createInflate()) : raw;
}

function safeJoin(root, relative) {
    const cleaned = relative.replace(/^\.\//, '');
    if (!cleaned || path.isAbsolute(cleaned) || cleaned.split('/').includes('..')) {
        throw new Error(`不安全的归档路径: ${relative}`);
    }
    const target = path.join(root, cleaned);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`归档路径越界: ${relative}`);
    return target;
}

async function readAll(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

/**
 * 解开 cpio（odc 070707 / newc 070701），写到 outDir。filter(name) 返回 false 的条目跳过。
 * 返回写出的文件数。
 */
async function extractCpio(stream, outDir, filter = () => true) {
    const buffer = await readAll(stream);
    let offset = 0;
    let written = 0;
    const root = path.resolve(outDir);
    fs.mkdirSync(root, { recursive: true });

    while (offset + 6 <= buffer.length) {
        const magic = buffer.toString('latin1', offset, offset + 6);
        let mode; let nameSize; let fileSize; let headerLen; let align = 1;
        if (magic === '070707') {
            headerLen = 76;
            mode = parseInt(buffer.toString('latin1', offset + 18, offset + 24), 8);
            nameSize = parseInt(buffer.toString('latin1', offset + 59, offset + 65), 8);
            fileSize = parseInt(buffer.toString('latin1', offset + 65, offset + 76), 8);
        } else if (magic === '070701' || magic === '070702') {
            headerLen = 110;
            mode = parseInt(buffer.toString('latin1', offset + 14, offset + 22), 16);
            fileSize = parseInt(buffer.toString('latin1', offset + 54, offset + 62), 16);
            nameSize = parseInt(buffer.toString('latin1', offset + 94, offset + 102), 16);
            align = 4;
        } else {
            throw new Error(`未知的 cpio 魔数: ${magic}`);
        }
        const nameStart = offset + headerLen;
        const name = buffer.toString('utf-8', nameStart, nameStart + nameSize - 1);
        // newc 的 header+name 与数据都按 4 字节对齐；odc 不对齐
        const dataStart = offset + Math.ceil((headerLen + nameSize) / align) * align;
        if (name === 'TRAILER!!!') break;
        const data = buffer.subarray(dataStart, dataStart + fileSize);
        offset = dataStart + Math.ceil(fileSize / align) * align;

        if (!filter(name)) continue;
        const relative = name.replace(/^\.\//, '');
        if (relative === '.' || relative === '') continue;
        const target = safeJoin(root, relative);
        const fileType = mode & 0o170000;
        if (fileType === 0o040000) {
            fs.mkdirSync(target, { recursive: true });
        } else if (fileType === 0o120000) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.rmSync(target, { force: true });
            fs.symlinkSync(data.toString('utf-8'), target);
        } else if (fileType === 0o100000) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, data, { mode: mode & 0o777 });
            fs.chmodSync(target, mode & 0o777);
            written += 1;
        }
    }
    return written;
}

/**
 * 解开 .pkg：找到各组件包的 Payload（gzip 压缩的 cpio），解到 outDir。
 * @returns {Promise<{files: number}>}
 */
async function extractPkgPayload(pkgPath, outDir, filter) {
    const xar = openXar(pkgPath);
    const payloads = xar.entries.filter(entry => entry.type === 'file' && path.posix.basename(entry.path) === 'Payload');
    if (payloads.length === 0) throw new Error('pkg 里没有 Payload');
    let files = 0;
    for (const entry of payloads) {
        const stream = entryStream(pkgPath, xar, entry).pipe(zlib.createGunzip());
        files += await extractCpio(stream, outDir, filter);
    }
    return { files };
}

module.exports = {
    openXar,
    extractCpio,
    extractPkgPayload,
    parseToc
};
