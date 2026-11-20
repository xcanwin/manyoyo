'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const traffic = require('../lib/egress-traffic');

const ID = '0123456789abcdef';
const ID2 = 'fedcba9876543210';

function record(overrides = {}) {
    return {
        id: ID,
        host: 'api.example.com',
        port: 443,
        decision: 'allow',
        proto: 'https',
        method: 'CONNECT',
        status: 200,
        bytesIn: 100,
        bytesOut: 200,
        durationMs: 12,
        ...overrides
    };
}

describe('egress-traffic：记录与读取', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-traffic-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('写入后有落盘；读取按时间倒序；非法 id / 字段被丢弃', () => {
        const recorder = traffic.createRecorder({ dir, now: () => '2026-01-01T00:00:00.000Z' });
        recorder.record(record({ host: 'a.example.com', ts: '2026-01-01T00:00:00.000Z' }));
        recorder.record(record({ host: 'b.example.com', ts: '2026-01-01T00:00:01.000Z' }));
        recorder.record(record({ id: '../bad' }));
        recorder.record(record({ port: 0 }));
        recorder.record(record({ host: '' }));
        recorder.flush();
        const records = traffic.read(dir, ID);
        expect(records.map(r => r.host)).toEqual(['b.example.com', 'a.example.com']);
        expect(records[0]).toEqual(expect.objectContaining({ port: 443, decision: 'allow', proto: 'https', method: 'CONNECT', status: 200, bytesIn: 100, bytesOut: 200, durationMs: 12 }));
        expect(fs.existsSync(path.join(dir, `${ID}.jsonl`))).toBe(true);
    });

    test('多次 flush 追加；残缺末行跳过', () => {
        const recorder = traffic.createRecorder({ dir });
        recorder.record(record({ host: 'one.example.com' }));
        recorder.flush();
        recorder.record(record({ host: 'two.example.com' }));
        recorder.flush();
        expect(traffic.read(dir, ID).map(r => r.host)).toEqual(['two.example.com', 'one.example.com']);

        fs.appendFileSync(path.join(dir, `${ID}.jsonl`), '{"host":"broken"', 'utf-8');
        expect(traffic.read(dir, ID)).toHaveLength(2);
    });

    test('每容器最多 2000 条：超出丢最旧的；别的容器写满不影响本容器', () => {
        const recorder = traffic.createRecorder({ dir });
        for (let i = 0; i < traffic.MAX_RECORDS + 5; i += 1) {
            recorder.record(record({ host: `h${i}.example.com`, ts: new Date(2026, 0, 1, 0, 0, i).toISOString() }));
            if (i % 400 === 399) recorder.flush(); // 真实环境每秒合并写一次，不会一次攒 2000 条
        }
        recorder.record(record({ id: ID2, host: 'other.example.com' }));
        recorder.flush();
        const records = traffic.read(dir, ID);
        expect(records).toHaveLength(traffic.MAX_RECORDS);
        expect(records[0].host).toBe(`h${traffic.MAX_RECORDS + 4}.example.com`);
        expect(records.some(r => r.host === 'h0.example.com')).toBe(false);
        expect(traffic.read(dir, ID2)).toHaveLength(1);
    });

    test('单文件不超过 1 MiB：写入很大的合法记录也裁剪到上限以内', () => {
        const recorder = traffic.createRecorder({ dir });
        for (let i = 0; i < 400; i += 1) {
            recorder.record(record({ host: `${'x'.repeat(200)}${i}.example.com` }));
        }
        recorder.flush();
        const size = fs.statSync(path.join(dir, `${ID}.jsonl`)).size;
        expect(size).toBeLessThanOrEqual(traffic.MAX_BYTES);
        expect(traffic.read(dir, ID).length).toBeGreaterThan(0);
    });

    test('clear 删除文件；不存在的容器读取为空', () => {
        const recorder = traffic.createRecorder({ dir });
        recorder.record(record());
        recorder.flush();
        traffic.clear(dir, ID);
        expect(traffic.read(dir, ID)).toEqual([]);
        expect(traffic.read(dir, ID2)).toEqual([]);
        expect(() => traffic.clear(dir, '../bad')).toThrow();
        expect(() => traffic.read(dir, '../bad')).toThrow();
    });

    test('stop 冲刷没写盘的增量', () => {
        const recorder = traffic.createRecorder({ dir });
        recorder.record(record({ host: 'last.example.com' }));
        recorder.stop();
        expect(traffic.read(dir, ID).map(r => r.host)).toEqual(['last.example.com']);
    });
});
