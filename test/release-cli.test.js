'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { runStages, runRemote, runRemoteStatus, stageList, createEngine, EXIT } = require('../scripts/release/cli');
const { parseArgs } = require('../scripts/release/index');
const { acquireJobLock } = require('../scripts/release/lock');
const { JobRunner } = require('../scripts/release/jobs');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-relcli-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const io = () => { const lines = { out: [], err: [] }; return { lines, out: line => lines.out.push(line), err: line => lines.err.push(line) }; };

function worldFacts(over = {}) {
    return {
        pkg: { version: '8.2.0', imageVersion: '2.1.0-common' }, tag: 'v8.2.0',
        git: { branch: 'main', headSha: 'm', dirty: [], fingerprint: 'f', hasOrigin: true, originMainSha: 'm', mergedIntoOriginMain: true, ahead: 0, latestTag: 'v8.1.0', imageChangedSinceTag: false, dockerChangedSinceTag: false, changedFiles: [], commitsSinceTag: [] },
        gh: { ok: true }, release: { exists: false, draft: false, assets: [], sums: null, createdAt: '', url: '' }, npm: { version: '8.1.0' }, image: { exists: true },
        runs: { ci: [], packages: [{ databaseId: 1, status: 'completed', conclusion: 'success', headSha: 'm' }], image: [], npm: [], assets: [], verify: [] }, ...over
    };
}

function fakeEngine(actions, facts = worldFacts()) {
    const engine = createEngine({ repoRoot: root, actions, acquireLock: null });
    engine.collect = async () => facts;
    engine.runner.deps.collect = engine.collect;
    engine.base.readAsync = async () => ({ status: 0, stdout: '' });
    return engine;
}

describe('command line driver', () => {
    test('--run with an external stage but no --yes prints the commands, exits 2 and runs nothing', async () => {
        const actions = { release: jest.fn(async () => {}), preflight: jest.fn(async () => {}) };
        const engine = fakeEngine(actions);
        const output = io();
        fs.writeFileSync(path.join(root, 'n.md'), 'notes');
        const code = await runStages(engine, { run: 'release', notesFile: path.join(root, 'n.md') }, output);
        expect(code).toBe(EXIT.NEEDS_YES);
        expect(output.lines.err.join('\n')).toContain('gh release create v8.2.0 --draft --target m');
        expect(actions.release).not.toHaveBeenCalled();
    });

    test('unknown stages are rejected', async () => {
        expect(() => stageList('merge,nope')).toThrow(/未知阶段/);
    });

    test('with --yes the stages run in order, finished ones are skipped, and the exit code reflects failure', async () => {
        const facts = worldFacts({ git: { ...worldFacts().git, changedFiles: [] } });
        let published = false;
        const actions = { publish: jest.fn(async () => { published = true; }) };
        const engine = fakeEngine(actions);
        // publish 依赖草稿资产齐全：用假的 collect 让它在执行前后状态变化
        engine.runner.deps.collect = async () => ({
            ...facts,
            release: { exists: true, draft: !published, assets: ['SHA256SUMS', ...['macos', 'linux'].flatMap(o => ['arm64', 'x64'].flatMap(a => [`manyoyo-8.2.0-${o}-${a}.run`, `manyoyo-8.2.0-${o}-${a}-app.tar.gz`]))].sort(), sums: null, createdAt: '2026-10-04T00:00:00Z', url: '' }
        });
        engine.collect = engine.runner.deps.collect;
        const output = io();
        const code = await runStages(engine, { run: 'merge,publish', yes: true }, output);
        expect(output.lines.out.join('\n')).toContain('[merge] skipped');
        expect(actions.publish).toHaveBeenCalledTimes(1);
        expect(code).toBe(EXIT.OK);

        const failing = fakeEngine({ packages: async () => { throw new Error('boom'); } }, worldFacts({ runs: { ci: [], packages: [], image: [], npm: [], assets: [], verify: [] } }));
        const failOutput = io();
        expect(await runStages(failing, { run: 'packages', yes: true, json: true }, failOutput)).toBe(EXIT.FAILED);
    });

    test('dry-run needs no --yes and never executes the real actions through the shell', async () => {
        const engine = fakeEngine({ packages: jest.fn(async () => {}) });
        engine.base.dryRun = true;
        engine.runner.deps.dryRun = true;
        expect(await runStages(engine, { run: 'packages' }, io())).toBe(EXIT.OK);
    });

    test('flags parse; values are required', () => {
        expect(parseArgs(['--run', 'merge,packages', '--yes', '--json', '--notes-file', 'n.md', '--version', '8.3.2', '--npm-dispatch'])).toMatchObject({ run: 'merge,packages', yes: true, json: true, notesFile: 'n.md', version: '8.3.2', npmDispatch: true });
        expect(() => parseArgs(['--run'])).toThrow(/需要一个值/);
        expect(() => parseArgs(['--run', '--yes'])).toThrow(/需要一个值/);
    });
});

