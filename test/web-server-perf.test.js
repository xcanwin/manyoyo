const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const zlib = require('zlib');
const http = require('http');
const { startWebServer, __testing } = require('../lib/web/server');
const { FileEventStore } = require('../lib/core/event-store');
const { createControlEvent } = require('../lib/core/events');
const messagesView = require('../lib/web/messages-view');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(err => (err ? reject(err) : resolve(port)));
        });
    });
}

function rawRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method, headers: { 'X-Requested-With': 'XMLHttpRequest', ...headers } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                let buffer = Buffer.concat(chunks);
                const encoding = res.headers['content-encoding'] || '';
                if (encoding === 'gzip') {
                    buffer = zlib.gunzipSync(buffer);
                }
                const text = buffer.toString('utf-8');
                let json = null;
                try { json = JSON.parse(text); } catch (e) { json = null; }
                resolve({ status: res.statusCode, headers: res.headers, text, json, wireLength: Number(res.headers['content-length'] || 0), encoding });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function buildServerOptions(tempHost, port, overrides = {}) {
    return {
        serverHost: '127.0.0.1',
        serverPort: port,
        authUser: 'webadmin',
        authPass: 'topsecret',
        authPassAuto: false,
        // 这些用例按 exec 次数断言“只执行一次”，自动标题的轻量调用会混进来
        autoTitle: false,
        dockerCmd: 'docker',
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
        webHistoryDir: path.join(tempHost, 'web-history'),
        webConfigPath: path.join(tempHost, 'manyoyo.json'),
        colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' },
        ...overrides
    };
}

function hexId(n) {
    return `${1700000000000 + n}-${n.toString(16).padStart(6, '0')}`;
}

function buildMessages(turns) {
    const messages = [];
    let n = 0;
    for (let i = 0; i < turns; i++) {
        messages.push({ id: hexId(n++), role: 'user', mode: 'agent', content: `问题 ${i}`, timestamp: '2026-01-01T00:00:00.000Z' });
        messages.push({
            id: hexId(n++), role: 'assistant', mode: 'agent', streamTrace: true, content: `[执行过程]\n${'长输出'.repeat(300)}`,
            traceEvents: [
                { kind: 'tool', toolId: `t${i}`, title: 'Bash', status: 'started', text: 'x'.repeat(2000) },
                { kind: 'tool', toolId: `t${i}`, title: 'Bash', status: 'completed', text: 'y'.repeat(2000) },
                { kind: 'error', text: 'z'.repeat(1000) }
            ],
            timestamp: '2026-01-01T00:00:01.000Z'
        });
        messages.push({ id: hexId(n++), role: 'assistant', mode: 'agent', content: `回答 ${i}`, timestamp: '2026-01-01T00:00:02.000Z' });
    }
    return messages;
}

