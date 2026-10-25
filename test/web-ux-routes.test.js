'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');
const { startWebServer } = require('../lib/web/server');
const { BUILTIN_AGENT_INSTRUCTIONS } = require('../lib/agent-instructions');

// 这一组接口：环境说明、会话标题 / 首条消息、置顶、斜杠命令候选、改动视图（git）。
// 假 docker 把 `exec … /bin/bash -lc <命令>` 交给本机 bash 真跑：git 命令对本机临时仓库执行，
// 假 claude 输出 stream-json，并像真 claude 一样把 ai-title 写进 $CLAUDE_CONFIG_DIR/projects/*/<sid>.jsonl

const SESSION_ID = '0d6c1f6a-1111-4a2b-9c3d-123456789abc';
const FORK_SESSION_ID = 'f0f0f0f0-2222-4a2b-9c3d-123456789abc';

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

async function request(url, options = {}) {
    const merged = Object.assign({}, options);
    if ((options.method || 'GET').toUpperCase() !== 'GET') {
        merged.headers = Object.assign({ 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' }, options.headers || {});
    }
    const response = await fetch(url, merged);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { response, text, json };
}

function writeFakes(tempHost) {
    const binDir = path.join(tempHost, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const claudeDir = path.join(tempHost, 'claude-config');
    const argvLog = path.join(tempHost, 'claude-argv.json');
    fs.writeFileSync(path.join(binDir, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
// 探测 --forward-subagent-text 用的 claude --help：不产生任何记录
if (process.argv.includes('--help')) process.exit(0);
if (process.argv.includes('--no-session-persistence') && String(process.argv[process.argv.length - 1]).startsWith('SIDE:')) {
  // 侧问：记一笔，问题以 SIDE: 开头时回答；含 SLOW 的慢一点（给并发 / 取消用例）
  fs.appendFileSync(${JSON.stringify(argvLog)} + '.side', JSON.stringify(process.argv.slice(2)) + '\\n');
  const question = process.argv[process.argv.length - 1];
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: 'result', result: '侧问答案：' + question }) + '\\n');
    process.exit(0);
  }, question.includes('SLOW') ? 1200 : 0);
  return;
}
if (process.argv.includes('--no-session-persistence')) {
  // 轻量调用（自动标题 / 回顾）：记一笔，回一个带引号的标题，不碰主运行的记录文件
  fs.appendFileSync(${JSON.stringify(argvLog)} + '.light', JSON.stringify(process.argv.slice(2)) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', result: '“修复登录页面。”\\n多余的解释' }) + '\\n');
  process.exit(0);
}
if (process.argv.includes('--input-format')) {
  // 协议探测（斜杠命令目录 / 模型目录）：直接回 initialize 的响应（假 docker 不转发 stdin），不跑模型
  const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(__dirname, 'fixtures', 'claude-initialize.json'))}, 'utf8'));
  for (const id of ['manyoyo-command-catalog', 'manyoyo-model-catalog']) {
    fixture.response.request_id = id;
    process.stdout.write(JSON.stringify(fixture) + '\\n');
  }
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(argvLog)} + '.effort', process.env.CLAUDE_CODE_EFFORT_LEVEL || '');
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-workspace');
fs.mkdirSync(dir, { recursive: true });
// 像真 claude 一样写带 uuid 的 user / assistant 记录，回退 / 分叉靠它们找“这一轮之前”的位置
const crypto = require('crypto');
const prompt = String(process.argv[process.argv.length - 1]);
const lastFile = path.join(dir, '.last-uuid');
const parent = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8') : null;
const userUuid = crypto.randomUUID();
const assistantUuid = crypto.randomUUID();
fs.appendFileSync(path.join(dir, '${SESSION_ID}.jsonl'),
  JSON.stringify({ type: 'user', uuid: userUuid, parentUuid: parent, timestamp: new Date().toISOString(), message: { content: prompt } }) + '\\n' +
  JSON.stringify({ type: 'assistant', uuid: assistantUuid, parentUuid: userUuid, timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: '好' }] } }) + '\\n');
