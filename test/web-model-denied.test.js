'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { startWebServer } = require('../lib/web/server');
const containerState = require('../lib/container-state');
const { normalizePolicy } = require('../lib/network-policy');
const { egressPaths } = require('../lib/egress-sidecar');

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
    return { events };
}

// 长任务：5 秒才结束；收到 SIGTERM 退出 143；kill 用的 /bin/sh exec 立刻返回
function writeFakeDocker(tempHost) {
    const file = path.join(tempHost, 'fake-docker.js');
    fs.writeFileSync(file, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec' && args.includes('/bin/sh')) process.exit(0);
if (args[0] === 'exec' && args.includes('/bin/bash')) {
  process.stdout.write('{"type":"thread.started","thread_id":"t-1"}\\n');
  const timer = setTimeout(() => { process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"正常完成"}}\\n'); process.exit(0); }, 5000);
  process.on('SIGTERM', () => { clearTimeout(timer); process.exit(143); });
  return;
}
process.exit(0);
`);
    fs.chmodSync(file, 0o755);
    return file;
}

async function withServer({ envLines, deniedHost }, fn) {
    const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-model-denied-'));
    const port = await getFreePort();
    const stateInfo = containerState.createState({
        homeDir: tempHost,
        envLines,
        network: normalizePolicy({ preset: 'allowlist', outbound: [{ action: 'allow', target: 'ok.example.com', ports: '', proto: 'all', enabled: true }] }),
        meta: { name: 'demo' }
    });
    const histDir = path.join(tempHost, 'web-history');
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(path.join(histDir, 'demo.json'), JSON.stringify({
        containerName: 'demo', updatedAt: null, messages: [],
        agentPromptCommand: 'codex exec --skip-git-repo-check {prompt}'
    }));
    let handle = null;
    try {
        handle = await startWebServer({
            serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: 'topsecret', authPassAuto: false,
            dockerCmd: writeFakeDocker(tempHost),
            networkManager: { ensureBridgeNetwork: async () => {}, resolveRefs: async p => p, apply: async () => ({ status: 'applied' }), ensureReady: async () => ({ status: 'applied' }) },
            hostPath: tempHost, homeDir: tempHost, containerPath: '/workspace',
            imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common',
            execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
            validateHostPath: () => {}, formatDate: () => '0101-0000',
            isValidContainerName: value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value),
            containerExists: () => true, getContainerStatus: () => 'running', waitForContainerReady: async () => {},
            dockerExecArgs: args => (args[0] === 'inspect' ? `${stateInfo.id}\n` : ''),
            showImagePullHint: () => {}, removeContainer: () => {},
            webHistoryDir: histDir, webConfigPath: path.join(tempHost, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' }, agentStopGraceMs: 100
        });
        const baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await request(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'webadmin', password: 'topsecret' }) });
        const cookie = login.response.headers.get('set-cookie').split(';')[0];
        const writeDenied = host => {
            const dir = egressPaths(tempHost).denied;
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${stateInfo.id}.jsonl`), `${JSON.stringify({ host, port: 443, reason: 'not-allowed', count: 1, first: '2026-01-01T00:00:00Z', last: '2026-01-01T00:00:00Z' })}\n`);
        };
        const stream = onEvent => readNdjson(`${baseUrl}/api/sessions/demo/agent/stream`, {
            method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: 'HELLO', clientMessageId: 'first-msg-0001' })
        }, onEvent);
        const messages = async () => (await request(`${baseUrl}/api/sessions/demo/messages`, { headers: { Cookie: cookie } })).json;
        await fn({ stream, writeDenied, messages, deniedHost });
    } finally {
        if (handle && handle.close) await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
    }
}

describe('模型域名被网络策略拦截', () => {
    test('被拦的是配置的模型域名：发 network_denied、尽早中止、回复带 networkDenied、不暂停队列', async () => {
        await withServer({ envLines: ['OPENAI_BASE_URL=https://blocked-model.example.com/v1'] }, async ({ stream, writeDenied, messages }) => {
            const started = Date.now();
            let written = false;
            const { events } = await stream(async event => {
                if (event.type === 'meta' && !written) { written = true; writeDenied('blocked-model.example.com'); }
            });
            expect(Date.now() - started).toBeLessThan(4800);
            expect(events.find(e => e.type === 'network_denied')).toEqual(expect.objectContaining({ type: 'network_denied', host: 'blocked-model.example.com', model: true }));
            const result = events.find(e => e.type === 'result');
            expect(result.interrupted).toBe(true);
            expect(result.networkDenied).toEqual({ host: 'blocked-model.example.com', model: true });
            const view = await messages();
            const reply = view.messages.filter(m => m.role === 'assistant' && !m.streamTrace).pop();
            expect(reply.networkDenied).toEqual({ host: 'blocked-model.example.com', model: true });
            expect(reply.content).toContain('blocked-model.example.com');
            expect(view.messages.every(m => m.pending !== true)).toBe(true);
            expect(view.queuePaused).toBeFalsy();
            const trace = view.messages.find(m => m.streamTrace);
            expect(trace.content).toContain('已中止：模型地址被网络策略拦截');
        });
    }, 20000);

    test('没配 BASE_URL 时，官方默认域名也算模型域名', async () => {
        await withServer({ envLines: ['OPENAI_API_KEY=sk-x'] }, async ({ stream, writeDenied }) => {
            let written = false;
            const { events } = await stream(async event => {
                if (event.type === 'meta' && !written) { written = true; writeDenied('api.openai.com'); }
            });
            expect(events.find(e => e.type === 'network_denied')).toEqual(expect.objectContaining({ host: 'api.openai.com', model: true }));
        });
    }, 20000);

    test('被拦的不是模型域名：只进执行过程，本轮不中止', async () => {
        await withServer({ envLines: ['OPENAI_BASE_URL=https://blocked-model.example.com/v1'] }, async ({ stream, writeDenied, messages }) => {
            let written = false;
            const { events } = await stream(async event => {
                if (event.type === 'meta' && !written) { written = true; writeDenied('other.example.com'); }
            });
            expect(events.find(e => e.type === 'network_denied')).toBeUndefined();
            expect(events.some(e => e.type === 'trace' && /other\.example\.com/.test(e.text || ''))).toBe(true);
            const result = events.find(e => e.type === 'result');
            expect(result.interrupted).toBe(false);
            const reply = (await messages()).messages.filter(m => m.role === 'assistant' && !m.streamTrace).pop();
            expect(reply.networkDenied).toBeUndefined();
        });
    }, 20000);

    test('env 里别的 URL（npm 源）被拦：不是模型地址，本轮不中止', async () => {
        await withServer({ envLines: ['OPENAI_BASE_URL=https://blocked-model.example.com/v1', 'NPM_CONFIG_REGISTRY=https://registry.npmmirror.com'] }, async ({ stream, writeDenied }) => {
            let written = false;
            const { events } = await stream(async event => {
                if (event.type === 'meta' && !written) { written = true; writeDenied('registry.npmmirror.com'); }
            });
            expect(events.find(e => e.type === 'network_denied')).toBeUndefined();
            expect(events.find(e => e.type === 'result').interrupted).toBe(false);
        });
    }, 20000);
});
