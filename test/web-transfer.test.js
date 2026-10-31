'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const zlib = require('zlib');
const http = require('http');
const WebSocket = require('ws');
const { Readable, PassThrough } = require('stream');
const { startWebServer } = require('../lib/web/server');
const { readTarEntries } = require('../lib/archive/tar');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
        server.on('error', reject);
    });
}

async function request(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { ...(method !== 'GET' ? { 'X-Requested-With': 'XMLHttpRequest' } : {}), ...(options.headers || {}) };
    const response = await fetch(url, { ...options, headers });
    const buffer = Buffer.from(await response.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buffer.toString('utf8')); } catch (e) { json = null; }
    return { response, buffer, json, status: response.status };
}

const fakeNetworkManager = () => ({ ensureBridgeNetwork: async () => {}, resolveRefs: async p => p, apply: async () => ({}), ensureReady: async () => ({}) });

async function extract(buffer) {
    const raw = typeof zlib.zstdDecompressSync === 'function' && buffer.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])) ? zlib.zstdDecompressSync(buffer) : zlib.gunzipSync(buffer);
    const out = {};
    for await (const { meta, body } of readTarEntries(Readable.from([raw]))) {
        const parts = []; for await (const p of body) parts.push(p);
        out[meta.name] = Buffer.concat(parts).toString();
    }
    return out;
}

