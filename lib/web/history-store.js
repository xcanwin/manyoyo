'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeConfigFileSecure } = require('../secure-file');

// 历史文件的进程内缓存 + 原子写 + 合并写盘。
// - 读：stat 的 ino + mtimeMs + size 没变就直接返回缓存对象（原子写每次都会换 inode，别的进程改了也能认出来）。
// - 版本号：进程内单调计数，加启动时随机的 bootId，供 ETag 使用；不能只用 mtime（同一毫秒内的两次写入会撞）。
// - 写：默认立即原子写；defer 写只改内存并最迟 DEFER_FLUSH_MS 后落盘，serve 关闭时 flushAll。

const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const DEFER_FLUSH_MS = 1000;

const bootId = crypto.randomBytes(3).toString('hex');
const cache = new Map();
// 版本号单独记：缓存条目被淘汰后 ETag 的版本号也不能丢（否则内容变了版本还是 0）
const versions = new Map();
const backedUp = new Set();
let versionSeq = 0;
let flushTimer = null;

function nextVersion(filePath) {
    versionSeq += 1;
    versions.set(filePath, versionSeq);
    return versionSeq;
}

function statKey(stat) {
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
}

function evictIfNeeded(keep) {
    let total = 0;
    cache.forEach(entry => { total += entry.bytes; });
    if (total <= CACHE_MAX_BYTES) {
        return;
    }
    const candidates = [...cache.entries()]
        .filter(([key, entry]) => !entry.dirty && key !== keep)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of candidates) {
        if (total <= CACHE_MAX_BYTES) {
            break;
        }
        cache.delete(key);
        total -= entry.bytes;
    }
}

function touch(entry) {
    entry.lastUsed = Date.now();
}

/**
 * @param {string} filePath
 * @param {(raw: any) => any} normalize 把解析出的 JSON 归一化为内存对象
 * @returns {{ value: any, version: number }|null} 文件不存在返回 null
 */
function read(filePath, normalize) {
    let stat = null;
    try {
        stat = fs.statSync(filePath);
    } catch (e) {
        stat = null;
    }
    const entry = cache.get(filePath);
    if (entry && entry.dirty) {
        // 内存里有尚未落盘的更新，比磁盘新
        touch(entry);
        return { value: entry.value, version: entry.version };
    }
    if (!stat) {
        cache.delete(filePath);
        return null;
    }
    if (entry && entry.key === statKey(stat)) {
        touch(entry);
        return { value: entry.value, version: entry.version };
    }
    const text = fs.readFileSync(filePath, 'utf-8');
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        // 解析失败：留一份备份，免得下一次保存把空历史写回去后原文彻底丢失（同一份损坏内容只备份一次）
        const corruptKey = `${filePath}|${statKey(stat)}`;
        if (!backedUp.has(corruptKey)) {
            backedUp.add(corruptKey);
            try {
                fs.copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`);
            } catch (copyError) { /* 尽力 */ }
        }
        cache.delete(filePath);
        return null;
    }
    const value = normalize(parsed);
    const next = {
        value,
        version: nextVersion(filePath),
        key: statKey(stat),
        bytes: stat.size,
        dirty: false,
        lastUsed: Date.now(),
        serialize: null
    };
    cache.set(filePath, next);
    evictIfNeeded(filePath);
    return { value, version: next.version };
}

function writeEntry(filePath, entry) {
    const text = entry.serialize(entry.value);
    writeConfigFileSecure(filePath, text);
    const stat = fs.statSync(filePath);
    entry.key = statKey(stat);
    entry.bytes = stat.size;
    entry.dirty = false;
}

function scheduleFlush() {
    if (flushTimer) {
        return;
    }
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushAll();
    }, DEFER_FLUSH_MS);
    if (typeof flushTimer.unref === 'function') {
        flushTimer.unref();
    }
}

/**
 * @param {string} filePath
 * @param {any} value 已归一化的内存对象（成为新的缓存值）
 * @param {(value: any) => string} serialize
 * @param {{ defer?: boolean }} [options]
 * @returns {number} 新版本号
 */
function write(filePath, value, serialize, options = {}) {
    const entry = {
        value,
        version: nextVersion(filePath),
        key: '',
        bytes: 0,
        dirty: true,
        lastUsed: Date.now(),
        serialize
    };
    const previous = cache.get(filePath);
    if (previous) {
        entry.bytes = previous.bytes;
    }
    cache.set(filePath, entry);
    if (options.defer === true) {
        scheduleFlush();
        return entry.version;
    }
    try {
        writeEntry(filePath, entry);
    } catch (error) {
        cache.delete(filePath);
        throw error;
    }
    evictIfNeeded(filePath);
    return entry.version;
}

/** 立即写出所有待写内容；目录已不存在（如测试清理后）则放弃，不重新建目录 */
function flushAll() {
    let failed = false;
    cache.forEach((entry, filePath) => {
        if (!entry.dirty) {
            return;
        }
        if (!fs.existsSync(path.dirname(filePath))) {
            cache.delete(filePath);
            return;
        }
        try {
            writeEntry(filePath, entry);
        } catch (error) {
            failed = true;
        }
    });
    if (failed) {
        // 写失败（磁盘满、权限）：稍后再试，不要等到下一次写入
        scheduleFlush();
    }
}

function flushFile(filePath) {
    const entry = cache.get(filePath);
    if (entry && entry.dirty) {
        writeEntry(filePath, entry);
    }
}

function remove(filePath) {
    cache.delete(filePath);
    versions.delete(filePath);
}

function getVersion(filePath) {
    return versions.get(filePath) || 0;
}

// 进程退出（含信号处理里的 process.exit）前写出待写内容
process.on('exit', flushAll);

module.exports = {
    bootId,
    read,
    write,
    flushAll,
    flushFile,
    remove,
    getVersion
};
