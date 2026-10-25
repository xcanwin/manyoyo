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
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(argvLog)} + '.effort', process.env.CLAUDE_CODE_EFFORT_LEVEL || '');
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-workspace');
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(dir, '${SESSION_ID}.jsonl'), '{"type":"user","x":1}\\n{"type":"ai-title","aiTitle":"旧标题","sessionId":"${SESSION_ID}"}\\n{"type":"ai-title","aiTitle":"  修复登录\\\\u0007页面 <b>bug</b>  ","sessionId":"${SESSION_ID}"}\\n');
if (process.argv.includes('--input-format')) {
  // 协议探测（斜杠命令目录 / 模型目录）：直接回 initialize 的响应（假 docker 不转发 stdin），不跑模型
  const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(__dirname, 'fixtures', 'claude-initialize.json'))}, 'utf8'));
  for (const id of ['manyoyo-command-catalog', 'manyoyo-model-catalog']) {
    fixture.response.request_id = id;
    process.stdout.write(JSON.stringify(fixture) + '\\n');
  }
  process.exit(0);
}
const out = [
  { type: 'system', subtype: 'init', session_id: '${SESSION_ID}', slash_commands: ['compact', 'color', 'my-skill', 'bad name!', 'doctor'], skills: ['my-skill', 'doctor'], terminal_slash_commands: ['doctor', 'color'] },
  { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } } },
  { type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 1200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, output_tokens: 50 } } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } },
  { type: 'result', subtype: 'success', result: '好', session_id: '${SESSION_ID}', modelUsage: { m: { contextWindow: 200000 } } }
];
process.stdout.write(out.map(item => JSON.stringify(item)).join('\\n') + '\\n');
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

async function withServer(fn, config = {}) {
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
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' }
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
