'use strict';

const fs = require('fs');
const path = require('path');
const { isValidId } = require('./container-id');

// 过滤代理放行的 HTTP(S) 元数据记录：每个容器一个 <id>.jsonl，逐条时间线（不按 host 聚合）。
// sidecar 里写（traffic 目录以读写方式挂入）、宿主机异步读 / 清空。
// 只存 host / 端口 / 方法 / 状态 / 字节 / 耗时，绝不存 path、query、正文、Cookie、Proxy-Authorization。
// 每容器上限 2000 条或 1 MiB，先到先裁；不做跨容器全局上限（总量随容器数自然有界，删除容器时清理）。
const MAX_RECORDS = 2000;
const MAX_BYTES = 1024 * 1024;
const FLUSH_MS = 1000;
const MAX_PENDING_PER_ID = MAX_RECORDS; // 一次合并周期内最多攒满一整个容器的上限，超出由裁剪保证
const MAX_HOST_LENGTH = 255;

function fileOf(dir, id) {
    if (!isValidId(id)) throw new Error(`非法的容器 id: ${id}`);
    return path.join(dir, `${id}.jsonl`);
}

function cleanText(value, max) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .slice(0, max);
}

function cleanCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return 0;
    return Math.min(Math.floor(number), 1e12);
}

function normalizeRecord(entry, at) {
    const host = cleanText(entry.host, MAX_HOST_LENGTH).toLowerCase();
    const port = Number(entry.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    const decision = entry.decision === 'deny' ? 'deny' : entry.decision === 'allow' ? 'allow' : '';
    if (!decision) return null;
    const proto = ['http', 'https', 'tcp'].includes(entry.proto) ? entry.proto : 'tcp';
    return {
        ts: typeof entry.ts === 'string' && entry.ts ? cleanText(entry.ts, 40) : at,
        host,
        port,
        decision,
        proto,
        method: cleanText(entry.method, 20).toUpperCase(),
        status: Number.isInteger(Number(entry.status)) ? Math.min(Math.max(Number(entry.status), 0), 599) : 0,
        bytesIn: cleanCount(entry.bytesIn),
        bytesOut: cleanCount(entry.bytesOut),
        durationMs: cleanCount(entry.durationMs)
    };
}

function parse(text) {
    const records = [];
    String(text || '').split('\n').forEach(line => {
        if (!line.trim()) return;
        try {
            const item = JSON.parse(line);
            const normalized = normalizeRecord(item, '');
            if (normalized) records.push(normalized);
        } catch (e) { /* 损坏 / 残缺的行跳过 */ }
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

async function readFileSafeAsync(file) {
    try {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile() || stat.size > MAX_BYTES * 2) return '';
        return await fs.promises.readFile(file, 'utf-8');
    } catch (e) {
        return '';
    }
}

/** 只保留最新的记录：先按条数，再按字节（从末尾往前累加）。 */
function serialize(records) {
    const kept = [];
    let text = '';
    for (let i = records.length - 1; i >= 0 && kept.length < MAX_RECORDS; i -= 1) {
        const line = `${JSON.stringify(records[i])}\n`;
        if (text.length + line.length > MAX_BYTES) break;
        text = line + text;
        kept.push(records[i]);
    }
    return text;
}

/** 宿主机：按时间倒序返回（最新的在前）。 */
function read(dir, id) {
    return parse(readFileSafe(fileOf(dir, id))).reverse();
}

/** 宿主机：异步读取（长文件不阻塞事件循环）。 */
async function readAsync(dir, id) {
    return parse(await readFileSafeAsync(fileOf(dir, id))).reverse();
}

/** 宿主机：清空（删文件）。 */
function clear(dir, id) {
    try {
        fs.unlinkSync(fileOf(dir, id));
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
    }
}

/**
 * sidecar：异步记录允许的 HTTP(S)。内存里攒增量，每秒合并写盘一次；
 * 合并时以磁盘当前内容为底，宿主机清空后从空白重新开始。写失败不影响代理本身。
 */
function createRecorder(options) {
    const dir = options.dir;
    const now = options.now || (() => new Date().toISOString());
    const flushMs = Number(options.flushMs) || FLUSH_MS;
    const pending = new Map(); // id → record[]
    let timer = null;

    function schedule() {
        if (timer) return;
        timer = setTimeout(() => { timer = null; flush(); }, flushMs);
        if (timer.unref) timer.unref();
    }

    function record(entry) {
        const id = entry && entry.id;
        if (!isValidId(id)) return;
        const normalized = normalizeRecord(entry, now());
        if (!normalized) return;
        const list = pending.get(id) || [];
        pending.set(id, list);
        if (list.length >= MAX_PENDING_PER_ID) return;
        list.push(normalized);
        schedule();
    }

    function flush() {
        const batch = [...pending.entries()];
        pending.clear();
        for (const [id, list] of batch) {
            try {
                const file = fileOf(dir, id);
                const existing = parse(readFileSafe(file));
                const tmp = `${file}.tmp`;
                fs.writeFileSync(tmp, serialize(existing.concat(list)), { mode: 0o644 });
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

module.exports = { MAX_RECORDS, MAX_BYTES, MAX_PENDING_PER_ID, read, readAsync, clear, parse, serialize, createRecorder };
