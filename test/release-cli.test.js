'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { runStages, checkItem, stageList, createEngine, EXIT } = require('../scripts/release/cli');
const { parseArgs } = require('../scripts/release/index');
const { acquireJobLock } = require('../scripts/release/lock');
const { JobRunner } = require('../scripts/release/jobs');
const { createStateStore } = require('../scripts/release/state');

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

    test('--run release needs --notes-file, unknown stages are rejected', async () => {
        await expect(runStages(fakeEngine({}), { run: 'release', yes: true }, io())).rejects.toThrow(/--notes-file/);
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
        const code = await runStages(engine, { run: 'device,publish', yes: true }, output);
        expect(output.lines.out.join('\n')).toContain('[device] skipped');
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

describe('device checks can only be ticked by a person', () => {
    test('no TTY refuses; a TTY needs the typed confirmation; the entry records who confirmed', async () => {
        const engine = fakeEngine({});
        await expect(checkItem(engine, 'plugin', io(), { isTTY: false, ask: async () => 'yes' })).rejects.toThrow(/只能由人确认/);
        await expect(checkItem(engine, 'plugin', io(), { isTTY: true, ask: async () => 'y' })).rejects.toThrow(/未确认/);
        await expect(checkItem(engine, 'nope', io(), { isTTY: true, ask: async () => 'yes' })).rejects.toThrow(/未知的检查项/);
        expect(createStateStore(root).load().devices).toBeUndefined();
        await checkItem(engine, 'plugin', io(), { isTTY: true, ask: async () => 'yes' });
        expect(createStateStore(root).load().devices['v8.2.0'].plugin).toMatchObject({ done: true, by: '终端确认' });
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

describe('an unfinished human-only stage is not a success', () => {
    test('--run device exits 1 while checks are pending and 0 once ticked', async () => {
        const hit = worldFacts({ git: { ...worldFacts().git, changedFiles: ['lib/plugin/a.js'] } });
        const engine = fakeEngine({ device: async () => {} }, hit);
        const output = io();
        expect(await runStages(engine, { run: 'device' }, output)).toBe(EXIT.FAILED);
        expect(output.lines.err.join('\n')).toContain('未完成');
        await checkItem(engine, 'plugin', io(), { isTTY: true, ask: async () => 'yes' });
        expect(await runStages(engine, { run: 'device' }, io())).toBe(EXIT.OK);
    });
});

describe('human-only stages are not offered as --run', () => {
    const published = () => worldFacts({ release: { exists: true, draft: false, assets: ['SHA256SUMS', ...['macos', 'linux'].flatMap(o => ['arm64', 'x64'].flatMap(a => [`manyoyo-8.2.0-${o}-${a}.run`, `manyoyo-8.2.0-${o}-${a}-app.tar.gz`]))].sort(), sums: null, createdAt: '2026-10-04T00:00:00Z', url: '' }, npm: { version: '8.2.0' }, runs: { ci: [], packages: [], image: [], npm: [], assets: [], verify: [{ databaseId: 9, status: 'completed', conclusion: 'success', headSha: 'm', createdAt: '2026-10-04T01:00:00Z' }] } });

    test('--status with manual as the next step suggests --check, never --run manual', async () => {
        const engine = fakeEngine({}, published());
        const output = io();
        await require('../scripts/release/cli').printStatus(engine, output, false);
        const text = output.lines.out.join('\n');
        expect(text).toContain('--check mac-upgrade');
        expect(text).not.toContain('--run manual');
    });

    test('--run manual is refused before any job starts: exit 2, Chinese explanation, no internal error', async () => {
        const engine = fakeEngine(require('../scripts/release/actions').ACTIONS, published());
        const output = io();
        expect(await runStages(engine, { run: 'manual' }, output)).toBe(EXIT.NEEDS_YES);
        const text = output.lines.err.join('\n');
        expect(text).toContain('没有可执行的动作');
        expect(text).not.toContain('is not a function');
        expect(engine.runner.current).toBeNull();
    });
});
