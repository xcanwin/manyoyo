'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createControlEvent } = require('../lib/core/events');
const { FileEventStore } = require('../lib/core/event-store');

describe('FileEventStore', () => {
    let rootDir;
    let store;

    beforeEach(() => {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-event-store-'));
        store = new FileEventStore(rootDir);
    });

    afterEach(() => {
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    test('appends ordered events and persists a projection snapshot', () => {
        const aggregateId = 'demo~agent-1';
        store.append(createControlEvent({ type: 'session.ready', aggregateId, seq: 1 }));
        store.append(createControlEvent({ type: 'process.exited', aggregateId, seq: 2, data: { exitCode: 0 } }));

        expect(store.read(aggregateId)).toHaveLength(2);
        expect(store.loadProjection(aggregateId)).toEqual(expect.objectContaining({
            aggregateId,
            status: 'completed',
            lastSeq: 2
        }));
    });

    test('recovers valid events when the final log line is incomplete', () => {
        const aggregateId = 'demo';
        store.append(createControlEvent({ type: 'session.ready', aggregateId, seq: 1 }));
        fs.appendFileSync(store.getEventFilePath(aggregateId), '{"broken"');

        expect(store.read(aggregateId)).toHaveLength(1);
        expect(store.loadProjection(aggregateId)).toEqual(expect.objectContaining({
            status: 'running',
            lastSeq: 1
        }));
    });

    // 进程在追加一行的中途被强杀：最后一行没有换行；之后继续追加不能把新事件拼到残缺行后面
    test('appending after a truncated final line keeps the log readable', () => {
        const aggregateId = 'demo';
        store.append(createControlEvent({ type: 'session.ready', aggregateId, seq: 1 }));
        fs.appendFileSync(store.getEventFilePath(aggregateId), '{"broken"');

        store.append(createControlEvent({ type: 'process.stdout', aggregateId, seq: 2, data: { text: 'x' } }));
        store.append(createControlEvent({ type: 'process.exited', aggregateId, seq: 3, data: { exitCode: 0 } }));

        expect(store.read(aggregateId).map(event => event.seq)).toEqual([1, 2, 3]);
    });

    test('a complete final line that only lacks the newline is kept', () => {
        const aggregateId = 'demo';
        const first = createControlEvent({ type: 'session.ready', aggregateId, seq: 1 });
        fs.mkdirSync(store.eventsDir, { recursive: true });
        fs.writeFileSync(store.getEventFilePath(aggregateId), JSON.stringify(first));
        store.append(createControlEvent({ type: 'process.stdout', aggregateId, seq: 2, data: { text: 'x' } }));
        expect(store.read(aggregateId).map(event => event.seq)).toEqual([1, 2]);
    });

    test('rejects duplicate or out-of-order aggregate sequences', () => {
        const aggregateId = 'demo';
        store.append(createControlEvent({ type: 'session.ready', aggregateId, seq: 1 }));

        expect(() => store.append(createControlEvent({ type: 'process.stdout', aggregateId, seq: 1 })))
            .toThrow('seq 必须连续递增');
        expect(() => store.append(createControlEvent({ type: 'process.stdout', aggregateId, seq: 3 })))
            .toThrow('seq 必须连续递增');
    });

    test('accepts a non-first legacy sequence when seeding a previously snapshotted aggregate', () => {
        const aggregateId = 'legacy';
        store.append(createControlEvent({ type: 'process.stdout', aggregateId, seq: 501 }));

        expect(store.read(aggregateId).map(event => event.seq)).toEqual([501]);
    });

    test('remove() deletes both the event log and the projection snapshot', () => {
        const aggregateId = 'demo~agent-2';
        store.append(createControlEvent({ type: 'session.ready', aggregateId, seq: 1 }));

        expect(fs.existsSync(store.getEventFilePath(aggregateId))).toBe(true);
        expect(fs.existsSync(store.getProjectionFilePath(aggregateId))).toBe(true);

        store.remove(aggregateId);

        expect(fs.existsSync(store.getEventFilePath(aggregateId))).toBe(false);
        expect(fs.existsSync(store.getProjectionFilePath(aggregateId))).toBe(false);
        expect(store.read(aggregateId)).toEqual([]);
    });

    test('remove() is a no-op when nothing exists for the aggregateId', () => {
        expect(() => store.remove('never-existed')).not.toThrow();
    });
});
