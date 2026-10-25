'use strict';

const { isEffortValue, extractEfforts, effortLevelsFor } = require('../lib/web/agent-effort');
const initialize = require('./fixtures/claude-initialize.json');

describe('推理强度选项（lib/web/agent-effort.js）', () => {
    test('只接受小写字母 2～16 位', () => {
        ['low', 'xhigh', 'max'].forEach(value => expect(isEffortValue(value)).toBe(true));
        ['', 'a', 'LOW', 'low high', 'low;', 'a'.repeat(17), 3, null].forEach(value => expect(isEffortValue(value)).toBe(false));
    });

    test('claude 目录项：supportedEffortLevels；supportsEffort 为 false 时没有', () => {
        const fixtureModels = initialize.response.response.models;
        expect(extractEfforts(fixtureModels[0])).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
        expect(extractEfforts({ supportsEffort: false, supportedEffortLevels: ['low'] })).toEqual([]);
        expect(extractEfforts({ supportedEffortLevels: ['low', 'low', 'Bad', 'x y', 'high'] })).toEqual(['low', 'high']);
        expect(extractEfforts(null)).toEqual([]);
    });

    test('codex 目录项：字符串或对象都认', () => {
        expect(extractEfforts({ supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'x' }, 'high', { reasoningEffort: 'a b' }] })).toEqual(['low', 'high']);
    });

    test('claude：按当前模型找目录项，没选模型用 default；目录里没有的模型不显示', () => {
        const catalog = [
            { value: 'default', resolvedModel: 'm-default', efforts: ['low', 'high'] },
            { value: 'haiku', resolvedModel: 'm-haiku', efforts: [] },
            { value: 'opus', resolvedModel: 'm-opus', efforts: ['low', 'max'] }
        ];
        expect(effortLevelsFor('claude', catalog, '')).toEqual(['low', 'high']);
        expect(effortLevelsFor('claude', catalog, 'opus')).toEqual(['low', 'max']);
        expect(effortLevelsFor('claude', catalog, 'haiku')).toEqual([]);
        expect(effortLevelsFor('claude', catalog, 'm-opus')).toEqual(['low', 'max']);
        expect(effortLevelsFor('claude', catalog, 'glm-5.3')).toEqual([]);
    });

    test('codex：id 必须和当前模型一致，找不到（自定义模型）就不显示', () => {
        const catalog = [{ value: 'gpt-5', efforts: ['low', 'high'] }];
        expect(effortLevelsFor('codex', catalog, 'gpt-5')).toEqual(['low', 'high']);
        expect(effortLevelsFor('codex', catalog, 'glm-5.3')).toEqual([]);
        expect(effortLevelsFor('codex', catalog, '')).toEqual([]);
        expect(effortLevelsFor('gemini', catalog, 'gpt-5')).toEqual([]);
    });
});
