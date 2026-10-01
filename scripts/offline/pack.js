'use strict';

// .run = sh 头 + tar.gz 负载。头部自校验（SHA256），用 sh 执行，不经 macOS 对下载可执行文件的拦截。
// 超过 GitHub Release 单文件上限时按卷拆分（.run.001 …），合并后即可校验与执行。

const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { sha256File } = require('../../lib/download-verified');

const PAYLOAD_MARKER = '__MANYOYO_PAYLOAD_BELOW__';
const DEFAULT_VOLUME_BYTES = 1900 * 1000 * 1000;

function renderRunHeader({ name, sha256 }) {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('header 需要有效的 payload SHA256');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`name 不合法: ${name}`);
    return `#!/bin/sh
# ${name}
# MANYOYO 离线安装包：本文件 = 这段 sh 脚本 + tar.gz 负载。先查看再执行：
#   sed -n '1,/^${PAYLOAD_MARKER}$/p' ${name}.run
# 用法:
#   sh ${name}.run                 校验后安装（安装逻辑在负载里的 install/install.sh）
#   sh ${name}.run --check         只校验 SHA256
#   sh ${name}.run --list          列出负载内容
#   sh ${name}.run --extract DIR   只解开到 DIR
set -eu

PAYLOAD_SHA256="${sha256}"
self="$0"

hash_cmd() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256; else sha256sum; fi
}
payload() {
    tail -n +"$(awk '/^${PAYLOAD_MARKER}$/ { print NR + 1; exit }' "$self")" "$self"
}
verify() {
    actual="$(payload | hash_cmd | awk '{ print $1 }')"
    if [ "$actual" != "$PAYLOAD_SHA256" ]; then
        echo "校验失败：安装包不完整或已被修改（期望 \${PAYLOAD_SHA256}，实际 \${actual}）。请重新下载。" >&2
        exit 1
    fi
}

case "\${1:-}" in
    --check) verify; echo "校验通过: $PAYLOAD_SHA256"; exit 0 ;;
    --list) payload | tar -tzf -; exit 0 ;;
    --extract)
        [ -n "\${2:-}" ] || { echo "用法: sh $self --extract DIR" >&2; exit 2; }
        verify
        mkdir -p "$2"
        payload | tar -xzf - -C "$2"
        exit 0 ;;
    -h|--help) sed -n '2,12p' "$self"; exit 0 ;;
esac

verify
tmp="$(mktemp -d "\${TMPDIR:-/tmp}/manyoyo-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM
payload | tar -xzf - -C "$tmp"
sh "$tmp/install/install.sh" "$@"
exit $?
${PAYLOAD_MARKER}
`;
}

async function writeRunFile({ payloadPath, outPath, name }) {
    const sha256 = await sha256File(payloadPath);
    fs.writeFileSync(outPath, renderRunHeader({ name, sha256 }), { mode: 0o755 });
    await pipeline(fs.createReadStream(payloadPath), fs.createWriteStream(outPath, { flags: 'a' }));
    fs.chmodSync(outPath, 0o755);
    return { path: outPath, payloadSha256: sha256 };
}

// JS 侧校验：找到标记行，哈希标记之后的全部字节，与头里声明的 SHA256 比对
async function verifyRunFile(runPath) {
    const fd = fs.openSync(runPath, 'r');
    let headerEnd = -1;
    let headerText = '';
    try {
        const buffer = Buffer.alloc(64 * 1024);
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const text = buffer.toString('latin1', 0, read);
        const marker = `\n${PAYLOAD_MARKER}\n`;
        const index = text.indexOf(marker);
        if (index === -1) throw new Error('没有找到负载标记，不是有效的 .run 文件');
        headerEnd = index + marker.length;
        headerText = text.slice(0, index);
    } finally {
        fs.closeSync(fd);
    }
    const declared = (headerText.match(/^PAYLOAD_SHA256="([0-9a-f]{64})"$/m) || [])[1];
    if (!declared) throw new Error('header 里没有 PAYLOAD_SHA256');
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        fs.createReadStream(runPath, { start: headerEnd })
            .on('data', chunk => hash.update(chunk))
            .on('error', reject)
            .on('end', resolve);
    });
    const actual = hash.digest('hex');
    return { ok: actual === declared, declared, actual };
}

function volumeName(base, index) {
    return `${base}.${String(index + 1).padStart(3, '0')}`;
}

async function splitFile(filePath, volumeBytes = DEFAULT_VOLUME_BYTES) {
    const size = fs.statSync(filePath).size;
    if (size <= volumeBytes) return [filePath];
    const parts = [];
    const fd = fs.openSync(filePath, 'r');
    try {
        for (let offset = 0, index = 0; offset < size; offset += volumeBytes, index += 1) {
            const part = volumeName(filePath, index);
            const end = Math.min(offset + volumeBytes, size) - 1;
            await pipeline(fs.createReadStream(filePath, { start: offset, end, fd, autoClose: false }), fs.createWriteStream(part));
            parts.push(part);
        }
    } finally {
        fs.closeSync(fd);
    }
    fs.rmSync(filePath);
    return parts;
}

async function joinVolumes(parts, outPath) {
    const sorted = [...parts].sort();
    fs.rmSync(outPath, { force: true });
    for (const part of sorted) {
        await pipeline(fs.createReadStream(part), fs.createWriteStream(outPath, { flags: 'a' }));
    }
    return outPath;
}

module.exports = {
    PAYLOAD_MARKER,
    DEFAULT_VOLUME_BYTES,
    renderRunHeader,
    writeRunFile,
    verifyRunFile,
    splitFile,
    joinVolumes,
    volumeName
};
