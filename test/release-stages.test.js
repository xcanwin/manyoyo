'use strict';

const { computeStages, nextStage, MANUAL_CHECKLIST } = require('../scripts/release/stages');
const { expectedAssetNames } = require('../scripts/release/facts');

const run = (id, sha, conclusion = 'success') => ({ databaseId: id, status: 'completed', conclusion, headSha: sha });

function facts(overrides = {}) {
    const base = {
        pkg: { version: '8.2.0', imageVersion: '2.1.0-common' },
        tag: 'v8.2.0',
        git: { branch: 'feat/x', headSha: 'aaa', dirty: [], fingerprint: 'fp1', hasOrigin: true, originMainSha: 'mmm', mergedIntoOriginMain: false, ahead: 0, latestTag: 'v8.1.0', imageChangedSinceTag: false, commitsSinceTag: [] },
        gh: { ok: true },
        release: { exists: false, assets: [], createdAt: '', url: '' },
        npm: { version: '8.1.0' },
        image: { exists: true },
        runs: { macos: [], linux: [], image: [], npm: [], assets: [], verify: [] }
    };
    return { ...base, ...overrides, git: { ...base.git, ...(overrides.git || {}) }, release: { ...base.release, ...(overrides.release || {}) }, npm: { ...base.npm, ...(overrides.npm || {}) }, image: { ...base.image, ...(overrides.image || {}) }, runs: { ...base.runs, ...(overrides.runs || {}) }, gh: { ...base.gh, ...(overrides.gh || {}) } };
}
const byId = stages => Object.fromEntries(stages.map(stage => [stage.id, stage]));

