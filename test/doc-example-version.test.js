const fs = require('fs');
const path = require('path');
const { imageVersion: PACKAGE_IMAGE_VERSION } = require('../package.json');

const ROOT_DIR = path.join(__dirname, '..');
// 有意保留的历史版本示例：{ file, version, reason }。需要时才加，空最好
const ALLOWED_HISTORICAL_VERSIONS = [];

const VERSION_PATTERN = /\b\d+\.\d+\.\d+-[a-z0-9-]+\b/g;
const PACKAGE_BASE_VERSION = PACKAGE_IMAGE_VERSION.split('-')[0];

function collectMarkdownFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.vitepress' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectMarkdownFiles(full, out);
        else if (entry.name.endsWith('.md')) out.push(full);
    }
    return out;
}

function collectImageVersions(content) {
    const matches = content.match(VERSION_PATTERN) || [];
    return Array.from(new Set(matches));
}

// 返回与 package.json imageVersion 主版本不一致的示例：[{ file, versions }]
function findMismatches(files, baseVersion = PACKAGE_BASE_VERSION, allowed = ALLOWED_HISTORICAL_VERSIONS) {
    const mismatches = [];
    for (const file of files) {
        const relativeFile = path.relative(ROOT_DIR, file).split(path.sep).join('/');
        const unexpected = collectImageVersions(fs.readFileSync(file, 'utf8')).filter(version => {
            if (version.split('-')[0] === baseVersion) return false;
            return !allowed.some(item => item.file === relativeFile && item.version === version);
        });
        if (unexpected.length > 0) mismatches.push({ file: relativeFile, versions: unexpected });
    }
    return mismatches;
}

describe('Documentation example image versions', () => {
    test('README.md and every docs page align with package imageVersion', () => {
        const files = [path.join(ROOT_DIR, 'README.md'), ...collectMarkdownFiles(path.join(ROOT_DIR, 'docs'))];
        const mismatches = findMismatches(files);

        if (mismatches.length > 0) {
            throw new Error(
                `Docs contain imageVersion examples outside package base version ${PACKAGE_BASE_VERSION}. ` +
                'Update the listed files when bumping package.json imageVersion (or whitelist a deliberate historical example):\n' +
                JSON.stringify(mismatches, null, 2)
            );
        }
    });

    test('the scan covers both languages and ignores the VitePress internals', () => {
        const files = collectMarkdownFiles(path.join(ROOT_DIR, 'docs')).map(file => path.relative(ROOT_DIR, file).split(path.sep).join('/'));
        expect(files).toEqual(expect.arrayContaining(['docs/guide/quick-start.md', 'docs/en/guide/quick-start.md', 'docs/advanced/custom-image.md']));
        expect(files.some(file => file.startsWith('docs/.vitepress/'))).toBe(false);
    });

    test('an outdated example is caught, and a whitelisted historical one is not', () => {
        const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'manyoyo-docver-'));
        try {
            const file = path.join(tmp, 'page.md');
            fs.writeFileSync(file, 'manyoyo build --iv 1.8.0-common\nmanyoyo build --iv 2.1.0-full\n');
            const relative = path.relative(ROOT_DIR, file).split(path.sep).join('/');
            expect(findMismatches([file], '2.1.0')).toEqual([{ file: relative, versions: ['1.8.0-common'] }]);
            expect(findMismatches([file], '2.1.0', [{ file: relative, version: '1.8.0-common', reason: 'historical example' }])).toEqual([]);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
