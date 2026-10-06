'use strict';

const {
    findTopLevelPropertyValueRange,
    findValueRangeByPath,
    applyTextReplacements,
    upsertValueByPath
} = require('../lib/json5-text-edit');
const JSON5 = require('json5');

describe('json5 text edit helpers', () => {
    test('findTopLevelPropertyValueRange should find top-level property with comments', () => {
        const text = '{\n    // note\n    imageVersion: "1.0.0-common",\n    runs: {}\n}\n';
        const range = findTopLevelPropertyValueRange(text, 'imageVersion');
        expect(range).not.toBeNull();
        expect(text.slice(range.start, range.end)).toBe('"1.0.0-common"');
    });

    test('findValueRangeByPath should find nested property', () => {
        const text = '{\n  runs: {\n    codex: {\n      serverPass: "secret"\n    }\n  }\n}\n';
        const range = findValueRangeByPath(text, ['runs', 'codex', 'serverPass']);
        expect(range).not.toBeNull();
        expect(text.slice(range.start, range.end)).toBe('"secret"');
    });

    test('applyTextReplacements should apply replacements from right to left', () => {
        const text = '{ foo: "a", bar: "b" }';
        const result = applyTextReplacements(text, [
            { start: 7, end: 10, text: '"x"' },
            { start: 17, end: 20, text: '"y"' }
        ]);
        expect(result).toBe('{ foo: "x", bar: "y" }');
    });

    describe('upsertValueByPath', () => {
        test('creates every missing intermediate object when nothing on the path exists yet', () => {
            const text = '{\n    // 顶层注释\n    imageVersion: "1.0.0-common",\n}\n';
            const result = upsertValueByPath(text, ['serve', 'quickChat', 'path'], JSON.stringify('~/.manyoyo/work/'));

            expect(result).toContain('// 顶层注释');
            expect(result).toContain('imageVersion: "1.0.0-common"');
            const parsed = JSON5.parse(result);
            expect(parsed.serve.quickChat.path).toBe('~/.manyoyo/work/');
        });

        test('adds a new key inside an existing object without touching sibling keys', () => {
            const text = '{\n    serve: {\n        // 网页标题\n        title: "My MANYOYO",\n    },\n}\n';
            const result = upsertValueByPath(text, ['serve', 'quickChat', 'run'], JSON.stringify('claude'));

            expect(result).toContain('// 网页标题');
            const parsed = JSON5.parse(result);
            expect(parsed.serve.title).toBe('My MANYOYO');
            expect(parsed.serve.quickChat.run).toBe('claude');
        });

        test('only replaces the value in place when the full path already exists', () => {
            const text = '{\n    serve: {\n        quickChat: {\n            path: "/old/path",\n            run: "claude",\n        },\n    },\n}\n';
            const result = upsertValueByPath(text, ['serve', 'quickChat', 'path'], JSON.stringify('/new/path'));

            const parsed = JSON5.parse(result);
            expect(parsed.serve.quickChat.path).toBe('/new/path');
            expect(parsed.serve.quickChat.run).toBe('claude');
        });

        test('applying two upserts in sequence produces both keys side by side', () => {
            const text = '{\n    imageVersion: "1.0.0-common",\n}\n';
            let result = upsertValueByPath(text, ['serve', 'quickChat', 'path'], JSON.stringify('~/.manyoyo/work/'));
            result = upsertValueByPath(result, ['serve', 'quickChat', 'run'], JSON.stringify('claude'));

            const parsed = JSON5.parse(result);
            expect(parsed.serve.quickChat.path).toBe('~/.manyoyo/work/');
            expect(parsed.serve.quickChat.run).toBe('claude');
        });

        test('throws instead of clobbering data when a path segment already exists but is not an object', () => {
            const text = '{\n    serve: "not-an-object",\n}\n';
            expect(() => upsertValueByPath(text, ['serve', 'quickChat', 'path'], '"x"')).toThrow();
        });
    });
});

