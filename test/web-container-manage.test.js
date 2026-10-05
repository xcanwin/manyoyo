'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { startWebServer } = require('../lib/web/server');
const state = require('../lib/container-state');
const { normalizePolicy } = require('../lib/network-policy');

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
    const merged = { ...options };
    if (method !== 'GET' && method !== 'HEAD') {
        merged.headers = { 'X-Requested-With': 'XMLHttpRequest', ...(options.headers || {}) };
    }
    const response = await fetch(url, merged);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { response, text, json };
}

const json = (cookie, method, body, extra = {}) => ({
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body)
});

describe('Web 容器管理接口（env / 自启动 / 网络 / 端口暴露 / 孤儿）', () => {
    let tempHost;
    let handle;
    let baseUrl;
    let cookie;
    let boxA;
    let boxB;
    let applied;
    let applyError;
    let managed;
    let fakeDocker;

    async function start(overrides = {}) {
        const port = await getFreePort();
        applied = [];
        applyError = '';
        managed = [
            { id: boxA.id, name: 'boxa', running: true },
            { id: boxB.id, name: 'boxb', running: true }
        ];
        fakeDocker = path.join(tempHost, 'docker');
        fs.writeFileSync(fakeDocker, '#!/bin/sh\necho started\n', { mode: 0o755 });
        handle = await startWebServer({
            serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: 'topsecret', authPassAuto: false,
            dockerCmd: fakeDocker, hostPath: tempHost, homeDir: tempHost, containerPath: '/workspace',
            imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common',
            execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
            validateHostPath: () => {}, formatDate: () => '0101-0000',
            isValidContainerName: value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value),
            containerExists: name => ['boxa', 'boxb', 'legacy'].includes(name),
            getContainerStatus: () => 'running',
            waitForContainerReady: async () => {},
            dockerExecArgs: args => {
                if (args[0] === 'inspect' && String(args[2]).includes('manyoyo.id')) {
                    return { boxa: boxA.id, boxb: boxB.id }[args[3]] || '';
                }
                return '';
            },
            networkManager: {
                ensureBridgeNetwork: async () => {},
                apply: async (name, opts) => { applied.push([name, opts && opts.expectId]); if (applyError) throw new Error(applyError); return { status: 'applied' }; },
                ensureReady: async () => ({ status: 'applied' }),
                relatedContainers: async () => [],
                listManaged: async () => managed
            },
            showImagePullHint: () => {}, removeContainer: () => {},
            webHistoryDir: path.join(tempHost, 'web-history'), webConfigPath: path.join(tempHost, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' },
            ...overrides
        });
        baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await request(`${baseUrl}/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'webadmin', password: 'topsecret' })
        });
        cookie = login.response.headers.get('set-cookie').split(';')[0];
    }

    beforeEach(async () => {
        tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-manage-'));
        boxA = state.createState({ homeDir: tempHost, envLines: ['A=1', 'SECRET_TOKEN=abc'], autostart: 'echo hi\n', network: normalizePolicy({}), netRequired: true, meta: { name: 'boxa' } });
        boxB = state.createState({ homeDir: tempHost, network: normalizePolicy({}), netRequired: true, meta: { name: 'boxb' } });
        await start();
    });
    afterEach(async () => {
        if (handle) await handle.close();
        handle = null;
        fs.rmSync(tempHost, { recursive: true, force: true });
    });

    describe('认证网关', () => {
        const routes = [
            ['GET', '/api/containers/boxa/env'], ['PUT', '/api/containers/boxa/env'],
            ['GET', '/api/containers/boxa/autostart'], ['PUT', '/api/containers/boxa/autostart'],
            ['POST', '/api/containers/boxa/autostart/run'], ['GET', '/api/containers/boxa/autostart/log'],
            ['GET', '/api/containers/boxa/network'], ['PUT', '/api/containers/boxa/network'],
            ['POST', '/api/containers/boxa/expose'], ['DELETE', '/api/containers/boxa/expose'],
            ['GET', '/api/containers/orphans'], ['DELETE', '/api/containers/orphans/0123456789abcdef']
        ];
        test.each(routes)('未登录 %s %s → 401', async (method, url) => {
            const r = await request(`${baseUrl}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
            expect(r.response.status).toBe(401);
        });

        test('登录后可用，登出后失效；写请求缺 X-Requested-With → 403', async () => {
            expect((await request(`${baseUrl}/api/containers/boxa/env`, { headers: { Cookie: cookie } })).response.status).toBe(200);
            const noCsrf = await fetch(`${baseUrl}/api/containers/boxa/env`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"text":"A=2"}' });
            expect(noCsrf.status).toBe(403);
            await request(`${baseUrl}/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
            expect((await request(`${baseUrl}/api/containers/boxa/env`, { headers: { Cookie: cookie } })).response.status).toBe(401);
        });
    });

    describe('env', () => {
        test('读：文本、解析结果、etag；容器里追加的非法行被报出', async () => {
            fs.appendFileSync(boxA.env, '1BAD=x\n');
            const r = await request(`${baseUrl}/api/containers/boxa/env`, { headers: { Cookie: cookie } });
            expect(r.response.status).toBe(200);
            expect(r.json.entries.map(e => e.key)).toEqual(['A', 'SECRET_TOKEN']);
            expect(r.json.invalid).toEqual([expect.objectContaining({ line: 3, text: '1BAD=x' })]);
            expect(r.json.etag).toMatch(/^[0-9a-f]{16}$/);
        });

        test('写：If-Match 一致才写；容器同时改过返回 409 并带最新内容；非法值 400', async () => {
            const read = await request(`${baseUrl}/api/containers/boxa/env`, { headers: { Cookie: cookie } });
            fs.appendFileSync(boxA.env, 'FROM_CONTAINER=1\n');
            const conflict = await request(`${baseUrl}/api/containers/boxa/env`, json(cookie, 'PUT', { text: 'A=2' }, { 'If-Match': read.json.etag }));
            expect(conflict.response.status).toBe(409);
            expect(conflict.json.conflict).toBe(true);
            expect(conflict.json.text).toContain('FROM_CONTAINER=1');

            const ok = await request(`${baseUrl}/api/containers/boxa/env`, json(cookie, 'PUT', { text: 'A=2\nC=3' }, { 'If-Match': conflict.json.etag }));
            expect(ok.response.status).toBe(200);
            expect(fs.readFileSync(boxA.env, 'utf-8')).toBe('A=2\nC=3\n');

            const bad = await request(`${baseUrl}/api/containers/boxa/env`, json(cookie, 'PUT', { text: 'X=a;b' }));
            expect(bad.response.status).toBe(400);
            const badKey = await request(`${baseUrl}/api/containers/boxa/env`, json(cookie, 'PUT', { text: '1BAD=x' }));
            expect(badKey.response.status).toBe(400);
            const notText = await request(`${baseUrl}/api/containers/boxa/env`, json(cookie, 'PUT', { text: 5 }));
            expect(notText.response.status).toBe(400);
        });

        test('旧容器（无 manyoyo.id）：GET 返回 legacy，PUT 409；不存在的容器 404；非法容器名 400', async () => {
            const legacy = await request(`${baseUrl}/api/containers/legacy/env`, { headers: { Cookie: cookie } });
            expect(legacy.json).toEqual(expect.objectContaining({ legacy: true }));
            const put = await request(`${baseUrl}/api/containers/legacy/env`, json(cookie, 'PUT', { text: 'A=1' }));
            expect(put.response.status).toBe(409);
            expect(put.json.legacy).toBe(true);
            expect((await request(`${baseUrl}/api/containers/nothere/env`, { headers: { Cookie: cookie } })).response.status).toBe(404);
            expect((await request(`${baseUrl}/api/containers/${encodeURIComponent('a b;c')}/env`, { headers: { Cookie: cookie } })).response.status).toBe(400);
        });
    });

    describe('自启动', () => {
        test('读写脚本与“serve 启动时自动拉起”；日志只读尾部', async () => {
            const put = await request(`${baseUrl}/api/containers/boxa/autostart`, json(cookie, 'PUT', { script: 'echo changed\n', autostartOnServe: true }));
            expect(put.response.status).toBe(200);
            expect(put.json).toEqual(expect.objectContaining({ script: 'echo changed\n', autostartOnServe: true }));
            expect(fs.readFileSync(boxA.autostart, 'utf-8')).toBe('echo changed\n');
            expect(JSON.parse(fs.readFileSync(boxA.network, 'utf-8')).autostartOnServe).toBe(true);

            fs.writeFileSync(boxA.autostartLog, `${'x'.repeat(100000)}\nTAIL-MARK`);
            const log = await request(`${baseUrl}/api/containers/boxa/autostart/log?tail=2048`, { headers: { Cookie: cookie } });
            expect(log.json.log.length).toBe(2048);
            expect(log.json.log.endsWith('TAIL-MARK')).toBe(true);
        });

        test('立即运行：先过网络门闩（ensureReady），再 exec', async () => {
            const r = await request(`${baseUrl}/api/containers/boxa/autostart/run`, json(cookie, 'POST', {}));
            expect(r.response.status).toBe(200);
            expect(r.json).toEqual({ started: true });
        });
    });

    describe('网络', () => {
        test('读：策略、下发状态、可选的其他容器', async () => {
            const r = await request(`${baseUrl}/api/containers/boxa/network`, { headers: { Cookie: cookie } });
            expect(r.json.policy.preset).toBe('restricted');
            expect(r.json.peers).toEqual([{ id: boxB.id, name: 'boxb', running: true }]);
            expect(r.json.running).toBe(true);
        });

        test('保存即下发；放开成 open 需要二次确认（服务端也校验）', async () => {
            const hostRule = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { host: [{ ports: '18601' }] } }));
            expect(hostRule.response.status).toBe(200);
            expect(applied).toEqual([['boxa', boxA.id]]);
            expect(state.readNetworkRaw(tempHost, boxA.id).host).toEqual([{ ports: '18601', proto: 'tcp' }]);

            const open = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { preset: 'open' } }));
            expect(open.response.status).toBe(400);
            expect(open.json).toEqual(expect.objectContaining({ needsConfirm: true, risks: ['open'] }));
            expect(state.readNetworkRaw(tempHost, boxA.id).preset).toBe('restricted');

            const confirmed = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { preset: 'open' }, confirmRisk: true }));
            expect(confirmed.response.status).toBe(200);
            expect(fs.existsSync(boxA.netRequired)).toBe(false);
        });

        test('下发失败显式报错（502 + 原因），策略已保存；非法策略与不存在的 peer 400', async () => {
            applyError = '网络规则下发失败: boom';
            const r = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { host: [{ ports: '80' }] } }));
            expect(r.response.status).toBe(502);
            expect(r.json.error).toContain('boom');
            expect(r.json.policy.host).toEqual([{ ports: '80', proto: 'tcp' }]);
            applyError = '';

            const bad = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { host: [{ ports: '80; flush ruleset' }] } }));
            expect(bad.response.status).toBe(400);
            const ghost = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { peers: { inbound: [{ from: 'ffffffffffffffff', ports: '7000' }] } } }));
            expect(ghost.response.status).toBe(400);
            const noBody = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', {}));
            expect(noBody.response.status).toBe(400);
            const ok = await request(`${baseUrl}/api/containers/boxb/network`, json(cookie, 'PUT', { policy: { peers: { inbound: [{ from: boxA.id, ports: '7000' }] } } }));
            expect(ok.response.status).toBe(200);
        });
    });

    describe('端口暴露', () => {
        test('加：立即监听；非本机绑定要确认；端口被占 409；删：释放端口', async () => {
            const hostPort = await getFreePort();
            const added = await request(`${baseUrl}/api/containers/boxa/expose`, json(cookie, 'POST', { bind: '127.0.0.1', hostPort, port: 8080 }));
            expect(added.response.status).toBe(200);
            expect(added.json.forwards).toEqual([{ bind: '127.0.0.1', hostPort, port: 8080 }]);
            expect(state.readNetworkRaw(tempHost, boxA.id).expose).toEqual([{ bind: '127.0.0.1', hostPort, port: 8080 }]);
            await new Promise((resolve, reject) => { const s = net.connect(hostPort, '127.0.0.1', () => { s.destroy(); resolve(); }); s.on('error', reject); });

            const wide = await request(`${baseUrl}/api/containers/boxa/expose`, json(cookie, 'POST', { bind: '0.0.0.0', hostPort: await getFreePort(), port: 8081 }));
            expect(wide.response.status).toBe(400);
            expect(wide.json.risks).toEqual(['publicBind']);

            const busy = await request(`${baseUrl}/api/containers/boxb/expose`, json(cookie, 'POST', { bind: '127.0.0.1', hostPort, port: 9000 }));
            expect(busy.response.status).toBe(409);
            expect(busy.json.error).toContain('已被占用');
            expect(state.readNetworkRaw(tempHost, boxB.id).expose || []).toEqual([]);

            const removed = await request(`${baseUrl}/api/containers/boxa/expose`, json(cookie, 'DELETE', { bind: '127.0.0.1', hostPort }));
            expect(removed.response.status).toBe(200);
            expect(removed.json.forwards).toEqual([]);
            await expect(new Promise((resolve, reject) => { const s = net.connect(hostPort, '127.0.0.1', () => { s.destroy(); resolve(); }); s.on('error', reject); })).rejects.toBeTruthy();
            expect((await request(`${baseUrl}/api/containers/boxa/expose`, json(cookie, 'DELETE', { bind: '127.0.0.1', hostPort }))).response.status).toBe(404);
        });
    });

    describe('孤儿状态目录', () => {
        test('列出没有对应容器的状态目录，只能删孤儿', async () => {
            const orphan = state.createState({ homeDir: tempHost, meta: { name: 'gone' } });
            const list = await request(`${baseUrl}/api/containers/orphans`, { headers: { Cookie: cookie } });
            expect(list.json.orphans).toEqual([expect.objectContaining({ id: orphan.id, name: 'gone' })]);

            const live = await request(`${baseUrl}/api/containers/orphans/${boxA.id}`, json(cookie, 'DELETE'));
            expect(live.response.status).toBe(409);
            expect(fs.existsSync(boxA.dir)).toBe(true);

            const removed = await request(`${baseUrl}/api/containers/orphans/${orphan.id}`, json(cookie, 'DELETE'));
            expect(removed.response.status).toBe(200);
            expect(fs.existsSync(orphan.dir)).toBe(false);
            expect((await request(`${baseUrl}/api/containers/orphans/..%2F..`, json(cookie, 'DELETE'))).response.status).toBe(404);
        });
    });

    describe('新建会话带自启动与网络', () => {
        test('autostart / network 写进状态目录；open 或非本机绑定没有 confirmRisk 时 400', async () => {
            const create = body => request(`${baseUrl}/api/sessions`, json(cookie, 'POST', { createOptions: { hostPath: tempHost, imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common', ...body } }));
            const risky = await create({ containerName: 'newbox1', network: { preset: 'open' } });
            expect(risky.response.status).toBe(400);
            expect(risky.text).toContain('confirmRisk');

            const ok = await create({ containerName: 'newbox2', autostart: 'echo boot\n', autostartOnServe: true, network: { host: [{ ports: '18601' }] } });
            expect(ok.response.status).toBe(200);
            expect(ok.json.applied).toEqual(expect.objectContaining({ autostartEnabled: true, networkPreset: 'restricted' }));
            const ids = state.listStateIds(tempHost).filter(id => ![boxA.id, boxB.id].includes(id));
            expect(ids).toHaveLength(1);
            expect(fs.readFileSync(state.paths(tempHost, ids[0]).autostart, 'utf-8')).toBe('echo boot\n');
            const policy = state.readNetworkRaw(tempHost, ids[0]);
            expect(policy).toEqual(expect.objectContaining({ preset: 'restricted', autostartOnServe: true, host: [{ ports: '18601', proto: 'tcp' }] }));
            expect(applied.some(([name]) => name === 'newbox2')).toBe(true);

            const confirmed = await create({ containerName: 'newbox3', network: { preset: 'open' }, confirmRisk: true });
            expect(confirmed.response.status).toBe(200);
        });
    });
});
