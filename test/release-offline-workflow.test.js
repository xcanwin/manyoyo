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
        expect(text).not.toContain('"$WORKFLOW_NAME"');
        expect(text).toContain('Build Offline Packages');
        expect(text).toContain('Build Linux Offline Packages');
        expect(text).toContain('grep -qx "$3"');
        expect(text).toContain("grep -qx 'success'");
    });

    test('verifies checksums and version before uploading, with an explicit file list', () => {
        const verify = text.indexOf('sha256sum -c');
        const upload = text.indexOf('gh release upload');
        expect(verify).toBeGreaterThan(-1);
        expect(upload).toBeGreaterThan(verify);
        expect(text).toContain('不属于版本');
        expect(text).not.toContain('release-manifest');
        expect(text).toContain('-app.tar.gz');
        expect(text).not.toMatch(/gh release upload "\$TAG" (assets\/)?\*/);
    });

    test('one run takes both platforms (macosRunId + linuxRunId), merges the per-platform sums into the single SHA256SUMS and uploads exactly 9 assets', () => {
        expect(text).toContain('macosRunId:');
        expect(text).toContain('linuxRunId:');
        expect(text).not.toMatch(/^\s+os:\s*$/m);
        expect(text).toContain('pattern: manyoyo-*-macos-*');
        expect(text).toContain('pattern: manyoyo-*-linux-*');
        expect(text).toContain('check macos "$MACOS_RUN_ID" "Build Offline Packages"');
        expect(text).toContain('check linux "$LINUX_RUN_ID" "Build Linux Offline Packages"');
        expect(text).toContain('cat SHA256SUMS-macos-arm64 SHA256SUMS-macos-x64 SHA256SUMS-linux-arm64 SHA256SUMS-linux-x64 > SHA256SUMS');
        // 上传清单：SHA256SUMS + 每个平台/架构的 .run（分卷仅超限兜底）与 -app.tar.gz；分平台清单与 lite 都不上传
        expect(text).toContain('FILES="SHA256SUMS"');
        expect(text).toContain('"manyoyo-${VERSION}-${os}-${arch}.run"');
        expect(text).toContain('"manyoyo-${VERSION}-${os}-${arch}-app.tar.gz"');
        expect(text).not.toMatch(/FILES="\$FILES SHA256SUMS-/);
        expect(text).toContain('不应再有精简包');
        expect(text).toContain('两次运行的提交不同');
        expect(text).toContain('缺少 ${os}-${arch} 的升级包');
        expect((text.match(/gh release upload/g) || []).length).toBe(1);
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
