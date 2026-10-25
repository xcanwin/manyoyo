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

async function request(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const merged = Object.assign({}, options);
    if (method !== 'GET' && method !== 'HEAD') {
        merged.headers = Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, options.headers || {});
    }
    const response = await fetch(url, merged);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { response, text, json };
}

async function readNdjson(url, options, onEvent) {
    const response = await fetch(url, Object.assign({}, options, {
        headers: Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, options.headers || {})
    }));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let pending = '';
    while (true) {
        const part = await reader.read();
        if (part.done) break;
        pending += decoder.decode(part.value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim()) continue;
            const payload = JSON.parse(line);
            events.push(payload);
            if (onEvent) await onEvent(payload);
        }
    }
    return { response, events };
}

function buildOptions(tempHost, port, overrides = {}) {
    return {
        serverHost: '127.0.0.1',
        serverPort: port,
        authUser: 'webadmin',
        authPass: 'topsecret',
        authPassAuto: false,
        // 这些用例按“最后一次 exec 就是 Agent 那一轮”来断言，自动标题的轻量调用会混进来
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
        agentStopGraceMs: 100,
        ...overrides
    };
}

async function waitFor(fn, timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const value = await fn();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('waitFor timeout');
}

// 第一次 exec 是长任务（5 秒，收到 SIGTERM 退出 143；withTool 时 0.3 秒后先完成一次工具调用），之后的 exec 立刻结束
function writeFakeDocker(tempHost, { withTool = false, firstMs = 5000, exitZeroOnTerm = false } = {}) {
    const file = path.join(tempHost, 'fake-docker.js');
    fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'exec' && args.includes('/bin/sh')) {
  // 停止 / 打断时进容器发信号的 exec：exitZeroOnTerm 时模拟真实 claude 收到 SIGINT 后正常收尾、退出码 0
  if (${exitZeroOnTerm}) { try { process.kill(Number(fs.readFileSync(${JSON.stringify(path.join(tempHost, 'long.pid'))}, 'utf8')), 'SIGUSR1'); } catch (e) {} }
  process.exit(0);
}
if (args[0] === 'exec' && args.includes('/bin/bash')) {
  const counter = ${JSON.stringify(path.join(tempHost, 'count'))};
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(n + 1));
  fs.appendFileSync(${JSON.stringify(path.join(tempHost, 'prompts.log'))}, args[args.length - 1].slice(-300) + '\\n---\\n');
  process.stdout.write('{"type":"thread.started","thread_id":"t-1"}\\n');
  if (n > 0) {
    process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"二轮完成"}}\\n');
    process.exit(0);
  }
  process.stdout.write('{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"long","status":"in_progress"}}\\n');
  if (${withTool}) setTimeout(() => process.stdout.write('{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"long","status":"completed","aggregated_output":"x","exit_code":0}}\\n'), 300);
  const timer = setTimeout(() => { process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"一轮完成"}}\\n'); process.exit(0); }, ${firstMs});
  fs.writeFileSync(${JSON.stringify(path.join(tempHost, 'long.pid'))}, String(process.pid));
  process.on('SIGUSR1', () => { clearTimeout(timer); process.exit(0); });
  process.on('SIGTERM', () => { clearTimeout(timer); process.exit(${exitZeroOnTerm ? 0 : 143}); });
  return;
}
process.exit(0);
`);
    fs.chmodSync(file, 0o755);
    return file;
}

function writeHistory(tempHost) {
    const dir = path.join(tempHost, 'web-history');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify({
        containerName: 'demo', updatedAt: null, messages: [],
        agentPromptCommand: 'codex exec --skip-git-repo-check {prompt}'
    }));
}

async function withServer(opts, fn) {
    const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-queue-'));
    const port = await getFreePort();
    writeHistory(tempHost);
    const dockerCmd = writeFakeDocker(tempHost, opts);
    let handle = null;
    try {
        handle = await startWebServer(buildOptions(tempHost, port, { dockerCmd, ...(opts.server || {}) }));
        const baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await request(`${baseUrl}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'webadmin', password: 'topsecret' })
        });
        const cookie = login.response.headers.get('set-cookie').split(';')[0];
        const call = (method, p, body) => request(`${baseUrl}${p}`, {
            method,
            headers: { Cookie: cookie, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        const messages = async () => (await call('GET', '/api/sessions/demo/messages')).json;
        const startFirst = (onEvent) => readNdjson(`${baseUrl}/api/sessions/demo/agent/stream`, {
            method: 'POST',
            headers: { Cookie: cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: 'FIRST', clientMessageId: 'first-msg-0001' })
        }, onEvent);
        try { await fn({ baseUrl, cookie, call, messages, startFirst, tempHost }); } finally { if (process.env.Q_DEBUG) console.error(fs.existsSync(path.join(tempHost, 'prompts.log')) ? fs.readFileSync(path.join(tempHost, 'prompts.log'), 'utf8') : 'none'); }
    } finally {
        if (handle && handle.close) await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
    }
}

