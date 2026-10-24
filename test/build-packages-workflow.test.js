'use strict';

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../.github/workflows');
const text = fs.readFileSync(path.join(dir, 'build-packages.yml'), 'utf8');

function jobBlock(name) {
    const start = text.indexOf(`\n  ${name}:\n`);
    expect(start).toBeGreaterThan(-1);
    const next = text.slice(start + 1).search(/\n  [a-z-]+:\n/);
    return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

describe('build-packages workflow (macOS + Linux in one run)', () => {
    test('replaces the two old offline workflows', () => {
        expect(fs.existsSync(path.join(dir, 'offline-macos.yml'))).toBe(false);
        expect(fs.existsSync(path.join(dir, 'offline-linux.yml'))).toBe(false);
        expect(text).toContain('name: Build Packages');
    });

    test('is manual only, has no secrets and cannot create a Release or publish', () => {
        const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\nenv:'));
        expect(onBlock).toContain('workflow_dispatch:');
        expect(onBlock).not.toMatch(/^\s*(pull_request|schedule|release):/m);
        expect(text).not.toMatch(/secrets\./);
        // 只有流水线调用（draftTag 不为空）时才会往草稿上传；不创建 / 公开 Release，也不发 npm
        expect(text).not.toMatch(/gh release (create|edit|delete)|softprops|action-gh-release|npm publish|docker push/);
        expect(text.match(/gh release upload/g) || []).toHaveLength(2);
    });

    test('runners are pinned: macOS 15 arm64/Intel and Ubuntu 24.04 x64/arm64', () => {
        const runners = [...text.matchAll(/runner:\s*(\S+)/g)].map(m => m[1]).sort();
        expect(runners).toEqual(['macos-15', 'macos-15-intel', 'ubuntu-24.04', 'ubuntu-24.04-arm']);
        expect(text).toMatch(/image-archive:\n\s+runs-on: ubuntu-24\.04\n/);
    });

    test('only image-archive pulls the image; the four platform jobs download the artifact instead', () => {
        expect(text.match(/docker pull/g) || []).toHaveLength(1);
        // 归档管道必须 pipefail：保存失败时 gzip 仍会成功，会上传被截断的镜像归档
        expect(text).toContain('set -o pipefail');
        expect(text.match(/docker save/g) || []).toHaveLength(1);
        for (const name of ['build-macos', 'build-linux']) {
            const job = jobBlock(name);
            expect(job).toContain('needs: [image-archive, web]');
            expect(job).toContain('actions/download-artifact@v8');
            expect(job).not.toMatch(/docker (pull|save)/);
            expect(job).not.toContain('scan-allowlist-image.json');
        }
    });

    test('the image scan runs once per architecture, cached by image ID + allowlist + scanner hash', () => {
        const archive = jobBlock('image-archive');
        expect(archive).toContain('docker image inspect');
        expect(archive).toContain('{{.Id}}');
        expect(archive).toContain('actions/cache@v5');
        expect(archive).toContain('hashFiles(');
        expect(archive).toContain('scan-allowlist-image.json');
        expect(archive).toContain('scripts/scan-release-artifacts.js');
        expect(archive).toMatch(/steps\.scan-cache\.outputs\.cache-hit != 'true'/);
        expect(archive.indexOf('node scripts/scan-release-artifacts.js')).toBeLessThan(archive.indexOf('actions/upload-artifact@v7'));
    });

    test('artifacts holding already-compressed files are uploaded with compression-level: 0', () => {
        const uploads = text.split('actions/upload-artifact@v7').slice(1);
        expect(uploads).toHaveLength(6);
        // web-index 只是一个 2 MB 的 html，其余三个装的都是已压缩的安装包 / 镜像归档
        uploads.filter(chunk => !chunk.includes('name: web-index') && !chunk.includes('name: meta-')).forEach(chunk => expect(chunk.split('\n\n')[0]).toContain('compression-level: 0'));
    });

    test('the packaged tree is still scanned in every platform job, before the upload', () => {
        for (const [name, allowlist] of [['build-macos', 'scan-allowlist.json'], ['build-linux', 'scan-allowlist-linux.json']]) {
            const job = jobBlock(name);
            expect(job).toContain('name: Scan packaged tree');
            expect(job).toContain(allowlist);
            expect(job.indexOf('node scripts/scan-release-artifacts.js')).toBeLessThan(job.indexOf('actions/upload-artifact@v7'));
        }
        expect(text).toContain("--exclude '^full/images(/|$)' --exclude '^full/vm(/|$)'");
        expect(text).toContain("--exclude '^lite/images(/|$)'");
    });

    test('artifact names keep the per-platform naming that release-offline downloads', () => {
        expect(text).toContain('name: manyoyo-${{ steps.version.outputs.version }}-macos-${{ matrix.arch }}');
        expect(text).toContain('name: manyoyo-${{ steps.version.outputs.version }}-linux-${{ matrix.arch }}');
        expect(text).toContain('name: manyoyo-image-${{ steps.version.outputs.imageVersion }}-${{ matrix.arch }}');
        expect(text).toContain('--platform linux');
        expect(text).toContain('brew install gnu-tar');
        expect(text).toContain('steps.files.outputs.list');
        expect(jobBlock('build-linux')).not.toMatch(/podman/);
    });

    test('the macOS VM disk is cached by podman version + arch + the upstream machine-os digest (ISO week only as the fallback)', () => {
        const job = jobBlock('build-macos');
        expect(job).toContain('MANYOYO_VM_DISK_CACHE_DIR');
        expect(job).toMatch(/key: vm-disk-podman-[^\n]*matrix\.arch[^\n]*steps\.machineos\.outputs\.key/);
        expect(job).toContain('https://quay.io/v2/podman/machine-os/manifests/');
        expect(job).toContain('docker-content-digest');
        // 查不到 digest 时退回按周的 key，不能因此让构建失败
        expect(job).toContain('key=week-${{ steps.version.outputs.week }}');
        expect(job).toContain('date -u +%G-W%V');
        expect(job).toContain('scripts/offline/lock.js');
        // digest 步骤必须在缓存恢复之前
        expect(job.indexOf('id: machineos')).toBeLessThan(job.indexOf('actions/cache@v5'));
    });

    test('the web UI is built once and handed to the platform jobs (no per-job npm ci / build:web, prepack must not rebuild)', () => {
        const web = jobBlock('web');
        expect(web).toContain('npm run build:web');
        expect(web).toContain('name: web-index');
        for (const name of ['build-macos', 'build-linux']) {
            const job = jobBlock(name);
            expect(job).not.toContain('npm ci');
            expect(job).not.toContain('npm run build:web');
            expect(job).toContain('name: web-index');
            expect(job).toContain("MANYOYO_SKIP_WEB_BUILD: '1'");
        }
    });

    test('Linux jobs smoke-install the package they just built, before uploading it; macOS does it in the pipeline (Intel takes minutes: not on the critical path)', () => {
        const job = jobBlock('build-linux');
        expect(job).toContain('Smoke install');
        expect(job).toContain('--install-only');
        expect(job).toContain('uninstall --yes');
        expect(job.indexOf('Smoke install')).toBeLessThan(job.indexOf('actions/upload-artifact@v7'));
        expect(job.indexOf('Smoke install')).toBeGreaterThan(job.indexOf('Scan packaged tree'));
        expect(jobBlock('build-macos')).not.toContain('Smoke install');
    });

    test('the macOS packaging compresses with pigz (multi-threaded, still standard gzip for the installer)', () => {
        const job = jobBlock('build-macos');
        expect(job).toContain('brew install gnu-tar pigz');
        expect(job).toContain('MANYOYO_PIGZ=1');
        expect(jobBlock('build-linux')).not.toContain('pigz');
    });

    test('the image archive is compressed with pigz (same level, standard gzip), keeping pipefail', () => {
        const job = jobBlock('image-archive');
        // 单线程 gzip 是这一步的瓶颈（6 次发布实测 130–214 秒）
        expect(job).toMatch(/docker save "[^"]+" \| pigz -n > /);
        expect(job).not.toMatch(/\| gzip -n >/);
        expect(job).not.toMatch(/pigz -n -[0-9]/); // 不改压缩级别：体积不能变大
        expect(job).toContain('set -o pipefail');
    });

    test('can be called by the release pipeline (workflow_call) and stays manually dispatchable', () => {
        const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\nenv:'));
        expect(onBlock).toContain('workflow_call:');
        expect(onBlock).toContain('workflow_dispatch:');
    });

    test('read permissions only, except the two platform jobs that may upload to the draft — and only when draftTag is given', () => {
        expect(text).toContain('packages: read');
        expect(text).not.toMatch(/packages: write/);
        const writes = text.split('\n').filter(line => /contents: write/.test(line));
        expect(writes).toHaveLength(2);
        for (const name of ['build-macos', 'build-linux']) expect(jobBlock(name)).toContain('contents: write');
        // 上传步骤都带 draftTag 条件；draftTag 只存在于 workflow_call，单独手动触发永远不会上传
        const onBlock = text.slice(text.indexOf('\non:'), text.indexOf('\nenv:'));
        const dispatch = onBlock.slice(onBlock.indexOf('workflow_dispatch:'), onBlock.indexOf('workflow_call:')).split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
        expect(dispatch).not.toContain('draftTag');
        for (const name of ['build-macos', 'build-linux']) {
            const job = jobBlock(name);
            const upload = job.slice(job.indexOf("name: Upload this platform's files to the draft Release"));
            expect(upload.slice(0, upload.indexOf('run:'))).toContain("if: inputs.draftTag != ''");
            // 大 artifact 只在没有草稿（单独触发）时上传；有草稿时只传小清单
            expect(job).toContain("if: inputs.draftTag == ''");
            expect(job).toContain('name: meta-');
            expect(job.indexOf('gh release upload')).toBeGreaterThan(job.indexOf('Scan packaged tree'));
        }
        // Linux 的冒烟安装在上传之前（失败就什么都不上传）
        const linux = jobBlock('build-linux');
        expect(linux.indexOf('Smoke install')).toBeLessThan(linux.indexOf('gh release upload'));
    });
});
