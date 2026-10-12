'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { startRemote, fetchRemoteRun, remoteStatusText, planRemote } = require('../scripts/release/remote');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-remote-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function facts(over = {}) {
    return {
        pkg: { version: '8.6.3', imageVersion: '2.1.0-common' }, tag: 'v8.6.3',
        git: { branch: 'main', dirty: [], hasOrigin: true, latestTag: 'v8.6.3', mergedIntoOriginMain: true, originMainSha: 'm', ...(over.git || {}) },
        gh: { ok: true, ...(over.gh || {}) }, ...(over.top || {})
    };
}

// 假 ctx：记录执行过的外部命令；git rev-parse HEAD / gh run list / gh run view 由 read / readAsync 给出
function makeCtx(options = {}) {
    const calls = [];
    const logs = [];
    let clock = 1000;
    const answers = options.answers || {};
    const answer = (cmd, args) => {
        const key = `${cmd} ${args.join(' ')}`;
        const hit = Object.keys(answers).find(prefix => key.startsWith(prefix));
        return hit ? answers[hit] : { status: 0, stdout: '' };
    };
    return {
        repoRoot: root, dryRun: options.dryRun || false, calls, logs,
        read: (cmd, args) => answer(cmd, args),
        readAsync: async (cmd, args) => answer(cmd, args),
        run: async (cmd, args, opts = {}) => {
            if (options.dryRun && !opts.safe) { logs.push(`[dry-run] ${cmd} ${args.join(' ')}`); return { status: 0 }; }
            calls.push({ cmd, args, ...opts });
            return { status: 0 };
        },
        log: line => logs.push(line),
        sleep: async ms => { clock += ms; },
        now: () => clock
    };
}
const commands = ctx => ctx.calls.map(call => `${call.cmd} ${call.args.join(' ')}`);
const runList = JSON.stringify([{ databaseId: 77, createdAt: new Date(1000000).toISOString(), status: 'queued' }]);

