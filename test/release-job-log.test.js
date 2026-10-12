'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JobRunner } = require('../scripts/release/jobs');
const { readLatestRun, readStageLog } = require('../scripts/release/job-log');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-joblog-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function makeRunner(actions, over = {}) {
    const world = { merged: false, built: false };
    const collect = async () => ({
        pkg: { version: '8.2.0', imageVersion: '2.1.0-common' }, tag: 'v8.2.0',
        git: { branch: 'feat/x', headSha: 'a', dirty: [], fingerprint: 'f', hasOrigin: true, originMainSha: 'm', mergedIntoOriginMain: world.merged, ahead: 0, latestTag: 'v8.1.0', imageChangedSinceTag: false, dockerChangedSinceTag: false, changedFiles: [], commitsSinceTag: [] },
        gh: { ok: true }, release: { exists: false, draft: false, assets: [], sums: null, createdAt: '', url: '' }, npm: { version: '8.1.0' }, image: { exists: true },
        runs: world.built ? { ci: [], packages: [{ databaseId: 1, status: 'completed', conclusion: 'success', headSha: 'm' }], image: [], npm: [], assets: [], verify: [] } : { ci: [], packages: [], image: [], npm: [], assets: [], verify: [] }
    });
    const runner = new JobRunner({
        collect, makeCtx: log => ({ log }), actions: { merge: async () => { world.merged = true; }, packages: async () => { world.built = true; }, ...actions },
        describe: id => [id], getState: () => ({ preflight: { ok: true, fingerprint: 'f' } }), recheckTimes: 0, logDir: path.join(root, 'logs'), ...over
    });
    return { runner, world };
}
const finished = runner => new Promise(resolve => runner.on('event', event => { if (event.type === 'done') resolve(event); }));
const runDirs = () => fs.readdirSync(path.join(root, 'logs')).filter(name => /^\d{8}-\d{6}-/.test(name)).sort();

describe('per-stage job logs', () => {
    test('every stage gets its own NN-<stage>.log and summary.json records result, timing and the failure', async () => {
        const { runner } = makeRunner({
            packages: async ctx => { ctx.log('\u001b[32mbuilding\u001b[39m'); throw new Error('构建失败'); }
        });
        const done = finished(runner);
        runner.start({ stages: ['merge', 'packages'], mode: 'auto', confirmed: true });
        expect((await done).status).toBe('failed');
        const [dir] = runDirs();
        expect(dir).toMatch(/^\d{8}-\d{6}-merge\+packages-\d{3}$/);
        const full = path.join(root, 'logs', dir);
        expect(fs.readdirSync(full).sort()).toEqual(['01-merge.log', '02-packages.log', 'summary.json']);
        // 日志文件只含本阶段的输出，且没有终端颜色码
        expect(fs.readFileSync(path.join(full, '02-packages.log'), 'utf-8')).toContain('building');
        expect(fs.readFileSync(path.join(full, '02-packages.log'), 'utf-8')).not.toContain('\u001b');
        expect(fs.readFileSync(path.join(full, '01-merge.log'), 'utf-8')).not.toContain('building');
        const summary = JSON.parse(fs.readFileSync(path.join(full, 'summary.json'), 'utf-8'));
        expect(summary).toMatchObject({ result: 'failed' });
        expect(Date.parse(summary.startedAt)).not.toBeNaN();
        expect(Date.parse(summary.finishedAt)).not.toBeNaN();
        expect(summary.stages.map(stage => [stage.id, stage.result, stage.logFile])).toEqual([['merge', 'done', '01-merge.log'], ['packages', 'failed', '02-packages.log']]);
        expect(summary.stages[1].detail).toContain('构建失败');
        expect(typeof summary.stages[0].durationMs).toBe('number');
    });

    test('skipped stages are recorded; a successful job ends as succeeded', async () => {
        const { runner, world } = makeRunner({});
        world.merged = true;
        const done = finished(runner);
        runner.start({ stages: ['merge', 'packages'], mode: 'auto', confirmed: true });
        await done;
        const summary = JSON.parse(fs.readFileSync(path.join(root, 'logs', runDirs()[0], 'summary.json'), 'utf-8'));
        expect(summary.result).toBe('succeeded');
        expect(summary.stages.map(stage => stage.result)).toEqual(['skipped', 'done']);
    });

    test('only the latest 20 runs are kept, and "latest" names the newest', async () => {
        const logs = path.join(root, 'logs');
        fs.mkdirSync(logs, { recursive: true });
        for (let i = 0; i < 25; i += 1) fs.mkdirSync(path.join(logs, `20200101-0000${String(i).padStart(2, '0')}-old`));
        const { runner } = makeRunner({});
        const done = finished(runner);
        runner.start({ stages: ['merge'], mode: 'single', confirmed: true });
        await done;
        const dirs = runDirs();
        expect(dirs).toHaveLength(20);
        expect(dirs.some(name => /-merge-\d{3}$/.test(name))).toBe(true);
        expect(fs.readFileSync(path.join(logs, 'latest'), 'utf-8').trim()).toBe(dirs.find(name => /-merge-\d{3}$/.test(name)));
    });

    test('two jobs started within the same second do not share a folder', async () => {
        const { runner } = makeRunner({});
        const first = finished(runner);
        runner.start({ stages: ['merge'], mode: 'single', confirmed: true });
        await first;
        const second = finished(runner);
        runner.start({ stages: ['merge'], mode: 'single', confirmed: true });
        await second;
        expect(new Set(runDirs()).size).toBe(2);
    });

    test('readLatestRun and readStageLog serve the web page; a crafted stage id cannot escape the folder', async () => {
        const { runner } = makeRunner({ merge: async ctx => { ctx.log('line1'); ctx.log('line2'); } });
        const done = finished(runner);
        runner.start({ stages: ['merge'], mode: 'single', confirmed: true });
        await done;
        const logs = path.join(root, 'logs');
        const latest = readLatestRun(logs);
        expect(latest.summary.stages[0].id).toBe('merge');
        expect(readStageLog(logs, latest.dir, 'merge').lines).toEqual(['line1', 'line2']);
        expect(readStageLog(logs, latest.dir, '../../etc/passwd')).toBeNull();
        expect(readStageLog(logs, '../x', 'merge')).toBeNull();
        expect(readLatestRun(path.join(root, 'missing'))).toBeNull();
    });
});
