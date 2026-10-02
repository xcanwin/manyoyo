'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBaseContext, createJobContext, redact } = require('../scripts/release/context');

describe('release context', () => {
    let root;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-relctx-')); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('redacts tokens from logs', () => {
        expect(redact('token github_pat_11ABCDEFGHIJKLMNOP and ghp_abcdefghij1234 and GITHUB_TOKEN=abc')).toBe('token *** and *** and GITHUB_TOKEN=***');
        expect(redact('Authorization: Bearer secret123')).toBe('Authorization: Bearer ***');
    });

    test('run streams output lines to the log and reports the exit code', async () => {
        const lines = [];
        const ctx = createJobContext(createBaseContext({ repoRoot: root }), line => lines.push(line));
        const result = await ctx.run(process.execPath, ['-e', 'console.log("a"); console.error("b"); process.exit(3)']);
        expect(result.status).toBe(3);
        expect(lines).toEqual(expect.arrayContaining(['a', 'b']));
        expect(lines[0]).toContain('$ ');
    });

    test('dry-run prints every command except those marked safe, which still run', async () => {
        const lines = [];
        const ctx = createJobContext(createBaseContext({ repoRoot: root, dryRun: true }), line => lines.push(line));
        expect((await ctx.run('definitely-not-a-command', ['x'], { external: true })).status).toBe(0);
        expect((await ctx.run('definitely-not-a-command', ['y'])).status).toBe(0);
        expect(lines).toEqual(['[dry-run] $ definitely-not-a-command x', '[dry-run] $ definitely-not-a-command y']);
        expect((await ctx.run(process.execPath, ['-e', 'process.exit(5)'], { safe: true })).status).toBe(5);
    });

    test('abort kills the running child and an aborted sleep returns early', async () => {
        const controller = new AbortController();
        const ctx = createJobContext(createBaseContext({ repoRoot: root }), () => {}, controller.signal);
        const running = ctx.run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
        setTimeout(() => controller.abort(), 100);
        expect((await running).status).toBe(143);
        const started = Date.now();
        await ctx.sleep(10000);
        expect(Date.now() - started).toBeLessThan(1000);
    });

    test('read reports a missing command as status 127 instead of throwing', () => {
        expect(createBaseContext({ repoRoot: root }).read('definitely-not-a-command', []).status).toBe(127);
    });
});
