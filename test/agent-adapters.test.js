'use strict';

const { resolveYoloCommand } = require('../lib/agent-adapters');

describe('lib/agent-adapters resolveYoloCommand', () => {
    test('keeps an omitted yolo setting as an empty command', () => {
        expect(resolveYoloCommand('')).toBe('');
    });

    test.each([
        ['claude', 'IS_SANDBOX=1 claude --dangerously-skip-permissions'],
        ['cc', 'IS_SANDBOX=1 claude --dangerously-skip-permissions'],
        ['c', 'IS_SANDBOX=1 claude --dangerously-skip-permissions'],
        ['gemini', 'gemini --yolo'],
        ['gm', 'gemini --yolo'],
        ['g', 'gemini --yolo'],
        ['codex', 'codex --dangerously-bypass-approvals-and-sandbox'],
        ['cx', 'codex --dangerously-bypass-approvals-and-sandbox'],
        ['opencode', 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode'],
        ['oc', 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode']
    ])('resolves "%s" to its YOLO command', (alias, expected) => {
        expect(resolveYoloCommand(alias)).toBe(expected);
    });

    test('is case-insensitive and trims whitespace', () => {
        expect(resolveYoloCommand(' CC ')).toBe('IS_SANDBOX=1 claude --dangerously-skip-permissions');
    });

    test('throws for an unknown alias', () => {
        expect(() => resolveYoloCommand('npm')).toThrow('未知 yolo 值: npm');
    });
});