const userTexts = msgs => msgs.filter(m => m.role === 'user').map(m => m.content);

describe('Web agent queue', () => {
    test('未登录 401', async () => {
        await withServer({}, async ({ baseUrl }) => {
            const res = await request(`${baseUrl}/api/sessions/demo/agent/queue`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            });
            expect(res.response.status).toBe(401);
            const del = await request(`${baseUrl}/api/sessions/demo/agent/queue/q-1`, { method: 'DELETE' });
            expect(del.response.status).toBe(401);
        });
    });

    test('入队：校验、幂等、上限、取消，/messages 带队列', async () => {
        await withServer({}, async ({ call, messages, startFirst }) => {
            let stopped = false;
            const stream = startFirst(async event => {
                if (event.type !== 'meta' || stopped) return;
                stopped = true;
                expect((await call('POST', '/api/sessions/demo/agent/queue', { prompt: '' })).response.status).toBe(400);
                expect((await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'x', when: 'later' })).response.status).toBe(400);
                const first = await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'Q1', when: 'turn', clientMessageId: 'queue-msg-0001' });
                expect(first.response.status).toBe(200);
                const again = await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'Q1', when: 'turn', clientMessageId: 'queue-msg-0001' });
                expect(again.json.duplicate).toBe(true);
                expect(again.json.queue).toHaveLength(1);
                expect((await messages()).queue.map(item => item.text)).toEqual(['Q1']);
                expect((await call('DELETE', `/api/sessions/demo/agent/queue/${first.json.item.id}`)).response.status).toBe(200);
                expect((await call('DELETE', `/api/sessions/demo/agent/queue/${first.json.item.id}`)).response.status).toBe(404);
                for (let i = 0; i < 10; i += 1) {
                    expect((await call('POST', '/api/sessions/demo/agent/queue', { prompt: `F${i}`, when: 'turn' })).response.status).toBe(200);
                }
                const full = await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'F10', when: 'turn' });
                expect(full.response.status).toBe(409);
                expect(full.json.full).toBe(true);
                // 清掉，让这一轮正常结束时不再接着发
                for (const item of (await messages()).queue) {
                    await call('DELETE', `/api/sessions/demo/agent/queue/${item.id}`);
                }
                await call('POST', '/api/sessions/demo/agent/stop', {});
            });
            await stream;
            expect((await messages()).queue).toEqual([]);
        });
    });

    test('turn：这一轮结束后自动发，流里收到 queue_next，用户消息沿用 clientMessageId', async () => {
        await withServer({ firstMs: 800 }, async ({ call, messages, startFirst }) => {
            let queued = false;
            const { events } = await startFirst(async event => {
                if (event.type === 'meta' && !queued) {
                    queued = true;
                    const r = await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'SECOND', when: 'turn', clientMessageId: 'queue-msg-0002' }); if (process.env.Q_DEBUG) console.error(r.response.status, r.text);
                }
            });
            expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['result', 'queue_next']));
            expect(events.findIndex(e => e.type === 'queue_next')).toBeGreaterThan(events.findIndex(e => e.type === 'result'));
            const view = await waitFor(async () => {
                const m = await messages();
                return userTexts(m.messages).length === 2 && m.messages.every(x => x.pending !== true) ? m : null;
            });
            expect(userTexts(view.messages)).toEqual(['FIRST', 'SECOND']);
            expect(view.messages.find(m => m.content === 'SECOND').clientMessageId).toBe('queue-msg-0002');
            expect(view.queue).toEqual([]);
        });
    }, 20000);

    test('now：立即打断，第一轮标已打断，新提示词接着执行（只执行一次）', async () => {
        await withServer({}, async ({ call, messages, startFirst }) => {
            let queued = false;
            const { events } = await startFirst(async event => {
                if (event.type === 'meta' && !queued) {
                    queued = true;
                    const res = await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'STEER', when: 'now', clientMessageId: 'queue-msg-0003' });
                    expect(res.response.status).toBe(200);
                    await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'STEER', when: 'now', clientMessageId: 'queue-msg-0003' });
                }
            });
            expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'result', interrupted: true })]));
            const view = await waitFor(async () => {
                const m = await messages();
                return userTexts(m.messages).length === 2 && m.messages.every(x => x.pending !== true) ? m : null;
            });
            expect(userTexts(view.messages)).toEqual(['FIRST', 'STEER']);
            const firstTrace = view.messages.find(m => m.streamTrace === true);
            expect(firstTrace.content).toContain('已打断，继续执行新的提示词');
        });
    }, 20000);

    test('用户停止：不自动发，队列保留，继续发送后才执行', async () => {
        await withServer({}, async ({ call, messages, startFirst }) => {
            let queued = false;
            const { events } = await startFirst(async event => {
                if (event.type === 'meta' && !queued) {
                    queued = true;
                    await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'KEEP', when: 'turn', clientMessageId: 'queue-msg-0004' });
                    await call('POST', '/api/sessions/demo/agent/stop', {});
                }
            });
            expect(events.map(e => e.type)).not.toContain('queue_next');
            await new Promise(resolve => setTimeout(resolve, 500));
            const kept = await messages();
            expect(kept.queue.map(item => item.text)).toEqual(['KEEP']);
            expect(userTexts(kept.messages)).toEqual(['FIRST']);
            expect((await call('POST', '/api/sessions/demo/agent/queue/continue', {})).json.started).toBe(true);
            const view = await waitFor(async () => {
                const m = await messages();
                return userTexts(m.messages).length === 2 && m.messages.every(x => x.pending !== true) ? m : null;
            });
            expect(view.queue).toEqual([]);
        });
    }, 20000);

    test('用户停止后再正常发一条：这一轮结束后，停止前留下的排队仍然不自动发（暂停要落盘，不只记在这一轮的内存里）', async () => {
        await withServer({}, async ({ call, messages, startFirst, baseUrl, cookie }) => {
            let queued = false;
            await startFirst(async event => {
                if (event.type === 'meta' && !queued) {
                    queued = true;
                    await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'KEEP', when: 'turn', clientMessageId: 'queue-msg-0010' });
                    await call('POST', '/api/sessions/demo/agent/stop', {});
                }
            });
            await new Promise(resolve => setTimeout(resolve, 300));
            const paused = await messages();
            expect(paused.queuePaused).toBe(true);
            const { events } = await readNdjson(`${baseUrl}/api/sessions/demo/agent/stream`, {
                method: 'POST',
                headers: { Cookie: cookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'SECOND', clientMessageId: 'second-msg-0010' })
            }, () => {});
            expect(events.map(e => e.type)).not.toContain('queue_next');
            await new Promise(resolve => setTimeout(resolve, 800));
            const view = await messages();
            expect(userTexts(view.messages)).toEqual(['FIRST', 'SECOND']);
            expect(view.queue.map(item => item.text)).toEqual(['KEEP']);
            expect(view.queuePaused).toBe(true);
            // 点“继续发送”才恢复，并清掉暂停
            expect((await call('POST', '/api/sessions/demo/agent/queue/continue', {})).json.started).toBe(true);
            const done = await waitFor(async () => {
                const m = await messages();
                return userTexts(m.messages).length === 3 && m.messages.every(x => x.pending !== true) ? m : null;
            });
            expect(done.queue).toEqual([]);
            expect(done.queuePaused).toBe(false);
        });
    }, 25000);

    test('step：等到下一个工具调用结束才打断', async () => {
        await withServer({ withTool: true }, async ({ call, messages, startFirst }) => {
            let queuedAt = 0;
            let interruptedAt = 0;
            const { events } = await startFirst(async event => {
                if (event.type === 'meta' && !queuedAt) {
                    queuedAt = Date.now();
                    await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'AFTERSTEP', when: 'step', clientMessageId: 'queue-msg-0005' });
                }
                if (event.type === 'result') interruptedAt = Date.now();
            });
            expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'result', interrupted: true })]));
            expect(interruptedAt - queuedAt).toBeGreaterThanOrEqual(250);
            expect(interruptedAt - queuedAt).toBeLessThan(4000);
            const view = await waitFor(async () => {
                const m = await messages();
                return userTexts(m.messages).length === 2 && m.messages.every(x => x.pending !== true) ? m : null;
            });
            expect(userTexts(view.messages)).toEqual(['FIRST', 'AFTERSTEP']);
        });
    }, 20000);

    test('step：等不到边界时超时退化成立即打断', async () => {
        await withServer({ server: { agentStepFallbackMs: 400 } }, async ({ call, messages, startFirst }) => {
            let queued = false;
            const { events } = await startFirst(async event => {
                if (event.type === 'meta' && !queued) {
                    queued = true;
                    await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'LATE', when: 'step', clientMessageId: 'queue-msg-0006' });
                }
            });
            expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'result', interrupted: true })]));
            const view = await waitFor(async () => {
                const m = await messages();
                return userTexts(m.messages).length === 2 && m.messages.every(x => x.pending !== true) ? m : null;
            });
            expect(userTexts(view.messages)).toEqual(['FIRST', 'LATE']);
        });
    }, 20000);

    test('没有运行中的任务时入队，立刻开始发送', async () => {
        await withServer({}, async ({ call, messages }) => {
            const res = await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'IDLE', when: 'turn', clientMessageId: 'queue-msg-0007' });
            expect(res.response.status).toBe(200);
            const view = await waitFor(async () => {
                const m = await messages();
                return userTexts(m.messages).length === 1 && m.messages.every(x => x.pending !== true) ? m : null;
            });
            expect(view.queue).toEqual([]);
            expect(userTexts(view.messages)).toEqual(['IDLE']);
        });
    }, 20000);

    test('now：真实 claude 收到 SIGINT 后退出码为 0，也要算被打断', async () => {
        await withServer({ exitZeroOnTerm: true }, async ({ call, messages, startFirst }) => {
            let queued = false;
            const { events } = await startFirst(async event => {
                if (event.type === 'meta' && !queued) {
                    queued = true;
                    await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'AFTER0', when: 'now', clientMessageId: 'queue-msg-0008' });
                }
            });
            expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'result', interrupted: true, exitCode: 0 })]));
            const view = await waitFor(async () => {
                const m = await messages();
                return userTexts(m.messages).length === 2 && m.messages.every(x => x.pending !== true) ? m : null;
            });
            expect(view.messages.find(m => m.streamTrace === true).content).toContain('已打断，继续执行新的提示词');
        });
    }, 20000);

    test('step 项在边界前被取消：不再打断正在跑的任务', async () => {
        await withServer({ withTool: true, firstMs: 1500 }, async ({ call, messages, startFirst }) => {
            let queued = false;
            const { events } = await startFirst(async event => {
                if (event.type === 'meta' && !queued) {
                    queued = true;
                    const res = await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'CANCELME', when: 'step', clientMessageId: 'queue-msg-0009' });
                    expect((await call('DELETE', `/api/sessions/demo/agent/queue/${res.json.item.id}`)).response.status).toBe(200);
                }
            });
            expect(events.find(e => e.type === 'result').interrupted).toBe(false);
            expect(events.map(e => e.type)).not.toContain('queue_next');
            expect(userTexts((await messages()).messages)).toEqual(['FIRST']);
        });
    }, 20000);

    test('排队中的 clientMessageId 也算收到过：直接走 /agent/stream 重发返回 409 duplicate', async () => {
        await withServer({}, async ({ baseUrl, cookie, call, startFirst }) => {
            let status = 0;
            let dup = null;
            await startFirst(async event => {
                if (event.type !== 'meta' || status) return;
                await call('POST', '/api/sessions/demo/agent/queue', { prompt: 'TWICE', when: 'turn', clientMessageId: 'queue-msg-0010' });
                const again = await request(`${baseUrl}/api/sessions/demo/agent/stream`, {
                    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: 'TWICE', clientMessageId: 'queue-msg-0010' })
                });
                status = again.response.status;
                dup = again.json;
                await call('POST', '/api/sessions/demo/agent/stop', {});
            });
            expect(status).toBe(409);
            expect(dup.duplicate).toBe(true);
        });
    }, 20000);
});