describe('startRemote (npm run release -- --remote)', () => {
    test('version already above the last release: push main, dispatch the pipeline with the commit — no version bump, no --yes involved', async () => {
        const ctx = makeCtx({ answers: { 'git rev-parse HEAD': { status: 0, stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' }, 'gh run list': { status: 0, stdout: runList }, 'gh run view': { status: 0, stdout: JSON.stringify({ url: 'https://github.com/x/y/actions/runs/77' }) } } });
        ctx.now = () => 1000000;
        const result = await startRemote(ctx, facts({ top: { pkg: { version: '8.6.4', imageVersion: '2.1.0-common' } } }), {});
        expect(result).toMatchObject({ runId: 77, version: '8.6.4', sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', url: 'https://github.com/x/y/actions/runs/77' });
        const list = commands(ctx);
        expect(list.some(line => line.startsWith('npm version'))).toBe(false);
        const push = list.findIndex(line => line.includes('push origin main'));
        const dispatch = list.findIndex(line => line === 'gh workflow run release-pipeline.yml --ref main -f sha=a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
        expect(push).toBeGreaterThan(-1);
        expect(dispatch).toBeGreaterThan(push);
        // 对外动作都标了 external（执行层据此在 dry-run 下只打印）
        expect(ctx.calls.filter(call => /push|workflow/.test(call.args.join(' '))).every(call => call.external === true)).toBe(true);
    });

    test('version not bumped: bump to the recommended patch (or --version), commit "升级版本到 x.y.z", then push and dispatch', async () => {
        const ctx = makeCtx({ answers: { 'git rev-parse HEAD': { status: 0, stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' }, 'gh run list': { status: 0, stdout: runList }, 'gh run view': { status: 0, stdout: '{}' } } });
        ctx.now = () => 1000000;
        const result = await startRemote(ctx, facts(), {});
        expect(result.version).toBe('8.6.4');
        const list = commands(ctx);
        expect(list).toContain('npm version 8.6.4 --no-git-tag-version');
        expect(list).toContain('git add -- package.json package-lock.json');
        const commit = ctx.calls.find(call => call.cmd === 'git' && call.args[0] === 'commit');
        expect(commit.input).toBe('升级版本到 8.6.4\n');
        expect(list.findIndex(line => line.includes('push origin main'))).toBeGreaterThan(list.indexOf('npm version 8.6.4 --no-git-tag-version'));

        const custom = makeCtx({ answers: { 'git rev-parse HEAD': { status: 0, stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n' }, 'gh run list': { status: 0, stdout: runList }, 'gh run view': { status: 0, stdout: '{}' } } });
        custom.now = () => 1000000;
        expect((await startRemote(custom, facts(), { version: '8.7.0' })).version).toBe('8.7.0');
        expect(commands(custom)).toContain('npm version 8.7.0 --no-git-tag-version');
    });

    test('refuses with a clear reason: dirty tree, not on main, no gh login, a version that is not above the last release', async () => {
        const dirty = facts({ git: { dirty: [{ code: 'M', path: 'a.js' }] } });
        await expect(startRemote(makeCtx(), dirty, {})).rejects.toMatchObject({ code: 'DIRTY' });
        await expect(startRemote(makeCtx(), facts({ git: { branch: 'feat/x' } }), {})).rejects.toMatchObject({ code: 'NOT_MAIN' });
        await expect(startRemote(makeCtx(), facts({ gh: { ok: false } }), {})).rejects.toMatchObject({ code: 'NO_GH' });
        await expect(startRemote(makeCtx(), facts(), { version: '8.6.3' })).rejects.toMatchObject({ code: 'BAD_VERSION' });
        // 全部是在动手之前拒绝：没有执行过任何命令
        const ctx = makeCtx();
        await expect(startRemote(ctx, dirty, {})).rejects.toBeDefined();
        expect(ctx.calls).toEqual([]);
    });

    test('--dry-run prints what it would do and neither pushes nor dispatches', async () => {
        const ctx = makeCtx({ dryRun: true });
        const result = await startRemote(ctx, facts(), {});
        expect(ctx.calls).toEqual([]);
        expect(ctx.logs.join('\n')).toMatch(/\[dry-run\] git .*push origin main/);
        expect(ctx.logs.join('\n')).toContain('[dry-run] gh workflow run release-pipeline.yml --ref main -f sha=');
        expect(result.runId).toBe(0);
    });
});

describe('remote run status', () => {
    const jobs = [
        { databaseId: 1, name: 'prepare', status: 'completed', conclusion: 'success', startedAt: '2026-10-13T10:00:00Z', completedAt: '2026-10-13T10:00:30Z', url: 'u1' },
        { databaseId: 2, name: 'packages / build-linux (x64, ubuntu-24.04)', status: 'completed', conclusion: 'failure', startedAt: '2026-10-13T10:01:00Z', completedAt: '2026-10-13T10:05:00Z', url: 'u2' },
        { databaseId: 3, name: 'draft', status: 'queued', conclusion: '', startedAt: null, completedAt: null, url: 'u3' }
    ];

    test('fetchRemoteRun groups jobs into stages; the latest run is used when no id is given', async () => {
        const ctx = makeCtx({ answers: {
            'gh run list': { status: 0, stdout: JSON.stringify([{ databaseId: 9 }]) },
            'gh run view 9': { status: 0, stdout: JSON.stringify({ databaseId: 9, status: 'in_progress', conclusion: '', url: 'https://r/9', headSha: 'abc', jobs }) }
        } });
        const run = await fetchRemoteRun(ctx, '');
        expect(run).toMatchObject({ runId: 9, status: 'in_progress', url: 'https://r/9' });
        expect(run.stages.map(stage => [stage.id, stage.result])).toEqual([['prepare', 'success'], ['packages', 'failure'], ['draft', 'running']]);
        expect(await fetchRemoteRun(makeCtx(), '')).toBeNull();
    });

    test('status text lists each stage and, for a failed run, says where the failed stage log is', async () => {
        const text = remoteStatusText({ runId: 9, status: 'completed', conclusion: 'failure', url: 'https://r/9', stages: [{ id: 'packages', result: 'failure', durationSec: 240, url: 'u2' }] }, { logDir: '/tmp/x/remote-9', failedLogs: ['/tmp/x/remote-9/failed-packages.log'] });
        expect(text).toContain('packages');
        expect(text).toContain('failure');
        expect(text).toContain('失败阶段的日志在：/tmp/x/remote-9/failed-packages.log');
    });
});

describe('planRemote (what the one-click dialog shows)', () => {
    test('the version to release, whether it will be bumped, and the commits', () => {
        const bumped = planRemote(facts({ top: { pkg: { version: '8.7.0', imageVersion: 'x' } } }));
        expect(bumped).toMatchObject({ version: '8.7.0', willBump: false });
        const plain = planRemote(facts());
        expect(plain).toMatchObject({ version: '8.6.4', willBump: true });
        expect(planRemote(facts({ git: { branch: 'feat/x' } })).problem).toContain('main');
        expect(planRemote(facts({ git: { dirty: [{ code: 'M', path: 'a' }] } })).problem).toContain('未提交');
    });
});
