'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getImportMarkerPath, readImportState, waitForImport } = require('../lib/offline-import');

let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-import-')); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const writeMarker = content => {
    const file = getImportMarkerPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
};

describe('offline image import state', () => {
    test('active only while the recorded process is alive', () => {
        expect(readImportState(home)).toEqual({ active: false, message: '' });
        writeMarker(JSON.stringify({ pid: process.pid, message: '正在导入离线镜像' }));
        expect(readImportState(home, { isImporter: () => true })).toEqual({ active: true, message: '正在导入离线镜像' });
        // pid 活着但不是导入脚本（pid 被复用）：不能当作“正在导入”
        expect(readImportState(home, { isImporter: () => false }).active).toBe(false);
        writeMarker(JSON.stringify({ pid: 2 ** 22 + 12345 }));
        expect(readImportState(home).active).toBe(false);
    });

    test('garbage markers count as no import', () => {
        writeMarker('not json');
        expect(readImportState(home).active).toBe(false);
        writeMarker(JSON.stringify({ pid: 'abc' }));
        expect(readImportState(home).active).toBe(false);
        writeMarker(JSON.stringify({ pid: -5 }));
        expect(readImportState(home).active).toBe(false);
    });

    test('waitForImport returns immediately when idle and polls until the import ends', async () => {
        const sleep = jest.fn(async () => {});
        expect(await waitForImport({ homeDir: home, sleep })).toBe(true);
        expect(sleep).not.toHaveBeenCalled();

        let remaining = 3;
        const onWait = jest.fn();
        const readState = () => ({ active: remaining-- > 0, message: '导入中' });
        expect(await waitForImport({ readState, sleep, onWait, pollMs: 10 })).toBe(true);
        expect(sleep).toHaveBeenCalledTimes(3);
        expect(onWait).toHaveBeenCalledWith({ active: true, message: '导入中' });
    });

    test('gives up after the timeout instead of hanging forever', async () => {
        let slept = 0;
        const result = await waitForImport({ readState: () => ({ active: true }), sleep: async ms => { slept += ms; }, pollMs: 1000, timeoutMs: 3000 });
        expect(result).toBe(false);
        expect(slept).toBe(3000);
    });
});
