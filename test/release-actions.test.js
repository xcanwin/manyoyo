'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ACTIONS, describeCommands, syncDocImageVersion } = require('../scripts/release/actions');
const { expectedAssetNames } = require('../scripts/release/facts');

let root;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-rel-'));
    fs.mkdirSync(path.join(root, 'docs', 'en'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs', '.vitepress'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{\n    "version": "8.1.0",\n    "imageVersion": "2.1.0-common"\n}\n');
    fs.writeFileSync(path.join(root, 'README.md'), 'manyoyo build --iv 2.1.0-common\n');
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), '2.1.0-full and 2.1.0-common and v2.1.0 and 12.1.0-common\n');
    fs.writeFileSync(path.join(root, 'docs', '.vitepress', 'x.md'), '2.1.0-common\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function facts(over = {}) {
    return {
        pkg: { version: '8.1.0', imageVersion: '2.1.0-common' }, tag: 'v8.1.0',
        git: { branch: 'feat/x', dirty: [{ code: 'M', path: 'a.js' }, { code: '?', path: 'b.js' }], originMainSha: 'm', latestTag: 'v8.0.1', ...(over.git || {}) },
        gh: { ok: true }, runs: over.runs || {}
    };
}

function makeCtx(options = {}) {
    const calls = [];
    const logs = [];
    const saved = [];
    let clock = 1000;
    const ctx = {
        repoRoot: root, dryRun: options.dryRun || false, logs, calls, saved,
        read: jest.fn(options.read || (() => ({ status: 0, stdout: '' }))),
        run: jest.fn(async (cmd, args, opts = {}) => { calls.push({ cmd, args, ...opts }); return { status: options.status === undefined ? 0 : options.status }; }),
        log: line => logs.push(line),
        sleep: async ms => { clock += ms; },
        now: () => clock,
        state: { save: patch => saved.push(patch), load: () => ({}) }
    };
    return ctx;
}

describe('version action', () => {
    test('bumps package version, validates it, and syncs imageVersion in package.json and doc examples (not .vitepress, not look-alikes)', async () => {
        const ctx = makeCtx();
        await ACTIONS.version(ctx, { version: '8.2.0', imageVersion: '2.2.0-common' }, facts());
        expect(ctx.calls[0]).toMatchObject({ cmd: 'npm', args: ['version', '8.2.0', '--no-git-tag-version'] });
        expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).imageVersion).toBe('2.2.0-common');
        expect(fs.readFileSync(path.join(root, 'README.md'), 'utf-8')).toBe('manyoyo build --iv 2.2.0-common\n');
        expect(fs.readFileSync(path.join(root, 'docs', 'a.md'), 'utf-8')).toBe('2.2.0-full and 2.2.0-common and v2.1.0 and 12.1.0-common\n');
        expect(fs.readFileSync(path.join(root, 'docs', '.vitepress', 'x.md'), 'utf-8')).toBe('2.1.0-common\n');
    });

    test.each([['abc'], ['8.0.0'], ['8.0.1']])('rejects an invalid or non-increasing version (%s)', async version => {
        await expect(ACTIONS.version(makeCtx(), { version }, facts())).rejects.toMatchObject({ code: 'BAD_VERSION' });
    });

    test('rejects a malformed image version and leaves package.json alone', async () => {
        await expect(ACTIONS.version(makeCtx(), { version: '8.2.0', imageVersion: 'latest' }, facts())).rejects.toMatchObject({ code: 'BAD_VERSION' });
        expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).imageVersion).toBe('2.1.0-common');
    });

    test('syncDocImageVersion reports which files changed', () => {
        expect(syncDocImageVersion(root, '2.1.0', '2.3.0').sort()).toEqual(['README.md', path.join('docs', 'a.md')].sort());
    });
});

describe('commit action', () => {
    test('stages only the chosen files that really have changes and commits with the cleaned message (no Co-Authored-By trailer)', async () => {
        const ctx = makeCtx();
        await ACTIONS.commit(ctx, { files: ['a.js'], message: '```\nfeat: x\n\nCo-Authored-By: Bot <b@x>\n```' }, facts());
        expect(ctx.calls[0]).toMatchObject({ cmd: 'git', args: ['add', '--', 'a.js'] });
        expect(ctx.calls[1]).toMatchObject({ cmd: 'git', args: ['commit', '-F', '-'], input: 'feat: x\n' });
    });

    test('refuses an empty selection, unknown files and an empty message', async () => {
        await expect(ACTIONS.commit(makeCtx(), { files: [], message: 'x' }, facts())).rejects.toMatchObject({ code: 'NO_FILES' });
        await expect(ACTIONS.commit(makeCtx(), { files: ['zzz'], message: 'x' }, facts())).rejects.toMatchObject({ code: 'NO_FILES' });
        await expect(ACTIONS.commit(makeCtx(), { files: ['a.js'], message: '  ' }, facts())).rejects.toMatchObject({ code: 'NO_MESSAGE' });
    });
});

