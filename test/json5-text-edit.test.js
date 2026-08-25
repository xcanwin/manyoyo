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
            const result = upsertValueByPath(text, ['serve', 'quickChat', 'path'], JSON.stringify('~/.manyoyo/workpath/'));

            expect(result).toContain('// 顶层注释');
            expect(result).toContain('imageVersion: "1.0.0-common"');
            const parsed = JSON5.parse(result);
            expect(parsed.serve.quickChat.path).toBe('~/.manyoyo/workpath/');
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
            let result = upsertValueByPath(text, ['serve', 'quickChat', 'path'], JSON.stringify('~/.manyoyo/workpath/'));
            result = upsertValueByPath(result, ['serve', 'quickChat', 'run'], JSON.stringify('claude'));

            const parsed = JSON5.parse(result);
            expect(parsed.serve.quickChat.path).toBe('~/.manyoyo/workpath/');
            expect(parsed.serve.quickChat.run).toBe('claude');
        });

        test('throws instead of clobbering data when a path segment already exists but is not an object', () => {
            const text = '{\n    serve: "not-an-object",\n}\n';
            expect(() => upsertValueByPath(text, ['serve', 'quickChat', 'path'], '"x"')).toThrow();
        });
    });
});
