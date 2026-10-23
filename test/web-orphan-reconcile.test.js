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

async function waitFor(fn, timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const value = await fn();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('waitFor timeout');
}

// 查询容器里活着的运行（/bin/sh -c）：liveFile 存在时输出一个运行 id，删掉该文件就代表跑完了
function writeFakeDocker(tempHost) {
    const file = path.join(tempHost, 'fake-docker.js');
    fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'exec' && args.includes('/bin/sh')) {
  if (fs.existsSync(${JSON.stringify(path.join(tempHost, 'live'))})) process.stdout.write('11111111-2222-3333-4444-555555555555\\n');
}
process.exit(0);
`);
    fs.chmodSync(file, 0o755);
    return file;
}

function pendingHistory(containerName) {
    return {
        containerName,
        updatedAt: null,
        agentPromptCommand: 'codex exec --skip-git-repo-check {prompt}',
        agents: {
            default: {
                agentId: 'default',
                messages: [
                    { id: 'u0', role: 'user', content: '旧问题', timestamp: '2026-01-01T00:00:00Z', mode: 'agent' },
                    { id: 'a0', role: 'assistant', content: '旧回复', timestamp: '2026-01-01T00:00:01Z', mode: 'agent' },
                    { id: 'u1', role: 'user', content: '长任务', timestamp: '2026-01-01T00:01:00Z', mode: 'agent', pending: true },
                    { id: 't1', role: 'assistant', content: '[执行过程]\n跑着', timestamp: '2026-01-01T00:01:01Z', mode: 'agent', streamTrace: true, pending: true, traceEvents: [] },
                    { id: 's1', role: 'assistant', content: '写到一半', timestamp: '2026-01-01T00:01:02Z', mode: 'agent', streamingReply: true, pending: true }
                ]
            }
        }
    };
}

async function withServer({ live = false, extraHistory = {}, serverOverrides = {} } = {}, fn) {
    const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-orphan-'));
    const histDir = path.join(tempHost, 'web-history');
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(path.join(histDir, 'demo.json'), JSON.stringify(pendingHistory('demo')));
    for (const [name, text] of Object.entries(extraHistory)) fs.writeFileSync(path.join(histDir, `${name}.json`), text);
    if (live) fs.writeFileSync(path.join(tempHost, 'live'), '1');
    const port = await getFreePort();
    let handle = null;
    try {
        handle = await startWebServer({
            serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: 'topsecret', authPassAuto: false,
            dockerCmd: writeFakeDocker(tempHost),
            networkManager: { ensureBridgeNetwork: async () => {}, resolveRefs: async p => p, apply: async () => ({}), ensureReady: async () => ({}) },
            hostPath: tempHost, homeDir: tempHost, containerPath: '/workspace', imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common',
            execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
            validateHostPath: () => {}, formatDate: () => '0101-0000',
            isValidContainerName: v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v),
            containerExists: () => true, getContainerStatus: () => 'running', waitForContainerReady: async () => {}, dockerExecArgs: () => '',
            showImagePullHint: () => {}, removeContainer: () => {},
            webHistoryDir: histDir, webConfigPath: path.join(tempHost, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' }, orphanPollMs: 100,
            ...serverOverrides
        });
        const baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ username: 'webadmin', password: 'topsecret' }) });
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const messages = async () => (await (await fetch(`${baseUrl}/api/sessions/demo/messages`, { headers: { Cookie: cookie } })).json());
        await fn({ messages, tempHost, histDir });
    } finally {
        if (handle && handle.close) await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
    }
}

const findNote = (msgs, text) => msgs.find(m => m.role === 'assistant' && !m.streamTrace && String(m.content).includes(text));

describe('serve 启动对账', () => {
    test('容器里没有活着的运行：pending 变已中断，执行过程补一行，回复写一句说明', async () => {
        await withServer({}, async ({ messages }) => {
            const view = await waitFor(async () => {
                const m = await messages();
                return m.messages.every(x => x.pending !== true) ? m : null;
            });
            expect(view.messages.every(m => m.pending !== true)).toBe(true);
            expect(view.messages.find(m => m.id === 'u1').interrupted).toBe(true);
            expect(view.messages.find(m => m.id === 't1').content).toContain('[任务] 服务重启，本轮已中断');
            const reply = view.messages.find(m => m.id === 's1');
            expect(reply.content).toContain('写到一半');
            expect(reply.content).toContain('服务重启时这一轮被中断了。可以发送“继续”让它接着做。');
            // 之前已完成的消息不动
            expect(view.messages.find(m => m.id === 'a0').interrupted).toBeUndefined();
        });
    });

    test('容器没在运行：同样标成已中断', async () => {
        await withServer({ serverOverrides: { getContainerStatus: () => 'exited' } }, async ({ messages }) => {
            const view = await waitFor(async () => {
                const m = await messages();
                return m.messages.every(x => x.pending !== true) ? m : null;
            });
            expect(findNote(view.messages, '被中断了')).toBeDefined();
        });
    });

    test('容器里还有活着的运行：先保持 pending，等它们结束后再标记，文案改成“后台跑完”', async () => {
        await withServer({ live: true }, async ({ messages, tempHost }) => {
            await new Promise(resolve => setTimeout(resolve, 400));
            const during = await messages();
            expect(during.messages.some(m => m.pending === true)).toBe(true);
            fs.rmSync(path.join(tempHost, 'live'));
            const view = await waitFor(async () => {
                const m = await messages();
                return m.messages.every(x => x.pending !== true) ? m : null;
            });
            expect(view.messages.find(m => m.id === 't1').content).toContain('服务重启，本轮在后台跑完，结果未接收');
            expect(view.messages.find(m => m.id === 's1').content).toContain('后台跑完了，但结果没能接收');
        });
    });

    test('没有流式半截回复时新建一条说明', async () => {
        await withServer({}, async ({ messages, histDir }) => {
            await waitFor(async () => (await messages()).messages.every(x => x.pending !== true));
            // 二次启动不再有 pending：不重复写说明
            const view = await messages();
            const notes = view.messages.filter(m => String(m.content).includes('被中断了'));
            expect(notes).toHaveLength(1);
            expect(fs.existsSync(histDir)).toBe(true);
        });
    });

    test('其它会话的历史文件损坏：跳过，不影响这个会话的对账', async () => {
        await withServer({ extraHistory: { broken: '{not json' } }, async ({ messages }) => {
            const view = await waitFor(async () => {
                const m = await messages();
                return m.messages.every(x => x.pending !== true) ? m : null;
            });
            expect(view.messages.find(m => m.id === 'u1').interrupted).toBe(true);
        });
    });
});
