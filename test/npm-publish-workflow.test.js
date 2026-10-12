'use strict';

const fs = require('fs');
const path = require('path');
const { validateAllowlist } = require('../scripts/scan-release-artifacts');

const text = fs.readFileSync(path.join(__dirname, '../.github/workflows/npm-publish.yml'), 'utf8');

describe('npm-publish workflow', () => {
    test('scans the packed tarball and only then publishes', () => {
        const scan = text.indexOf('scripts/scan-release-artifacts.js');
        const pack = text.indexOf('npm pack');
        const publish = text.indexOf('npm publish');
        expect(pack).toBeGreaterThan(-1);
        expect(scan).toBeGreaterThan(pack);
        expect(publish).toBeGreaterThan(scan);
    });

    test('the release allowlist is valid (every entry has a reason and is narrowly scoped)', () => {
        const entries = JSON.parse(fs.readFileSync(path.join(__dirname, '../scripts/release-scan-allowlist.json'), 'utf8'));
        expect(() => validateAllowlist(entries)).not.toThrow();
    });

    test('runs when a Release is published (not on tag push) and can be re-run by hand with a tag input', () => {
        const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\njobs:'));
        expect(onBlock).toMatch(/release:\s*\n\s+types: \[published\]/);
        expect(onBlock).toContain('workflow_dispatch:');
        expect(onBlock).toMatch(/inputs:\s*\n\s+tag:/);
        expect(onBlock).not.toMatch(/^\s*push:/m);
    });

    test('no longer creates the GitHub Release itself (the console owns it)', () => {
        expect(text).not.toContain('create-release');
        expect(text).not.toMatch(/gh release (create|view)/);
        expect(text).not.toContain('contents: write');
    });

    test('checks out the tag and refuses to publish when the tag and package.json version differ', () => {
        expect(text).toContain('inputs.tag || github.event.release.tag_name');
        expect(text.match(/ref: refs\/tags\/\$\{\{ env\.TAG \}\}/g) || []).toHaveLength(2);
        const verify = text.indexOf('Verify tag matches package version');
        expect(verify).toBeGreaterThan(-1);
        expect(verify).toBeLessThan(text.indexOf('npm test'));
        expect(text).toContain('Tag version mismatch');
    });

    test('skipTests skips only the test job: the tag/version check is repeated in the publish job and the tag must point at the tested sha', () => {
        const publish = text.slice(text.indexOf('\n  publish-npm:'));
        expect(publish).toContain('Tag version mismatch');
        expect(publish).toContain('inputs.skipTests == true');
        expect(publish).toContain('不是流水线测试过的');
        expect(text).toMatch(/build:\n\s+if: [^\n]*inputs\.skipTests != true/);
        // build 被跳过时发布 job 仍要继续，但 build 失败 / 取消不能继续
        expect(publish).toContain('!failure() && !cancelled()');
        expect(text).toMatch(/skipTests:\s*\n\s+description:[^\n]*\n\s+type: boolean/);
    });

    test('never publishes a pre-release to the latest dist-tag', () => {
        expect(text).toContain('!github.event.release.prerelease');
    });
});
