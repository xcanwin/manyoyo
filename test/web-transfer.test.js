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
    let home, handle, baseUrl, cookie, existing, execCalls, runtime, holdCp, fakeDockerLog, statfsFree;
    const api = (method, route, body, headers = {}) => request(`${baseUrl}${route}`, { method, headers: { Cookie: cookie, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });

    function writeHistory(name, data) {
        fs.mkdirSync(path.join(home, 'web-history'), { recursive: true });
        fs.writeFileSync(path.join(home, 'web-history', `${name}.json`), JSON.stringify({ containerName: name, ...data }));
    }

    beforeEach(async () => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-xfer-'));
        existing = new Set();
        execCalls = [];
        holdCp = null;
        statfsFree = null;
        runtime = {
            inspect: name => (existing.has(name) ? { id: 'aaaaaaaaaaaaaaaa', image: 'img:1', status: 'running', mounts: [] } : null),
            pause() {}, unpause() {}, diff: () => '',
            cp: () => {
                if (holdCp) return { stream: holdCp, done: Promise.resolve({ code: 0, stderr: '' }) };
                return { stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve({ code: 1, stderr: 'no such file' }) };
            },
            cpIn: () => { const stdin = new PassThrough(); stdin.resume(); return { stdin, done: new Promise(r => stdin.on('end', () => r({ code: 0, stderr: '' }))), kill() {} }; }
        };
        const port = await getFreePort();
        // 假 docker：只记录 exec（first 命令走 ctx.dockerCmd 起子进程）
        fakeDockerLog = path.join(home, 'fake-docker.log');
        const fakeDocker = path.join(home, 'fake-docker.js');
        fs.writeFileSync(fakeDocker, `#!/usr/bin/env node\nconst fs = require('fs');\nconst args = process.argv.slice(2);\nif (args[0] === 'exec') fs.appendFileSync(${JSON.stringify(fakeDockerLog)}, JSON.stringify(args) + '\\n');\nprocess.stdout.write('ok');\n`);
        fs.chmodSync(fakeDocker, 0o755);
        handle = await startWebServer({
            serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: 'topsecret', authPassAuto: false,
            dockerCmd: fakeDocker, networkManager: fakeNetworkManager(), transferRuntime: runtime,
            statfsSync: p => (statfsFree === null ? require('fs').statfsSync(p) : { bavail: statfsFree, bsize: 1 }),
            hostPath: home, homeDir: home, containerPath: '/workspace', imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common',
            execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
            validateHostPath: () => {}, formatDate: () => '0101-0000',
            isValidContainerName: v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v),
            containerExists: name => existing.has(name), getContainerStatus: () => 'running', waitForContainerReady: async () => {},
            dockerExecArgs: (args) => {
                execCalls.push(args);
                if (args[0] === 'run' && args.indexOf('--name') >= 0) existing.add(args[args.indexOf('--name') + 1]);
                if (args[0] === 'ps') return [...existing].map(n => `${n}\tUp 1 minute\tlocalhost/xcanwin/manyoyo:1.0.0-common`).join('\n');
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

    test('直接下载：POST 建任务 → GET 下载（只能取一次）→ 归档里有清单、历史、END', async () => {
        writeHistory('src1', { remark: '备注A', agents: { default: { agentId: 'default', agentName: 'AGENT 1', messages: [] } } });
        const created = await api('POST', '/api/exports', { containers: ['src1'], tier: 'light', output: 'download' });
        expect(created.status).toBe(200);
        const download = await api('GET', created.json.downloadUrl);
        expect(download.status).toBe(200);
        expect(download.response.headers.get('content-disposition')).toMatch(/manyoyo-export-\d{8}-\d{6}\.tar\.(zst|gz)/);
        const entries = await extract(download.buffer);
        const names = Object.keys(entries);
        expect(names[0]).toBe('manifest.json');
        expect(names[names.length - 1]).toBe('END.json');
        expect(JSON.parse(entries['c/0/history.json']).remark).toBe('备注A');
        expect((await api('GET', created.json.downloadUrl)).status).toBe(404);
        expect((await api('GET', `/api/jobs/${created.json.jobId}`)).json.job.status).toBe('done');
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
        const created = await api('POST', '/api/exports', { containers: ['busy1'], items: ['history', 'agentSessions'], output: 'server' });
        expect(created.status).toBe(200);
        await new Promise(r => setTimeout(r, 100));
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
        expect(list.json.sessions.find(s => s.containerName === 'busy1').job).toMatchObject({ type: 'export' });
        const ws = new WebSocket(`ws://127.0.0.1:${new URL(baseUrl).port}/api/sessions/busy1/terminal/ws`, { headers: { Cookie: cookie } });
        const wsStatus = await new Promise(resolve => { ws.on('unexpected-response', (r, res) => resolve(res.statusCode)); ws.on('error', () => resolve('error')); ws.on('open', () => resolve('open')); });
        expect(wsStatus).toBe(409);
        // 放行
        holdCp.end();
        for (let i = 0; i < 50; i += 1) {
            const job = (await api('GET', `/api/jobs/${created.json.jobId}`)).json.job;
            if (job.status !== 'running') { expect(job.status).toBe('done'); break; }
            await new Promise(r => setTimeout(r, 50));
        }
        expect((await api('POST', '/api/sessions/busy1/fs/write', {})).status).not.toBe(409);
        const files = await api('GET', '/api/exports');
        expect(files.json.files).toHaveLength(1);
        expect((await api('GET', `/api/exports/files/${files.json.files[0].name}`)).buffer.length).toBe(files.json.files[0].size);
        expect((await api('DELETE', `/api/exports/files/${files.json.files[0].name}`)).status).toBe(200);
        expect((await api('GET', '/api/exports')).json.files).toHaveLength(0);
    });

    test('导出 → 服务器文件 → 先看清单 → 改名导入：历史、事件文件名和内容都对；first 不执行；失败或取消不留东西', async () => {
        writeHistory('src1', {
            remark: '源', pinned: true,
            runtimeSnapshot: { hostPath: path.join(home, 'oldwork'), containerPath: '/workspace', env: { A: '1' }, first: { shell: 'echo first-ran' }, containerMode: 'sock', volumes: ['/:/host'] },
            agents: { default: { agentId: 'default', agentName: 'AGENT 1', engineSessionId: 'sess-1', messages: [] } }
        });
        fs.mkdirSync(path.join(home, 'web-history', 'events'), { recursive: true });
        fs.writeFileSync(path.join(home, 'web-history', 'events', 'src1.jsonl'), `${JSON.stringify({ id: 'e1', type: 'session.ready', version: 1, aggregateId: 'src1', sessionId: 'src1', seq: 1, timestamp: 't', data: {} })}\n`);
        const created = await api('POST', '/api/exports', { containers: ['src1'], tier: 'light', output: 'server' });
        for (let i = 0; i < 50; i += 1) {
            const job = (await api('GET', `/api/jobs/${created.json.jobId}`)).json.job;
            if (job.status !== 'running') { expect(job.status).toBe('done'); break; }
            await new Promise(r => setTimeout(r, 50));
        }
        const file = (await api('GET', '/api/exports')).json.files[0].name;

        const inspected = await api('POST', '/api/imports/inspect', { serverFile: file });
        expect(inspected.status).toBe(200);
        expect(inspected.json.containers[0]).toMatchObject({ name: 'src1', nameTaken: true, suggestedName: 'src1-2', risks: { containerMode: 'sock', volumes: ['/:/host'] } });
        expect((await api('POST', '/api/imports/inspect', Buffer.from('not an archive at all'), { 'Content-Type': 'application/octet-stream' })).status).toBe(400);
        expect((await api('POST', '/api/imports/inspect', { serverFile: '../etc/passwd' })).status).toBe(400);

        // 名字被占用 → 拒绝
        expect((await api('POST', '/api/imports', { serverFile: file, plan: { containers: { 0: { name: 'src1', hostPath: '' } } } })).status).toBe(409);
        const imported = await api('POST', '/api/imports', { serverFile: file, plan: { containers: { 0: { name: 'dst1', hostPath: path.join(home, 'newwork'), imageMode: 'same', confirm: {} } } } });
        expect(imported.status).toBe(200);
        expect(imported.json.containers).toEqual(['dst1']);
        const hist = JSON.parse(fs.readFileSync(path.join(home, 'web-history', 'dst1.json'), 'utf8'));
        expect(hist.remark).toBe('源');
        expect(hist.pinned).toBe(true);
        // 没带“Agent 会话记录”以外的？轻量档带了会话记录，所以续接标记保留
        expect(hist.agents.default.engineSessionId).toBe('sess-1');
        // 未确认的高风险设置没有生效
        expect(hist.runtimeSnapshot.containerMode || 'common').not.toBe('sock');
        expect(hist.runtimeSnapshot.volumes || []).toEqual([]);
        const ev = fs.readFileSync(path.join(home, 'web-history', 'events', 'dst1.jsonl'), 'utf8');
        expect(JSON.parse(ev.trim())).toMatchObject({ aggregateId: 'dst1', sessionId: 'dst1', seq: 1 });
        const execLog = fs.existsSync(fakeDockerLog) ? fs.readFileSync(fakeDockerLog, 'utf8') : '';
        expect(execLog).not.toContain('first-ran');
    });

    test('导入工作目录：~/.manyoyo/work 下的子目录可以，其它 ~/.manyoyo 里的位置拒绝', async () => {
        writeHistory('src1', { runtimeSnapshot: { hostPath: path.join(home, 'o'), containerPath: '/workspace' }, agents: { default: { agentId: 'default', messages: [] } } });
        const created = await api('POST', '/api/exports', { containers: ['src1'], tier: 'light', output: 'server' });
        for (let i = 0; i < 50; i += 1) { const j = (await api('GET', `/api/jobs/${created.json.jobId}`)).json.job; if (j.status !== 'running') break; await new Promise(r => setTimeout(r, 50)); }
        const file = (await api('GET', '/api/exports')).json.files[0].name;
        const bad = await api('POST', '/api/imports', { serverFile: file, plan: { containers: { 0: { name: 'dst9', hostPath: path.join(home, '.manyoyo', 'web-history', 'x') } } } });
        expect(bad.status).toBe(400);
        expect(bad.json.error).toContain('~/.manyoyo');
        const ok = await api('POST', '/api/imports', { serverFile: file, plan: { containers: { 0: { name: 'dst9', hostPath: path.join(home, '.manyoyo', 'work', 'dst9') } } } });
        expect(ok.status).toBe(200);
    });

    test('名字预留与清理接口：导出期间别处不能同名新建容器（409）、不能清理历史 / 目录；上传超时设为不限', async () => {
        existing.add('busy2');
        writeHistory('busy2', { agents: { default: { agentId: 'default', messages: [] } } });
        holdCp = new PassThrough();
        const created = await api('POST', '/api/exports', { containers: ['busy2'], items: ['history', 'agentSessions'], output: 'server' });
        expect(created.status).toBe(200);
        await new Promise(r => setTimeout(r, 100));
        const dup = await api('POST', '/api/sessions', { createOptions: { containerName: 'busy2', hostPath: home, containerPath: home } });
        expect(dup.status).toBe(409);
        expect((await api('DELETE', '/api/storage/histories', { names: ['busy2'] })).status).toBe(409);
        expect(handle.server.requestTimeout).toBe(0);
        holdCp.end();
        for (let i = 0; i < 50; i += 1) {
            const job = (await api('GET', `/api/jobs/${created.json.jobId}`)).json.job;
            if (job.status !== 'running') break;
            await new Promise(r => setTimeout(r, 50));
        }
        expect((await api('DELETE', '/api/storage/histories', { names: ['busy2'] })).status).not.toBe(409);
    });

    test('磁盘不足：导出到服务器在开始前被拒（507，不留 .part）；导入按剩余空间限制解包大小，超出就撤销', async () => {
        writeHistory('src1', { runtimeSnapshot: { hostPath: path.join(home, 'oldwork'), containerPath: '/workspace' }, agents: { default: { agentId: 'default', messages: [] } } });
        statfsFree = 100 * 1024 * 1024; // 比 1GiB 安全余量还小
        const refused = await api('POST', '/api/exports', { containers: ['src1'], tier: 'light', output: 'server', estimate: 1000 });
        expect(refused.status).toBe(507);
        expect(refused.json.error).toContain('磁盘');
        const exportsDir = path.join(home, '.manyoyo', 'exports');
        expect(fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir).filter(f => f.endsWith('.part')) : []).toEqual([]);
        // 直接下载模式不看服务器磁盘
        statfsFree = null;
        const created = await api('POST', '/api/exports', { containers: ['src1'], tier: 'light', output: 'download' });
        const full = (await api('GET', created.json.downloadUrl)).buffer;
        statfsFree = 1024 * 1024 * 1024 + 10; // 只够 10 字节解包
        const plan = encodeURIComponent(JSON.stringify({ containers: { 0: { name: 'dst3', hostPath: path.join(home, 'work3'), imageMode: 'same', confirm: {} } } }));
        const result = await request(`${baseUrl}/api/imports?plan=${plan}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: full });
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(fs.existsSync(path.join(home, 'web-history', 'dst3.json'))).toBe(false);
        expect(fs.existsSync(path.join(home, 'work3'))).toBe(false);
    });

    test('上传中途断开：导入失败，新建的东西全部撤销', async () => {
        writeHistory('src1', { runtimeSnapshot: { hostPath: path.join(home, 'oldwork'), containerPath: '/workspace' }, agents: { default: { agentId: 'default', messages: [] } } });
        const created = await api('POST', '/api/exports', { containers: ['src1'], tier: 'light', output: 'download' });
        const full = (await api('GET', created.json.downloadUrl)).buffer;
        const plan = encodeURIComponent(JSON.stringify({ containers: { 0: { name: 'dst2', hostPath: path.join(home, 'work2'), imageMode: 'same', confirm: {} } } }));
        const result = await request(`${baseUrl}/api/imports?plan=${plan}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: full.subarray(0, Math.floor(full.length / 2)) });
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(fs.existsSync(path.join(home, 'web-history', 'dst2.json'))).toBe(false);
        expect(fs.existsSync(path.join(home, 'work2'))).toBe(false);
        const tmp = path.join(home, '.manyoyo', 'tmp');
        expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toEqual([]);
        // 完整上传可以成功
        const ok = await request(`${baseUrl}/api/imports?plan=${plan}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: full });
        expect(ok.status).toBe(200);
        expect(fs.existsSync(path.join(home, 'web-history', 'dst2.json'))).toBe(true);
    });
});
