'use strict';

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../.github/workflows');
const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
const pipeline = read('release-pipeline.yml');
const npmPublish = read('npm-publish.yml');
// 顶层 key 到下一个顶层 key 之间的文本
const block = (text, key) => {
    const start = text.search(new RegExp(`^${key}:`, 'm'));
    const rest = text.slice(start + key.length + 1);
    const end = rest.search(/^\S/m);
    return end === -1 ? rest : rest.slice(0, end);
};
const job = name => {
    const jobs = block(pipeline, 'jobs');
    const start = jobs.search(new RegExp(`^  ${name}:`, 'm'));
    const rest = jobs.slice(start + name.length + 3);
    const end = rest.search(/^ {2}\S/m);
    return end === -1 ? rest : rest.slice(0, end);
};

describe('release-pipeline workflow', () => {
    test('npm is triggered with workflow_dispatch (gh workflow run), never called with uses: — the npm trusted publisher is bound to npm-publish.yml', () => {
        const npm = job('npm');
        expect(npm).toContain('gh workflow run npm-publish.yml');
        expect(npm).toContain('actions: write');
        expect(pipeline).not.toMatch(/uses:\s*\.\/\.github\/workflows\/npm-publish\.yml/);
        // npm-publish.yml 自己不能变成可被调用的 workflow，OIDC 里的 workflow_ref 才仍然是它
        expect(npmPublish).not.toContain('workflow_call');
        expect(npmPublish).toMatch(/permissions:\s*\n\s+id-token: write/);
        expect(npmPublish).toContain('--provenance');
        // skipTests 必须带 sha，由 npm-publish 自己核对 tag 指向的提交；隐私扫描保留
        expect(npmPublish).toContain('skipTests:');
        expect(npmPublish).toContain('不是流水线测试过的');
        expect(npmPublish).toContain('scan-release-artifacts.js');
    });

    test('only one real release at a time and it never cancels a running one; dry runs use their own group so they cannot push a queued real release out', () => {
        const concurrency = block(pipeline, 'concurrency');
        expect(concurrency).toContain("'release'");
        expect(concurrency).toContain('release-dry-');
        expect(concurrency).toMatch(/cancel-in-progress: false/);
    });

    test('npm stage is safe to re-run (skips the dispatch when npm already has the version) and recognises only its own dispatched run', () => {
        const npm = job('npm');
        expect(npm.indexOf('npm view "@xcanwin/manyoyo@${VERSION}" version')).toBeGreaterThan(-1);
        expect(npm.indexOf('npm view "@xcanwin/manyoyo@${VERSION}" version')).toBeLessThan(npm.indexOf('gh workflow run npm-publish.yml'));
        expect(npm).toContain('endswith(');
        expect(npm).toContain('-b main');
        expect(npmPublish).toMatch(/run-name: .*tag/);
    });

    test('nothing from package.json is interpolated into a shell script unchecked: prepare validates the version, summary reads it from env', () => {
        expect(job('prepare')).toContain("grep -Eq '^[0-9]+");
        expect(job('summary')).toContain('VERSION: ${{ needs.prepare.outputs.version }}');
        expect(job('summary')).not.toMatch(/run: \|[\s\S]*\$\{\{ needs\./);
    });

    test('order: draft first → builds upload into it → finalize merges the checksum list → verify before publish → npm and post-publish verify only after publish', () => {
        const needs = name => (job(name).match(/^ {4}needs: (.+)$/m) || [, ''])[1];
        expect(needs('draft')).toBe('[prepare]');
        expect(needs('packages')).toContain('draft');
        expect(needs('finalize')).toContain('test');
        expect(needs('finalize')).toContain('packages');
        expect(needs('prepublish-verify')).toContain('finalize');
        expect(needs('publish')).toContain('prepublish-verify');
        // macOS 冒烟安装与合并清单 / 公开前验证并行，只挡住 publish（Intel 上要六七分钟）
        expect(needs('publish')).toContain('smoke-macos');
        expect(needs('smoke-macos')).toContain('packages');
        expect(needs('finalize')).not.toContain('smoke-macos');
        expect(job('smoke-macos')).toContain('MANYOYO_TEST_SKIP_MACHINE=1');
        expect(job('smoke-macos')).toContain('uninstall --yes');
        expect(job('smoke-macos')).toContain('gh release download');
        expect(needs('npm')).toContain('publish');
        expect(needs('postpublish-verify')).toContain('publish');
        // 只有 draft 创建 Release；只有 publish 公开它
        expect(pipeline.match(/gh release create/g) || []).toHaveLength(1);
        expect(job('draft')).toContain('gh release create');
        expect(job('draft')).toContain('--target "$SHA"');
        expect(pipeline.match(/--draft=false/g) || []).toHaveLength(1);
        expect(job('publish')).toContain('--draft=false');
        expect(job('publish')).toContain('assert-assets.js');
    });

    test('every job after prepare runs only when the jobs it needs really succeeded (a skipped image job must not skip the chain, a failed test must not let it through)', () => {
        const condition = name => (job(name).match(/^ {4}if: (.+)$/m) || [, ''])[1];
        expect(condition('packages')).toContain("needs.prepare.result == 'success'");
        expect(condition('packages')).toContain("needs.image.result == 'skipped'");
        expect(condition('packages')).toContain("needs.draft.result == 'success'");
        expect(condition('finalize')).toContain("needs.test.result == 'success'");
        expect(condition('finalize')).toContain("needs.packages.result == 'success'");
        expect(condition('smoke-macos')).toContain("needs.packages.result == 'success'");
        expect(condition('prepublish-verify')).toContain("needs.finalize.result == 'success'");
        for (const upstream of ['prepublish-verify', 'smoke-macos']) expect(condition('publish')).toContain(`needs.${upstream}.result == 'success'`);
        expect(condition('npm')).toContain("needs.publish.result == 'success'");
        expect(condition('postpublish-verify')).toContain("needs.publish.result == 'success'");
        // 不能用会在 test 失败时放行的 !failure() 兜底
        for (const name of ['draft', 'finalize', 'publish', 'npm']) expect(condition(name)).not.toContain('!failure()');
    });

    test('dryRun never publishes: publish, npm and post-publish are skipped, and the dry-run draft is deleted whatever happens', () => {
        for (const name of ['publish', 'npm', 'postpublish-verify']) expect(job(name)).toContain("needs.prepare.outputs.dryRun != 'true'");
        const cleanup = job('cleanup-dryrun');
        expect(cleanup).toContain('always()');
        expect(cleanup).toContain('gh release delete');
        expect(job('draft')).toContain('--prerelease');
        expect(job('prepare')).toContain('refs/heads/main');
        expect(job('prepare')).toContain('强制 dryRun');
    });

    test('the summary job always runs and uploads the release-report artifact', () => {
        const summary = job('summary');
        expect(summary).toMatch(/if: always\(\)/);
        expect(summary).toContain('pipeline-report.js');
        expect(summary).toContain('name: release-report');
        expect(summary).toContain('retention-days: 30');
    });

    test('every reusable workflow it calls can be called, and keeps its own workflow_dispatch for manual re-runs', () => {
        const called = [...pipeline.matchAll(/uses:\s*\.\/\.github\/workflows\/(\S+)/g)].map(m => m[1]);
        // release-offline.yml 不再被流水线调用（保留单独手动触发，用于修复时从某次运行补挂资产）
        expect(called.sort()).toEqual(['build-packages.yml', 'ci.yml', 'image-publish.yml', 'release-verify.yml']);
        for (const name of called) {
            const text = read(name);
            expect(text).toContain('workflow_call:');
            if (name !== 'ci.yml') expect(text).toContain('workflow_dispatch:');
        }
    });

    test('the web smoke sends X-Requested-With on every POST (the serve CSRF check rejects non-GET requests without it with 403 — found by a trial run)', () => {
        const posts = job('prepublish-verify').split('\n').filter(line => line.includes('-X POST'));
        expect(posts.length).toBeGreaterThanOrEqual(4);
        posts.forEach(line => expect(line).toContain("X-Requested-With: XMLHttpRequest"));
    });

    test('uses only the built-in token — no new secrets', () => {
        expect(new Set(pipeline.match(/secrets\.[A-Za-z_]+/g) || [])).toEqual(new Set());
    });

    test('delivered state has no leftover branch trigger or temporary workflow (trial runs use a temporary push trigger that must be removed before merging)', () => {
        const on = block(pipeline, 'on');
        expect(on).toContain('workflow_dispatch:');
        expect(on).not.toMatch(/^\s*push:/m);
        expect(on).not.toContain('feat/release-autopilot');
        expect(pipeline).not.toContain('TEMP-BRANCH-TRIGGER');
        // 试跑期间临时加的触发文件与实验用 workflow 也不能留下
        expect(fs.existsSync(path.join(__dirname, '../.release-dryrun-trigger'))).toBe(false);
        expect(fs.readdirSync(dir).filter(name => /^tmp-|^temp-|-experiment/.test(name))).toEqual([]);
        for (const name of fs.readdirSync(dir)) expect(read(name)).not.toMatch(/branches:\s*\n\s*-\s*feat\/release-autopilot/);
    });
});
