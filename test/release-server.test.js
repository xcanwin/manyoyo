'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createReleaseServer, buildNotesDraft } = require('../scripts/release/server');
const { parseArgs } = require('../scripts/release/index');

function fakeFacts(over = {}) {
    return {
        pkg: { version: '8.2.0', imageVersion: '2.1.0-common' }, tag: 'v8.2.0',
        git: { branch: 'feat/x', headSha: 'a', dirty: [{ code: 'M', path: 'lib/a.js' }], fingerprint: 'f', hasOrigin: true, originMainSha: 'm', mergedIntoOriginMain: false, ahead: 0, latestTag: 'v8.1.0', imageChangedSinceTag: false, commitsSinceTag: ['feat: 新增 A', '合并 feat/y：8.1.0', 'fix: 修 B'], ...(over.git || {}) },
        gh: { ok: true }, release: { exists: false, assets: [], createdAt: '', url: '' }, npm: { version: '8.1.0' }, image: { exists: true },
        runs: { macos: [], linux: [], image: [], npm: [], assets: [], verify: [] }
    };
}

let root;
let app;
let url;
let facts;
const waitDone = async () => { for (let i = 0; i < 100 && !app.runner.events.some(event => event.type === 'done'); i += 1) await new Promise(resolve => setTimeout(resolve, 20)); };
beforeEach(async () => {
    facts = fakeFacts();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-relsrv-'));
    fs.writeFileSync(path.join(root, 'page.html'), '<html><head><title>x</title></head><body>ok</body></html>');
    app = createReleaseServer({
        repoRoot: root, port: 0, token: 'tok123', htmlFile: path.join(root, 'page.html'),
        collect: async () => facts, read: () => ({ status: 0, stdout: '' }),
        actions: { merge: async ctx => ctx.log('merging'), preflight: async () => {} },
        agentCommitMessage: async () => ({ message: 'feat: from agent', reason: '' })
    });
    const info = await app.listen();
    url = `http://127.0.0.1:${info.port}`;
});
afterEach(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
});

