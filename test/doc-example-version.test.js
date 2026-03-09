const fs = require('fs');
const path = require('path');
const { imageVersion: PACKAGE_IMAGE_VERSION } = require('../package.json');

const ROOT_DIR = path.join(__dirname, '..');
const DOC_FILES_TO_ENFORCE = [
    'README.md',
    'docs/zh/guide/quick-start.md',
    'docs/en/guide/quick-start.md',
    'docs/zh/guide/basic-usage.md',
    'docs/en/guide/basic-usage.md',
    'docs/zh/reference/cli-options.md',
    'docs/en/reference/cli-options.md'
];

const VERSION_PATTERN = /\b\d+\.\d+\.\d+-[a-z0-9-]+\b/g;
const PACKAGE_BASE_VERSION = PACKAGE_IMAGE_VERSION.split('-')[0];

function collectImageVersions(content) {
    const matches = content.match(VERSION_PATTERN) || [];
    return Array.from(new Set(matches));
}

describe('Documentation example image versions', () => {
    test('entry docs should align with package imageVersion', () => {
        const mismatches = [];

        for (const relativeFile of DOC_FILES_TO_ENFORCE) {
            const filePath = path.join(ROOT_DIR, relativeFile);
            const content = fs.readFileSync(filePath, 'utf8');
            const versions = collectImageVersions(content);
            const unexpected = versions.filter((version) => {
                return version.split('-')[0] !== PACKAGE_BASE_VERSION;
            });

            if (unexpected.length > 0) {
                mismatches.push({
                    file: relativeFile,
                    versions: unexpected
                });
            }
        }

        expect(mismatches).toEqual([]);
    });
});
