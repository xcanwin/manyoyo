'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { computeStages, STAGES, MANUAL_CHECKLIST } = require('../scripts/release/stages');
const { checkAssets, treeFingerprint } = require('../scripts/release/facts');
const { ACTIONS, describeCommands } = require('../scripts/release/actions');
const { matchDeviceRules } = require('../scripts/release/device-rules');

const run = (id, sha, conclusion = 'success') => ({ databaseId: id, status: 'completed', conclusion, headSha: sha });
const names = (version, volumes = false) => {
    const list = ['SHA256SUMS'];
    for (const os_ of ['macos', 'linux']) {
        for (const arch of ['arm64', 'x64']) {
            list.push(`manyoyo-${version}-${os_}-${arch}-app.tar.gz`);
            if (volumes && os_ === 'macos' && arch === 'x64') list.push(`manyoyo-${version}-macos-x64.run.001`, `manyoyo-${version}-macos-x64.run.002`);
            else list.push(`manyoyo-${version}-${os_}-${arch}.run`);
        }
    }
    return list.sort();
};

function facts(overrides = {}) {
    const base = {
        pkg: { version: '8.2.0', imageVersion: '2.1.0-common' },
        tag: 'v8.2.0',
        git: { branch: 'feat/x', headSha: 'aaa', dirty: [], fingerprint: 'fp1', hasOrigin: true, originMainSha: 'mmm', mergedIntoOriginMain: false, ahead: 0, latestTag: 'v8.1.0', imageChangedSinceTag: false, dockerChangedSinceTag: false, changedFiles: [], commitsSinceTag: [] },
        gh: { ok: true },
        release: { exists: false, draft: false, assets: [], sums: null, createdAt: '', url: '' },
        npm: { version: '8.1.0' },
        image: { exists: true },
        runs: { ci: [], packages: [], image: [], npm: [], assets: [], verify: [] }
    };
    const merge = key => ({ ...base[key], ...(overrides[key] || {}) });
    return { ...base, ...overrides, git: merge('git'), release: merge('release'), npm: merge('npm'), image: merge('image'), runs: merge('runs'), gh: merge('gh') };
}
const byId = stages => Object.fromEntries(stages.map(stage => [stage.id, stage]));
const merged = { git: { mergedIntoOriginMain: true } };
const built = { runs: { packages: [run(1, 'mmm')] } };
const pre = { preflight: { ok: true, fingerprint: 'fp1' } };

describe('asset set (B1)', () => {
    test('a split Intel package (10 assets) is complete; a missing platform is not', () => {
        expect(checkAssets('8.2.0', names('8.2.0', true)).ok).toBe(true);
        expect(checkAssets('8.2.0', names('8.2.0')).ok).toBe(true);
        const lacking = names('8.2.0').filter(name => !name.includes('linux-arm64'));
        const result = checkAssets('8.2.0', lacking);
        expect(result.ok).toBe(false);
        expect(result.missing.length).toBeGreaterThan(0);
        // 分卷必须从 001 连续
        const gap = names('8.2.0', true).filter(name => !name.endsWith('.run.001'));
        expect(checkAssets('8.2.0', gap).ok).toBe(false);
        // 多出来的陌生文件不算齐全
        expect(checkAssets('8.2.0', [...names('8.2.0'), 'manyoyo-8.2.0-macos-arm64-lite.run']).ok).toBe(false);
    });

    test('when SHA256SUMS is known, the listed files must equal the uploaded assets', () => {
        const all = names('8.2.0', true);
        const listed = all.filter(name => name !== 'SHA256SUMS');
        expect(checkAssets('8.2.0', all, listed).ok).toBe(true);
        expect(checkAssets('8.2.0', all, listed.slice(1)).ok).toBe(false);
    });

    test('stages: 10 assets mean assets done', () => {
        const s = byId(computeStages(facts({ ...merged, ...built, release: { exists: true, draft: true, assets: names('8.2.0', true) } }), pre));
        expect(s.assets.state).toBe('done');
        expect(s.publish.state).toBe('todo');
    });
});

