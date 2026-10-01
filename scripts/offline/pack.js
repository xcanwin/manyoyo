'use strict';

// .run = sh 头 + tar.gz 负载。头部自校验（SHA256），用 sh 执行，不经 macOS 对下载可执行文件的拦截。
// 超过 GitHub Release 单文件上限时按卷拆分（.run.001 …）：同目录下直接 sh xxx.run.001 即可（头里记录卷数，按序流式拼接校验与解包）；手动 cat 合并后当单文件用也行。

const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { sha256File } = require('../../lib/download-verified');

const PAYLOAD_MARKER = '__MANYOYO_PAYLOAD_BELOW__';
const DEFAULT_VOLUME_BYTES = 1900 * 1000 * 1000;

function renderRunHeader({ name, sha256, volumes = 1 }) {
    if (!Number.isInteger(volumes) || volumes < 1 || volumes > 9999) throw new Error(`volumes 不合法: ${volumes}`);
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
# 分卷（${name}.run.001、.002 …）：放在同一目录，直接 sh ${name}.run.001 即可，不用手动合并。
set -eu

PAYLOAD_SHA256="${sha256}"
VOLUMES=${String(volumes).padStart(4, '0')}
self="$0"

hash_cmd() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256; else sha256sum; fi
}
# 分卷模式：被执行的文件是 xxx.run.001，且头里记录的卷数大于 1；合并后的单文件不走这里
split_mode=0
vol_base=""
vol_count="$(expr "$VOLUMES" + 0)"
case "$self" in
    *.run.001) if [ "$vol_count" -gt 1 ]; then split_mode=1; vol_base="\${self%.001}"; fi ;;
esac
vol_name() { printf '%s.%03d' "$vol_base" "$1"; }
file_size() { wc -c < "$1" | tr -d ' '; }
check_volumes() {
    [ "$split_mode" = 1 ] || return 0
    first_size="$(file_size "$self")"
    i=2
    while [ "$i" -le "$vol_count" ]; do
        v="$(vol_name "$i")"
        if [ ! -f "$v" ]; then
            echo "缺少分卷：找不到 \${v}（共 \${vol_count} 卷）。请把所有分卷下载到同一个目录后重试。" >&2
            exit 1
        fi
        if [ "$i" -lt "$vol_count" ] && [ "$(file_size "$v")" != "$first_size" ]; then
            echo "分卷大小不对：\${v} 应为 \${first_size} 字节，实际 $(file_size "$v")。请重新下载这一卷。" >&2
            exit 1
        fi
        i=$((i + 1))
    done
}
payload() {
    tail -n +"$(awk '/^${PAYLOAD_MARKER}$/ { print NR + 1; exit }' "$self")" "$self"
    if [ "$split_mode" = 1 ]; then
        i=2
        while [ "$i" -le "$vol_count" ]; do
            cat "$(vol_name "$i")"
            i=$((i + 1))
        done
    fi
}
verify() {
    check_volumes
    actual="$(payload | hash_cmd | awk '{ print $1 }')"
    if [ "$actual" != "$PAYLOAD_SHA256" ]; then
        if [ "$split_mode" = 1 ]; then
            echo "校验失败：分卷内容不完整或已被修改（期望 \${PAYLOAD_SHA256}，实际 \${actual}）。请重新下载校验不通过的分卷（对照 SHA256SUMS）。" >&2
        else
            echo "校验失败：安装包不完整或已被修改（期望 \${PAYLOAD_SHA256}，实际 \${actual}）。请重新下载。" >&2
        fi
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
    -h|--help) sed -n '2,13p' "$self"; exit 0 ;;
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

// volumeBytes：之后会按这个大小拆卷，头里要先写好卷数（头长度与卷数无关，所以总大小可提前算出，拆分与合并结果字节一致）
async function writeRunFile({ payloadPath, outPath, name, volumeBytes = 0 }) {
    const sha256 = await sha256File(payloadPath);
    const headerBytes = Buffer.byteLength(renderRunHeader({ name, sha256 }));
    const total = headerBytes + fs.statSync(payloadPath).size;
    const volumes = volumeBytes > 0 ? Math.max(1, Math.ceil(total / volumeBytes)) : 1;
    fs.writeFileSync(outPath, renderRunHeader({ name, sha256, volumes }), { mode: 0o755 });
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