fs.writeFileSync(lastFile, assistantUuid);
const forked = process.argv.includes('--fork-session');
const sessionId = forked ? '${FORK_SESSION_ID}' : '${SESSION_ID}';
fs.appendFileSync(path.join(dir, '${SESSION_ID}.jsonl'), '{"type":"user","x":1}\\n{"type":"ai-title","aiTitle":"旧标题","sessionId":"${SESSION_ID}"}\\n{"type":"ai-title","aiTitle":"  修复登录\\\\u0007页面 <b>bug</b>  ","sessionId":"${SESSION_ID}"}\\n');
const out = [
  { type: 'system', subtype: 'init', session_id: sessionId, slash_commands: ['compact', 'color', 'my-skill', 'bad name!', 'doctor'], skills: ['my-skill', 'doctor'], terminal_slash_commands: ['doctor', 'color'] },
  { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } } },
  { type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 1200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, output_tokens: 50 } } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } },
  { type: 'result', subtype: 'success', result: '好', session_id: sessionId, modelUsage: { m: { contextWindow: 200000 } } }
];
const finish = () => process.stdout.write(out.map(item => JSON.stringify(item)).join('\\n') + '\\n');
if (prompt.includes('SLOWRUN')) setTimeout(finish, 1500); else finish();
`);
    fs.chmodSync(path.join(binDir, 'claude'), 0o755);
    const docker = path.join(tempHost, 'fake-docker.js');
    fs.writeFileSync(docker, `#!/usr/bin/env node
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const index = args.indexOf('/bin/bash');
// 模拟“读标题的命令还在跑，用户把这个 AGENT 连同历史删掉了”：经服务端自己的删除接口删
const dropFile = ${JSON.stringify(path.join(tempHost, 'drop-agent.json'))};
if (args[0] === 'exec' && index >= 0 && require('fs').existsSync(dropFile) && args[index + 2].includes('ai-title')) {
  const { baseUrl, cookie } = JSON.parse(require('fs').readFileSync(dropFile, 'utf8'));
  fetch(baseUrl + '/api/sessions/demo/remove-with-history', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ removeHistory: true })
  }).then(() => {
    const result = spawnSync('bash', ['-c', args[index + 2]], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, PATH: ${JSON.stringify(binDir)} + ':' + process.env.PATH, CLAUDE_CONFIG_DIR: ${JSON.stringify(claudeDir)} }
    });
    process.exit(result.status === null ? 1 : result.status);
  });
  return;
}
// 分叉 / 回退读会话记录用的是 bash -c 加脚本（不走登录 shell）：只放行这一种，别的（快照等）仍然什么都不做
const plainIndex = args.indexOf('bash');
if (args[0] === 'exec' && index < 0 && plainIndex >= 0 && String(args[plainIndex + 2]).includes('parentUuid')) {
  const result = spawnSync('bash', ['-c', args[plainIndex + 2]], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PATH: ${JSON.stringify(binDir)} + ':' + process.env.PATH, CLAUDE_CONFIG_DIR: ${JSON.stringify(claudeDir)} }
  });
  process.exit(result.status === null ? 1 : result.status);
}
if (args[0] === 'exec' && index >= 0) {
  const result = spawnSync('bash', ['-c', args[index + 2]], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PATH: ${JSON.stringify(binDir)} + ':' + process.env.PATH, CLAUDE_CONFIG_DIR: ${JSON.stringify(claudeDir)} }
  });
  process.exit(result.status === null ? 1 : result.status);
}
process.exit(0);
`);
    fs.chmodSync(docker, 0o755);
    return { docker, argvLog };
}

function git(cwd, ...args) {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
}

async function withServer(fn, config = {}, serverOptions = {}) {
    const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-ux-routes-'));
    const repo = path.join(tempHost, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n');
    const dir = path.join(tempHost, 'web-history');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify({
        containerName: 'demo', updatedAt: null, messages: [], agentPromptCommand: 'claude -p {prompt}',
        applied: { containerPath: repo, hostPath: repo }
    }));
    fs.writeFileSync(path.join(tempHost, 'manyoyo.json'), JSON.stringify(config));
    const fakes = writeFakes(tempHost);
    const port = await getFreePort();
    let handle = null;
    try {
        handle = await startWebServer({
            serverHost: '127.0.0.1',
            serverPort: port,
            authUser: 'webadmin',
            authPass: 'topsecret',
            authPassAuto: false,
            dockerCmd: fakes.docker,
            networkManager: {
                ensureBridgeNetwork: async () => {},
                resolveRefs: async policy => policy,
                apply: async () => ({ status: 'applied' }),
                ensureReady: async () => ({ status: 'applied' })
            },
            hostPath: tempHost,
            homeDir: tempHost,
            containerPath: '/workspace',
            imageName: 'localhost/xcanwin/manyoyo',
            imageVersion: '1.0.0-common',
            execCommandPrefix: '',
            execCommand: '',
            execCommandSuffix: '',
            contModeArgs: [],
            containerEnvs: [],
            containerVolumes: [],
            validateHostPath: () => {},
            formatDate: () => '0101-0000',
            isValidContainerName: value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value),
            containerExists: () => true,
            getContainerStatus: () => 'running',
            waitForContainerReady: async () => {},
            dockerExecArgs: () => '',
            showImagePullHint: () => {},
            removeContainer: () => {},
            webHistoryDir: dir,
            webConfigPath: path.join(tempHost, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' },
            ...serverOptions
        });
        const baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await request(`${baseUrl}/auth/login`, {
            method: 'POST',
            body: JSON.stringify({ username: 'webadmin', password: 'topsecret' })
        });
        const cookie = login.response.headers.get('set-cookie').split(';')[0];
        await fn({ baseUrl, cookie, tempHost, repo, argvLog: fakes.argvLog });
    } finally {
        if (handle && typeof handle.close === 'function') await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
    }
}

async function waitFor(check, timeoutMs = 5000) {
    const started = Date.now();
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() - started > timeoutMs) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

async function summaryOf(baseUrl, cookie) {
    const list = await request(`${baseUrl}/api/sessions`, { headers: { Cookie: cookie } });
    return list.json.sessions.find(item => item.name === 'demo');
}

describe('新增接口都走认证网关', () => {
    test('未登录一律 401', async () => {
        await withServer(async ({ baseUrl }) => {
            const routes = [
                ['GET', '/api/agent-instructions'],
                ['POST', '/api/agent-instructions'],
                ['POST', '/api/sessions/demo/agent-pin'],
                ['GET', '/api/sessions/demo/slash-commands'],
                ['GET', '/api/sessions/demo/git/changes'],
                ['GET', '/api/sessions/demo/git/diff?path=a.txt']
            ];
            for (const [method, url] of routes) {
                const res = await request(`${baseUrl}${url}`, { method, body: method === 'POST' ? '{}' : undefined });
                expect([url, res.response.status]).toEqual([url, 401]);
            }
        });
    });
});

describe('环境说明、标题、首条消息、斜杠命令', () => {
    test('一轮对话后：命令带环境说明，标题来自 ai-title（最后一条、按纯文本清洗），首条消息被记下，斜杠命令按规则过滤', async () => {
        await withServer(async ({ baseUrl, cookie, argvLog }) => {
            const builtin = await request(`${baseUrl}/api/agent-instructions`, { headers: { Cookie: cookie } });
            expect(builtin.json).toEqual({
                builtin: BUILTIN_AGENT_INSTRUCTIONS,
                custom: '全局说明',
                builtinEnabled: true,
                customEnabled: true,
                composed: `${BUILTIN_AGENT_INSTRUCTIONS}\n\n全局说明\n`
            });

            const stream = await request(`${baseUrl}/api/sessions/demo/agent/stream`, {
                method: 'POST',
                headers: { Cookie: cookie },
                body: JSON.stringify({ prompt: '帮我修一下\n登录页面的 bug', clientMessageId: 'ux-routes-0001' })
            });
            expect(stream.response.status).toBe(200);

            const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
            const index = argv.indexOf('--append-system-prompt');
            expect(argv[index + 1]).toBe(`${BUILTIN_AGENT_INSTRUCTIONS}\n\n全局说明`);

            const summary = await waitFor(async () => {
                const item = await summaryOf(baseUrl, cookie);
                return item && item.agentTitle ? item : null;
            });
            expect(summary.agentTitle).toBe('修复登录 页面 <b>bug</b>');
            expect(summary.firstPrompt).toBe('帮我修一下 登录页面的 bug');

            const commands = await request(`${baseUrl}/api/sessions/demo/slash-commands`, { headers: { Cookie: cookie } });
            // skill 列出；终端专用（doctor、color）不列；名字不合法的丢掉；内置命令只列实测可用的
            const names = commands.json.commands.map(item => item.name);
            expect(names).toContain('my-skill');
            expect(names).not.toContain('doctor');
            expect(names).not.toContain('color');
            expect(names).not.toContain('bad name!');
            // 每项都是 { name, description, argumentHint }（目录里没有的，说明为空）
            expect(commands.json.commands.find(item => item.name === 'my-skill')).toEqual({ name: 'my-skill', description: '', argumentHint: '', source: '' });
        }, { agentInstructions: '全局说明' });
    });
});

describe('斜杠命令候选：新 AGENT 没跑过一轮也有', () => {
    test('用 initialize 目录：带说明、不含内部命令；结果按容器缓存', async () => {
        await withServer(async ({ baseUrl, cookie }) => {
            const unauth = await request(`${baseUrl}/api/sessions/demo/slash-commands`);
            expect(unauth.response.status).toBe(401);
            const commands = await request(`${baseUrl}/api/sessions/demo/slash-commands`, { headers: { Cookie: cookie } });
            expect(commands.response.status).toBe(200);
            expect(commands.json.agentProgram).toBe('claude');
            const names = commands.json.commands.map(item => item.name);
            expect(names).toEqual(expect.arrayContaining(['playwright-cli', 'code-review', 'context']));
            ['__remote-workflow', 'workflow-launch-exec', 'heapdump', 'clear', 'compact'].forEach(name => expect(names).not.toContain(name));
            const skill = commands.json.commands.find(item => item.name === 'playwright-cli');
            expect(skill.description).toMatch(/Playwright/);
            expect(skill.description).not.toMatch(/\(user\)/);
        });
    });
});

describe('推理强度与上下文占用', () => {
    test('选项来自模型目录；设置后下一轮用环境变量前缀注入；非法 / 不支持的强度被拒；轮结束写上下文占用', async () => {
        await withServer(async ({ baseUrl, cookie, argvLog }) => {
            const url = `${baseUrl}/api/sessions/demo/effort`;
            expect((await request(url)).response.status).toBe(401);
            expect((await request(url, { method: 'POST', body: '{}' })).response.status).toBe(401);
            const options = await request(url, { headers: { Cookie: cookie } });
            expect(options.json).toMatchObject({ levels: ['low', 'medium', 'high', 'xhigh', 'max'], effort: '' });
            for (const bad of ['LOW', 'low; id', 'x']) {
                const res = await request(url, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ effort: bad }) });
                expect([bad, res.response.status]).toEqual([bad, 400]);
            }
            const unsupported = await request(url, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ effort: 'ultra' }) });
            expect(unsupported.response.status).toBe(400);
            const ok = await request(url, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ effort: 'low' }) });
            expect(ok.json.effort).toBe('low');
            expect((await summaryOf(baseUrl, cookie)).effort).toBe('low');

            await request(`${baseUrl}/api/sessions/demo/agent/stream`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ prompt: 'hi', clientMessageId: 'effort-0001' }) });
            expect(fs.readFileSync(`${argvLog}.effort`, 'utf8')).toBe('low');
            const summary = await waitFor(async () => {
                const item = await summaryOf(baseUrl, cookie);
                return item && item.contextUsage ? item : null;
            });
            expect(summary.contextUsage).toMatchObject({ usedTokens: 2050, window: 200000, inputTokens: 1200, cacheReadTokens: 800 });

            // 换成目录里没有的模型：当前强度回到默认
            const switched = await request(`${baseUrl}/api/sessions/demo/model`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ model: 'custom-x' }) });
            expect(switched.json.effort).toBe('');
            expect((await summaryOf(baseUrl, cookie)).effort).toBe('');

            // 默认强度（空）= 不注入
            await request(`${baseUrl}/api/sessions/demo/agent/stream`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ prompt: 'again', clientMessageId: 'effort-0002' }) });
            expect(fs.readFileSync(`${argvLog}.effort`, 'utf8')).toBe('');
        });
    });
});

describe('自动标题', () => {
    test('第一句话发出后生成一次，写进 autoTitle；第二轮不再生成；有备注的不生成', async () => {
        await withServer(async ({ baseUrl, cookie, argvLog }) => {
            const send = (prompt, id) => request(`${baseUrl}/api/sessions/demo/agent/stream`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ prompt, clientMessageId: id }) });
            await send('帮我修一下登录页面', 'title-0001');
            const summary = await waitFor(async () => {
                const item = await summaryOf(baseUrl, cookie);
                return item && item.autoTitle ? item : null;
            });
            expect(summary.autoTitle).toBe('修复登录页面');
            await send('再来一句', 'title-0002');
            await new Promise(resolve => setTimeout(resolve, 300));
            const calls = fs.readFileSync(`${argvLog}.light`, 'utf8').trim().split('\n');
            expect(calls).toHaveLength(1);
            const argv = JSON.parse(calls[0]);
            expect(argv).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', '--tools', '', '--output-format', 'json']));
            expect(argv[argv.length - 1]).toBe('帮我修一下登录页面');
        });
    });
});

describe('侧问', () => {
    test('带上下文问一句：不进对话记录、不占运行锁；没有引擎会话时是无上下文提问；同一 AGENT 同时一个；参数校验', async () => {
        await withServer(async ({ baseUrl, cookie, argvLog }) => {
            const url = `${baseUrl}/api/sessions/demo/agent/side`;
            const ask = (question, extra = {}) => request(url, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ question, ...extra }) });
            expect((await request(url, { method: 'POST', body: '{}' })).response.status).toBe(401);
            expect((await ask('')).response.status).toBe(400);
            expect((await ask('字'.repeat(4001))).response.status).toBe(400);
            expect((await request(url, { method: 'POST', headers: { Cookie: cookie }, body: '{"question":5}' })).response.status).toBe(400);

            // 还没有引擎会话：不带 -r / --fork-session
            const first = await ask('SIDE:1 你好');
            expect(first.response.status).toBe(200);
            expect(first.json.answer).toBe('侧问答案：SIDE:1 你好');
            const noContext = JSON.parse(fs.readFileSync(`${argvLog}.side`, 'utf8').trim().split('\n')[0]);
            expect(noContext).not.toContain('-r');
            expect(noContext).not.toContain('--fork-session');

            // 跑一轮拿到引擎会话 id，再问：分叉且不落盘
            await request(`${baseUrl}/api/sessions/demo/agent/stream`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ prompt: 'hi', clientMessageId: 'side-0001' }) });
            const before = (await request(`${baseUrl}/api/sessions/demo/messages`, { headers: { Cookie: cookie } })).json.messages.length;
            const second = await ask('SIDE:2 上文是什么');
            expect(second.json.answer).toContain('SIDE:2');
            const lines = fs.readFileSync(`${argvLog}.side`, 'utf8').trim().split('\n');
            const withContext = JSON.parse(lines[lines.length - 1]);
            expect(withContext).toEqual(expect.arrayContaining(['-r', SESSION_ID, '--fork-session', '--no-session-persistence']));
            const after = (await request(`${baseUrl}/api/sessions/demo/messages`, { headers: { Cookie: cookie } })).json.messages.length;
            expect(after).toBe(before);

            // 同一 AGENT 同时一个
            const slow = ask('SIDE:3 SLOW');
            await new Promise(resolve => setTimeout(resolve, 150));
            expect((await ask('SIDE:4')).response.status).toBe(409);
            expect((await slow).json.answer).toContain('SLOW');
            expect((await ask('SIDE:5')).response.status).toBe(200);
        });
    });

    test('客户端中途断开后，同一 AGENT 可以再问', async () => {
        await withServer(async ({ baseUrl, cookie }) => {
            const url = `${baseUrl}/api/sessions/demo/agent/side`;
            const controller = new AbortController();
            const pending = fetch(url, { method: 'POST', signal: controller.signal, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ question: 'SIDE:slow SLOW' }) }).catch(() => null);
            await new Promise(resolve => setTimeout(resolve, 200));
            controller.abort();
            await pending;
            const next = await waitFor(async () => {
                const res = await request(url, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ question: 'SIDE:after' }) });
                return res.response.status === 200 ? res : null;
            }, 6000);
            expect(next.json.answer).toContain('SIDE:after');
        });
    });
});

describe('分叉', () => {
    test('从某一轮另开一条线：同容器新建 AGENT，带之前的对话，下一轮用 --fork-session 且原 AGENT 不变', async () => {
        await withServer(async ({ baseUrl, cookie, argvLog, tempHost }) => {
            const api = (url, options = {}) => request(`${baseUrl}${url}`, { headers: { Cookie: cookie }, ...options });
            const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });
            const stored = () => JSON.parse(fs.readFileSync(path.join(tempHost, 'web-history', 'demo.json'), 'utf8')).agents;
            expect((await request(`${baseUrl}/api/sessions/demo/agent/fork`, { method: 'POST', body: '{}' })).response.status).toBe(401);
            const send = (name, prompt, id) => post(`/api/sessions/${encodeURIComponent(name)}/agent/stream`, { prompt, clientMessageId: id });
            await send('demo', '第一轮', 'fork-0001');
            await send('demo', '第二轮', 'fork-0002');
            const original = (await api('/api/sessions/demo/messages')).json;
            const userMessages = original.messages.filter(item => item.role === 'user');
            expect(userMessages.map(item => item.content)).toEqual(['第一轮', '第二轮']);

            // 非法 / 不存在的消息
            expect((await post('/api/sessions/demo/agent/fork', { messageId: 'nope' })).response.status).toBe(404);
            const assistant = original.messages.find(item => item.role === 'assistant');
            expect((await post('/api/sessions/demo/agent/fork', { messageId: assistant.id })).response.status).toBe(404);

            // 从第二轮分叉：新 AGENT 带第一轮的对话，提示词放回给前端
            const forked = await post('/api/sessions/demo/agent/fork', { messageId: userMessages[1].id });
            expect(forked.response.status).toBe(200);
            expect(forked.json).toMatchObject({ prompt: '第二轮', agentId: 'agent-2', name: 'demo~agent-2' });
            const forkMessages = (await api(`/api/sessions/${encodeURIComponent(forked.json.name)}/messages`)).json.messages;
            expect(forkMessages.filter(item => item.role === 'user').map(item => item.content)).toEqual(['第一轮']);
            expect(forkMessages.every(item => !item.clientMessageId && !item.pending)).toBe(true);

            // 下一轮：命令带 -r 原会话 --resume-session-at <第一轮回复> --fork-session；跑完拿到新会话 id
            const records = fs.readFileSync(path.join(path.dirname(argvLog), 'claude-config', 'projects', '-workspace', `${SESSION_ID}.jsonl`), 'utf8')
                .split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.uuid);
            const firstAssistant = records.find(item => item.type === 'assistant');
            await send(forked.json.name, '分叉后的新问题', 'fork-0003');
            const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
            expect(argv).toEqual(expect.arrayContaining(['-r', SESSION_ID, '--resume-session-at', firstAssistant.uuid, '--fork-session']));
            const sessions = (await api('/api/sessions')).json.sessions;
            const forkSummary = sessions.find(item => item.name === 'demo~agent-2');
            expect(forkSummary).toBeDefined();

            // 原 AGENT 不变：消息、会话 id 不动
            const after = (await api('/api/sessions/demo/messages')).json;
            expect(after.messages.map(item => item.id)).toEqual(original.messages.map(item => item.id));
            expect(after.epoch).toBe(original.epoch);
            expect(stored().default.engineSessionId).toBe(SESSION_ID);
            expect(stored()['agent-2']).toMatchObject({ engineSessionId: FORK_SESSION_ID, forkPending: false, rewindToUuid: '' });
            expect(stored()['agent-2'].autoTitle).toMatch(/（分叉）$/);

            // 再发一轮不再带 --fork-session
            await send(forked.json.name, '再来一轮', 'fork-0004');
            const next = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
            expect(next).not.toContain('--fork-session');
            expect(next).toEqual(expect.arrayContaining(['-r', FORK_SESSION_ID]));
        });
    });

    test('从最新处分叉（不给 messageId）：带全部对话；任务进行中 409', async () => {
        await withServer(async ({ baseUrl, cookie }) => {
            const api = (url, options = {}) => request(`${baseUrl}${url}`, { headers: { Cookie: cookie }, ...options });
            const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });
            await post('/api/sessions/demo/agent/stream', { prompt: '第一轮', clientMessageId: 'fork-1001' });
            const latest = await post('/api/sessions/demo/agent/fork', {});
            expect(latest.response.status).toBe(200);
            expect(latest.json.prompt).toBe('');
            const messages = (await api(`/api/sessions/${encodeURIComponent(latest.json.name)}/messages`)).json.messages;
            expect(messages.filter(item => item.role === 'user' && item.mode === 'agent')).toHaveLength(1);

            const running = post('/api/sessions/demo/agent/stream', { prompt: 'SLOWRUN', clientMessageId: 'fork-1002' });
            await new Promise(resolve => setTimeout(resolve, 300));
            expect((await post('/api/sessions/demo/agent/fork', {})).response.status).toBe(409);
            await running;
        });
    });
});

describe('回顾', () => {
    test('空闲不到 30 分钟不生成；过了才生成并存起来；/recap 用 force 立即生成；执行中不生成；未登录 401', async () => {
        let skew = 0;
        await withServer(async ({ baseUrl, cookie, argvLog }) => {
            const url = `${baseUrl}/api/sessions/demo/agent/recap`;
            expect((await request(url, { method: 'POST', body: '{}' })).response.status).toBe(401);
            await request(`${baseUrl}/api/sessions/demo/agent/stream`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ prompt: '帮我修一下登录页面', clientMessageId: 'recap-0001' }) });
            await waitFor(async () => (await summaryOf(baseUrl, cookie) || {}).autoTitle);
            const lightCalls = () => fs.readFileSync(`${argvLog}.light`, 'utf8').trim().split('\n').length;
            const before = lightCalls();
            const early = await request(url, { method: 'POST', headers: { Cookie: cookie }, body: '{}' });
            expect(early.json.recap).toBeNull();
            expect(lightCalls()).toBe(before);

            skew = 31 * 60 * 1000;
            const late = await request(url, { method: 'POST', headers: { Cookie: cookie }, body: '{}' });
            expect(late.json.recap).toMatchObject({ text: '修复登录页面' });
            expect(lightCalls()).toBe(before + 1);
            expect((await summaryOf(baseUrl, cookie)).recap.text).toBe('修复登录页面');
            // 已经生成过：不再重复调用
            await request(url, { method: 'POST', headers: { Cookie: cookie }, body: '{}' });
            expect(lightCalls()).toBe(before + 1);
            // force 重新生成
            skew = 0;
            await request(url, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ force: true }) });
            expect(lightCalls()).toBe(before + 2);
        }, {}, { nowMs: () => Date.now() + skew });
    });
});

describe('Agent 环境说明的保存', () => {
    test('写进全局配置（保留文件里其他内容与注释），下一轮执行就带上；非字符串 400', async () => {
        await withServer(async ({ baseUrl, cookie, tempHost, argvLog }) => {
            fs.writeFileSync(path.join(tempHost, 'manyoyo.json'), '{\n    // 我的注释\n    "imageVersion": "1.0.0-common"\n}\n');
            const bad = await request(`${baseUrl}/api/agent-instructions`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ custom: 1 }) });
            expect(bad.response.status).toBe(400);
            const saved = await request(`${baseUrl}/api/agent-instructions`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ custom: '回答用中文' }) });
            expect(saved.json).toMatchObject({ saved: true });
            const raw = fs.readFileSync(path.join(tempHost, 'manyoyo.json'), 'utf8');
            expect(raw).toContain('// 我的注释');
            expect(raw).toContain('"imageVersion": "1.0.0-common"');
            expect((await request(`${baseUrl}/api/agent-instructions`, { headers: { Cookie: cookie } })).json.custom).toBe('回答用中文');
            await request(`${baseUrl}/api/sessions/demo/agent/stream`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ prompt: 'hi', clientMessageId: 'ux-routes-0002' }) });
            const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
            expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(`${BUILTIN_AGENT_INSTRUCTIONS}\n\n回答用中文`);
        });
    });
});

describe('审查回归：不给不存在 / 已删除的 AGENT 建记录', () => {
    test('读标题期间 AGENT 被删了：标题不写回，不会“复活”', async () => {
        await withServer(async ({ baseUrl, cookie, tempHost }) => {
            const file = path.join(tempHost, 'web-history', 'demo.json');
            fs.writeFileSync(path.join(tempHost, 'drop-agent.json'), JSON.stringify({ baseUrl, cookie }));
            {
                await request(`${baseUrl}/api/sessions/demo/agent/stream`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ prompt: 'hi', clientMessageId: 'ux-routes-0003' }) });
                await new Promise(resolve => setTimeout(resolve, 1500));
                const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
                expect(data.agents && data.agents.default).toBeUndefined();
            }
        });
    });

    test('给不存在的 AGENT 置顶返回 404，不建记录', async () => {
        await withServer(async ({ baseUrl, cookie, tempHost }) => {
            const res = await request(`${baseUrl}/api/sessions/${encodeURIComponent('demo~agent-9')}/agent-pin`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ pinned: true }) });
            expect(res.response.status).toBe(404);
            const data = JSON.parse(fs.readFileSync(path.join(tempHost, 'web-history', 'demo.json'), 'utf8'));
            expect(data.agents && data.agents['agent-9']).toBeUndefined();
        });
    });
});

describe('置顶', () => {
    test('置顶状态落盘并出现在会话列表里，可以取消', async () => {
        await withServer(async ({ baseUrl, cookie }) => {
            expect((await summaryOf(baseUrl, cookie)).pinned).toBe(false);
            const on = await request(`${baseUrl}/api/sessions/demo/agent-pin`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ pinned: true }) });
            expect(on.json).toMatchObject({ pinned: true });
            expect((await summaryOf(baseUrl, cookie)).pinned).toBe(true);
            await request(`${baseUrl}/api/sessions/demo/agent-pin`, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ pinned: false }) });
            expect((await summaryOf(baseUrl, cookie)).pinned).toBe(false);
        });
    });
});

describe('改动视图', () => {
    test('列出改动；diff 只给列表里的已跟踪文件；不合法路径 400', async () => {
        await withServer(async ({ baseUrl, cookie, repo }) => {
            const changes = await request(`${baseUrl}/api/sessions/demo/git/changes`, { headers: { Cookie: cookie } });
            expect(changes.json.repo).toBe(true);
            expect(changes.json.root).toBe(fs.realpathSync(repo));
            expect(changes.json.files.map(file => [file.path, file.status])).toEqual(expect.arrayContaining([['a.txt', 'modified'], ['new.txt', 'untracked']]));

            const diff = await request(`${baseUrl}/api/sessions/demo/git/diff?path=a.txt`, { headers: { Cookie: cookie } });
            expect(diff.json.diff).toContain('+two');

            const notListed = await request(`${baseUrl}/api/sessions/demo/git/diff?path=${encodeURIComponent('../../etc/passwd')}`, { headers: { Cookie: cookie } });
            expect(notListed.response.status).toBe(404);
            const untracked = await request(`${baseUrl}/api/sessions/demo/git/diff?path=new.txt`, { headers: { Cookie: cookie } });
            expect(untracked.response.status).toBe(404);
            const option = await request(`${baseUrl}/api/sessions/demo/git/diff?path=${encodeURIComponent('--output=/tmp/x')}`, { headers: { Cookie: cookie } });
            expect(option.response.status).toBe(400);
        });
    });
});

describe('目录列举的前缀与数量上限（@ 补全用）', () => {
    const { __testing } = require('../lib/web/server');
    test('先按前缀过滤，再按“目录在前 + 名字”取前 limit 项，并标记截断', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-list-'));
        try {
            for (const name of ['src-b.ts', 'src-a.ts', 'Src-c.ts', 'readme.md']) fs.writeFileSync(path.join(dir, name), '');
            fs.mkdirSync(path.join(dir, 'src-dir'));
            const run = options => JSON.parse(spawnSync('bash', ['-c', __testing.buildContainerFileListCommand(dir, options)], { encoding: 'utf8' }).stdout);
            const limited = run({ prefix: 'src', limit: 2 });
            expect(limited.entries.map(entry => entry.name)).toEqual(['src-dir', 'src-a.ts']);
            expect(limited.truncated).toBe(true);
            const all = run({ prefix: 'src', limit: 10 });
            expect(all.entries.map(entry => entry.name)).toEqual(['src-dir', 'src-a.ts', 'src-b.ts', 'Src-c.ts']);
            expect(all.truncated).toBeUndefined();
            expect(run({}).entries).toHaveLength(5);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