describe('stage order and gates', () => {
    test('stage order puts the real-device gate before the release and publishes only after the assets (B6/B11)', () => {
        expect(STAGES.map(stage => stage.id)).toEqual(['preflight', 'version', 'commit', 'merge', 'image', 'packages', 'device', 'release', 'assets', 'publish', 'verify', 'npm', 'manual']);
    });

    test('merge is blocked until preflight passed on this tree, or CI passed on this very commit (B2)', () => {
        expect(byId(computeStages(facts())).merge.state).toBe('blocked');
        expect(byId(computeStages(facts(), pre)).merge.state).toBe('todo');
        expect(byId(computeStages(facts(), { preflight: { ok: true, fingerprint: 'other' } })).merge.state).toBe('blocked');
        expect(byId(computeStages(facts({ runs: { ci: [run(5, 'aaa')] } }))).merge.state).toBe('todo');
        expect(byId(computeStages(facts({ runs: { ci: [run(5, 'old')] } }))).merge.state).toBe('blocked');
        expect(byId(computeStages(facts({ runs: { ci: [run(5, 'aaa')] }, git: { dirty: [{ code: 'M', path: 'a' }] } }))).merge.state).toBe('blocked');
        expect(byId(computeStages(facts({ runs: { ci: [run(5, 'aaa', 'failure')] } }))).merge.state).toBe('blocked');
    });

    test('docker/ changed since the last tag without a new imageVersion blocks the image stage (B5)', () => {
        const s = byId(computeStages(facts({ ...merged, git: { ...merged.git, dockerChangedSinceTag: true, imageChangedSinceTag: true } }), pre));
        expect(s.image.state).toBe('blocked');
        expect(s.image.detail).toContain('imageVersion');
        // 升了版本号并且新镜像已发布，就不再阻塞
        const bumped = byId(computeStages(facts({ ...merged, git: { ...merged.git, dockerChangedSinceTag: true, imageChangedSinceTag: true, imageVersionChanged: true } }), pre));
        expect(bumped.image.state).toBe('done');
    });

    test('release is a draft pinned to the packages commit; publish needs complete assets and flips the draft', () => {
        let s = byId(computeStages(facts({ ...merged, ...built }), pre));
        expect(s.release.state).toBe('todo');
        expect(s.release.detail).toContain('草稿');
        s = byId(computeStages(facts({ ...merged, ...built, release: { exists: true, draft: true, assets: [] } }), pre));
        expect(s.release.state).toBe('done');
        expect(s.assets.state).toBe('todo');
        expect(s.publish.state).toBe('blocked');
        expect(s.npm.state).toBe('blocked');
        s = byId(computeStages(facts({ ...merged, ...built, release: { exists: true, draft: false, assets: names('8.2.0') } }), pre));
        expect(s.publish.state).toBe('done');
        expect(s.npm.state).toBe('todo');
        expect(s.verify.state).toBe('todo');
    });

    test('the build is judged by build-packages.yml on the main commit', () => {
        expect(byId(computeStages(facts(merged), pre)).packages.state).toBe('todo');
        expect(byId(computeStages(facts({ ...merged, runs: { packages: [run(1, 'old')] } }), pre)).packages.state).toBe('todo');
        expect(byId(computeStages(facts({ ...merged, ...built }), pre)).packages.state).toBe('done');
    });
});

describe('published version (B7)', () => {
    test('once the release is public with complete assets, earlier stages stay done even if main moved on', () => {
        const s = byId(computeStages(facts({
            ...merged,
            git: { mergedIntoOriginMain: true, originMainSha: 'newer' },
            npm: { version: '8.2.0' },
            release: { exists: true, draft: false, assets: names('8.2.0', true), createdAt: '2026-10-02T10:00:00Z' },
            runs: { packages: [run(1, 'mmm')], verify: [{ ...run(9, 'mmm'), createdAt: '2026-10-02T11:00:00Z' }] }
        }), { checklists: { 'v8.2.0': Object.fromEntries(MANUAL_CHECKLIST.map(item => [item.id, true])) } }));
        expect(computeStages(facts({ release: { exists: true, draft: false, assets: names('8.2.0') } })).map(stage => stage.id)).toEqual(STAGES.map(stage => stage.id));
        for (const id of ['preflight', 'version', 'commit', 'merge', 'image', 'packages', 'device', 'release', 'assets', 'publish', 'verify', 'npm', 'manual']) {
            expect(s[id].state).toBe('done');
        }
        expect(s.version.detail).toContain('已发布');
    });
});

