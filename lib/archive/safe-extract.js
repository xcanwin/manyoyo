'use strict';

// 宿主机侧解包的安全规则（导入的归档可能来自别人）：
// - 拒绝绝对路径、`..`、空段、NUL、硬链接、设备等特殊文件；
// - 写文件前逐级 lstat：父目录必须是本次新建的真实目录（不是符号链接），目标不能是已存在的符号链接；
// - 去掉 setuid / setgid / sticky；
// - 符号链接不在解包时创建：先记下来，最后只在“相对路径且解析后仍在根目录内”时创建，其余跳过并计数。

const fs = require('fs');
const path = require('path');

const HOLE_BLOCK = 64 * 1024;
const ZEROS = Buffer.alloc(HOLE_BLOCK);

function writeAt(fd, buffer, position) {
    return new Promise((resolve, reject) => {
        let written = 0;
        const next = () => {
            fs.write(fd, buffer, written, buffer.length - written, position + written, (error, n) => {
                if (error) return reject(error);
                written += n;
                if (written >= buffer.length) return resolve();
                next();
            });
        };
        next();
    });
}

class UnsafeEntryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UnsafeEntryError';
    }
}

// 归档里的相对路径 → 段数组；不合规直接抛错
function splitEntryPath(name) {
    if (typeof name !== 'string' || name.length === 0) throw new UnsafeEntryError('条目名为空');
    if (name.includes('\0')) throw new UnsafeEntryError('条目名含 NUL');
    if (name.includes('\\')) throw new UnsafeEntryError(`条目名含反斜杠: ${name}`);
    if (name.startsWith('/')) throw new UnsafeEntryError(`条目名是绝对路径: ${name}`);
    const segments = name.split('/');
    if (segments[segments.length - 1] === '') segments.pop();
    if (!segments.length) throw new UnsafeEntryError('条目名为空');
    for (const segment of segments) {
        if (segment === '' ) throw new UnsafeEntryError(`条目名含空段: ${name}`);
        if (segment === '.' || segment === '..') throw new UnsafeEntryError(`条目名含 ${segment}: ${name}`);
    }
    return segments;
}

function safeMode(mode, isDir) {
    // 只留 rwx 九位，去掉 setuid / setgid / sticky；目录至少本人可进入可写（解包过程需要）
    const base = (Number(mode) || 0) & 0o777;
    return isDir ? (base | 0o700) : (base || 0o600);
}

class SafeExtractor {
    /**
     * root：本次导入的临时目录（调用方新建，已存在）。
     * limits：{ maxFiles, maxBytes }，防止无限膨胀。
     */
    constructor(root, limits = {}) {
        this.root = fs.realpathSync(root);
        this.created = new Set([this.root]);
        this.deferredLinks = [];
        this.skippedLinks = 0;
        this.skippedSpecial = 0;
        this.files = 0;
        this.bytes = 0;
        this.maxFiles = limits.maxFiles || 5_000_000;
        this.maxBytes = limits.maxBytes || Infinity;
    }

    // 逐级确认父目录是“本次新建的真实目录”；缺的就建
    ensureDir(segments) {
        let current = this.root;
        for (const segment of segments) {
            const next = path.join(current, segment);
            let stat = null;
            try {
                stat = fs.lstatSync(next);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            if (stat === null) {
                fs.mkdirSync(next, { mode: 0o700 });
                this.created.add(next);
            } else if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new UnsafeEntryError(`父路径不是目录: ${next}`);
            } else if (!this.created.has(next)) {
                throw new UnsafeEntryError(`父目录不是本次导入新建的: ${next}`);
            }
            current = next;
        }
        return current;
    }

    addDir(name, mode) {
        const segments = splitEntryPath(name);
        const dir = this.ensureDir(segments);
        try { fs.chmodSync(dir, safeMode(mode, true)); } catch (error) { /* 尽力而为 */ }
    }

    // body：异步可迭代的字节流
    async addFile(name, mode, body, expectedSize) {
        const segments = splitEntryPath(name);
        this.files += 1;
        if (this.files > this.maxFiles) throw new UnsafeEntryError('条目数量超过上限');
        if (this.bytes + expectedSize > this.maxBytes) throw new UnsafeEntryError('解包大小超过上限');
        const parent = this.ensureDir(segments.slice(0, -1));
        const target = path.join(parent, segments[segments.length - 1]);
        let flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
        const fd = fs.openSync(target, flags, safeMode(mode, false));
        try {
            // 全 0 的块不写（留成空洞），最后按大小截断：稀疏文件解出来不会被撑成实心
            let position = 0;
            for await (const chunk of body) {
                this.bytes += chunk.length;
                if (this.bytes > this.maxBytes) throw new UnsafeEntryError('解包大小超过上限');
                for (let offset = 0; offset < chunk.length; offset += HOLE_BLOCK) {
                    const piece = chunk.subarray(offset, Math.min(offset + HOLE_BLOCK, chunk.length));
                    if (Buffer.compare(piece, ZEROS.subarray(0, piece.length)) !== 0) await writeAt(fd, piece, position);
                    position += piece.length;
                }
            }
            fs.ftruncateSync(fd, position);
        } finally {
            // 出错时可能已经关过 fd：再关一次报 EBADF 会盖掉真正的错误
            try { fs.closeSync(fd); } catch (error) { if (error.code !== 'EBADF') throw error; }
        }
        return target;
    }

    // 符号链接：先记下，最后统一处理
    addSymlink(name, linkname) {
        const segments = splitEntryPath(name);
        this.deferredLinks.push({ segments, linkname: String(linkname || '') });
    }

    skipSpecial() {
        this.skippedSpecial += 1;
    }

    // 所有文件落地后调用：只创建“相对路径且解析后仍在 root 内”的链接
    finalizeSymlinks() {
        let made = 0;
        for (const { segments, linkname } of this.deferredLinks) {
            const verdict = this.checkLink(segments, linkname);
            if (!verdict) {
                this.skippedLinks += 1;
                continue;
            }
            try {
                const parent = this.ensureDir(segments.slice(0, -1));
                const target = path.join(parent, segments[segments.length - 1]);
                try {
                    fs.lstatSync(target);
                    this.skippedLinks += 1;
                    continue;
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
                fs.symlinkSync(linkname, target);
                made += 1;
            } catch (error) {
                this.skippedLinks += 1;
            }
        }
        this.deferredLinks = [];
        return made;
    }

    checkLink(segments, linkname) {
        if (!linkname || linkname.includes('\0') || path.isAbsolute(linkname)) return false;
        const dirOfLink = path.join(this.root, ...segments.slice(0, -1));
        const resolved = path.resolve(dirOfLink, linkname);
        return resolved === this.root || resolved.startsWith(`${this.root}${path.sep}`);
    }
}

module.exports = { SafeExtractor, UnsafeEntryError, splitEntryPath, safeMode };
