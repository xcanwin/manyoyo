'use strict';

const fs = require('fs');
const path = require('path');

const text = fs.readFileSync(path.join(__dirname, '../.github/workflows/release-offline.yml'), 'utf8');
const npmText = fs.readFileSync(path.join(__dirname, '../.github/workflows/npm-publish.yml'), 'utf8');

describe('release-offline workflow', () => {
    test('is manual only and can neither build, publish to npm nor create a Release/tag', () => {
        const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\njobs:'));
        expect(onBlock).toContain('workflow_dispatch:');
        expect(onBlock).not.toMatch(/^\s*(push|pull_request|schedule|release):/m);
        expect(text).not.toMatch(/gh release create|npm publish|git push|git tag|docker push|docker build/);
        expect(text).toContain('gh release upload');
    });

    test('validates the tag and run id, and only takes a successful Build Offline Packages run', () => {
        expect(text).toContain("'^v[0-9]+\\.[0-9]+\\.[0-9]+$'");
        expect(text).toContain("'^[0-9]+$'");
        expect(text).toContain('Build Offline Packages');
        expect(text).toContain('Build Linux Offline Packages');
        expect(text).toContain('grep -qx "$WORKFLOW_NAME"');
        expect(text).toContain("grep -qx 'success'");
    });

    test('verifies checksums and version before uploading, with an explicit file list', () => {
        const verify = text.indexOf('sha256sum -c');
        const upload = text.indexOf('gh release upload');
        expect(verify).toBeGreaterThan(-1);
        expect(upload).toBeGreaterThan(verify);
        expect(text).toContain('不属于版本');
        expect(text).toContain('release-manifest-${OS_NAME}-');
        expect(text).toContain('options:\n          - macos\n          - linux');
        expect(text).toContain('-app.tar.gz');
        expect(text).not.toMatch(/gh release upload "\$TAG" (assets\/)?\*/);
    });

    test('the platform decides workflow name, artifact pattern and file names; linux never overwrites the combined SHA256SUMS', () => {
        expect(text).toContain('pattern: manyoyo-*-${{ inputs.os }}-*');
        expect(text).toContain('"manyoyo-${VERSION}-${OS_NAME}-${arch}-app.tar.gz"');
        expect(text).toContain('if [ "$OS_NAME" = macos ]; then');
        expect(text).toContain('[ "$OS_NAME" = macos ] && FILES="$FILES SHA256SUMS"');
        expect(text).toContain('os 只能是 macos 或 linux');
    });

    test('uses least privilege and no secrets other than the built-in token', () => {
        expect(text).toMatch(/permissions:\s*\n\s+contents: write\s*\n\s+actions: read/);
        expect(new Set(text.match(/secrets\.[A-Za-z_]+/g) || [])).toEqual(new Set());
        expect(text).toContain('github.token');
    });

    test('npm-publish does not fail or duplicate when the Release already exists', () => {
        expect(npmText).toContain('gh release view ${{ github.ref_name }}');
        expect(npmText).toContain('gh release create');
    });
});