describe('upsertValueByPath indentation', () => {
    const { upsertValueByPath } = require('../lib/json5-text-edit');
    test('nested inserts keep a consistent 4-space indent and valid JSON5', () => {
        const JSON5 = require('json5');
        let text = '{\n    a: 1,\n}\n';
        text = upsertValueByPath(text, ['runs', 'claude'], JSON.stringify({ env: { K: 'v' } }, null, 4));
        expect(text).toBe('{\n    "runs": {\n        "claude": {\n            "env": {\n                "K": "v"\n            }\n        }\n    },\n    a: 1,\n}\n');
        expect(JSON5.parse(text).runs.claude.env.K).toBe('v');
    });
});

describe('upsertValueByPath 格式保持', () => {
    test('空对象插入不产生空行', () => {
        const text = upsertValueByPath('{\n}\n', ['runs', 'a'], '{}');
        expect(text).toBe('{\n    "runs": {\n        "a": {}\n    }\n}\n');
    });

    test("'{' 行尾注释留在原行，且头部注释里的 { 不影响定位", () => {
        const text = upsertValueByPath('// 头 {x}\n{ // 说明\n    a: 1,\n}\n', ['b'], '2');
        expect(text).toBe('// 头 {x}\n{ // 说明\n    "b": 2,\n    a: 1,\n}\n');
        expect(JSON5.parse(text)).toEqual({ a: 1, b: 2 });
    });
});

describe('upsertValueByPath 写入严格 JSON 友好', () => {
    test('从空对象依次写入多处：键名全带引号、无尾逗号，JSON.parse 可解析', () => {
        let text = '{}\n';
        text = upsertValueByPath(text, ['runs', 'claude'], JSON.stringify({ env: { K: 'v' } }, null, 4));
        text = upsertValueByPath(text, ['serverPass'], JSON.stringify('x'));
        text = upsertValueByPath(text, ['serve', 'quickChat', 'path'], JSON.stringify('~/w'));
        text = upsertValueByPath(text, ['serve', 'quickChat', 'run'], JSON.stringify('claude'));
        const parsed = JSON.parse(text);
        expect(parsed.runs.claude.env.K).toBe('v');
        expect(parsed.serverPass).toBe('x');
        expect(parsed.serve.quickChat).toEqual({ path: '~/w', run: 'claude' });
        expect(text).not.toMatch(/,\s*[}\]]/);
    });

    test('已有内容、注释与原有键名写法不动', () => {
        const text = upsertValueByPath('{\n    // 注释\n    imageVersion: "1.0.0-common",\n}\n', ['serverPass'], '"p"');
        expect(text).toContain('// 注释');
        expect(text).toContain('imageVersion: "1.0.0-common",');
        expect(JSON5.parse(text).serverPass).toBe('p');
    });
});

describe('向导写配置产出的文件能被严格 JSON 解析', () => {
    test('setup-config 的 agent / 密码 / 镜像源 / quickChat 依次写入', () => {
        const { EMPTY_CONFIG_RAW, buildAgentConfigRaw, buildPasswordConfigRaw, buildMirrorsConfigRaw } = require('../lib/setup-config');
        let raw = buildAgentConfigRaw(EMPTY_CONFIG_RAW, 'claude', { env: { ANTHROPIC_BASE_URL: 'http://x' } });
        raw = buildPasswordConfigRaw(raw, 'pw');
        raw = buildMirrorsConfigRaw(raw, { npm: 'https://r.example' });
        raw = upsertValueByPath(raw, ['serve', 'quickChat', 'path'], '"~/w"');
        raw = upsertValueByPath(raw, ['serve', 'quickChat', 'run'], '"claude"');
        const parsed = JSON.parse(raw);
        expect(parsed.runs.claude.env.ANTHROPIC_BASE_URL).toBe('http://x');
        expect(parsed.serverPass).toBe('pw');
        expect(parsed.serve.quickChat.run).toBe('claude');
    });
});
