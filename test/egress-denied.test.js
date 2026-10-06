'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const denied = require('../lib/egress-denied');

const ID = 'aaaaaaaaaaaaaaaa';

describe('egress-denied 拒绝记录', () => {
    let dir;
    let tick;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-denied-'));
        tick = 0;
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const makeRecorder = () => denied.createRecorder({ dir, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString() });

    test('同一 host:port 合并计数，按最近出现倒序；不同端口分开', () => {
        const rec = makeRecorder();
        ['a.example.com', 'b.example.com', 'a.example.com', 'a.example.com'].forEach(host => rec.record({ id: ID, host, port: 443, reason: 'domain' }));
        rec.record({ id: ID, host: 'a.example.com', port: 80, reason: 'domain' });
        rec.flush();
        const list = denied.read(dir, ID);
        expect(list.map(r => [r.host, r.port, r.count])).toEqual([['a.example.com', 80, 1], ['a.example.com', 443, 3], ['b.example.com', 443, 1]]);
        // 再来一批：在磁盘内容上累加
        const again = makeRecorder();
        again.record({ id: ID, host: 'b.example.com', port: 443, reason: 'address' });
        again.flush();
        const b = denied.read(dir, ID).find(r => r.host === 'b.example.com');
        expect(b.count).toBe(2);
        expect(b.reason).toBe('address');
    });

    test('宿主机清空后从空白重新计数', () => {
        const rec = makeRecorder();
        rec.record({ id: ID, host: 'a.example.com', port: 443, reason: 'domain' });
        rec.flush();
        denied.clear(dir, ID);
        expect(denied.read(dir, ID)).toEqual([]);
        rec.record({ id: ID, host: 'a.example.com', port: 443, reason: 'domain' });
        rec.flush();
        expect(denied.read(dir, ID)[0].count).toBe(1);
        denied.clear(dir, ID);
        expect(() => denied.clear(dir, ID)).not.toThrow();
    });

    test('文件超过 256 KiB 时丢掉最久没出现的，保留最新的', () => {
        const records = [];
        for (let i = 0; i < 5000; i += 1) {
            records.push({ host: `host-${i}-${'x'.repeat(100)}.example.com`, port: 443, reason: 'domain', count: 1, first: '2026-01-01T00:00:00.000Z', last: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
        }
        const text = denied.serialize(records);
        expect(text.length).toBeLessThanOrEqual(denied.MAX_BYTES);
        const kept = denied.parse(text);
        expect(kept.length).toBeLessThanOrEqual(denied.MAX_RECORDS);
        expect(kept.some(r => r.host.startsWith('host-4999-'))).toBe(true);
        expect(kept.some(r => r.host.startsWith('host-0-'))).toBe(false);
    });

    test('高频记录只写一次盘（定时合并）；非法 id 不落盘、不抛错', () => {
        jest.useFakeTimers();
        try {
            const rec = makeRecorder();
            for (let i = 0; i < 1000; i += 1) rec.record({ id: ID, host: 'a.example.com', port: 443, reason: 'domain' });
            rec.record({ id: '../etc', host: 'x.example.com', port: 443, reason: 'domain' });
            expect(fs.readdirSync(dir)).toEqual([]);
            jest.advanceTimersByTime(1100);
            expect(fs.readdirSync(dir)).toEqual([`${ID}.jsonl`]);
            expect(denied.read(dir, ID)[0].count).toBe(1000);
            expect(() => denied.read(dir, '../etc')).toThrow();
        } finally {
            jest.useRealTimers();
        }
    });

    test('内存增量有上限：不同 host 太多时丢弃多出来的，超长 host 不记录', () => {
        const rec = makeRecorder();
        for (let i = 0; i < denied.MAX_PENDING_PER_ID + 100; i += 1) rec.record({ id: ID, host: `h${i}.example.com`, port: 443, reason: 'domain' });
        rec.record({ id: ID, host: `${'a'.repeat(300)}.example.com`, port: 443, reason: 'domain' });
        rec.record({ id: ID, host: 'h0.example.com', port: 443, reason: 'domain' }); // 已有的 key 仍然累加
        rec.flush();
        const list = denied.read(dir, ID);
        expect(list.length).toBe(denied.MAX_PENDING_PER_ID);
        expect(list.find(r => r.host === 'h0.example.com').count).toBe(2);
        expect(list.some(r => r.host.length > 255)).toBe(false);
    });
});