const call = (method, route, { body, headers = {}, token = 'tok123' } = {}) => fetch(`${url}${route}`, {
    method,
    headers: { ...(token ? { 'X-Release-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
});

describe('release server security', () => {
    test('the page needs the token in the URL and injects it; the API needs the token header', async () => {
        expect((await fetch(`${url}/`)).status).toBe(401);
        expect((await fetch(`${url}/?token=wrong`)).status).toBe(401);
        const page = await fetch(`${url}/?token=tok123`);
        expect(page.status).toBe(200);
        const html = await page.text();
        expect(html).toContain('window.__RELEASE__={"token":"tok123"}');
        expect(page.headers.get('referrer-policy')).toBe('no-referrer');
        expect((await call('GET', '/api/status', { token: null })).status).toBe(401);
        expect((await call('GET', '/api/status', { token: 'nope' })).status).toBe(401);
        expect((await call('GET', '/api/status')).status).toBe(200);
    });

    test('foreign Host or Origin headers are refused (DNS rebinding / CSRF from other pages)', async () => {
        const send = headers => new Promise(resolve => {
            const req = http.request(`${url}/api/status`, { headers: { 'X-Release-Token': 'tok123', ...headers } }, res => { res.resume(); resolve(res.statusCode); });
            req.end();
        });
        expect(await send({ Host: 'evil.example:3900' })).toBe(403);
        expect(await send({ Origin: 'http://evil.example' })).toBe(403);
        expect(await send({ Origin: url })).toBe(200);
    });

    test('POST must be JSON, bodies must parse, unknown routes 404', async () => {
        const form = await fetch(`${url}/api/cancel`, { method: 'POST', headers: { 'X-Release-Token': 'tok123', 'Content-Type': 'text/plain' }, body: 'x' });
        expect(form.status).toBe(400);
        const bad = await fetch(`${url}/api/run`, { method: 'POST', headers: { 'X-Release-Token': 'tok123', 'Content-Type': 'application/json' }, body: '{bad' });
        expect(bad.status).toBe(400);
        expect((await call('GET', '/api/nope')).status).toBe(404);
    });

    test('the ping route reveals nothing but the app name', async () => {
        expect(await (await fetch(`${url}/api/ping`)).json()).toEqual({ app: 'manyoyo-release-console' });
    });
});

describe('release server API', () => {
    test('status lists the stages, next step, dirty files, rule message, version suggestions and a notes draft', async () => {
        const status = await (await call('GET', '/api/status')).json();
        expect(status.stages.map(stage => stage.id)).toEqual(['preflight', 'version', 'commit', 'merge', 'image', 'packages', 'release', 'npm', 'assets', 'verify', 'manual']);
        expect(status.nextStage).toBe('preflight');
        expect(status.dirty).toEqual([{ code: 'M', path: 'lib/a.js' }]);
        expect(status.ruleMessage).toBe('feat: 调整 lib');
        expect(status.suggestions.map(item => item.version)).toEqual(['9.0.0', '8.2.0', '8.1.1']);
        expect(status.notesDraft).toContain('- feat: 新增 A');
        expect(status.notesDraft).toContain('- fix: 修 B');
        expect(status.notesDraft).not.toContain('合并 feat/y');
        expect(status.checklist.every(item => item.done === false)).toBe(true);
    });

    test('external stages need confirmed:true; with it the job runs and streams events', async () => {
        facts.git.dirty = [];
        const refused = await call('POST', '/api/run', { body: { stages: ['merge'], mode: 'single' } });
        expect(refused.status).toBe(400);
        expect((await refused.json()).code).toBe('CONFIRM_REQUIRED');
        const started = await call('POST', '/api/run', { body: { stages: ['merge'], mode: 'single', confirmed: true } });
        expect(started.status).toBe(200);
        await waitDone();
        expect(app.runner.events.some(event => event.type === 'log' && event.line === 'merging')).toBe(true);
        const sse = await fetch(`${url}/api/events?token=tok123`);
        const reader = sse.body.getReader();
        const first = new TextDecoder().decode((await reader.read()).value);
        expect(first).toContain('"type":"start"');
        await reader.cancel();
    });

    test('step mode: the page confirms through /api/confirm; cancel works; a second job is refused with 409', async () => {
        facts.git.dirty = [];
        await call('POST', '/api/run', { body: { stages: ['merge'], mode: 'step' } });
        await new Promise(resolve => setTimeout(resolve, 50));
        const busy = await call('POST', '/api/run', { body: { stages: ['merge'], mode: 'single', confirmed: true } });
        expect(busy.status).toBe(409);
        const status = await (await call('GET', '/api/status')).json();
        expect(status.job.confirm.stage).toBe('merge');
        expect(status.job.confirm.commands.length).toBeGreaterThan(0);
        await call('POST', '/api/confirm', { body: { approve: false } });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect((await (await call('GET', '/api/status')).json()).job.status).toBe('cancelled');
        expect((await (await call('POST', '/api/cancel', { body: {} })).json()).cancelled).toBe(false);
    });

    test('commit message: rule and agent modes, and the manual checklist persists', async () => {
        expect(await (await call('POST', '/api/commit-message', { body: { mode: 'rule', files: ['docs/a.md'] } })).json()).toEqual({ message: 'docs: 更新 docs 文档', reason: '' });
        expect((await (await call('POST', '/api/commit-message', { body: { mode: 'rule', files: [] } })).json()).reason).toContain('没有选择文件');
        expect((await (await call('POST', '/api/commit-message', { body: { mode: 'agent' } })).json()).message).toBe('feat: from agent');
        expect((await call('POST', '/api/checklist', { body: { id: 'nope', done: true } })).status).toBe(400);
        await call('POST', '/api/checklist', { body: { id: 'mac-new-user', done: true } });
        const status = await (await call('GET', '/api/status')).json();
        expect(status.checklist.find(item => item.id === 'mac-new-user').done).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(root, '.release', 'state.json'), 'utf-8')).checklists['v8.2.0']['mac-new-user']).toBe(true);
    });
});

test('a commit title with $ replacement patterns cannot corrupt the notes draft', () => {
    const file = path.join(os.tmpdir(), `manyoyo-notes2-${process.pid}.md`);
    fs.writeFileSync(file, '## 更新内容\n\n…\n\n## What\n\n…\n');
    try {
        const draft = buildNotesDraft(fakeFacts({ git: { commitsSinceTag: ["fix: 处理 $' 与 $& 展开"] } }), file);
        expect(draft).toBe("## 更新内容\n\n- fix: 处理 $' 与 $& 展开\n\n## What\n\n…\n");
    } finally {
        fs.rmSync(file, { force: true });
    }
});

test('notes draft fills the template with commit subjects and keeps the English placeholder', () => {
    const file = path.join(os.tmpdir(), `manyoyo-notes-${process.pid}.md`);
    fs.writeFileSync(file, '## 更新内容\n\n…\n\n## What\n\n…\n');
    try {
        const draft = buildNotesDraft(fakeFacts(), file);
        expect(draft).toBe('## 更新内容\n\n- feat: 新增 A\n- fix: 修 B\n\n## What\n\n…\n');
    } finally {
        fs.rmSync(file, { force: true });
    }
});

test('CLI argument parsing', () => {
    expect(parseArgs([])).toMatchObject({ status: false, dryRun: false, open: true, port: 3900 });
    expect(parseArgs(['--status', '--dry-run', '--no-open', '--port', '3901'])).toMatchObject({ status: true, dryRun: true, open: false, port: 3901 });
    expect(() => parseArgs(['--port', 'x'])).toThrow(/端口|port/);
    expect(() => parseArgs(['--bogus'])).toThrow(/未知参数/);
});