describe('网页导出 / 导入接口', () => {
    let home, handle, baseUrl, cookie, existing, execCalls, runtime, holdCp, fakeDockerLog, statfsFree, waitMs, runFailure, extraPs;
    const api = (method, route, body, headers = {}) => request(`${baseUrl}${route}`, { method, headers: { Cookie: cookie, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });

    // 轮询任务直到进入目标状态之一
    async function waitJob(jobId, states, timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const job = (await api('GET', `/api/jobs/${jobId}`)).json.job;
            if (states.includes(job.status)) return job;
            if (Date.now() > deadline) throw new Error(`任务 ${jobId} 停在 ${job.status}，没到 ${states.join('/')}`);
            await new Promise(r => setTimeout(r, 25));
        }
    }

    // 导出（直接下载）：POST → 等 ready → GET，返回下载响应
    async function exportDownload(body) {
        const created = await api('POST', '/api/exports', { output: 'download', ...body });
        expect(created.status).toBe(202);
        const job = await waitJob(created.json.jobId, ['ready']);
        const download = await api('GET', job.downloadUrl);
        return { created: created.json, job, download };
    }

    // 导出（保存到服务器）：POST → 等 done，返回 { jobId, file }
    async function exportToServer(body) {
        const created = await api('POST', '/api/exports', { output: 'server', ...body });
        expect(created.status).toBe(202);
        const job = await waitJob(created.json.jobId, ['done', 'failed']);
        expect(job.error).toBe('');
        return { jobId: created.json.jobId, file: job.result.file, job };
    }

    // 导入（上传）：先登记设置，再上传归档本身，最后等任务结束
    async function importUpload(buffer, plan) {
        const registered = await api('POST', '/api/imports/uploads', { plan });
        if (registered.status !== 200) return { registered };
        const uploaded = await api('POST', registered.json.uploadUrl, buffer, { 'Content-Type': 'application/octet-stream' });
        return { registered, uploaded, job: uploaded.json && uploaded.json.jobId ? await waitJob(uploaded.json.jobId, ['done', 'failed', 'cancelled']) : null };
    }

    function writeHistory(name, data) {
        fs.mkdirSync(path.join(home, 'web-history'), { recursive: true });
        fs.writeFileSync(path.join(home, 'web-history', `${name}.json`), JSON.stringify({ containerName: name, ...data }));
    }

    async function boot() {
        const port = await getFreePort();
        // 假 docker：只记录 exec（first 命令走 ctx.dockerCmd 起子进程）
        fakeDockerLog = path.join(home, 'fake-docker.log');
        const fakeDocker = path.join(home, 'fake-docker.js');
        fs.writeFileSync(fakeDocker, `#!/usr/bin/env node\nconst fs = require('fs');\nconst args = process.argv.slice(2);\nif (args[0] === 'exec') fs.appendFileSync(${JSON.stringify(fakeDockerLog)}, JSON.stringify(args) + '\\n');\nprocess.stdout.write('ok');\n`);
        fs.chmodSync(fakeDocker, 0o755);
        handle = await startWebServer({
            serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: 'topsecret', authPassAuto: false,
            dockerCmd: fakeDocker, networkManager: fakeNetworkManager(), transferRuntime: runtime, transferWaitMs: waitMs, duBytes: async () => 0,
            statfsSync: p => (statfsFree === null ? require('fs').statfsSync(p) : { bavail: statfsFree, bsize: 1 }),
            hostPath: home, homeDir: home, containerPath: '/workspace', imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common',
            execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
            validateHostPath: () => {}, formatDate: () => '0101-0000',
            isValidContainerName: v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v),
            containerExists: name => existing.has(name), getContainerStatus: () => 'running', waitForContainerReady: async () => {},
            dockerExecArgs: (args) => {
                execCalls.push(args);
                if (args[0] === 'run' && runFailure) throw new Error(runFailure);
                if (args[0] === 'run' && args.indexOf('--name') >= 0) existing.add(args[args.indexOf('--name') + 1]);
                if (args[0] === 'ps') return [...[...existing].map(n => `${n}\tUp 1 minute\tlocalhost/xcanwin/manyoyo:1.0.0-common`), ...extraPs].join('\n');
                if (args[0] === 'inspect' && String(args[2]).includes('manyoyo.id')) {
                    if (!existing.has(args[3])) return '';
                    const dir = path.join(home, '.manyoyo', 'containers');
                    return fs.existsSync(dir) ? (fs.readdirSync(dir).sort()[0] || '') : '';
                }
                return '';
            },
            showImagePullHint: () => {},
            removeContainer: name => { existing.delete(name); },
            webHistoryDir: path.join(home, 'web-history'), webConfigPath: path.join(home, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' }
        });
        baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await request(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'webadmin', password: 'topsecret' }) });
        cookie = String(login.response.headers.get('set-cookie')).split(';')[0];
    }
    const restart = boot;

    beforeEach(async () => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-xfer-'));
        existing = new Set();
        execCalls = [];
        holdCp = null;
        statfsFree = null;
        waitMs = undefined;
        runFailure = null;
        extraPs = [];
        runtime = {
            inspect: async name => (existing.has(name) ? { id: 'aaaaaaaaaaaaaaaa', image: 'img:1', status: 'running', mounts: [] } : null),
            pause: async () => {}, unpause: async () => {}, diff: async () => {},
            cp: () => {
                if (holdCp) return { stream: holdCp, done: Promise.resolve({ code: 0, stderr: '' }) };
                return { stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve({ code: 1, stderr: 'no such file' }) };
            },
            cpIn: () => { const stdin = new PassThrough(); stdin.resume(); return { stdin, done: new Promise(r => stdin.on('end', () => r({ code: 0, stderr: '' }))), kill() {} }; }
        };
        await boot();
    });
    afterEach(async () => {
        if (handle) await handle.close();
        fs.rmSync(home, { recursive: true, force: true });
    });

    test('未登录 401；预览给出档位和内容项', async () => {
        expect((await request(`${baseUrl}/api/transfer/preview`)).status).toBe(401);
        expect((await request(`${baseUrl}/api/exports`, { method: 'POST', body: '{}' })).status).toBe(401);
        const res = await api('GET', '/api/transfer/preview?containers=nope');
        expect(res.status).toBe(200);
        expect(res.json.tiers.map(t => t.id)).toEqual(['light', 'standard', 'full']);
        expect(res.json.items.find(i => i.id === 'agentSessions')).toBeTruthy();
    });

    test('直接下载：POST 立即返回 202 → 后台准备（ready）→ GET 下载（只能取一次）→ 归档里有清单、历史、END；响应带 X-Accel-Buffering: no', async () => {
        writeHistory('src1', { remark: '备注A', agents: { default: { agentId: 'default', agentName: 'AGENT 1', messages: [] } } });
        const { created, job, download } = await exportDownload({ containers: ['src1'], tier: 'light' });
        expect(job.downloadUrl).toBe(`/api/exports/${created.jobId}/download`);
        expect(download.status).toBe(200);
        expect(download.response.headers.get('content-disposition')).toMatch(/manyoyo-export-\d{8}-\d{6}\.tar\.(zst|gz)/);
        expect(download.response.headers.get('x-accel-buffering')).toBe('no');
        const entries = await extract(download.buffer);
        const names = Object.keys(entries);
        expect(names[0]).toBe('manifest.json');
        expect(names[names.length - 1]).toBe('END.json');
        expect(JSON.parse(entries['c/0/history.json']).remark).toBe('备注A');
        expect((await api('GET', job.downloadUrl)).status).toBe(404);
        expect((await waitJob(created.jobId, ['done'])).status).toBe('done');
    });

    test('POST /api/exports 立即返回：准备（diff）卡住时也不等；准备中容器已被闸门锁住，可以取消，取消后 diff 收到信号、锁释放', async () => {
        existing.add('slow1');
        writeHistory('slow1', { agents: { default: { agentId: 'default', messages: [] } } });
        let diffSignal = null;
        runtime.diff = (name, { signal }) => new Promise((resolve, reject) => { diffSignal = signal; signal.addEventListener('abort', () => reject(Object.assign(new Error('已取消'), { name: 'RuntimeAbortError' }))); });
        const started = Date.now();
        const created = await api('POST', '/api/exports', { containers: ['slow1'], items: ['agentSessions'], output: 'download' });
        expect(created.status).toBe(202);
        expect(Date.now() - started).toBeLessThan(1500);
        expect((await api('GET', `/api/jobs/${created.json.jobId}`)).json.job.status).toBe('preparing');
        // 准备中就已经锁住容器
        const gated = await api('POST', '/api/sessions/slow1/remove', {});
        expect(gated.status).toBe(409);
        expect(gated.json).toMatchObject({ busy: 'export', jobId: created.json.jobId });
        expect((await api('POST', '/api/exports', { containers: ['slow1'], tier: 'light' })).status).toBe(409);
        await new Promise(r => setTimeout(r, 50));
        const cancelled = await api('POST', `/api/jobs/${created.json.jobId}/cancel`);
        expect(cancelled.status).toBe(200);
        expect((await waitJob(created.json.jobId, ['cancelled'])).status).toBe('cancelled');
        expect(diffSignal.aborted).toBe(true);
        expect((await api('POST', '/api/sessions/slow1/fs/write', {})).status).not.toBe(409);
    });

    test('准备好后 2 分钟没人取：自动取消并释放；下载链接作废', async () => {
        await handle.close();
        waitMs = 150; // 用更短的等待重新起服务（起服务时读取）
        await restart();
        writeHistory('src1', {});
        const created = await api('POST', '/api/exports', { containers: ['src1'], tier: 'light', output: 'download' });
        const ready = await waitJob(created.json.jobId, ['ready']);
        const gone = await waitJob(created.json.jobId, ['cancelled'], 3000);
        expect(gone.error).toContain('没有开始下载');
        expect((await api('GET', ready.downloadUrl)).status).toBe(404);
    });

    test('下载一开始就先发响应头（准备好之后首字节不等容器里的数据）；客户端中途断开记为已取消而不是失败', async () => {
        existing.add('hold1');
        writeHistory('hold1', { agents: { default: { agentId: 'default', messages: [] } } });
        holdCp = new PassThrough(); // 容器里的数据一直不来
        runtime.diff = async (name, { onEntry }) => { onEntry('A', '/root/.codex/sessions/s.jsonl'); };
        const created = await api('POST', '/api/exports', { containers: ['hold1'], items: ['agentSessions'], output: 'download' });
        const ready = await waitJob(created.json.jobId, ['ready']);
        const controller = new AbortController();
        const started = Date.now();
        const response = await fetch(`${baseUrl}${ready.downloadUrl}`, { headers: { Cookie: cookie }, signal: controller.signal });
        expect(response.status).toBe(200);
        expect(Date.now() - started).toBeLessThan(1500);
        const reader = response.body.getReader();
        await reader.read(); // 清单已被冲刷出来
        expect((await api('GET', `/api/jobs/${created.json.jobId}`)).json.job.status).toBe('running');
        controller.abort();
        const job = await waitJob(created.json.jobId, ['cancelled', 'failed'], 5000);
        expect(job.status).toBe('cancelled');
        holdCp.destroy();
    });

    test('参数校验：容器不存在 404、未知档位 400、容器名非法 400；下载接口只认自己建的任务', async () => {
        expect((await api('POST', '/api/exports', { containers: ['ghost'], tier: 'light' })).status).toBe(404);
        writeHistory('src1', {});
        expect((await api('POST', '/api/exports', { containers: ['src1'], tier: 'nope' })).status).toBe(400);
        expect((await api('POST', '/api/exports', { containers: ['../x'], tier: 'light' })).status).toBe(400);
        expect((await api('GET', '/api/exports/0123456789abcdef/download')).status).toBe(404);
        expect((await api('GET', '/api/exports/files/..%2F..%2Fetc%2Fpasswd')).status).toBe(400);
        expect((await api('DELETE', '/api/exports/files/notallowed.txt')).status).toBe(400);
    });

    test('导出期间闸门：对话、文件写、删除、克隆、终端全部 409，读消息放行，列表带 job；结束后恢复', async () => {
        existing.add('busy1');
        writeHistory('busy1', { agents: { default: { agentId: 'default', messages: [] } } });
        holdCp = new PassThrough();
        runtime.diff = async (name, { onEntry }) => { onEntry('A', '/root/.codex/sessions/s.jsonl'); };
        const created = await api('POST', '/api/exports', { containers: ['busy1'], items: ['history', 'agentSessions'], output: 'server' });
        expect(created.status).toBe(202);
        await waitJob(created.json.jobId, ['running']);
        for (const [method, route, body] of [
            ['POST', '/api/sessions/busy1/agent/stream', { prompt: 'hi' }],
            ['POST', '/api/sessions/busy1/remove', {}],
            ['POST', '/api/sessions/busy1/clone', {}],
            ['POST', '/api/sessions/busy1/fs/write', {}],
            ['PUT', '/api/containers/busy1/env', { text: 'A=1' }],
            ['POST', '/api/sessions/busy1/container/stop', {}]
        ]) {
            const res = await api(method, route, body);
            expect([method, route, res.status]).toEqual([method, route, 409]);
            expect(res.json).toMatchObject({ busy: 'export', jobId: created.json.jobId });
        }
        expect((await api('GET', '/api/sessions/busy1/messages')).status).not.toBe(409);
        const list = await api('GET', '/api/sessions');
        expect(list.json.sessions.find(s => s.containerName === 'busy1').job).toMatchObject({ type: 'export', status: 'running' });
        const ws = new WebSocket(`ws://127.0.0.1:${new URL(baseUrl).port}/api/sessions/busy1/terminal/ws`, { headers: { Cookie: cookie } });
        const wsStatus = await new Promise(resolve => { ws.on('unexpected-response', (r, res) => resolve(res.statusCode)); ws.on('error', () => resolve('error')); ws.on('open', () => resolve('open')); });
        expect(wsStatus).toBe(409);
        // 放行
        holdCp.end();
        expect((await waitJob(created.json.jobId, ['done', 'failed'])).status).toBe('done');
        expect((await api('POST', '/api/sessions/busy1/fs/write', {})).status).not.toBe(409);
        const files = await api('GET', '/api/exports');
        expect(files.json.files).toHaveLength(1);
        const fileRes = await api('GET', `/api/exports/files/${files.json.files[0].name}`);
        expect(fileRes.buffer.length).toBe(files.json.files[0].size);
        expect(fileRes.response.headers.get('x-accel-buffering')).toBe('no');
        expect((await api('DELETE', `/api/exports/files/${files.json.files[0].name}`)).status).toBe(200);
        expect((await api('GET', '/api/exports')).json.files).toHaveLength(0);
    });

    test('任务期间所有会碰到该容器的运行时查询都绕开它（docker 在 cp 期间锁住容器，inspect 会一直等）：侧栏列表、容量估算、存储面板', async () => {
        existing.add('busy3');
        existing.add('free3');
        writeHistory('busy3', { agents: { default: { agentId: 'default', messages: [] } } });
        writeHistory('free3', { agents: { default: { agentId: 'default', messages: [] } } });
        // 目标容器被 cp 锁住时，改 nft 规则的一次性 helper 会卡在 Created 状态，同步 inspect 它也会一起卡住：列表里要排除它
        extraPs.push('manyoyo-helper-0a1b2c3d\tCreated\tlocalhost/xcanwin/manyoyo:1.0.0-common');
        // 先在没有任务时列一次，让服务端缓存容器信息
        expect((await api('GET', '/api/sessions')).status).toBe(200);
        holdCp = new PassThrough();
        runtime.diff = async (name, { onEntry }) => { onEntry('A', '/root/.codex/sessions/s.jsonl'); };
        const created = await api('POST', '/api/exports', { containers: ['busy3'], items: ['agentSessions'], output: 'server' });
        await waitJob(created.json.jobId, ['running']);
        execCalls.length = 0;
        expect((await api('GET', '/api/sessions')).status).toBe(200);
        await api('GET', '/api/system/capacity');
        await api('GET', '/api/storage');
        const inspects = execCalls.filter(args => args[0] === 'inspect');
        expect(inspects.length).toBeGreaterThan(0);
        for (const args of inspects) {
            expect(args).not.toContain('busy3');
            expect(args).not.toContain('manyoyo-helper-0a1b2c3d');
        }
        expect(inspects.some(args => args.includes('free3'))).toBe(true);
        holdCp.end();
        await waitJob(created.json.jobId, ['done', 'failed']);
    });

    test('暂停失败不会停止容器：任务结果里告诉用户“没能暂停”', async () => {
        existing.add('nopause');
        writeHistory('nopause', { agents: { default: { agentId: 'default', messages: [] } } });
        const stops = [];
        runtime.stop = async name => stops.push(name);
        runtime.pause = async () => { throw new Error('cgroup 不支持暂停'); };
        runtime.diff = async (name, { onEntry }) => { onEntry('A', '/root/.codex/sessions/s.jsonl'); };
        const { job } = await exportToServer({ containers: ['nopause'], items: ['agentSessions'] });
        expect(stops).toEqual([]);
        expect(job.result.warnings[0]).toContain('没能暂停');
        expect(job.warnings.length).toBe(1);
    });

    test('导出 → 服务器文件 → 先看清单 → 改名导入（立即返回任务号，结果在任务里）：历史、事件文件名和内容都对；first 不执行', async () => {
        writeHistory('src1', {
            remark: '源', pinned: true,
            runtimeSnapshot: { hostPath: path.join(home, 'oldwork'), containerPath: '/workspace', env: { A: '1' }, first: { shell: 'echo first-ran' }, containerMode: 'sock', volumes: ['/:/host'] },
            agents: { default: { agentId: 'default', agentName: 'AGENT 1', engineSessionId: 'sess-1', messages: [] } }
        });
        fs.mkdirSync(path.join(home, 'web-history', 'events'), { recursive: true });
        fs.writeFileSync(path.join(home, 'web-history', 'events', 'src1.jsonl'), `${JSON.stringify({ id: 'e1', type: 'session.ready', version: 1, aggregateId: 'src1', sessionId: 'src1', seq: 1, timestamp: 't', data: {} })}\n`);
        const { file } = await exportToServer({ containers: ['src1'], tier: 'light' });

        const inspected = await api('POST', '/api/imports/inspect', { serverFile: file });
        expect(inspected.status).toBe(200);
        expect(inspected.json.containers[0]).toMatchObject({ name: 'src1', nameTaken: true, suggestedName: 'src1-2', risks: { containerMode: 'sock', volumes: ['/:/host'] } });
        expect((await api('POST', '/api/imports/inspect', Buffer.from('not an archive at all'), { 'Content-Type': 'application/octet-stream' })).status).toBe(400);
        expect((await api('POST', '/api/imports/inspect', { serverFile: '../etc/passwd' })).status).toBe(400);

        // 名字被占用 → 拒绝
        expect((await api('POST', '/api/imports', { serverFile: file, plan: { containers: { 0: { name: 'src1', hostPath: '' } } } })).status).toBe(409);
        const started = Date.now();
        const imported = await api('POST', '/api/imports', { serverFile: file, plan: { containers: { 0: { name: 'dst1', remark: '导入后的新备注', hostPath: path.join(home, 'newwork'), imageMode: 'same', confirm: {} } } } });
        expect(imported.status).toBe(202);
        expect(Date.now() - started).toBeLessThan(1500);
        const job = await waitJob(imported.json.jobId, ['done', 'failed']);
        expect(job.error).toBe('');
        expect(job.result.containers).toEqual(['dst1']);
        // 被丢掉的东西在任务结果里
        expect(job.result.details[0].dropped.join('|')).toContain('没勾选');
        const hist = JSON.parse(fs.readFileSync(path.join(home, 'web-history', 'dst1.json'), 'utf8'));
        expect(hist.remark).toBe('导入后的新备注');
        expect(hist.pinned).toBe(true);
        expect(hist.agents.default.engineSessionId).toBe('sess-1');
        expect(hist.runtimeSnapshot.containerMode || 'common').not.toBe('sock');
        expect(hist.runtimeSnapshot.volumes || []).toEqual([]);
        const ev = fs.readFileSync(path.join(home, 'web-history', 'events', 'dst1.jsonl'), 'utf8');
        expect(JSON.parse(ev.trim())).toMatchObject({ aggregateId: 'dst1', sessionId: 'dst1', seq: 1 });
        const execLog = fs.existsSync(fakeDockerLog) ? fs.readFileSync(fakeDockerLog, 'utf8') : '';
        expect(execLog).not.toContain('first-ran');
    });

    test('面板里改过的设置也带走并还原：导出风险摘要以状态目录为准；导入时网络规则 / 环境变量文件要确认，不勾就不生效，系统提示词照常还原', async () => {
        const containerState = require('../lib/container-state');
        const envFile = path.join(home, 'extra.env');
        fs.writeFileSync(envFile, 'FROM_FILE=1\n');
        writeHistory('src1', { runtimeSnapshot: { hostPath: path.join(home, 'oldwork'), containerPath: '/workspace' }, agents: { default: { agentId: 'default', messages: [] } } });
        existing.add('src1');
        containerState.createState({
            homeDir: home, id: 'aaaaaaaaaaaaaaaa', envLines: [],
            network: { preset: 'custom', outbound: [{ action: 'allow', target: 'panel-added.example.com', proto: 'tcp', ports: '', enabled: true }], inbound: [] },
            envFiles: [envFile], systemPrompt: { enabled: true, text: '面板里改过的提示词' }, autostart: 'echo panel-added-autostart'
        });
        const { file } = await exportToServer({ containers: ['src1'], tier: 'light' });
        // 清掉源的状态目录，避免和导入后新容器（假 docker 里 id 取第一个目录）混在一起
        fs.rmSync(path.join(home, '.manyoyo', 'containers'), { recursive: true, force: true });
        const inspected = await api('POST', '/api/imports/inspect', { serverFile: file });
        expect(inspected.json.containers[0].risks).toMatchObject({ networkOpen: true, envFiles: [envFile] });

        const run = async (name, confirm) => {
            const imported = await api('POST', '/api/imports', { serverFile: file, plan: { containers: { 0: { name, hostPath: '', imageMode: 'same', confirm } } } });
            expect(imported.status).toBe(202);
            const job = await waitJob(imported.json.jobId, ['done', 'failed']);
            expect(job.error).toBe('');
            return { job, hist: JSON.parse(fs.readFileSync(path.join(home, 'web-history', `${name}.json`), 'utf8')) };
        };
        const unconfirmed = await run('dst-a', {});
        expect(unconfirmed.job.result.details[0].dropped.join('|')).toContain('自定义网络规则没勾选');
        expect(unconfirmed.job.result.details[0].dropped.join('|')).toContain('环境变量文件');
        // 面板里后来加的自启动脚本只在状态目录里（快照里没有），不勾选时也要告诉用户没带上
        expect(unconfirmed.job.result.details[0].dropped.join('|')).toContain('自启动脚本没勾选');
        expect(unconfirmed.hist.runtimeSnapshot.network.preset).toBe('restricted');
        expect(unconfirmed.hist.runtimeSnapshot.network.outbound).toEqual([]);
        expect(unconfirmed.hist.runtimeSnapshot.envFile || []).toEqual([]);
        expect(unconfirmed.hist.runtimeSnapshot.systemPrompt).toMatchObject({ text: '面板里改过的提示词' });
        const confirmed = await run('dst-b', { networkOpen: true, envFiles: [envFile] });
        expect(confirmed.hist.runtimeSnapshot.network.outbound[0].target).toBe('panel-added.example.com');
        expect(confirmed.hist.runtimeSnapshot.envFile).toEqual([envFile]);
    });

    test('导入建容器失败（如端口被占）：界面只给一句原因，不带整条 run 命令行；截断归档 / 客户端断开也不出现英文技术词', async () => {
        writeHistory('src1', { runtimeSnapshot: { hostPath: path.join(home, 'oldwork'), containerPath: '/workspace' }, agents: { default: { agentId: 'default', messages: [] } } });
        const { file } = await exportToServer({ containers: ['src1'], tier: 'light' });
        runFailure = 'Command failed: podman run -d --name dst7 --env KEEP=1 --publish 18080:80 localhost/xcanwin/manyoyo:1.0.0-common';
        const imported = await api('POST', '/api/imports', { serverFile: file, plan: { containers: { 0: { name: 'dst7', hostPath: '', imageMode: 'same', confirm: {} } } } });
        const job = await waitJob(imported.json.jobId, ['failed', 'done']);
        expect(job.status).toBe('failed');
        expect(job.error).not.toMatch(/podman run|--env|--publish/);
        expect(job.error).toContain('创建容器失败');
        expect(fs.existsSync(path.join(home, 'web-history', 'dst7.json'))).toBe(false);
    });

    test('工作目录路径：结尾斜杠视为同一个目录；写 / 说成“不允许根目录”而不是“必须是绝对路径”；读清单时就告诉每个容器的镜像状态', async () => {
        existing.add('src1');
        writeHistory('src1', { runtimeSnapshot: { hostPath: path.join(home, 'oldwork'), containerPath: '/workspace' }, agents: { default: { agentId: 'default', messages: [] } } });
        const { file } = await exportToServer({ containers: ['src1'], tier: 'light' });
        const root = await api('POST', '/api/imports/uploads', { plan: { containers: { 0: { name: 'dst8', hostPath: '/' } } } });
        expect(root.status).toBe(400);
        expect(root.json.error).toContain('根目录');
        expect(root.json.error).not.toContain('必须是绝对路径');
        const relative = await api('POST', '/api/imports/uploads', { plan: { containers: { 0: { name: 'dst8', hostPath: 'relative/dir' } } } });
        expect(relative.json.error).toContain('绝对路径');
        const slash = await api('POST', '/api/imports/uploads', { plan: { containers: { 0: { name: 'dst8', hostPath: `${path.join(home, 'with-slash')}/` } } } });
        expect(slash.status).toBe(200);
        await api('POST', `/api/jobs/${slash.json.jobId}/cancel`);
        // 清单里每个容器带镜像状态：归档里的 img:1 不是 manyoyo 的镜像 → untrusted
        const inspected = await api('POST', '/api/imports/inspect', { serverFile: file });
        expect(inspected.json.containers[0].imageStatus).toBe('untrusted');
    });

    test('导入设置不再放在 URL 里：旧的 ?plan= 方式不被接受', async () => {
        writeHistory('src1', { runtimeSnapshot: { hostPath: path.join(home, 'oldwork'), containerPath: '/workspace' }, agents: { default: { agentId: 'default', messages: [] } } });
        const { download } = await exportDownload({ containers: ['src1'], tier: 'light' });
        const plan = encodeURIComponent(JSON.stringify({ containers: { 0: { name: 'old-style', hostPath: path.join(home, 'ws'), imageMode: 'same', confirm: {} } } }));
        const result = await request(`${baseUrl}/api/imports?plan=${plan}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: download.buffer });
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(fs.existsSync(path.join(home, 'web-history', 'old-style.json'))).toBe(false);
    });

    test('导入工作目录：~/.manyoyo/work 下的子目录可以，其它 ~/.manyoyo 里的位置拒绝', async () => {
        writeHistory('src1', { runtimeSnapshot: { hostPath: path.join(home, 'o'), containerPath: '/workspace' }, agents: { default: { agentId: 'default', messages: [] } } });
        const { file } = await exportToServer({ containers: ['src1'], tier: 'light' });
        const bad = await api('POST', '/api/imports', { serverFile: file, plan: { containers: { 0: { name: 'dst9', hostPath: path.join(home, '.manyoyo', 'web-history', 'x') } } } });
        expect(bad.status).toBe(400);
        expect(bad.json.error).toContain('~/.manyoyo');
        const ok = await api('POST', '/api/imports', { serverFile: file, plan: { containers: { 0: { name: 'dst9', hostPath: path.join(home, '.manyoyo', 'work', 'dst9') } } } });
        expect(ok.status).toBe(202);
        expect((await waitJob(ok.json.jobId, ['done', 'failed'])).status).toBe('done');
    });

    test('名字预留与清理接口：导出期间别处不能同名新建容器（409）、不能清理历史 / 目录；上传超时设为不限', async () => {
        existing.add('busy2');
        writeHistory('busy2', { agents: { default: { agentId: 'default', messages: [] } } });
        holdCp = new PassThrough();
        runtime.diff = async (name, { onEntry }) => { onEntry('A', '/root/.codex/sessions/s.jsonl'); };
        const created = await api('POST', '/api/exports', { containers: ['busy2'], items: ['history', 'agentSessions'], output: 'server' });
        expect(created.status).toBe(202);
        await waitJob(created.json.jobId, ['running']);
        const dup = await api('POST', '/api/sessions', { createOptions: { containerName: 'busy2', hostPath: home, containerPath: home } });
        expect(dup.status).toBe(409);
        expect((await api('DELETE', '/api/storage/histories', { names: ['busy2'] })).status).toBe(409);
        expect(handle.server.requestTimeout).toBe(0);
        holdCp.end();
        await waitJob(created.json.jobId, ['done', 'failed']);
        expect((await api('DELETE', '/api/storage/histories', { names: ['busy2'] })).status).not.toBe(409);
    });

    test('磁盘不足：导出到服务器在开始前被拒（507，不留 .part）；导入按剩余空间限制解包大小，超出就撤销', async () => {
        writeHistory('src1', { runtimeSnapshot: { hostPath: path.join(home, 'oldwork'), containerPath: '/workspace' }, agents: { default: { agentId: 'default', messages: [] } } });
        statfsFree = 100 * 1024 * 1024; // 比 1GiB 安全余量还小
        const refused = await api('POST', '/api/exports', { containers: ['src1'], tier: 'light', output: 'server' });
        expect(refused.status).toBe(507);
        expect(refused.json.error).toContain('磁盘');
        const exportsDir = path.join(home, '.manyoyo', 'exports');
        expect(fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir).filter(f => f.endsWith('.part')) : []).toEqual([]);
        // 直接下载模式不看服务器磁盘
        statfsFree = null;
        const { download } = await exportDownload({ containers: ['src1'], tier: 'light' });
        const full = download.buffer;
        statfsFree = 1024 * 1024 * 1024 + 10; // 只够 10 字节解包
        const result = await importUpload(full, { containers: { 0: { name: 'dst3', hostPath: path.join(home, 'work3'), imageMode: 'same', confirm: {} } } });
        expect(result.uploaded.status).toBeGreaterThanOrEqual(400);
        expect(fs.existsSync(path.join(home, 'web-history', 'dst3.json'))).toBe(false);
        expect(fs.existsSync(path.join(home, 'work3'))).toBe(false);
    });

    test('导入上传两步：设置在请求体里（24KB 的设置也行），登记时就预留新名字，上传完立即返回，结果在任务里', async () => {
        writeHistory('src1', { runtimeSnapshot: { hostPath: path.join(home, 'oldwork'), containerPath: '/workspace' }, agents: { default: { agentId: 'default', messages: [] } } });
        const { download } = await exportDownload({ containers: ['src1'], tier: 'light' });
        const bigRemark = '备'.repeat(200);
        const plan = { containers: { 0: { name: 'dst2', remark: bigRemark, hostPath: path.join(home, 'work2'), imageMode: 'same', confirm: { volumes: Array.from({ length: 900 }, (_, i) => `/host/dir-number-${i}:/mnt/${i}`) } } } };
        expect(JSON.stringify(plan).length).toBeGreaterThan(24 * 1024);
        const registered = await api('POST', '/api/imports/uploads', { plan });
        expect(registered.status).toBe(200);
        expect(registered.json.uploadUrl).toBe(`/api/imports/${registered.json.jobId}/upload`);
        expect((await api('GET', `/api/jobs/${registered.json.jobId}`)).json.job.status).toBe('waiting');
        // 名字已被预留：同名再登记 409；别处新建同名容器 409；检查清单时也算已占用
        expect((await api('POST', '/api/imports/uploads', { plan })).status).toBe(409);
        const dup = await api('POST', '/api/sessions', { createOptions: { containerName: 'dst2', hostPath: home, containerPath: home } });
        expect(dup.status).toBe(409);
        const inspected = await api('POST', '/api/imports/inspect', download.buffer, { 'Content-Type': 'application/octet-stream' });
        expect(inspected.json.containers[0].suggestedName).toBe('src1-2');
        const uploaded = await api('POST', registered.json.uploadUrl, download.buffer, { 'Content-Type': 'application/octet-stream' });
        expect(uploaded.status).toBe(202);
        expect(uploaded.json.jobId).toBe(registered.json.jobId);
        const job = await waitJob(registered.json.jobId, ['done', 'failed']);
        expect(job.error).toBe('');
        expect(fs.existsSync(path.join(home, 'web-history', 'dst2.json'))).toBe(true);
        // 上传链接只能用一次
        expect((await api('POST', registered.json.uploadUrl, download.buffer, { 'Content-Type': 'application/octet-stream' })).status).toBe(404);
    });

    test('导入登记时就检查：工作目录已存在且非空直接拒绝（不用等整份上传完）；等待上传可取消，取消后名字释放', async () => {
        writeHistory('src1', { runtimeSnapshot: { hostPath: path.join(home, 'oldwork'), containerPath: '/workspace' }, agents: { default: { agentId: 'default', messages: [] } } });
        const full = path.join(home, 'occupied');
        fs.mkdirSync(full);
        fs.writeFileSync(path.join(full, 'x'), '1');
        const refused = await api('POST', '/api/imports/uploads', { plan: { containers: { 0: { name: 'dst4', hostPath: full, imageMode: 'same', confirm: {} } } } });
        expect(refused.status).toBe(409);
        expect(refused.json.error).toContain('工作目录已存在且不为空');
        const asFile = await api('POST', '/api/imports/uploads', { plan: { containers: { 0: { name: 'dst4', hostPath: path.join(full, 'x'), imageMode: 'same', confirm: {} } } } });
        expect(asFile.status).toBe(400);
        expect(asFile.json.error).toContain('不是目录');
        const registered = await api('POST', '/api/imports/uploads', { plan: { containers: { 0: { name: 'dst4', hostPath: path.join(home, 'free'), imageMode: 'same', confirm: {} } } } });
        expect(registered.status).toBe(200);
        expect((await api('POST', `/api/jobs/${registered.json.jobId}/cancel`)).status).toBe(200);
        expect((await api('GET', `/api/jobs/${registered.json.jobId}`)).json.job.status).toBe('cancelled');
        const again = await api('POST', '/api/imports/uploads', { plan: { containers: { 0: { name: 'dst4', hostPath: path.join(home, 'free'), imageMode: 'same', confirm: {} } } } });
        expect(again.status).toBe(200);
        expect((await api('POST', '/api/imports/uploads', { plan: { containers: { 0: { name: 'dst5', hostPath: '', imageMode: 'same', confirm: {} } } } })).status).toBe(409); // 已经有一个导入在进行
    });

    test('上传中途断开：导入失败，新建的东西全部撤销，完整上传可以成功', async () => {
        writeHistory('src1', { runtimeSnapshot: { hostPath: path.join(home, 'oldwork'), containerPath: '/workspace' }, agents: { default: { agentId: 'default', messages: [] } } });
        const { download } = await exportDownload({ containers: ['src1'], tier: 'light' });
        const full = download.buffer;
        const plan = { containers: { 0: { name: 'dst2', hostPath: path.join(home, 'work2'), imageMode: 'same', confirm: {} } } };
        const cut = await importUpload(full.subarray(0, Math.floor(full.length / 2)), plan);
        expect(cut.uploaded.status).toBeGreaterThanOrEqual(400);
        expect(fs.existsSync(path.join(home, 'web-history', 'dst2.json'))).toBe(false);
        expect(fs.existsSync(path.join(home, 'work2'))).toBe(false);
        const tmp = path.join(home, '.manyoyo', 'tmp');
        expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toEqual([]);
        // 文案是一句人话，不是 EBADF / Premature close 之类
        expect(cut.uploaded.json.error).not.toMatch(/EBADF|Premature|unexpected end/i);
        const ok = await importUpload(full, plan);
        expect(ok.uploaded.status).toBe(202);
        expect(ok.job.status).toBe('done');
        expect(fs.existsSync(path.join(home, 'web-history', 'dst2.json'))).toBe(true);
    });
});
