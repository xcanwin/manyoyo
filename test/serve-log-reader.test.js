const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    isValidLogDateTag,
    parseServeLogLine,
    readServeLogEntries
} = require('../lib/serve-log-reader');

function writeLog(lines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-log-reader-'));
    const file = path.join(dir, 'serve-2026-09-18.log');
    fs.writeFileSync(file, lines.map(line => `${line}\n`).join(''), 'utf-8');
    return { dir, file };
}

function buildLine(level, message, extra) {
    const ts = '2026-09-18 14:46:08.123';
    const tail = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
    return `[${ts}] [pid:1234] [${level}] ${message}${tail}`;
}

describe('isValidLogDateTag', () => {
    // date 直接拼进文件路径，不校验就能拼出 serve-../../../../etc/x.log 这种目录穿越
    test('只接受 YYYY-MM-DD', () => {
        expect(isValidLogDateTag('2026-09-18')).toBe(true);
        expect(isValidLogDateTag('2026-9-8')).toBe(false);
        expect(isValidLogDateTag('../../../../etc/passwd')).toBe(false);
        expect(isValidLogDateTag('2026-09-18/../..')).toBe(false);
        expect(isValidLogDateTag('')).toBe(false);
        expect(isValidLogDateTag(null)).toBe(false);
    });
});

describe('parseServeLogLine', () => {
    test('解析出时间、pid、级别、消息与结构化附加字段', () => {
        const entry = parseServeLogLine(buildLine('WARN', 'agent stream client disconnected', {
            session: 'demo~agent-2',
            elapsedMs: 182340,
            runContinues: true
        }));
        expect(entry).toEqual({
            ts: '2026-09-18 14:46:08.123',
            pid: 1234,
            level: 'WARN',
            message: 'agent stream client disconnected',
            extra: { session: 'demo~agent-2', elapsedMs: 182340, runContinues: true }
        });
    });

    test('没有附加字段时 extra 为空对象', () => {
        expect(parseServeLogLine(buildLine('INFO', 'web server closing')).extra).toEqual({});
    });

    test('附加字段不是合法 JSON 时降级成 raw，不丢整行', () => {
        const entry = parseServeLogLine('[2026-09-18 14:46:08.123] [pid:1] [ERROR] boom {不是json}');
        expect(entry.message).toBe('boom');
        expect(entry.extra).toEqual({ raw: '{不是json}' });
    });

    test('不符合格式的行返回 null（比如子进程直接打到 stdout 的内容）', () => {
        expect(parseServeLogLine('随便一行输出')).toBeNull();
        expect(parseServeLogLine('')).toBeNull();
    });
});

describe('readServeLogEntries', () => {
    test('默认返回最新的若干条，且按从新到旧排列', () => {
        const { dir, file } = writeLog([
            buildLine('INFO', 'e1'),
            buildLine('INFO', 'e2'),
            buildLine('INFO', 'e3')
        ]);
        try {
            const result = readServeLogEntries(file, { limit: 2 });
            expect(result.entries.map(e => e.message)).toEqual(['e3', 'e2']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('不把整个文件读进内存：只扫描到凑够 limit 为止', () => {
        const many = [];
        for (let i = 0; i < 5000; i += 1) {
            many.push(buildLine('INFO', `填充第 ${i} 条，用来把文件撑大一些`));
        }
        many.push(buildLine('ERROR', '最后一条'));
        const { dir, file } = writeLog(many);
        try {
            const size = fs.statSync(file).size;
            const result = readServeLogEntries(file, { limit: 5 });
            expect(result.entries[0].message).toBe('最后一条');
            expect(result.entries).toHaveLength(5);
            // 扫描字节数应该远小于文件大小，否则就退化成全量读了
            expect(result.scannedBytes).toBeLessThan(size / 4);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('用 nextEndOffset 往前翻页，不重不漏', () => {
        const lines = [];
        for (let i = 1; i <= 10; i += 1) {
            lines.push(buildLine('INFO', `m${i}`));
        }
        const { dir, file } = writeLog(lines);
        try {
            const first = readServeLogEntries(file, { limit: 4 });
            expect(first.entries.map(e => e.message)).toEqual(['m10', 'm9', 'm8', 'm7']);
            expect(typeof first.nextEndOffset).toBe('number');

            const second = readServeLogEntries(file, { limit: 4, endOffset: first.nextEndOffset });
            expect(second.entries.map(e => e.message)).toEqual(['m6', 'm5', 'm4', 'm3']);

            const third = readServeLogEntries(file, { limit: 4, endOffset: second.nextEndOffset });
            expect(third.entries.map(e => e.message)).toEqual(['m2', 'm1']);
            expect(third.nextEndOffset).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('多字节中文跨块也不会被截断成乱码', () => {
        const lines = [];
        for (let i = 0; i < 400; i += 1) {
            lines.push(buildLine('INFO', `中文日志内容第${i}条，包含足够多的汉字以便跨越读取块边界`));
        }
        const { dir, file } = writeLog(lines);
        try {
            const result = readServeLogEntries(file, { limit: 400, chunkSize: 512 });
            expect(result.entries).toHaveLength(400);
            expect(result.entries.every(e => /^中文日志内容第\d+条/.test(e.message))).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('按级别筛选', () => {
        const { dir, file } = writeLog([
            buildLine('INFO', 'i1'),
            buildLine('WARN', 'w1'),
            buildLine('ERROR', 'e1'),
            buildLine('INFO', 'i2')
        ]);
        try {
            const result = readServeLogEntries(file, { limit: 10, levels: ['WARN', 'ERROR'] });
            expect(result.entries.map(e => e.message)).toEqual(['e1', 'w1']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('按关键字筛选（大小写不敏感，覆盖 message 与 extra）', () => {
        const { dir, file } = writeLog([
            buildLine('INFO', 'agent turn started', { session: 'my-easy-20260918-144608' }),
            buildLine('INFO', 'web server started', { port: 8080 })
        ]);
        try {
            expect(readServeLogEntries(file, { limit: 10, keyword: 'AGENT' }).entries).toHaveLength(1);
            expect(readServeLogEntries(file, { limit: 10, keyword: '144608' }).entries).toHaveLength(1);
            expect(readServeLogEntries(file, { limit: 10, keyword: '不存在' }).entries).toHaveLength(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('文件不存在时返回空结果而不是抛错', () => {
        const result = readServeLogEntries('/tmp/manyoyo-not-exist-xyz.log', { limit: 10 });
        expect(result.entries).toEqual([]);
        expect(result.nextEndOffset).toBeNull();
    });

    test('limit 有上限，避免一次拉爆内存', () => {
        const { dir, file } = writeLog([buildLine('INFO', 'only')]);
        try {
            const result = readServeLogEntries(file, { limit: 999999 });
            expect(result.limit).toBeLessThanOrEqual(500);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