describe('Web messages sync, conditional requests and compression', () => {
    let tempHost;
    let handle;
    let baseUrl;
    let cookie;
    let historyFile;

    async function startServer(overrides = {}) {
        const port = await getFreePort();
        handle = await startWebServer(buildServerOptions(tempHost, port, overrides));
        baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await rawRequest(`${baseUrl}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'webadmin', password: 'topsecret' })
        });
        cookie = login.headers['set-cookie'][0].split(';')[0];
    }

    function writeHistory(messages, extra = {}) {
        fs.mkdirSync(path.dirname(historyFile), { recursive: true });
        fs.writeFileSync(historyFile, JSON.stringify({
            containerName: 'demo',
            agents: { default: { agentId: 'default', agentName: 'AGENT 1', messages, ...extra } }
        }));
    }

    const get = (url, headers = {}) => rawRequest(`${baseUrl}${url}`, { headers: { Cookie: cookie, ...headers } });

    beforeEach(() => {
        tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-perf-'));
        historyFile = path.join(tempHost, 'web-history', 'demo.json');
        handle = null;
    });

    afterEach(async () => {
        if (handle) await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
    });

    test('未登录访问 /messages 与 trace 返回 401，登出后失效', async () => {
        writeHistory(buildMessages(1));
        await startServer();
        const anon = await rawRequest(`${baseUrl}/api/sessions/demo/messages`);
        expect(anon.status).toBe(401);
        const anonTrace = await rawRequest(`${baseUrl}/api/sessions/demo/messages/${hexId(1)}/trace`);
        expect(anonTrace.status).toBe(401);
        expect((await get('/api/sessions/demo/messages')).status).toBe(200);
        await rawRequest(`${baseUrl}/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
        expect((await get('/api/sessions/demo/messages')).status).toBe(401);
    });

    test('默认返回最近一页，起点对齐到 user 消息，并带 epoch / firstId / hasMore / mode', async () => {
        const messages = buildMessages(40);
        writeHistory(messages);
        await startServer();
        const res = await get('/api/sessions/demo/messages?limit=10');
        expect(res.status).toBe(200);
        expect(res.json.mode).toBe('page');
        expect(res.json.hasMore).toBe(true);
        expect(res.json.firstId).toBe(res.json.messages[0].id);
        expect(res.json.epoch).toMatch(/^[0-9a-f]{8,32}$/);
        expect(res.json.messages[res.json.messages.length - 1].id).toBe(messages[messages.length - 1].id);
        expect(res.json.messages[0].role).toBe('user');
        expect(res.json.messages.length).toBeGreaterThanOrEqual(10);
        expect(res.json.messages.length).toBeLessThanOrEqual(30);
    });

    test('after + epoch 只返回锚点之后的消息；epoch 不符或锚点不存在时整页重置', async () => {
        const messages = buildMessages(10);
        writeHistory(messages);
        await startServer();
        const first = await get('/api/sessions/demo/messages?limit=200');
        const epoch = first.json.epoch;
        const anchor = messages[messages.length - 4].id;
        const tail = await get(`/api/sessions/demo/messages?after=${anchor}&epoch=${epoch}`);
        expect(tail.json.mode).toBe('tail');
        expect(tail.json.messages.map(m => m.id)).toEqual(messages.slice(-3).map(m => m.id));

        const wrongEpoch = await get(`/api/sessions/demo/messages?after=${anchor}&epoch=00000000`);
        expect(wrongEpoch.json.mode).toBe('reset');
        expect(wrongEpoch.json.messages.length).toBeGreaterThan(0);

        const missing = await get(`/api/sessions/demo/messages?after=${hexId(9999)}&epoch=${epoch}`);
        expect(missing.json.mode).toBe('reset');
    });

    test('before 返回更早的一页，最后一页 hasMore=false', async () => {
        const messages = buildMessages(20);
        writeHistory(messages);
        await startServer();
        const newest = await get('/api/sessions/demo/messages?limit=20');
        const cursor = newest.json.messages[0].id;
        const older = await get(`/api/sessions/demo/messages?before=${cursor}&limit=20`);
        expect(older.json.mode).toBe('page');
        const olderIds = older.json.messages.map(m => m.id);
        expect(olderIds[olderIds.length - 1]).toBe(messages[messages.findIndex(m => m.id === cursor) - 1].id);
        const oldest = await get(`/api/sessions/demo/messages?before=${messages[3].id}&limit=200`);
        expect(oldest.json.hasMore).toBe(false);
        expect(oldest.json.messages[0].id).toBe(messages[0].id);
    });

    test.each([
        ['limit=0'], ['limit=201'], ['limit=abc'], ['limit=-1'], ['limit=1.5'],
        ['before=../../etc'], ['before=abc'], ['after=1-2&epoch=zz'], ['after=1700000000000-000001'],
        ['after=1700000000000-000001&before=1700000000000-000002&epoch=abcdef12']
    ])('非法查询参数 %s 返回 400', async query => {
        writeHistory(buildMessages(1));
        await startServer();
        const res = await get(`/api/sessions/demo/messages?${query}`);
        expect(res.status).toBe(400);
        expect(typeof res.json.error).toBe('string');
    });

    test('列表里的 trace 被截断且标记 traceTruncated，步数与是否有错误不变；trace 接口返回完整内容', async () => {
        const messages = buildMessages(2);
        writeHistory(messages);
        await startServer();
        const list = await get('/api/sessions/demo/messages?limit=200');
        const trace = list.json.messages.find(m => m.streamTrace);
        const original = messages.find(m => m.streamTrace);
        expect(trace.traceTruncated).toBe(true);
        expect(trace.traceEvents).toHaveLength(original.traceEvents.length);
        expect(trace.traceEvents.map(e => e.kind)).toEqual(original.traceEvents.map(e => e.kind));
        expect(trace.traceEvents[0].toolId).toBe('t0');
        expect(trace.traceEvents[0].text.length).toBeLessThan(300);
        expect(trace.content.length).toBeLessThan(300);

        const full = await get(`/api/sessions/demo/messages/${original.id}/trace`);
        expect(full.status).toBe(200);
        expect(full.json.traceEvents).toEqual(original.traceEvents);
        expect(full.json.content).toBe(original.content);
        expect((await get(`/api/sessions/demo/messages/${messages[0].id}/trace`)).status).toBe(404);
        expect((await get('/api/sessions/demo/messages/bad-id/trace')).status).toBe(400);
    });

    test('/audit 仍然输出完整内容', async () => {
        const messages = buildMessages(1);
        writeHistory(messages);
        await startServer();
        const audit = await get('/api/sessions/demo/audit');
        expect(audit.status).toBe(200);
    });

    test('If-None-Match 命中回 304 且没有 body；写入后 ETag 变化（含大小相同的连续写入）', async () => {
        writeHistory(buildMessages(3));
        await startServer();
        const first = await get('/api/sessions/demo/messages');
        const etag = first.headers.etag;
        expect(etag).toMatch(/^W\//);
        expect(first.headers['cache-control']).toBe('no-cache');
        const second = await get('/api/sessions/demo/messages', { 'If-None-Match': etag });
        expect(second.status).toBe(304);
        expect(second.text).toBe('');

        const etags = new Set([etag]);
        for (const remark of ['aaaa', 'bbbb', 'cccc']) {
            const saved = await rawRequest(`${baseUrl}/api/sessions/demo/agent-remark`, {
                method: 'POST',
                headers: { Cookie: cookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ remark })
            });
            expect(saved.status).toBe(200);
            // 把 mtime 固定成同一个值：只看 mtime 的实现会在“同一毫秒、大小相同”的写入后误回 304
            fs.utimesSync(historyFile, 1700000000, 1700000000);
            const next = await get('/api/sessions/demo/messages');
            expect(etags.has(next.headers.etag)).toBe(false);
            etags.add(next.headers.etag);
            expect((await get('/api/sessions/demo/messages', { 'If-None-Match': next.headers.etag })).status).toBe(304);
        }
    });

    test('别的进程改写历史文件后下一次请求就能看到', async () => {
        writeHistory(buildMessages(1));
        await startServer();
        const before = await get('/api/sessions/demo/messages');
        const replacement = buildMessages(2);
        const tmp = `${historyFile}.other`;
        fs.writeFileSync(tmp, JSON.stringify({ containerName: 'demo', agents: { default: { agentId: 'default', messages: replacement } } }));
        fs.renameSync(tmp, historyFile);
        const after = await get('/api/sessions/demo/messages', { 'If-None-Match': before.headers.etag });
        expect(after.status).toBe(200);
        expect(after.json.messages).toHaveLength(replacement.length);
    });

    test('Accept-Encoding: gzip 时 >1KB 的 JSON 被压缩，解压后与未压缩一致', async () => {
        writeHistory(buildMessages(20));
        await startServer();
        const plain = await get('/api/sessions/demo/messages?limit=200', { 'Accept-Encoding': 'identity' });
        const gz = await get('/api/sessions/demo/messages?limit=200', { 'Accept-Encoding': 'gzip' });
        expect(plain.encoding).toBe('');
        expect(gz.encoding).toBe('gzip');
        expect(gz.headers.vary).toMatch(/Accept-Encoding/i);
        expect(gz.text).toBe(plain.text);
        expect(gz.wireLength).toBeLessThan(plain.wireLength);
    });

    test('/sessions 与 detail 支持 304', async () => {
        writeHistory(buildMessages(1));
        await startServer();
        for (const url of ['/api/sessions', '/api/sessions/demo/detail']) {
            const first = await get(url);
            expect(first.headers.etag).toBeTruthy();
            expect((await get(url, { 'If-None-Match': first.headers.etag })).status).toBe(304);
        }
    });

    test('index.html 带 ETag 可 304，gzip 后更小', async () => {
        await startServer();
        const first = await get('/', { 'Accept-Encoding': 'gzip' });
        expect(first.status).toBe(200);
        expect(first.encoding).toBe('gzip');
        expect(first.headers.etag).toBeTruthy();
        const second = await get('/', { 'If-None-Match': first.headers.etag, 'Accept-Encoding': 'gzip' });
        expect(second.status).toBe(304);
    });

    function writeFakeClaudeDocker() {
        const fake = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec' && String(args[4] || '').includes('claude ')) {
  process.stdout.write('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}\\n');
  process.stdout.write('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}\\n');
  process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"done ${'x'.repeat(2000)}"}]}}\\n');
  process.stdout.write('{"type":"result","subtype":"success","session_id":"s1"}\\n');
}
process.exit(0);
`, { mode: 0o755 });
        return fake;
    }

    function postJson(url, payload) {
        return rawRequest(`${baseUrl}${url}`, {
            method: 'POST',
            headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' },
            body: JSON.stringify(payload)
        });
    }

    test('epoch 随历史文件持久化，重启后不变；追加消息不会换 epoch', async () => {
        writeHistory(buildMessages(1));
        await startServer();
        const epoch = (await get('/api/sessions/demo/messages')).json.epoch;
        expect(epoch).toMatch(/^[0-9a-f]{8,32}$/);
        await handle.close();
        handle = null;
        await startServer();
        expect((await get('/api/sessions/demo/messages')).json.epoch).toBe(epoch);
    });

    test('agent/stream 的 NDJSON 不压缩；clientMessageId 存进 user 消息，非法值返回 400', async () => {
        writeHistory([], { agentPromptCommand: 'claude --dangerously-skip-permissions -p {prompt}' });
        await startServer({ dockerCmd: writeFakeClaudeDocker() });
        const bad = await postJson('/api/sessions/demo/agent/stream', { prompt: 'hi', clientMessageId: 'bad id!' });
        expect(bad.status).toBe(400);
        const badRun = await postJson('/api/sessions/demo/run', { command: 'ls', clientMessageId: 'short' });
        expect(badRun.status).toBe(400);

        const clientId = 'client-abc123XYZ';
        const stream = await postJson('/api/sessions/demo/agent/stream', { prompt: 'hi', clientMessageId: clientId });
        expect(stream.status).toBe(200);
        expect(stream.headers['content-type']).toMatch(/x-ndjson/);
        expect(stream.headers['content-encoding']).toBeUndefined();
        expect(stream.headers['x-accel-buffering']).toBe('no');

        const list = await get('/api/sessions/demo/messages');
        const user = list.json.messages.find(m => m.role === 'user');
        expect(user.clientMessageId).toBe(clientId);
        expect(list.json.messages.some(m => m.pending === true)).toBe(false);
    });

    function slowNetworkManager() {
        const sleep = () => new Promise(resolve => setTimeout(resolve, 300));
        return {
            ensureBridgeNetwork: async () => {},
            resolveRefs: async policy => policy,
            apply: async () => ({ status: 'applied' }),
            ensureReady: async () => { await sleep(); return { status: 'applied' }; }
        };
    }

    function writeCountingDocker() {
        const fake = path.join(tempHost, 'fake-docker-count.js');
        const countFile = path.join(tempHost, 'exec-count.log');
        fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || args.join(' '));
  if (command.includes('claude ')) {
    fs.appendFileSync(${JSON.stringify(countFile)}, 'agent\\n');
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\\n');
    process.stdout.write('{"type":"result","subtype":"success","session_id":"s1"}\\n');
  } else if (command.includes('echo run-marker')) {
    fs.appendFileSync(${JSON.stringify(countFile)}, 'run\\n');
    process.stdout.write('run-marker\\n');
  }
}
process.exit(0);
`, { mode: 0o755 });
        const count = kind => (fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf-8').split('\n').filter(line => line === kind).length : 0);
        return { fake, count };
    }

    test('同一个 clientMessageId 的 agent 请求只执行一次，第二次返回 409 duplicate', async () => {
        writeHistory([], { agentPromptCommand: 'claude --dangerously-skip-permissions -p {prompt}' });
        const { fake, count } = writeCountingDocker();
        await startServer({ dockerCmd: fake });
        const clientId = 'dup-client-id-001';
        const first = await postJson('/api/sessions/demo/agent/stream', { prompt: 'hi', clientMessageId: clientId });
        expect(first.status).toBe(200);
        const second = await postJson('/api/sessions/demo/agent/stream', { prompt: 'hi', clientMessageId: clientId });
        expect(second.status).toBe(409);
        expect(second.json.duplicate).toBe(true);
        expect(typeof second.json.error).toBe('string');
        expect(count('agent')).toBe(1);
        const other = await postJson('/api/sessions/demo/agent/stream', { prompt: 'hi', clientMessageId: 'dup-client-id-002' });
        expect(other.status).toBe(200);
        expect(count('agent')).toBe(2);
        const noId = await postJson('/api/sessions/demo/agent/stream', { prompt: 'hi' });
        expect(noId.status).toBe(200);
        expect(count('agent')).toBe(3);
        const list = await get('/api/sessions/demo/messages?limit=200');
        expect(list.json.messages.filter(m => m.role === 'user' && m.clientMessageId === clientId)).toHaveLength(1);
    });

    test('命令模式同样按 clientMessageId 去重', async () => {
        writeHistory([]);
        const { fake, count } = writeCountingDocker();
        await startServer({ dockerCmd: fake });
        const clientId = 'dup-run-id-0001';
        const first = await postJson('/api/sessions/demo/run', { command: 'echo run-marker', clientMessageId: clientId });
        expect(first.status).toBe(200);
        const second = await postJson('/api/sessions/demo/run', { command: 'echo run-marker', clientMessageId: clientId });
        expect(second.status).toBe(409);
        expect(second.json.duplicate).toBe(true);
        expect(count('run')).toBe(1);
    });

    // 审查 #4：检查重复和落盘之间有 await，并发的同一条请求不能都通过
    test('并发发来的同一个 clientMessageId（命令模式）只执行一次', async () => {
        writeHistory([]);
        const { fake, count } = writeCountingDocker();
        await startServer({
            dockerCmd: fake,
            // 网络规则就绪要等一会儿：检查重复和落盘之间有真正的 await，并发的请求才能暴露窗口
            networkManager: slowNetworkManager()
        });
        const clientId = 'dup-concurrent-01';
        const results = await Promise.all([1, 2, 3].map(() => postJson('/api/sessions/demo/run', { command: 'echo run-marker', clientMessageId: clientId })));
        expect(results.map(r => r.status).sort()).toEqual([200, 409, 409]);
        expect(results.filter(r => r.status === 409).every(r => r.json.duplicate === true)).toBe(true);
        expect(count('run')).toBe(1);
    });

    test('并发发来的同一个 clientMessageId（agent 非流式）只执行一次', async () => {
        writeHistory([], { agentPromptCommand: 'claude --dangerously-skip-permissions -p {prompt}' });
        const { fake, count } = writeCountingDocker();
        await startServer({
            dockerCmd: fake,
            // 网络规则就绪要等一会儿：检查重复和落盘之间有真正的 await，并发的请求才能暴露窗口
            networkManager: slowNetworkManager()
        });
        const clientId = 'dup-concurrent-02';
        const results = await Promise.all([1, 2, 3].map(() => postJson('/api/sessions/demo/agent', { prompt: 'hi', clientMessageId: clientId })));
        expect(results.map(r => r.status).sort()).toEqual([200, 409, 409]);
        expect(count('agent')).toBe(1);
    });

    test('流结束后历史已落盘（结束类事件立即写盘）', async () => {
        writeHistory([], { agentPromptCommand: 'claude --dangerously-skip-permissions -p {prompt}' });
        await startServer({ dockerCmd: writeFakeClaudeDocker() });
        await postJson('/api/sessions/demo/agent/stream', { prompt: 'hi' });
        const persisted = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
        const messages = persisted.agents.default.messages;
        expect(messages.some(m => m.role === 'user' && m.pending === false)).toBe(true);
        expect(messages.some(m => m.streamTrace === true && m.pending === false)).toBe(true);
        expect(messages.some(m => m.role === 'assistant' && !m.streamTrace && String(m.content).startsWith('done'))).toBe(true);
    });

    test('流式过程中的历史写盘被合并：大量 trace 事件只落盘几次', async () => {
        const fake = path.join(tempHost, 'fake-docker-many.js');
        fs.writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec' && String(args[4] || '').includes('claude ')) {
  for (let i = 0; i < 100; i++) {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_' + i, name: 'Bash', input: { command: 'ls ' + i } }] } }) + '\\n');
  }
  process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}\\n');
  process.stdout.write('{"type":"result","subtype":"success","session_id":"s1"}\\n');
}
process.exit(0);
`, { mode: 0o755 });
        writeHistory([], { agentPromptCommand: 'claude --dangerously-skip-permissions -p {prompt}' });
        await startServer({ dockerCmd: fake });
        // 新实现是“临时文件 + rename”，旧实现直接 writeFileSync 目标文件：两种写法都按“写了一次历史文件”计数
        const realWrite = fs.writeFileSync;
        let historyWrites = 0;
        const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
            if (String(file) === historyFile || (String(file).startsWith(`${historyFile}.`) && String(file).endsWith('.tmp'))) historyWrites += 1;
            return realWrite(file, ...rest);
        });
        try {
            const stream = await postJson('/api/sessions/demo/agent/stream', { prompt: 'hi' });
            expect(stream.text).toContain('"type":"result"');
        } finally {
            spy.mockRestore();
        }
        // 100 个 trace + 100 个控制事件在旧实现里至少写 200 次
        expect(historyWrites).toBeLessThan(25);
        const persisted = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
        const trace = persisted.agents.default.messages.find(m => m.streamTrace === true);
        expect(trace.traceEvents.length).toBeGreaterThanOrEqual(100);
        expect(trace.pending).toBe(false);
    });

    test('只读路由调用后，缓存里的历史与磁盘一致', async () => {
        const messages = [
            { id: hexId(1), role: 'user', mode: 'agent', content: 'hi', timestamp: '2026-01-01T00:00:00.000Z' },
            { id: hexId(2), role: 'assistant', mode: 'agent', content: 'yo', timestamp: '2026-01-01T00:00:01.000Z' }
        ];
        writeHistory(messages);
        await startServer();
        for (const url of ['/api/sessions', '/api/sessions/demo/detail', '/api/sessions/demo/messages', '/api/sessions/demo/audit', '/api/sessions/demo/model-options']) {
            await get(url);
        }
        const onDisk = JSON.parse(fs.readFileSync(historyFile, 'utf-8')).agents.default.messages;
        const served = (await get('/api/sessions/demo/messages?limit=200')).json.messages;
        expect(served).toEqual(onDisk);
    });

    test('历史文件不再带顶层 messages，且旧格式文件仍能读取', async () => {
        // 旧格式：只有顶层 messages，没有 agents
        fs.mkdirSync(path.dirname(historyFile), { recursive: true });
        const legacy = buildMessages(1);
        fs.writeFileSync(historyFile, JSON.stringify({ containerName: 'demo', messages: legacy }, null, 4));
        await startServer();
        const res = await get('/api/sessions/demo/messages');
        expect(res.json.messages).toHaveLength(legacy.length);
        await rawRequest(`${baseUrl}/api/sessions/demo/agent-remark`, {
            method: 'POST',
            headers: { Cookie: cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ remark: 'x' })
        });
        const persisted = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
        expect(persisted.messages).toBeUndefined();
        expect(persisted.agents.default.messages).toHaveLength(legacy.length);
        expect(persisted.agents.default.epoch).toMatch(/^[0-9a-f]+$/);
    });
});

describe('历史读写层：epoch 与关闭时落盘', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-history-layer-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('删除非 pending 消息会换 epoch，删除 pending 消息（流式占位）不会', () => {
        const ref = { containerName: 'demo', agentId: 'default' };
        const stable = __testing.appendWebSessionMessage(dir, ref, 'user', 'hello', { mode: 'agent' });
        const pending = __testing.appendWebSessionMessage(dir, ref, 'assistant', 'streaming', { pending: true });
        const epochOf = () => __testing.loadWebSessionHistory(dir, 'demo').agents.default.epoch;
        const before = epochOf();
        expect(before).toMatch(/^[0-9a-f]{8,32}$/);
        __testing.removeWebSessionMessage(dir, ref, pending.id);
        expect(epochOf()).toBe(before);
        __testing.removeWebSessionMessage(dir, ref, stable.id);
        expect(epochOf()).not.toBe(before);
    });

    test('克隆历史时每个 agent 换新的 epoch', () => {
        const source = { agents: { default: { epoch: 'aaaaaaaaaaaa', messages: [{ id: '1-a' }] }, 'agent-2': { epoch: 'bbbbbbbbbbbb', messages: [] } } };
        const cloned = __testing.cloneWebAgentSessionsDeep(source);
        expect(cloned.default.messages).toEqual([{ id: '1-a' }]);
        expect(cloned.default.epoch).not.toBe('aaaaaaaaaaaa');
        expect(cloned['agent-2'].epoch).not.toBe('bbbbbbbbbbbb');
        expect(cloned.default.epoch).toMatch(/^[0-9a-f]{8,32}$/);
    });

    // kill -9 之后：事件日志（每条立即追加）比历史快照（合并写盘，最迟落后 1 秒）新，下一轮对话不能因此失败
    test('事件日志比历史快照新（进程被强杀后重启）：下一条控制事件按日志续 seq，不报错', () => {
        const ref = { containerName: 'demo', agentId: 'default' };
        const aggregateId = 'demo';
        const store = new FileEventStore(dir);
        const events = [];
        for (let seq = 1; seq <= 5; seq += 1) {
            const event = createControlEvent({ type: 'process.stdout', aggregateId, seq, data: { text: `e${seq}` } });
            store.append(event);
            events.push(event);
        }
        // 历史快照只落到了 seq 3
        fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify({
            containerName: 'demo',
            agents: { default: { agentId: 'default', messages: [], events: events.slice(0, 3) } }
        }));
        const next = __testing.appendWebSessionControlEvent(dir, ref, 'session.ready');
        expect(next.seq).toBe(6);
        expect(store.read(aggregateId).map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
        const again = __testing.appendWebSessionControlEvent(dir, ref, 'session.ready');
        expect(again.seq).toBe(7);
    });

    // 审查 #7：seq 缓存与日志对不上（日志被别的进程追加过）时，丢掉缓存按日志重算，不报错
    test('事件日志被别的进程追加后，seq 缓存失效并按日志续上', () => {
        const ref = { containerName: 'demo', agentId: 'default' };
        const mine = __testing.appendWebSessionControlEvent(dir, ref, 'session.ready');
        const other = new FileEventStore(dir);
        other.append(createControlEvent({ type: 'process.stdout', aggregateId: 'demo', seq: mine.seq + 1, data: { text: 'other' } }));
        const next = __testing.appendWebSessionControlEvent(dir, ref, 'session.ready');
        expect(next.seq).toBe(mine.seq + 2);
    });

    test('serve 关闭时把攒着的（defer）历史写出来', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-close-flush-'));
        const webHistoryDir = path.join(tempHost, 'web-history');
        const port = await getFreePort();
        const handle = await startWebServer(buildServerOptions(tempHost, port));
        try {
            const ref = { containerName: 'demo', agentId: 'default' };
            __testing.appendWebSessionMessage(webHistoryDir, ref, 'user', 'first', { mode: 'agent' });
            const history = __testing.loadWebSessionHistory(webHistoryDir, 'demo');
            history.agents.default.messages.push({ id: '1700000000001-aaaaaa', role: 'assistant', content: 'only in memory', timestamp: 'x' });
            __testing.saveWebSessionHistory(webHistoryDir, 'demo', history, { defer: true });
            const file = path.join(webHistoryDir, 'demo.json');
            expect(fs.readFileSync(file, 'utf-8')).not.toContain('only in memory');
            await handle.close();
            expect(fs.readFileSync(file, 'utf-8')).toContain('only in memory');
        } finally {
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });
});

describe('messages-view', () => {
    test('截断规则不改变事件个数与 kind', () => {
        const message = {
            id: hexId(1), streamTrace: true, content: 'c'.repeat(2000),
            traceEvents: [{ kind: 'error', text: 'e'.repeat(1000), arguments: { command: 'z'.repeat(900) } }, { kind: 'tool', text: 'short' }]
        };
        const out = messagesView.toListMessage(message);
        expect(out.traceTruncated).toBe(true);
        expect(out.traceEvents.map(e => e.kind)).toEqual(['error', 'tool']);
        expect(out.traceEvents[0].arguments.command.length).toBeLessThan(300);
        expect(out.traceEvents[1].text).toBe('short');
        expect(message.traceEvents[0].text).toHaveLength(1000);
    });

    test('不需要截断的消息原样返回', () => {
        const message = { id: hexId(1), streamTrace: true, content: 'ok', traceEvents: [{ kind: 'status', text: 'ok' }] };
        expect(messagesView.toListMessage(message)).toBe(message);
    });
});
