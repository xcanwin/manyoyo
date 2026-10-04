'use strict';

const { computeStages, nextStage, MANUAL_CHECKLIST } = require('../scripts/release/stages');


const run = (id, sha, conclusion = 'success') => ({ databaseId: id, status: 'completed', conclusion, headSha: sha });

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
    return { ...base, ...overrides, git: { ...base.git, ...(overrides.git || {}) }, release: { ...base.release, ...(overrides.release || {}) }, npm: { ...base.npm, ...(overrides.npm || {}) }, image: { ...base.image, ...(overrides.image || {}) }, runs: { ...base.runs, ...(overrides.runs || {}) }, gh: { ...base.gh, ...(overrides.gh || {}) } };
}
const ASSETS = ['SHA256SUMS', ...['macos', 'linux'].flatMap(os => ['arm64', 'x64'].flatMap(arch => [`manyoyo-8.2.0-${os}-${arch}.run`, `manyoyo-8.2.0-${os}-${arch}-app.tar.gz`]))].sort();
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
        expect(byId(computeStages(facts({ release: { exists: true, draft: true } }))).version.state).toBe('todo');
    });

    test('verify falls back to the latest successful run after the release was created when nothing was recorded', () => {
        const ready = { git: { mergedIntoOriginMain: true }, runs: { packages: [run(1, 'mmm')] } };
        const released = { ...ready, release: { exists: true, draft: false, assets: ASSETS, createdAt: '2026-10-02T10:00:00Z' } };
        const verify = (id, at, conclusion = 'success') => ({ ...run(id, 'mmm', conclusion), createdAt: at });
        expect(byId(computeStages(facts({ ...released, runs: { ...ready.runs, verify: [verify(5, '2026-10-02T11:00:00Z')] } }))).verify.state).toBe('done');
        expect(byId(computeStages(facts({ ...released, runs: { ...ready.runs, verify: [verify(5, '2026-10-02T09:00:00Z')] } }))).verify.state).toBe('todo');
        expect(byId(computeStages(facts({ ...released, runs: { ...ready.runs, verify: [verify(5, '2026-10-02T11:00:00Z', 'failure')] } }))).verify.state).toBe('todo');
    });

    test('a verify run recorded for an older tag never counts for the new release', () => {
        const ready = { git: { mergedIntoOriginMain: true }, runs: { packages: [run(1, 'mmm')], verify: [run(9, 'mmm')] }, release: { exists: true, draft: false, assets: ASSETS, createdAt: '2026-10-02T10:00:00Z' } };
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
        // 上一个版本勾选过的清单不会带到新版本
        expect(byId(computeStages(facts(), { checklists: { 'v8.1.0': all } })).manual.state).toBe('todo');
        const stages = computeStages(facts({ git: { dirty: [{ code: 'M', path: 'a' }] } }));
        expect(nextStage(stages).id).toBe('preflight');
        expect(nextStage(stages.map(stage => ({ ...stage, state: 'done' })))).toBeNull();
    });
});
