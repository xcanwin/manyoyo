'use strict';

const { JobRunner } = require('../scripts/release/jobs');

// 一个会随动作变化的假世界：合并后 merged=true，构建后 packages=true
function makeWorld() {
    const world = { merged: false, built: false, released: false, logs: [] };
    const collect = async () => ({
        pkg: { version: '8.2.0', imageVersion: '2.1.0-common' },
        tag: 'v8.2.0',
        git: { branch: 'feat/x', headSha: 'a', dirty: [], fingerprint: 'f', hasOrigin: true, originMainSha: 'm', mergedIntoOriginMain: world.merged, ahead: 0, latestTag: 'v8.1.0', imageChangedSinceTag: false, dockerChangedSinceTag: false, changedFiles: [], commitsSinceTag: [] },
        gh: { ok: true },
        release: { exists: world.released, draft: true, assets: [], sums: null, createdAt: '', url: '' },
        npm: { version: '8.1.0' },
        image: { exists: true },
        runs: world.built
            ? { ci: [], packages: [{ databaseId: 1, status: 'completed', conclusion: 'success', headSha: 'm' }], image: [], npm: [], assets: [], verify: [] }
            : { ci: [], packages: [], image: [], npm: [], assets: [], verify: [] }
    });
    const actions = {
        merge: jest.fn(async () => { world.merged = true; }),
        packages: jest.fn(async () => { world.built = true; }),
        release: jest.fn(async () => { world.released = true; }),
        image: jest.fn(async () => {})
    };
    const runner = new JobRunner({
        collect,
        makeCtx: (log) => ({ log }),
        actions,
        describe: id => [`do ${id}`],
        getState: () => ({ preflight: { ok: true, fingerprint: 'f' } }),
        recheckTimes: 0
    });
    return { world, actions, runner };
}

const finished = runner => new Promise(resolve => runner.on('event', event => { if (event.type === 'done') resolve(event); }));
const nextConfirm = runner => new Promise(resolve => runner.on('event', function handler(event) { if (event.type === 'confirm') { runner.off('event', handler); resolve(event); } }));

