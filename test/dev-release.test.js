const path = require('path');
const { execSync } = require('child_process');
const {
    parseReleaseVersion,
    buildVersionSuggestions,
    pickLatestVersionTag,
    normalizeCommitMessage
} = require('../lib/dev-release');

const DEV_RELEASE_SCRIPT = path.join(__dirname, '..', 'scripts', 'dev-release.js');

describe('Dev Release Helpers', () => {
    test('--help should display maintainer release help', () => {
        const output = execSync(`node ${DEV_RELEASE_SCRIPT} --help`, { encoding: 'utf-8' });
        expect(output).toContain('manyoyo dev release');
        expect(output).toContain('维护者发布向导');
        expect(output).toContain('--version');
        expect(output).toContain('$commit-diff');
    });

    test('parseReleaseVersion should parse x.y.z', () => {
        expect(parseReleaseVersion('5.6.1')).toEqual({
            major: 5,
            minor: 6,
            patch: 1
        });
    });

    test('parseReleaseVersion should reject invalid version', () => {
        expect(parseReleaseVersion('5.6')).toBeNull();
        expect(parseReleaseVersion('v5.6.1')).toBeNull();
        expect(parseReleaseVersion('5.6.1-beta')).toBeNull();
    });

    test('buildVersionSuggestions should return patch minor major suggestions', () => {
        expect(buildVersionSuggestions('5.6.1')).toEqual([
            { key: 'patch', label: '第3段 +1 (patch)', version: '5.6.2', recommended: true },
            { key: 'minor', label: '第2段 +1 (minor)', version: '5.7.0', recommended: false },
            { key: 'major', label: '第1段 +1 (major)', version: '6.0.0', recommended: false }
        ]);
    });

    test('pickLatestVersionTag should pick highest semver tag', () => {
        expect(pickLatestVersionTag([
            'v5.6.1',
            'v5.7.0',
            'v5.6.9',
            'not-a-version'
        ])).toEqual({
            tag: 'v5.7.0',
            version: '5.7.0'
        });
    });

    test('normalizeCommitMessage should strip fenced code block wrapper', () => {
        expect(normalizeCommitMessage([
            '```text',
            '',
            '- 第一行',
            '- 第二行',
            '```',
            ''
        ].join('\n'))).toBe('- 第一行\n- 第二行');
    });
});
