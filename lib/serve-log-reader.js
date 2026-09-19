'use strict';

const fs = require('fs');

// serve 日志一行的格式（写入侧见 bin/manyoyo.js 的 createServeLogger）：
//   [<本地时间>] [pid:<pid>] [<LEVEL>] <message>[ <extra JSON>]
const SERVE_LOG_LINE_PATTERN = /^\[([^\]]+)\] \[pid:(\d+)\] \[([A-Z]+)\] (.*)$/;
const LOG_DATE_TAG_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_CHUNK_SIZE = 64 * 1024;
// 过滤条件很窄（比如只看 error）时可能扫很久都凑不满 limit，给一个扫描上限兜底，
// 避免一次请求把整份日志读完、把事件循环堵住
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

function isValidLogDateTag(value) {
    return typeof value === 'string' && LOG_DATE_TAG_PATTERN.test(value);
}

// message 与 extra 之间没有分隔符，只能从右边找第一个能当 JSON 解析的 "{...}"。
// 解析不出来就整体当 message，不丢内容
function splitMessageAndExtra(rest) {
    const text = String(rest || '');
    const braceIndex = text.indexOf(' {');
    if (braceIndex === -1) {
        return { message: text.trim(), extra: {} };
    }
    const message = text.slice(0, braceIndex).trim();
    const tail = text.slice(braceIndex + 1);
    try {
        const parsed = JSON.parse(tail);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { message, extra: parsed };
        }
    } catch (e) {
        // 落到下面的 raw 分支
    }
    return { message, extra: { raw: tail } };
}

function parseServeLogLine(line) {
    const matched = String(line || '').match(SERVE_LOG_LINE_PATTERN);
    if (!matched) {
        return null;
    }
    const { message, extra } = splitMessageAndExtra(matched[4]);
    return {
        ts: matched[1],
        pid: Number(matched[2]),
        level: matched[3],
        message,
        extra
    };
}

function normalizeLimit(limit) {
    const parsed = Number(limit);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_LIMIT;
    }
    return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function buildMatcher(options) {
    const levels = Array.isArray(options.levels) && options.levels.length
        ? new Set(options.levels.map(level => String(level).toUpperCase()))
        : null;
    const keyword = options.keyword ? String(options.keyword).toLowerCase() : '';
    const session = options.session ? String(options.session) : '';
    return (entry, rawLine) => {
        if (levels && !levels.has(entry.level)) {
            return false;
        }
        if (session && entry.extra.session !== session) {
            return false;
        }
        if (keyword && !rawLine.toLowerCase().includes(keyword)) {
            return false;
        }
        return true;
    };
}

// 从文件末尾往前分块读，凑够 limit 条就停——日志文件会长到几十 MB，
// 整份 readFileSync + split('\n') 是同步阻塞，会把 serve 的事件循环卡住
// （见 CLAUDE.md 的日志约束）。用 Buffer 按换行字节切分，中文跨块也不会被截断。
// endOffset 是翻页游标：传上一页返回的 nextEndOffset 就能继续往更早翻
function readServeLogEntries(filePath, options = {}) {
    const limit = normalizeLimit(options.limit);
    const chunkSize = Number.isFinite(options.chunkSize) && options.chunkSize > 0
        ? Math.floor(options.chunkSize)
        : DEFAULT_CHUNK_SIZE;
    const empty = { entries: [], nextEndOffset: null, scannedBytes: 0, limit };

    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (e) {
        return empty;
    }
    if (!stat.isFile()) {
        return empty;
    }

    const size = stat.size;
    const requestedEnd = Number(options.endOffset);
    let end = Number.isFinite(requestedEnd) && requestedEnd >= 0 ? Math.min(requestedEnd, size) : size;
    if (end <= 0) {
        return empty;
    }

    const matches = buildMatcher(options);
    const entries = [];
    let scannedBytes = 0;
    let pos = end;
    // pending 里的字节在文件中的起始偏移就是 pos；开头那一行可能不完整，
    // 要留到下一轮（读到更早的块）再拼
    let pending = Buffer.alloc(0);
    let unconsumedEnd = end;
    let reachedLimit = false;

    const fd = fs.openSync(filePath, 'r');
    try {
        while (pos > 0 && !reachedLimit && scannedBytes < MAX_SCAN_BYTES) {
            const readSize = Math.min(chunkSize, pos);
            pos -= readSize;
            scannedBytes += readSize;
            const buf = Buffer.alloc(readSize);
            fs.readSync(fd, buf, 0, readSize, pos);
            pending = pending.length ? Buffer.concat([buf, pending]) : buf;

            let lineEnd = pending.length;
            let newlineIndex = pending.lastIndexOf(NEWLINE, lineEnd - 1);
            while (newlineIndex >= 0) {
                const rawLine = pending.subarray(newlineIndex + 1, lineEnd).toString('utf-8');
                lineEnd = newlineIndex;
                const entry = parseServeLogLine(rawLine);
                if (entry && matches(entry, rawLine)) {
                    entries.push(entry);
                    if (entries.length >= limit) {
                        reachedLimit = true;
                        break;
                    }
                }
                newlineIndex = pending.lastIndexOf(NEWLINE, lineEnd - 1);
            }
            pending = pending.subarray(0, lineEnd);
            unconsumedEnd = pos + lineEnd;
        }

        // 文件开头那一行前面没有换行符，单独收尾
        if (!reachedLimit && pos === 0 && pending.length) {
            const rawLine = pending.toString('utf-8');
            const entry = parseServeLogLine(rawLine);
            if (entry && matches(entry, rawLine)) {
                entries.push(entry);
            }
            unconsumedEnd = 0;
        }
    } finally {
        fs.closeSync(fd);
    }

    return {
        entries,
        nextEndOffset: unconsumedEnd > 0 ? unconsumedEnd : null,
        scannedBytes,
        limit
    };
}

module.exports = {
    isValidLogDateTag,
    parseServeLogLine,
    readServeLogEntries
};