describe('JobRunner', () => {
    test('a single external stage needs an explicit confirmation; unknown stages and a second job are rejected', async () => {
        const { runner, actions } = makeWorld();
        expect(() => runner.start({ stages: ['merge'], mode: 'single' })).toThrow(expect.objectContaining({ code: 'CONFIRM_REQUIRED' }));
        expect(() => runner.start({ stages: ['nope'], mode: 'single' })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
        expect(() => runner.start({ stages: ['merge', 'image'], mode: 'single', confirmed: true })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
        const done = finished(runner);
        runner.start({ stages: ['merge'], mode: 'single', confirmed: true });
        expect(() => runner.start({ stages: ['merge'], mode: 'single', confirmed: true })).toThrow(expect.objectContaining({ code: 'BUSY' }));
        expect((await done).status).toBe('succeeded');
        expect(actions.merge).toHaveBeenCalledTimes(1);
    });

    test('step mode asks before every external stage and runs only after approval', async () => {
        const { runner, actions } = makeWorld();
        const done = finished(runner);
        const first = nextConfirm(runner);
        runner.start({ stages: ['merge', 'packages', 'release'], mode: 'step' });
        let confirm = await first;
        expect(confirm.stage).toBe('merge');
        expect(confirm.commands).toEqual(['do merge']);
        expect(actions.merge).not.toHaveBeenCalled();
        let next = nextConfirm(runner);
        runner.approve(true);
        confirm = await next;
        expect(confirm.stage).toBe('packages');
        expect(actions.merge).toHaveBeenCalled();
        next = nextConfirm(runner);
        runner.approve(true);
        expect((await next).stage).toBe('release');
        runner.approve(true);
        expect((await done).status).toBe('succeeded');
        expect(actions.release).toHaveBeenCalled();
    });

    test('rejecting a confirmation stops the job without running the stage', async () => {
        const { runner, actions } = makeWorld();
        const done = finished(runner);
        const confirm = nextConfirm(runner);
        runner.start({ stages: ['merge', 'packages'], mode: 'step' });
        await confirm;
        runner.approve(false);
        const event = await done;
        expect(event.status).toBe('cancelled');
        expect(actions.merge).not.toHaveBeenCalled();
    });

    test('auto mode needs one up-front confirmation, then runs every stage and skips what is already done', async () => {
        const { runner, actions, world } = makeWorld();
        expect(() => runner.start({ stages: ['merge', 'packages'], mode: 'auto' })).toThrow(expect.objectContaining({ code: 'CONFIRM_REQUIRED' }));
        world.merged = true; // merge 已完成 → 跳过
        const done = finished(runner);
        runner.start({ stages: ['merge', 'packages', 'release'], mode: 'auto', confirmed: true });
        expect((await done).status).toBe('succeeded');
        expect(actions.merge).not.toHaveBeenCalled();
        expect(actions.packages).toHaveBeenCalled();
        expect(actions.release).toHaveBeenCalled();
        expect(runner.events.some(event => event.type === 'stage' && event.stage === 'merge' && event.state === 'skipped')).toBe(true);
    });

    test('a blocked stage stops a multi-stage run with the reason', async () => {
        const { runner, actions } = makeWorld();
        const done = finished(runner);
        runner.start({ stages: ['release'], mode: 'auto', confirmed: true });
        const event = await done;
        expect(event.status).toBe('failed');
        expect(event.error).toContain('被阻塞');
        expect(actions.release).not.toHaveBeenCalled();
    });

    test('a stage that finishes but is not actually done fails the run instead of continuing', async () => {
        const { runner, actions } = makeWorld();
        actions.merge.mockImplementation(async () => {}); // 没有真的合并
        const done = finished(runner);
        runner.start({ stages: ['merge', 'packages'], mode: 'auto', confirmed: true });
        const event = await done;
        expect(event.status).toBe('failed');
        expect(event.error).toContain('状态仍是');
        expect(actions.packages).not.toHaveBeenCalled();
    });

    test('the server enforces prerequisites for external stages even in single mode', async () => {
        const { runner, actions } = makeWorld();
        const done = finished(runner);
        runner.start({ stages: ['release'], mode: 'single', confirmed: true });
        const event = await done;
        expect(event.status).toBe('failed');
        expect(event.error).toContain('被阻塞');
        expect(actions.release).not.toHaveBeenCalled();
    });

    test('auto mode stops at a stage whose state cannot be confirmed (warn) instead of running it', async () => {
        const { runner, actions, world } = makeWorld();
        world.merged = true;
        const original = runner.deps.collect;
        runner.deps.collect = async () => ({ ...(await original()), image: { exists: null } });
        const done = finished(runner);
        runner.start({ stages: ['image', 'packages'], mode: 'auto', confirmed: true });
        const event = await done;
        expect(event.status).toBe('failed');
        expect(event.error).toContain('需要人工确认');
        expect(actions.image).not.toHaveBeenCalled();
    });

    test('a stage whose external state lags behind (GitHub run list, npm CDN) is re-checked before failing the run', async () => {
        const { runner, actions, world } = makeWorld();
        world.merged = true;
        runner.recheckTimes = 3;
        runner.recheckDelayMs = 1;
        const original = runner.deps.collect;
        let lag = 2; // 动作做完后，前两次读到的仍是旧状态
        actions.packages.mockImplementation(async () => { world.built = true; });
        runner.deps.collect = async () => {
            const facts = await original();
            if (world.built && lag > 0) { lag -= 1; return { ...facts, runs: { ci: [], packages: [], image: [], npm: [], assets: [], verify: [] } }; }
            return facts;
        };
        const done = finished(runner);
        runner.start({ stages: ['packages'], mode: 'auto', confirmed: true });
        expect((await done).status).toBe('succeeded');
        expect(runner.events.some(event => event.type === 'log' && /状态还没更新/.test(event.line))).toBe(true);
    });

    test('dry-run walks through every stage even though nothing changes (no BLOCKED / NOT_DONE stops)', async () => {
        const { runner, actions } = makeWorld();
        runner.deps.dryRun = true;
        const done = finished(runner);
        runner.start({ stages: ['merge', 'packages', 'release'], mode: 'auto', confirmed: true });
        expect((await done).status).toBe('succeeded');
        expect(actions.merge).toHaveBeenCalled();
        expect(actions.packages).toHaveBeenCalled();
        expect(actions.release).toHaveBeenCalled();
    });

    test('cancel aborts the running job and the signal reaches the action', async () => {
        const { runner, actions } = makeWorld();
        let signal;
        actions.merge.mockImplementation(async (ctx) => { await new Promise(resolve => setTimeout(resolve, 30)); signal = ctx.signal; });
        runner.deps.makeCtx = (log, sig) => ({ log, signal: sig });
        const done = finished(runner);
        runner.start({ stages: ['merge', 'packages'], mode: 'auto', confirmed: true });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(runner.cancel()).toBe(true);
        expect((await done).status).toBe('cancelled');
        expect(signal.aborted).toBe(true);
        expect(actions.packages).not.toHaveBeenCalled();
    });
});
