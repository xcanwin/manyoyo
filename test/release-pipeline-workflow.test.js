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

    test('only one release pipeline at a time, and it never cancels a running one', () => {
        expect(block(pipeline, 'concurrency')).toMatch(/group: release\s*\n\s+cancel-in-progress: false/);
    });

    test('order: tested + built → draft → attach → verify before publish → npm and post-publish verify only after publish', () => {
        const needs = name => (job(name).match(/^ {4}needs: (.+)$/m) || [, ''])[1];
        expect(needs('draft')).toContain('test');
        expect(needs('draft')).toContain('packages');
        expect(needs('attach')).toContain('draft');
        expect(needs('prepublish-verify')).toContain('attach');
        expect(needs('publish')).toContain('prepublish-verify');
        // macOS 冒烟安装与草稿 / 挂资产并行，只挡住 publish（Intel 上要六七分钟，不能放在 draft 之前）
        expect(needs('publish')).toContain('smoke-macos');
        expect(needs('smoke-macos')).toContain('packages');
        expect(needs('draft')).not.toContain('smoke-macos');
        expect(job('smoke-macos')).toContain('MANYOYO_TEST_SKIP_MACHINE=1');
        expect(job('smoke-macos')).toContain('uninstall --yes');
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
        expect(called.sort()).toEqual(['build-packages.yml', 'ci.yml', 'image-publish.yml', 'release-offline.yml', 'release-verify.yml']);
        for (const name of called) {
            const text = read(name);
            expect(text).toContain('workflow_call:');
            if (name !== 'ci.yml') expect(text).toContain('workflow_dispatch:');
        }
    });

    test('uses only the built-in token — no new secrets', () => {
        expect(new Set(pipeline.match(/secrets\.[A-Za-z_]+/g) || [])).toEqual(new Set());
    });

    // 试跑期间（CI 跑在分支 feat/release-autopilot 上）临时放行；清理提交会连同这行一起删掉，合并到 main 后由流水线自己的 test 阶段强制执行
    (process.env.GITHUB_REF_NAME === 'feat/release-autopilot' ? test.skip : test)('delivered state has no leftover branch trigger or temporary workflow (trial runs use a temporary push trigger that must be removed before merging)', () => {
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
