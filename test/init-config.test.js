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

    // 交互询问期间别处（另一个终端、网页设置）改了配置文件：写入时要在最新内容上局部写 runs.<agent>，不能用开始时读到的旧文本覆盖
    test('询问期间配置文件被别处改了：写入保留别人的修改', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'my-init-race-'));
        try {
            fs.mkdirSync(path.join(home, '.manyoyo'));
            const p = path.join(home, '.manyoyo', 'manyoyo.json');
            const original = '{\n    // 我的注释\n    yolo: "c",\n    runs: {\n        gemini: { yolo: "g" },\n    },\n}\n';
            fs.writeFileSync(p, original);
            await initAgentConfigs('gemini', {
                homeDir: home,
                yesMode: false,
                log: () => {},
                loadConfig: () => JSON5.parse(original),
                askQuestion: async () => {
                    // 用户还在回答“是否覆盖”时，别处把 yolo 改成了 cx，并新增了一个 run
                    fs.writeFileSync(p, original.replace('yolo: "c",', 'yolo: "cx",').replace('runs: {', 'runs: {\n        added: { yolo: "oc" },'));
                    return 'y';
                }
            });
            const text = fs.readFileSync(p, 'utf-8');
            const parsed = JSON5.parse(text);
            expect(parsed.yolo).toBe('cx');
            expect(parsed.runs.added).toEqual({ yolo: 'oc' });
            expect(parsed.runs.gemini.yolo).not.toBe('g');
            expect(text).toContain('// 我的注释');
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});
