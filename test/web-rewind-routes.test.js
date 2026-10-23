'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { startWebServer } = require('../lib/web/server');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(err => (err ? reject(err) : resolve(port)));
        });
    });
}

// 假 docker：
// - `bash -c <脚本>`（快照 / 回退）：把 /run/manyoyo/snap.git 换成宿主机临时目录后，用真 bash 在宿主机上执行
// - `/bin/bash -lc <命令>`（Agent 一轮）：按提示词里的指令改工作目录里的文件，再回一句话
function writeFakeDocker(tempHost, workDir, snapDir) {
    const file = path.join(tempHost, 'fake-docker.js');
    fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
if (args[0] !== 'exec') process.exit(0);
const bashIdx = args.indexOf('bash');
if (bashIdx >= 0 && args[bashIdx + 1] === '-c') {
  const script = args[bashIdx + 2].split('/run/manyoyo/snap.git').join(${JSON.stringify(snapDir)});
  if (script.includes('git checkout') && fs.existsSync(${JSON.stringify(path.join(tempHost, 'slow'))})) spawnSync('sleep', ['1.5']);
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: ${JSON.stringify(tempHost)}, CLAUDE_CONFIG_DIR: '' } });
  process.stdout.write(r.stdout);
  process.exit(0);
}
if (args.includes('/bin/bash')) {
  const command = args[args.length - 1];
  const work = ${JSON.stringify(workDir)};
  for (const m of command.matchAll(/WRITE ([a-z0-9.\\/]+)=([a-z0-9]+)/g)) {
    fs.mkdirSync(path.dirname(path.join(work, m[1])), { recursive: true });
    fs.writeFileSync(path.join(work, m[1]), m[2]);
  }
  for (const m of command.matchAll(/DELETE ([a-z0-9.\\/]+)/g)) fs.rmSync(path.join(work, m[1]), { force: true });
  fs.appendFileSync(${JSON.stringify(path.join(tempHost, "commands.log"))}, command + '\\n=====\\n');
  if (command.includes('claude')) process.stdout.write('{"type":"system","subtype":"init","session_id":"11111111-2222-3333-4444-555555555555"}\\n{"type":"result","subtype":"success","result":"完成","session_id":"11111111-2222-3333-4444-555555555555"}\\n');
  else process.stdout.write('{"type":"thread.started","thread_id":"t-1"}\\n{"type":"item.completed","item":{"type":"agent_message","text":"完成"}}\\n');
}
process.exit(0);
`);
    fs.chmodSync(file, 0o755);
    return file;
}

async function withServer(fn, historyOverride = {}) {
    const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-rewind-routes-'));
    const workDir = path.join(tempHost, 'work');
    const snapDir = path.join(tempHost, 'snap.git');
    fs.mkdirSync(workDir);
    const histDir = path.join(tempHost, 'web-history');
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(path.join(histDir, 'demo.json'), JSON.stringify({
        containerName: 'demo', updatedAt: null, messages: [],
        agentPromptCommand: 'codex exec --skip-git-repo-check {prompt}',
        applied: { containerPath: workDir },
        ...historyOverride
    }));
    const port = await getFreePort();
    let handle = null;
    try {
        handle = await startWebServer({
            serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: 'topsecret', authPassAuto: false,
            dockerCmd: writeFakeDocker(tempHost, workDir, snapDir),
            networkManager: { ensureBridgeNetwork: async () => {}, resolveRefs: async p => p, apply: async () => ({}), ensureReady: async () => ({}) },
            hostPath: tempHost, homeDir: tempHost, containerPath: workDir, imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common',
            execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
            validateHostPath: () => {}, formatDate: () => '0101-0000',
            isValidContainerName: v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v),
            containerExists: () => true, getContainerStatus: () => 'running', waitForContainerReady: async () => {}, dockerExecArgs: () => '',
            showImagePullHint: () => {}, removeContainer: () => {},
            webHistoryDir: histDir, webConfigPath: path.join(tempHost, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' }, agentStopGraceMs: 100
        });
        const baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ username: 'webadmin', password: 'topsecret' }) });
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const call = async (method, p, body) => {
            const res = await fetch(`${baseUrl}${p}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: body === undefined ? undefined : JSON.stringify(body) });
            const text = await res.text();
            let json = null;
            try { json = JSON.parse(text); } catch (e) { json = null; }
            return { status: res.status, json, text };
        };
        let n = 0;
        const turn = async prompt => {
            n += 1;
            const res = await call('POST', '/api/sessions/demo/agent/stream', { prompt, clientMessageId: `cm-turn-${String(n).padStart(4, '0')}` });
            expect(res.status).toBe(200);
        };
        const messages = async () => (await call('GET', '/api/sessions/demo/messages')).json.messages;
        const users = async () => (await messages()).filter(m => m.role === 'user');
        const read = file => (fs.existsSync(path.join(workDir, file)) ? fs.readFileSync(path.join(workDir, file), 'utf8') : null);
        await fn({ call, turn, messages, users, read, workDir, tempHost, baseUrl });
    } finally {
        if (handle && handle.close) await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
    }
}