describe('device gate', () => {
    test('rules fire by changed area and ignore CI-only build scripts and workflows', () => {
        const hit = files => matchDeviceRules(files).map(rule => rule.id);
        expect(hit(['lib/plugin/playwright-relay.js'])).toEqual(['plugin']);
        expect(hit(['docker/res/playwright/browser.json'])).toEqual(['plugin']);
        expect(hit(['scripts/install.sh'])).toEqual(['install']);
        expect(hit(['scripts/offline/install.sh', 'lib/post-install.js'])).toEqual(['install']);
        expect(hit(['lib/runtime-heal.js'])).toEqual(['runtime']);
        expect(hit(['lib/web/server.js', 'frontend/src/app.tsx'])).toEqual(['web']);
        expect(hit(['scripts/offline/build.js', 'scripts/offline/stage.js', 'scripts/normalized-tar.js', '.github/workflows/build-packages.yml', 'frontend/src/release/release-app.tsx', 'frontend/release.html', 'docs/a.md', 'test/a.test.js'])).toEqual([]);
    });

    test('no rule hit means the device gate is done; hits block until ticked for this tag', () => {
        let s = byId(computeStages(facts({ ...merged, ...built }), pre));
        expect(s.device.state).toBe('done');
        const hitFacts = facts({ ...merged, ...built, git: { ...merged.git, changedFiles: ['lib/plugin/a.js', 'lib/web/b.js'] } });
        s = byId(computeStages(hitFacts, pre));
        expect(s.device.state).toBe('todo');
        expect(s.release.state).toBe('blocked');
        s = byId(computeStages(hitFacts, { ...pre, devices: { 'v8.2.0': { plugin: { done: true, by: 'u', sha: 'mmm' } } } }));
        expect(s.device.state).toBe('todo');
        s = byId(computeStages(hitFacts, { ...pre, devices: { 'v8.2.0': { plugin: { done: true, sha: 'mmm' }, web: { done: true, sha: 'mmm' } } } }));
        expect(s.device.state).toBe('done');
        expect(s.release.state).toBe('todo');
        // 别的版本勾选过的不算
        s = byId(computeStages(hitFacts, { ...pre, devices: { 'v8.1.0': { plugin: { done: true, sha: 'mmm' }, web: { done: true, sha: 'mmm' } } } }));
        expect(s.device.state).toBe('todo');
    });
});

describe('review findings', () => {
    test('a draft in progress never makes "bump the version" the next step; after merge, preflight stays done', () => {
        const drafting = computeStages(facts({ ...merged, ...built, release: { exists: true, draft: true, assets: [] } }), {});
        expect(byId(drafting).version.state).toBe('done');
        expect(byId(drafting).preflight.state).toBe('done');
        expect(drafting.find(stage => stage.state === 'todo').id).toBe('assets');
    });

    test('a real-device tick is only valid for the main commit it was made on', () => {
        const hitFacts = facts({ ...merged, ...built, git: { ...merged.git, changedFiles: ['lib/plugin/a.js'] } });
        const ticked = { ...pre, devices: { 'v8.2.0': { plugin: { done: true, sha: 'mmm' } } } };
        expect(byId(computeStages(hitFacts, ticked)).device.state).toBe('done');
        const moved = facts({ ...merged, ...built, git: { ...merged.git, originMainSha: 'newer', changedFiles: ['lib/plugin/a.js'] } });
        const stage = byId(computeStages(moved, ticked)).device;
        expect(stage.state).toBe('todo');
        expect(stage.detail).toContain('重新确认');
        // 没有记录提交的旧格式勾选同样不算
        expect(byId(computeStages(hitFacts, { ...pre, devices: { 'v8.2.0': { plugin: { done: true } } } })).device.state).toBe('todo');
    });

    test('--npm-dispatch re-runs a failed npm-publish instead of waiting on the dead run', async () => {
        const reads = (cmd, args) => {
            if (cmd === 'gh' && args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ databaseId: 9, createdAt: new Date(0).toISOString() }]) };
            if (cmd === 'gh' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ status: 'completed', conclusion: 'failure' }) };
            return { status: 0, stdout: '' };
        };
        const calls = [];
        let clock = 100000;
        const ctx = { repoRoot: os.tmpdir(), dryRun: false, read: reads, run: async (cmd, args) => { calls.push(args); return { status: 0 }; }, log: () => {}, sleep: async ms => { clock += ms; }, now: () => clock, state: { save: () => {}, load: () => ({}) } };
        await expect(ACTIONS.npm(ctx, { dispatch: true }, { ...facts({ ...merged, ...built }) })).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
        expect(calls[0]).toEqual(['workflow', 'run', 'npm-publish.yml', '--ref', 'v8.2.0', '-f', 'tag=v8.2.0']);
    });
});

