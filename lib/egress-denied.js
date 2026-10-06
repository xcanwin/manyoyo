'use strict';

const fs = require('fs');
const path = require('path');
const { isValidId } = require('./container-id');

// 过滤代理拒绝过的访问记录：每个容器一个 <id>.jsonl，同一 host:port 合并计数。
// sidecar 里写（目录以读写方式挂入）、宿主机读 / 清空。文件超过 256 KiB 就丢最久没出现的。
// 只依赖 node 内置模块：sidecar 里带的就是这个文件。
const MAX_BYTES = 256 * 1024;
const MAX_RECORDS = 1000;
const FLUSH_MS = 1000;
const MAX_PENDING_PER_ID = 500; // 一次合并周期内最多攒这么多不同的 host:port，防止被刷爆内存
const MAX_HOST_LENGTH = 255;

function fileOf(dir, id) {
    if (!isValidId(id)) throw new Error(`非法的容器 id: ${id}`);
    return path.join(dir, `${id}.jsonl`);
}

function parse(text) {
    const records = [];
    String(text || '').split('\n').forEach(line => {
        if (!line.trim()) return;
        try {
            const r = JSON.parse(line);
            if (typeof r.host === 'string' && Number.isInteger(r.port) && Number.isInteger(r.count)) {
                records.push({ host: r.host, port: r.port, reason: String(r.reason || ''), count: r.count, first: String(r.first || ''), last: String(r.last || '') });
            }
        } catch (e) { /* 损坏的行跳过 */ }
    });
    return records;
}

function readFileSafe(file) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_BYTES * 2) return '';
        return fs.readFileSync(file, 'utf-8');
    } catch (e) {
        return '';
    }
}

/** 宿主机：按最近出现时间倒序返回 [{host, port, reason, count, first, last}] */
function read(dir, id) {
    return parse(readFileSafe(fileOf(dir, id))).sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}

/** 宿主机：清空（删文件；目录是宿主机用户的，sidecar 以 root 写出的文件也删得掉） */
function clear(dir, id) {
    try { fs.unlinkSync(fileOf(dir, id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function serialize(records) {
    const sorted = records.slice().sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0)).slice(0, MAX_RECORDS);
    let text = '';
    const kept = [];
    for (const r of sorted) {
        const line = `${JSON.stringify(r)}\n`;
        if (text.length + line.length > MAX_BYTES) break;
        text += line;
        kept.push(r);
    }
    return text;
}

/**
 * sidecar：记录拒绝。内存里只攒“还没写盘的增量”，每秒合并进文件一次（高频路径不逐条写盘）；
 * 合并时总是以磁盘上的当前内容为底，所以宿主机清空（删文件）后会从空白重新计数。
 */
function createRecorder(options) {
    const dir = options.dir;
    const now = options.now || (() => new Date().toISOString());
    const pending = new Map(); // id → Map(host:port → record 增量)
    let timer = null;

    function record({ id, host, port, reason }) {
        if (!isValidId(id) || !host || host.length > MAX_HOST_LENGTH || !Number.isInteger(port)) return;
        const byKey = pending.get(id) || new Map();
        pending.set(id, byKey);
        const key = `${host}:${port}`;
        if (!byKey.has(key) && byKey.size >= MAX_PENDING_PER_ID) return;
        const at = now();
        const hit = byKey.get(key);
        if (hit) {
            hit.count += 1;
            hit.last = at;
            hit.reason = reason;
        } else {
            byKey.set(key, { host, port, reason, count: 1, first: at, last: at });
        }
        if (!timer) {
            timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS);
            if (timer.unref) timer.unref();
        }
    }

    function flush() {
        const batch = [...pending.entries()];
        pending.clear();
        for (const [id, byKey] of batch) {
            try {
                const file = fileOf(dir, id);
                const merged = new Map(parse(readFileSafe(file)).map(r => [`${r.host}:${r.port}`, r]));
                byKey.forEach((delta, key) => {
                    const old = merged.get(key);
                    merged.set(key, old
                        ? { ...old, reason: delta.reason, count: old.count + delta.count, last: delta.last }
                        : delta);
                });
                const tmp = `${file}.tmp`;
                fs.writeFileSync(tmp, serialize([...merged.values()]), { mode: 0o644 });
                fs.renameSync(tmp, file);
            } catch (e) { /* 写不进去不影响代理本身 */ }
        }
    }

    function stop() {
        if (timer) clearTimeout(timer);
        timer = null;
        flush();
    }

    return { record, flush, stop };
}

module.exports = { MAX_BYTES, MAX_RECORDS, MAX_PENDING_PER_ID, read, clear, parse, serialize, createRecorder };