async function threeRounds({ turn }) {
    await turn('round1 WRITE a.txt=1');
    await turn('round2 WRITE a.txt=2 WRITE b.txt=bb');
    await turn('round3 DELETE a.txt');
}

describe('按轮快照、按轮改动、回退、隐藏', () => {
    test('每轮的用户消息记下 snapBefore / snapAfter，且前一轮的 after 就是下一轮的内容起点', async () => {
        await withServer(async ctx => {
            await threeRounds(ctx);
            const list = await ctx.users();
            expect(list).toHaveLength(3);
            list.forEach(m => {
                expect(m.snapBefore).toMatch(/^[0-9a-f]{40}$/);
                expect(m.snapAfter).toMatch(/^[0-9a-f]{40}$/);
                expect(m.snapBefore).not.toBe(m.snapAfter);
            });
            const changes = await ctx.call('GET', `/api/sessions/demo/git/rounds/changes?from=${list[1].snapBefore}&to=${list[1].snapAfter}`);
            expect(changes.status).toBe(200);
            expect(Object.fromEntries(changes.json.files.map(f => [f.path, f.status]))).toEqual({ 'a.txt': 'modified', 'b.txt': 'added' });
            const diff = await ctx.call('GET', `/api/sessions/demo/git/rounds/diff?from=${list[1].snapBefore}&to=${list[1].snapAfter}&path=a.txt`);
            expect(diff.json.diff).toContain('+2');
        });
    }, 30000);

    test('按轮改动接口：快照号 / 路径不合法 400，不在这一轮改动里的文件 404', async () => {
        await withServer(async ctx => {
            await ctx.turn('round1 WRITE a.txt=1');
            const [first] = await ctx.users();
            const q = (from, to, extra = '') => `/api/sessions/demo/git/rounds/${extra ? 'diff' : 'changes'}?from=${from}&to=${to}${extra}`;
            for (const bad of ['abc', 'HEAD', `${first.snapBefore};id`, 'A'.repeat(40)]) {
                expect((await ctx.call('GET', q(bad, first.snapAfter))).status).toBe(400);
                expect((await ctx.call('GET', q(first.snapBefore, bad, '&path=a.txt'))).status).toBe(400);
            }
            expect((await ctx.call('GET', q(first.snapBefore, first.snapAfter, '&path=--output%3Dx'))).status).toBe(400);
            expect((await ctx.call('GET', q(first.snapBefore, first.snapAfter, '&path=zzz.txt'))).status).toBe(404);
        });
    }, 30000);

    test('回退到第 2 轮（对话和文件）：文件回到第 2 轮开始前，消息只剩第 1 轮，提示词原样返回，引擎会话清掉', async () => {
        await withServer(async ctx => {
            await threeRounds(ctx);
            const [, second] = await ctx.users();
            const preview = await ctx.call('POST', '/api/sessions/demo/rewind/preview', { messageId: second.id });
            expect(preview.json.files).toMatchObject({ ok: true, total: 2 });
            expect(preview.json.files.files.map(f => `${f.action}:${f.path}`).sort()).toEqual(['delete:b.txt', 'restore:a.txt'].sort());
            expect(preview.json.precise).toBe(false);
            expect(ctx.read('a.txt')).toBeNull();

            const res = await ctx.call('POST', '/api/sessions/demo/rewind', { messageId: second.id, scope: 'both' });
            expect(res.status).toBe(200);
            expect(res.json).toMatchObject({ ok: true, filesRestored: true, conversationMode: 'history', prompt: 'round2 WRITE a.txt=2 WRITE b.txt=bb' });
            expect(ctx.read('a.txt')).toBe('1');
            expect(ctx.read('b.txt')).toBeNull();
            expect((await ctx.users()).map(m => m.content)).toEqual(['round1 WRITE a.txt=1']);
            expect((await ctx.messages()).every(m => m.id !== second.id)).toBe(true);
        });
    }, 60000);

    test('只恢复对话：文件不动；只恢复文件：消息不动', async () => {
        await withServer(async ctx => {
            await threeRounds(ctx);
            const [, second, third] = await ctx.users();
            const filesOnly = await ctx.call('POST', '/api/sessions/demo/rewind', { messageId: second.id, scope: 'files' });
            expect(filesOnly.json).toMatchObject({ ok: true, filesRestored: true, conversationMode: '' });
            expect(ctx.read('a.txt')).toBe('1');
            expect((await ctx.users())).toHaveLength(3);
            // 回退本身可撤销：把第 3 轮之后的状态再恢复回来
            const undo = await ctx.call('POST', '/api/sessions/demo/rewind', { messageId: third.id, scope: 'conversation' });
            expect(undo.json).toMatchObject({ ok: true, filesRestored: false });
            expect(ctx.read('a.txt')).toBe('1');
            expect((await ctx.users()).map(m => m.content)).toEqual(['round1 WRITE a.txt=1', 'round2 WRITE a.txt=2 WRITE b.txt=bb']);
        });
    }, 60000);

    test('对话回退后接着聊：下一轮从剩下的聊天记录开新会话（历史注入），不带旧引擎会话', async () => {
        await withServer(async ctx => {
            await threeRounds(ctx);
            const [, second] = await ctx.users();
            await ctx.call('POST', '/api/sessions/demo/rewind', { messageId: second.id, scope: 'conversation' });
            await ctx.turn('round2b WRITE c.txt=cc');
            const log = fs.readFileSync(path.join(ctx.tempHost, 'commands.log'), 'utf8');
            const last = log.trim().split('=====\n').filter(Boolean).pop();
            expect(last).not.toContain('resume');
            expect(last).toContain('round2b');
        });
    }, 60000);

    test('进行中 / 不存在的消息 / 非法 scope', async () => {
        await withServer(async ctx => {
            await ctx.turn('round1 WRITE a.txt=1');
            const [first] = await ctx.users();
            expect((await ctx.call('POST', '/api/sessions/demo/rewind', { messageId: first.id, scope: 'nope' })).status).toBe(400);
            expect((await ctx.call('POST', '/api/sessions/demo/rewind', { messageId: 'does-not-exist', scope: 'both' })).status).toBe(404);
            const assistant = (await ctx.messages()).find(m => m.role === 'assistant');
            expect((await ctx.call('POST', '/api/sessions/demo/rewind', { messageId: assistant.id, scope: 'both' })).status).toBe(404);
        });
    }, 30000);

    test('没有文件快照的旧消息：回退文件 409，只回退对话可以', async () => {
        await withServer(async ctx => {
            await ctx.turn('round1 WRITE a.txt=1');
            const [first] = await ctx.users();
            const histFile = path.join(ctx.tempHost, 'web-history', 'demo.json');
            const data = JSON.parse(fs.readFileSync(histFile, 'utf8'));
            const agent = data.agents.default;
            agent.messages.find(m => m.id === first.id).snapBefore = undefined;
            fs.writeFileSync(histFile, JSON.stringify(data));
            // 缓存按 stat 判断是否过期：确保 mtime 变了
            fs.utimesSync(histFile, new Date(), new Date(Date.now() + 5000));
            expect((await ctx.call('POST', '/api/sessions/demo/rewind', { messageId: first.id, scope: 'files' })).status).toBe(409);
            expect((await ctx.call('POST', '/api/sessions/demo/rewind', { messageId: first.id, scope: 'conversation' })).status).toBe(200);
        });
    }, 30000);

    test('回退进行中占住运行锁：这时发新的一轮得到 409，回退结束后又可以发', async () => {
        await withServer(async ctx => {
            await threeRounds(ctx);
            const [, second] = await ctx.users();
            fs.writeFileSync(path.join(ctx.tempHost, 'slow'), '1');
            const rewinding = ctx.call('POST', '/api/sessions/demo/rewind', { messageId: second.id, scope: 'both' });
            await new Promise(resolve => setTimeout(resolve, 500));
            const blocked = await ctx.call('POST', '/api/sessions/demo/agent/stream', { prompt: 'sneak in', clientMessageId: 'cm-sneak-0001' });
            expect(blocked.status).toBe(409);
            expect((await rewinding).status).toBe(200);
            fs.rmSync(path.join(ctx.tempHost, 'slow'));
            await ctx.turn('after rewind WRITE d.txt=dd');
            expect(ctx.read('d.txt')).toBe('dd');
        });
    }, 60000);

    test('隐藏这一组：用户消息、执行过程、回复都带 hidden，可取消；换新 epoch', async () => {
        await withServer(async ctx => {
            await threeRounds(ctx);
            const [, second] = await ctx.users();
            const before = (await ctx.call('GET', '/api/sessions/demo/messages')).json.epoch;
            expect((await ctx.call('POST', '/api/sessions/demo/messages/hide', { messageId: second.id })).json).toMatchObject({ ok: true, count: 3 });
            const hidden = (await ctx.messages()).filter(m => m.hidden === true);
            expect(hidden).toHaveLength(3);
            expect(hidden[0].id).toBe(second.id);
            expect(hidden.map(m => m.role)).toEqual(['user', 'assistant', 'assistant']);
            const after = (await ctx.call('GET', '/api/sessions/demo/messages')).json.epoch;
            expect(after).not.toBe(before);
            await ctx.call('POST', '/api/sessions/demo/messages/hide', { messageId: second.id, hidden: false });
            expect((await ctx.messages()).some(m => m.hidden)).toBe(false);
            expect((await ctx.call('POST', '/api/sessions/demo/messages/hide', { messageId: 'nope' })).status).toBe(404);
        });
    }, 60000);

    test('未登录访问这些接口一律 401；缺少 CSRF 头的 POST 403', async () => {
        await withServer(async ctx => {
            const anon = (method, p) => fetch(`${ctx.baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: method === 'POST' ? '{}' : undefined });
            const from = 'a'.repeat(40);
            for (const [method, p] of [
                ['GET', `/api/sessions/demo/git/rounds/changes?from=${from}&to=${from}`],
                ['GET', `/api/sessions/demo/git/rounds/diff?from=${from}&to=${from}&path=a`],
                ['POST', '/api/sessions/demo/rewind/preview'],
                ['POST', '/api/sessions/demo/rewind'],
                ['POST', '/api/sessions/demo/messages/hide']
            ]) {
                expect((await anon(method, p)).status).toBe(401);
            }
        });
    });
});

describe('Claude：回退对话后的下一轮带 --resume-session-at，且只带一次', () => {
    const SID = '11111111-2222-3333-4444-555555555555';
    const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
    test('从容器里的会话文件找到分叉点；回退到第一轮则开新会话', async () => {
        await withServer(async ctx => {
            // 容器里的会话文件（结构取自真实的 Claude 会话）：三轮，每轮 user → assistant
            const rec = (n, parent, type, content) => JSON.stringify({ uuid: id(n), parentUuid: parent === null ? null : id(parent), type, isSidechain: false, timestamp: new Date().toISOString(), message: { role: type, content } });
            const dir = path.join(ctx.tempHost, '.claude', 'projects', '-work');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${SID}.jsonl`), [
                rec(1, null, 'user', '第一问'), rec(2, 1, 'assistant', [{ type: 'text', text: 'a1' }]),
                rec(3, 2, 'user', '第二问'), rec(4, 3, 'assistant', [{ type: 'text', text: 'a2' }]),
                rec(5, 4, 'user', '第三问'), rec(6, 5, 'assistant', [{ type: 'text', text: 'a3' }])
            ].join('\n'));
            await ctx.turn('第一问');
            await ctx.turn('第二问');
            await ctx.turn('第三问');
            const logs = () => fs.readFileSync(path.join(ctx.tempHost, 'commands.log'), 'utf8').trim().split('=====\n').filter(entry => entry.includes('stream-json'));
            expect(logs()[1]).toContain(`-r ${SID}`);
            expect(logs().join('')).not.toContain('--resume-session-at');

            const [, second] = await ctx.users();
            const res = await ctx.call('POST', '/api/sessions/demo/rewind', { messageId: second.id, scope: 'conversation' });
            expect(res.json).toMatchObject({ ok: true, conversationMode: 'precise', prompt: '第二问' });
            await ctx.turn('第二问改');
            expect(logs()[3]).toContain(`-r ${SID}`);
            expect(logs()[3]).toContain(`--resume-session-at ${id(2)}`);
            await ctx.turn('第三问改');
            expect(logs()[4]).toContain(`-r ${SID}`);
            expect(logs()[4]).not.toContain('--resume-session-at');

            // 回退到第一轮：引擎会话清掉，下一轮不带 -r（开新会话）
            const [first] = await ctx.users();
            expect((await ctx.call('POST', '/api/sessions/demo/rewind', { messageId: first.id, scope: 'conversation' })).json.conversationMode).toBe('precise');
            await ctx.turn('重新开始');
            expect(logs()[5]).not.toContain(' -r ');
            expect(logs()[5]).not.toContain('--resume-session-at');
        }, { agentPromptCommand: 'claude -p {prompt}' });
    }, 90000);
});