describe('merge action', () => {
    test('from a feature branch: switch to main, fast-forward pull, no-ff merge, push; external commands are flagged', async () => {
        const ctx = makeCtx({ read: () => ({ status: 0, stdout: '' }) });
        await ACTIONS.merge(ctx, {}, facts());
        const lines = ctx.calls.map(call => `${call.cmd} ${call.args.join(' ')}${call.external ? ' [external]' : ''}`);
        expect(lines).toEqual([
            'git switch main',
            'git -c credential.helper=!gh auth git-credential pull --ff-only origin main [external]',
            'git merge --no-ff feat/x -m 合并 feat/x：8.1.0',
            'git -c credential.helper=!gh auth git-credential push origin main [external]'
        ]);
    });

    test('on main it only pushes, and a configured credential helper is respected', async () => {
        const ctx = makeCtx({ read: () => ({ status: 0, stdout: 'osxkeychain' }) });
        await ACTIONS.merge(ctx, {}, facts({ git: { branch: 'main' } }));
        expect(ctx.calls.map(call => call.args.join(' '))).toEqual(['push origin main']);
    });

    test('a failing command stops the sequence', async () => {
        const ctx = makeCtx({ status: 1 });
        await expect(ACTIONS.merge(ctx, {}, facts())).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
        expect(ctx.calls).toHaveLength(1);
    });
});