describe('single-instance lock', () => {
    test('a live holder makes the second job BUSY; a dead holder (kill -9) is taken over', async () => {
        const release = acquireJobLock(root, 'web');
        expect(() => acquireJobLock(root, 'cli')).not.toThrow(); // 同一进程视为自己，可重入
        release();
        const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '../scripts/release/lock'))}).acquireJobLock(${JSON.stringify(root)}, 'other'); setInterval(()=>{}, 1000)`], { stdio: 'ignore' });
        const lockFile = path.join(root, '.release', 'job.lock');
        for (let i = 0; i < 100 && !fs.existsSync(lockFile); i += 1) await new Promise(resolve => setTimeout(resolve, 50));
        expect(() => acquireJobLock(root, 'cli')).toThrow(/已有发布任务在运行/);
        child.kill('SIGKILL');
        await new Promise(resolve => child.on('close', resolve));
        const taken = acquireJobLock(root, 'cli');
        expect(JSON.parse(fs.readFileSync(lockFile, 'utf-8')).pid).toBe(process.pid);
        taken();
        expect(fs.existsSync(lockFile)).toBe(false);
    });

    test('JobRunner turns a busy lock into BUSY and releases the lock when the job ends', async () => {
        const state = { held: false };
        const runner = new JobRunner({
            collect: async () => worldFacts({ release: { exists: false, draft: false, assets: [], sums: null, createdAt: '', url: '' } }),
            makeCtx: log => ({ log }), actions: { preflight: async () => {} }, describe: () => [], getState: () => ({}), recheckTimes: 0, dryRun: true,
            acquireLock: () => { if (state.held) throw new Error('busy'); state.held = true; return () => { state.held = false; }; }
        });
        const done = new Promise(resolve => runner.on('event', event => { if (event.type === 'done') resolve(event); }));
        runner.start({ stages: ['preflight'], mode: 'single' });
        expect(() => runner.start({ stages: ['preflight'], mode: 'single' })).toThrow(expect.objectContaining({ code: 'BUSY' }));
        await done;
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(state.held).toBe(false);
    });
});

describe('verify and npm run in parallel', () => {
    test('adjacent stages of the same group start together', async () => {
        const order = [];
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const published = worldFacts({ release: { exists: true, draft: false, assets: ['SHA256SUMS', ...['macos', 'linux'].flatMap(o => ['arm64', 'x64'].flatMap(a => [`manyoyo-8.2.0-${o}-${a}.run`, `manyoyo-8.2.0-${o}-${a}-app.tar.gz`]))].sort(), sums: null, createdAt: '2026-10-04T00:00:00Z', url: '' } });
        let verified = false;
        let npmDone = false;
        const runner = new JobRunner({
            collect: async () => ({ ...published, npm: { version: npmDone ? '8.2.0' : '8.1.0' }, runs: { ...published.runs, verify: verified ? [{ databaseId: 9, status: 'completed', conclusion: 'success', headSha: 'm', createdAt: '2026-10-04T01:00:00Z' }] : [] } }),
            makeCtx: log => ({ log }), describe: () => [], getState: () => ({}), recheckTimes: 0,
            actions: {
                verify: async () => { order.push('verify:start'); await gate; verified = true; order.push('verify:end'); },
                npm: async () => { order.push('npm:start'); release(); npmDone = true; order.push('npm:end'); }
            }
        });
        const done = new Promise(resolve => runner.on('event', event => { if (event.type === 'done') resolve(event); }));
        runner.start({ stages: ['verify', 'npm'], mode: 'auto', confirmed: true });
        expect((await done).status).toBe('succeeded');
        expect(order.slice(0, 2)).toEqual(['verify:start', 'npm:start']);
    });
});

describe('single stage runs even when already done', () => {
    test('--run version after a release was published still bumps (single mode)', async () => {
        const actions = { version: jest.fn(async () => {}) };
        const engine = fakeEngine(actions, worldFacts({ release: { exists: true, draft: false, assets: ['SHA256SUMS', ...['macos', 'linux'].flatMap(o => ['arm64', 'x64'].flatMap(a => [`manyoyo-8.2.0-${o}-${a}.run`, `manyoyo-8.2.0-${o}-${a}-app.tar.gz`]))].sort(), sums: null, createdAt: '', url: '' } }));
        const code = await runStages(engine, { run: 'version', version: '8.2.1' }, io());
        expect(code).toBe(EXIT.OK);
        expect(actions.version).toHaveBeenCalledWith(expect.anything(), { version: '8.2.1', imageVersion: undefined }, expect.anything());
    });
});

describe('--remote / --remote-status', () => {
    const runInfo = { runId: 77, url: 'https://github.com/x/y/actions/runs/77', version: '8.7.0', sha: 'a'.repeat(40) };

    test('flags parse; --remote-status takes an optional run id', () => {
        expect(parseArgs(['--remote'])).toMatchObject({ remote: true, watch: false });
        expect(parseArgs(['--remote', '--watch', '--version', '8.7.0', '--dry-run'])).toMatchObject({ remote: true, watch: true, version: '8.7.0', dryRun: true });
        expect(parseArgs(['--remote-status'])).toMatchObject({ remoteStatus: true, remoteRunId: '' });
        expect(parseArgs(['--remote-status', '12345'])).toMatchObject({ remoteStatus: true, remoteRunId: '12345' });
        expect(parseArgs(['--remote-status', '--json'])).toMatchObject({ remoteStatus: true, remoteRunId: '', json: true });
    });

    test('--remote starts the pipeline without --yes (the flag itself is the authorization), prints the run address and returns at once', async () => {
        const start = jest.fn(async () => runInfo);
        const output = io();
        const code = await runRemote(fakeEngine({}), { remote: true, version: '8.7.0' }, output, { start });
        expect(code).toBe(EXIT.OK);
        expect(start).toHaveBeenCalledWith(expect.anything(), expect.anything(), { version: '8.7.0' });
        expect(output.lines.out.join('\n')).toContain('https://github.com/x/y/actions/runs/77');
        expect(output.lines.out.join('\n')).toContain('--remote-status');
    });

    test('--remote reports why it refused (exit 1) and does not need the console lock when nothing ran', async () => {
        const start = jest.fn(async () => { throw Object.assign(new Error('有 1 个文件未提交'), { code: 'DIRTY' }); });
        const output = io();
        expect(await runRemote(fakeEngine({}), { remote: true }, output, { start })).toBe(EXIT.FAILED);
        expect(output.lines.err.join('\n')).toContain('有 1 个文件未提交');
    });

    test('--remote --watch follows the run and exits with its result', async () => {
        const start = jest.fn(async () => runInfo);
        const states = [
            { runId: 77, status: 'in_progress', conclusion: '', url: 'u', stages: [{ id: 'prepare', result: 'success', durationSec: 5 }] },
            { runId: 77, status: 'completed', conclusion: 'failure', url: 'u', stages: [{ id: 'packages', result: 'failure', durationSec: 9 }] }
        ];
        const fetch = jest.fn(async () => states.shift());
        const output = io();
        const code = await runRemote(fakeEngine({}), { remote: true, watch: true }, output, { start, fetch, sleep: async () => {} });
        expect(code).toBe(EXIT.FAILED);
        expect(output.lines.out.join('\n')).toContain('packages');
    });

    test('--remote-status prints the stages; a finished run downloads the report and names the failed stage logs; success exits 0, failure exits 1', async () => {
        const failed = { runId: 9, status: 'completed', conclusion: 'failure', url: 'u', stages: [{ id: 'packages', result: 'failure', durationSec: 60 }] };
        const download = jest.fn(async () => ({ logDir: '/tmp/r/remote-9', failedLogs: ['/tmp/r/remote-9/failed-packages.log'] }));
        const output = io();
        expect(await runRemoteStatus(fakeEngine({}), { remoteStatus: true, remoteRunId: '9' }, output, { fetch: async () => failed, download })).toBe(EXIT.FAILED);
        expect(download).toHaveBeenCalled();
        expect(output.lines.out.join('\n')).toContain('失败阶段的日志在：/tmp/r/remote-9/failed-packages.log');

        const ok = { ...failed, conclusion: 'success', stages: [{ id: 'prepare', result: 'success', durationSec: 3 }] };
        expect(await runRemoteStatus(fakeEngine({}), { remoteStatus: true, remoteRunId: '' }, io(), { fetch: async () => ok, download: async () => ({ logDir: 'd', failedLogs: [] }) })).toBe(EXIT.OK);

        const running = { ...failed, status: 'in_progress', conclusion: '' };
        const dl = jest.fn();
        expect(await runRemoteStatus(fakeEngine({}), { remoteStatus: true, remoteRunId: '' }, io(), { fetch: async () => running, download: dl })).toBe(EXIT.OK);
        expect(dl).not.toHaveBeenCalled();

        const none = io();
        expect(await runRemoteStatus(fakeEngine({}), { remoteStatus: true, remoteRunId: '' }, none, { fetch: async () => null })).toBe(EXIT.FAILED);
        expect(none.lines.err.join('\n')).toContain('没有');
    });
});
