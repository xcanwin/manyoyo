'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const JSON5 = require('json5');
const { initAgentConfigs } = require('../lib/init-config');

describe('init-config 保留 manyoyo.json 注释', () => {
    test('init 只局部写入 runs.<agent>，不重排整个文件', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'my-init-'));
        try {
            fs.mkdirSync(path.join(home, '.manyoyo'));
            const p = path.join(home, '.manyoyo', 'manyoyo.json');
            const original = '{\n    // 我的注释\n    yolo: "c", // 行尾\n    runs: {\n        mine: { yolo: "cx" },\n    },\n}\n';
            fs.writeFileSync(p, original);
            await initAgentConfigs('gemini', {
                homeDir: home,
                yesMode: true,
                log: () => {},
                loadConfig: () => JSON5.parse(original)
            });
            const text = fs.readFileSync(p, 'utf-8');
            expect(text).toContain('// 我的注释');
            expect(text).toContain('yolo: "c", // 行尾');
            expect(text).toContain('mine: { yolo: "cx" },');
            const parsed = JSON5.parse(text);
            expect(parsed.runs.gemini).toBeDefined();
            expect(parsed.runs.mine).toEqual({ yolo: 'cx' });
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});