describe('release / assets / npm', () => {
    test('a failing build stops the other poller and the first failure is reported', async () => {
        const polls = { 11: 0, 22: 0 };
        const ctx = makeCtx({
            read: (cmd, args) => {
                if (args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ databaseId: args.includes('offline-macos.yml') ? 11 : 22, createdAt: new Date(2000).toISOString() }]) };
                const id = Number(args[2]);
                polls[id] += 1;
                if (id === 11) return { status: 0, stdout: JSON.stringify({ status: 'completed', conclusion: 'failure', url: 'u' }) };
                return { status: 0, stdout: JSON.stringify({ status: 'in_progress' }) };
            }
        });
        await expect(ACTIONS.packages(ctx, {}, facts())).rejects.toMatchObject({ code: 'RUN_FAILED' });
        const after = polls[22];
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(polls[22]).toBe(after);
    });

    test('an aborted command is reported as cancelled, not as a failed command', async () => {
        const controller = new AbortController();
        const ctx = makeCtx({ status: 143 });
        ctx.signal = controller.signal;
        ctx.run = jest.fn(async () => { controller.abort(); return { status: 143 }; });
        await expect(ACTIONS.preflight(ctx, {}, facts())).rejects.toMatchObject({ code: 'CANCELLED' });
    });

    test('release needs notes and passes them through a temp file that is removed afterwards', async () => {
        await expect(ACTIONS.release(makeCtx(), { notes: ' ' }, facts())).rejects.toMatchObject({ code: 'NO_NOTES' });
        const ctx = makeCtx();
        let notesFile = '';
        ctx.run = jest.fn(async (cmd, args) => { notesFile = args[args.indexOf('--notes-file') + 1]; expect(fs.readFileSync(notesFile, 'utf-8')).toBe('hello\n'); return { status: 0 }; });
        await ACTIONS.release(ctx, { notes: 'hello' }, facts());
        expect(fs.existsSync(notesFile)).toBe(false);
    });

    test('assets passes the successful main builds to release-offline and verifies exactly 9 assets', async () => {
        const good = (id) => [{ databaseId: id, status: 'completed', conclusion: 'success', headSha: 'm' }];
        const f = facts({ runs: { macos: good(11), linux: good(22) } });
        const reads = [];
        const ctx = makeCtx({
            read: (cmd, args) => {
                reads.push(args.join(' '));
                if (args[0] === 'run' && args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ databaseId: 77, createdAt: new Date(2000).toISOString() }]) };
                if (args[0] === 'run' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ status: 'completed', conclusion: 'success', url: 'u' }) };
                if (args[0] === 'release') return { status: 0, stdout: JSON.stringify({ assets: expectedAssetNames('8.1.0').map(name => ({ name })) }) };
                return { status: 0, stdout: '' };
            }
        });
        await ACTIONS.assets(ctx, {}, f);
        expect(ctx.calls[0].args).toEqual(['workflow', 'run', 'release-offline.yml', '--ref', 'main', '-f', 'tag=v8.1.0', '-f', 'macosRunId=11', '-f', 'linuxRunId=22']);

        const bad = makeCtx({
            read: (cmd, args) => {
                if (args[0] === 'run' && args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ databaseId: 77, createdAt: new Date(2000).toISOString() }]) };
                if (args[0] === 'run' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ status: 'completed', conclusion: 'success' }) };
                return { status: 0, stdout: JSON.stringify({ assets: [{ name: 'SHA256SUMS' }] }) };
            }
        });
        await expect(ACTIONS.assets(bad, {}, f)).rejects.toMatchObject({ code: 'ASSETS_MISMATCH' });
        await expect(ACTIONS.assets(makeCtx(), {}, facts())).rejects.toMatchObject({ code: 'NO_BUILD' });
    });

    test('a failed workflow run is reported with its result', async () => {
        const ctx = makeCtx({
            read: (cmd, args) => (args[1] === 'list'
                ? { status: 0, stdout: JSON.stringify([{ databaseId: 5, createdAt: new Date(2000).toISOString() }]) }
                : { status: 0, stdout: JSON.stringify({ status: 'completed', conclusion: 'failure', url: 'http://run' }) })
        });
        await expect(ACTIONS.image(ctx, {}, facts())).rejects.toMatchObject({ code: 'RUN_FAILED', message: expect.stringContaining('failure') });
    });

    test('npm needs several consecutive reads of the new version: a CDN flap back to the old one resets the count', async () => {
        const sequence = ['8.0.1', '8.1.0', '8.0.1', '8.1.0', '8.1.0', '8.1.0'];
        let views = 0;
        const ctx = makeCtx({
            read: (cmd, args) => {
                if (cmd === 'gh' && args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ databaseId: 9 }]) };
                if (cmd === 'gh') return { status: 0, stdout: JSON.stringify({ status: 'completed', conclusion: 'success' }) };
                return { status: 0, stdout: sequence[Math.min(views++, sequence.length - 1)] };
            }
        });
        await ACTIONS.npm(ctx, {}, facts());
        expect(views).toBe(6);
    });

    test('npm waits for the publish run, then polls npm until the version is visible', async () => {
        let views = 0;
        const ctx = makeCtx({
            read: (cmd, args) => {
                if (cmd === 'gh' && args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ databaseId: 9 }]) };
                if (cmd === 'gh') return { status: 0, stdout: JSON.stringify({ status: 'completed', conclusion: 'success' }) };
                views += 1;
                return { status: 0, stdout: views < 3 ? '8.0.1' : '8.1.0' };
            }
        });
        await ACTIONS.npm(ctx, {}, facts());
        expect(views).toBe(5); // 第 3 次起连续 3 次读到新版本
    });

    test('dry-run skips the file-writing version and commit actions', async () => {
        const ctx = makeCtx({ dryRun: true });
        await ACTIONS.version(ctx, { version: '8.2.0', imageVersion: '2.2.0-common' }, facts());
        await ACTIONS.commit(ctx, { files: ['a.js'], message: 'x' }, facts());
        expect(ctx.calls).toEqual([]);
        expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).imageVersion).toBe('2.1.0-common');
    });

    test('dry-run never executes external commands and does not wait', async () => {
        const ctx = makeCtx({ dryRun: true });
        ctx.run = jest.fn(async () => ({ status: 0 }));
        await ACTIONS.image(ctx, {}, facts());
        expect(ctx.run).toHaveBeenCalledWith('gh', ['workflow', 'run', 'image-publish.yml', '--ref', 'main'], { external: true });
        expect(ctx.read).not.toHaveBeenCalled();
    });
});

describe('preflight action', () => {
    test('records the result against the current tree fingerprint, also when a step fails', async () => {
        const ctx = makeCtx({ read: (cmd, args) => ({ status: cmd === 'sh' ? 1 : 0, stdout: args[0] === 'rev-parse' ? 'abc' : '' }) });
        await ACTIONS.preflight(ctx, {}, facts());
        expect(ctx.calls.map(call => call.args.join(' '))).toEqual(['run build:web', 'test', 'run docs:check']);
        expect(ctx.calls.every(call => call.safe === true)).toBe(true);
        expect(ctx.saved[0].preflight.ok).toBe(true);
        expect(ctx.logs.join('\n')).toContain('shellcheck');

        const failing = makeCtx({ status: 1 });
        await expect(ACTIONS.preflight(failing, {}, facts())).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
        expect(failing.saved[0].preflight.ok).toBe(false);
    });
});

test('describeCommands shows the real commands for the confirmation dialog', () => {
    expect(describeCommands('merge', facts(), {})).toEqual(['git switch main', 'git pull --ff-only origin main', 'git merge --no-ff feat/x', 'git push origin main']);
    expect(describeCommands('merge', facts({ git: { branch: 'main' } }), {})).toEqual(['git push origin main']);
    expect(describeCommands('release', facts(), {})[0]).toContain('gh release create v8.1.0');
});