describe('actions', () => {
    function ctxFor(options = {}) {
        const calls = [];
        let clock = 1000;
        return {
            calls, repoRoot: os.tmpdir(), dryRun: false,
            read: jest.fn(options.read || (() => ({ status: 0, stdout: '' }))),
            run: jest.fn(async (cmd, args, opts = {}) => { calls.push({ cmd, args, ...opts }); return { status: 0 }; }),
            log: () => {}, sleep: async ms => { clock += ms; }, now: () => clock,
            state: { save: () => {}, load: () => ({}) }
        };
    }
    const f = (over = {}) => ({ ...facts({ ...merged, ...built }), ...over });

    test('release creates a draft pinned to the sha of the successful build (B4/B6)', async () => {
        const ctx = ctxFor();
        await ACTIONS.release(ctx, { notes: 'hello' }, f());
        const args = ctx.calls[0].args;
        expect(args.slice(0, 3)).toEqual(['release', 'create', 'v8.2.0']);
        expect(args).toContain('--draft');
        expect(args[args.indexOf('--target') + 1]).toBe('mmm');
        expect(args).not.toContain('main');
    });

    test('publish flips the draft only after the assets are checked', async () => {
        const ctx = ctxFor();
        await ACTIONS.publish(ctx, {}, f());
        expect(ctx.calls[0]).toMatchObject({ cmd: 'gh', args: ['release', 'edit', 'v8.2.0', '--draft=false'], external: true });
    });

    test('assets dispatches release-offline with the single build run id and accepts split volumes', async () => {
        const reads = (cmd, args) => {
            if (args[0] === 'run' && args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ databaseId: 77, createdAt: new Date(2000).toISOString() }]) };
            if (args[0] === 'run' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ status: 'completed', conclusion: 'success', url: 'u' }) };
            if (args[0] === 'release' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ assets: names('8.2.0', true).map(name => ({ name })) }) };
            if (args[0] === 'release' && args[1] === 'download') return { status: 0, stdout: names('8.2.0', true).filter(name => name !== 'SHA256SUMS').map(name => `abc  ${name}`).join('\n') };
            return { status: 0, stdout: '' };
        };
        const ctx = ctxFor({ read: reads });
        await ACTIONS.assets(ctx, {}, f());
        expect(ctx.calls[0].args).toEqual(['workflow', 'run', 'release-offline.yml', '--ref', 'main', '-f', 'tag=v8.2.0', '-f', 'runId=1']);
        const bad = ctxFor({ read: (cmd, args) => (args[0] === 'release' && args[1] === 'view' ? { status: 0, stdout: JSON.stringify({ assets: [{ name: 'SHA256SUMS' }] }) } : reads(cmd, args)) });
        await expect(ACTIONS.assets(bad, {}, f())).rejects.toMatchObject({ code: 'ASSETS_MISMATCH' });
    });

    test('npm that is never triggered by the release explains the fallback; with dispatch it runs the workflow itself', async () => {
        const reads = (cmd, args) => (cmd === 'gh' && args[1] === 'list' ? { status: 0, stdout: '[]' } : { status: 0, stdout: '' });
        await expect(ACTIONS.npm(ctxFor({ read: reads }), {}, f())).rejects.toMatchObject({ code: 'RUN_NOT_FOUND', message: expect.stringContaining('gh workflow run npm-publish.yml') });
        const ctx = ctxFor({ read: reads });
        await expect(ACTIONS.npm(ctx, { dispatch: true }, f())).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
        expect(ctx.calls[0].args).toEqual(['workflow', 'run', 'npm-publish.yml', '--ref', 'v8.2.0', '-f', 'tag=v8.2.0']);
    });

    test('describeCommands shows the draft, the pinned sha and the publish command', () => {
        expect(describeCommands('release', f(), {}).join('\n')).toMatch(/--draft --target mmm/);
        expect(describeCommands('publish', f(), {})).toEqual(['gh release edit v8.2.0 --draft=false']);
        expect(describeCommands('packages', f(), {})).toEqual(['gh workflow run build-packages.yml --ref main']);
    });
});

describe('treeFingerprint (B9)', () => {
    test('editing an untracked file changes the fingerprint', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-fp-'));
        try {
            const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
            git('init', '-q');
            git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
            const read = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf-8' }); return { status: r.status, stdout: r.stdout, stderr: r.stderr }; };
            fs.writeFileSync(path.join(dir, 'new.js'), 'one');
            const first = treeFingerprint(read, dir);
            expect(treeFingerprint(read, dir)).toBe(first);
            fs.writeFileSync(path.join(dir, 'new.js'), 'two');
            expect(treeFingerprint(read, dir)).not.toBe(first);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
