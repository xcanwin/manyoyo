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
});
