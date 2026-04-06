'use strict';

const {
    findTopLevelPropertyValueRange,
    findValueRangeByPath,
    applyTextReplacements
} = require('../lib/json5-text-edit');

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
});