describe('release stages', () => {
    test('a dirty feature branch: preflight and commit are todo, merge is blocked until committed, publishing is blocked behind merge', () => {
        const s = byId(computeStages(facts({ git: { dirty: [{ code: 'M', path: 'a.js' }] } })));
        expect(s.preflight.state).toBe('todo');
        expect(s.version.state).toBe('done');
        expect(s.commit.state).toBe('todo');
        expect(s.merge.state).toBe('blocked');
        expect(s.packages.state).toBe('blocked');
        expect(s.release.state).toBe('blocked');
    });

    test('preflight is only valid for the exact tree it ran on', () => {
        const ok = { preflight: { ok: true, fingerprint: 'fp1' } };
        expect(byId(computeStages(facts(), ok)).preflight.state).toBe('done');
        expect(byId(computeStages(facts({ git: { fingerprint: 'fp2' } }), ok)).preflight.state).toBe('todo');
        expect(byId(computeStages(facts(), { preflight: { ok: false, fingerprint: 'fp1' } })).preflight.state).toBe('todo');
    });

    test('version: an already released version asks for a bump; an unreleased bump is done', () => {
        expect(byId(computeStages(facts())).version.state).toBe('done');
        expect(byId(computeStages(facts({ pkg: { version: '8.1.0', imageVersion: 'x' } }))).version.state).toBe('todo');
        expect(byId(computeStages(facts({ release: { exists: true } }))).version.state).toBe('todo');
    });

    test('after merging, the image and package builds come first; the release needs all of them', () => {
        const merged = { git: { mergedIntoOriginMain: true } };
        let s = byId(computeStages(facts({ ...merged, image: { exists: false } })));
        expect(s.merge.state).toBe('done');
        expect(s.image.state).toBe('todo');
        expect(s.packages.state).toBe('blocked');
        s = byId(computeStages(facts(merged)));
        expect(s.image.state).toBe('done');
        expect(s.packages.state).toBe('todo');
        expect(s.release.state).toBe('blocked');
        // 构建必须基于 main 当前提交：旧提交上的成功构建不算
        s = byId(computeStages(facts({ ...merged, runs: { macos: [run(1, 'old')], linux: [run(2, 'mmm')] } })));
        expect(s.packages.state).toBe('todo');
        s = byId(computeStages(facts({ ...merged, runs: { macos: [run(1, 'mmm')], linux: [run(2, 'mmm')] } })));
        expect(s.packages.state).toBe('done');
        expect(s.release.state).toBe('todo');
    });

    test('release → npm → assets → verify follow the real state', () => {
        const ready = { git: { mergedIntoOriginMain: true }, runs: { macos: [run(1, 'mmm')], linux: [run(2, 'mmm')] } };
        let s = byId(computeStages(facts({ ...ready, release: { exists: true, assets: [] } })));
        expect(s.release.state).toBe('done');
        expect(s.npm.state).toBe('todo');
        expect(s.assets.state).toBe('todo');
        s = byId(computeStages(facts({ ...ready, npm: { version: '8.2.0' }, release: { exists: true, assets: expectedAssetNames('8.2.0') }, runs: { ...ready.runs, verify: [run(9, 'mmm')] } }), { verify: { tag: 'v8.2.0', id: 9 } }));
        expect(s.npm.state).toBe('done');
        expect(s.assets.state).toBe('done');
        expect(s.verify.state).toBe('done');
        // 多一个或少一个资产都不算完成
        s = byId(computeStages(facts({ ...ready, release: { exists: true, assets: [...expectedAssetNames('8.2.0'), 'manyoyo-8.2.0-macos-arm64-lite.run'] } })));
        expect(s.assets.state).toBe('todo');
    });

    test('verify falls back to the latest successful run after the release was created when nothing was recorded', () => {
        const ready = { git: { mergedIntoOriginMain: true }, runs: { macos: [run(1, 'mmm')], linux: [run(2, 'mmm')] } };
        const released = { ...ready, release: { exists: true, assets: expectedAssetNames('8.2.0'), createdAt: '2026-10-02T10:00:00Z' } };
        const verify = (id, at, conclusion = 'success') => ({ ...run(id, 'mmm', conclusion), createdAt: at });
        expect(byId(computeStages(facts({ ...released, runs: { ...ready.runs, verify: [verify(5, '2026-10-02T11:00:00Z')] } }))).verify.state).toBe('done');
        expect(byId(computeStages(facts({ ...released, runs: { ...ready.runs, verify: [verify(5, '2026-10-02T09:00:00Z')] } }))).verify.state).toBe('todo');
        expect(byId(computeStages(facts({ ...released, runs: { ...ready.runs, verify: [verify(5, '2026-10-02T11:00:00Z', 'failure')] } }))).verify.state).toBe('todo');
    });

    test('a verify run recorded for an older tag never counts for the new release', () => {
        const ready = { git: { mergedIntoOriginMain: true }, runs: { macos: [run(1, 'mmm')], linux: [run(2, 'mmm')], verify: [run(9, 'mmm')] }, release: { exists: true, assets: expectedAssetNames('8.2.0') } };
        expect(byId(computeStages(facts(ready), { verify: { tag: 'v8.1.0', id: 9 } })).verify.state).toBe('todo');
        expect(byId(computeStages(facts(ready), { verify: { tag: 'v8.2.0', id: 9 } })).verify.state).toBe('done');
    });

    test('without gh authorization every GitHub-dependent stage explains how to fix it', () => {
        const s = byId(computeStages(facts({ gh: { ok: false }, git: { mergedIntoOriginMain: true } })));
        for (const id of ['image', 'packages', 'release']) {
            expect(s[id].state).toBe('blocked');
            expect(s[id].detail).toContain('gh');
        }
    });

    test('manual checklist is done only when every item is ticked; nextStage skips done and blocked stages', () => {
        const all = Object.fromEntries(MANUAL_CHECKLIST.map(item => [item.id, true]));
        expect(byId(computeStages(facts(), { checklists: { 'v8.2.0': all } })).manual.state).toBe('done');
        expect(byId(computeStages(facts(), { checklists: { 'v8.2.0': { [MANUAL_CHECKLIST[0].id]: true } } })).manual.state).toBe('todo');
        // 上一个版本勾选过的清单不会带到新版本
        expect(byId(computeStages(facts(), { checklists: { 'v8.1.0': all } })).manual.state).toBe('todo');
        const stages = computeStages(facts({ git: { dirty: [{ code: 'M', path: 'a' }] } }));
        expect(nextStage(stages).id).toBe('preflight');
        expect(nextStage(stages.map(stage => ({ ...stage, state: 'done' })))).toBeNull();
    });
});
