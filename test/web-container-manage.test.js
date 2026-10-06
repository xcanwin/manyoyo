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
            ['POST', '/api/containers/boxa/network/allow'], ['DELETE', '/api/containers/boxa/network/denied'],
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

            const bad = await request(`${baseUrl}/api/containers/boxa/env`, json(cookie, 'PUT', { text: 'X=a;b' }, { 'If-Match': ok.json.etag }));
            expect(bad.response.status).toBe(400);
            const badKey = await request(`${baseUrl}/api/containers/boxa/env`, json(cookie, 'PUT', { text: '1BAD=x' }, { 'If-Match': ok.json.etag }));
            expect(badKey.response.status).toBe(400);
            const noMatch = await request(`${baseUrl}/api/containers/boxa/env`, json(cookie, 'PUT', { text: 'A=9' }));
            expect(noMatch.response.status).toBe(428);
            const notText = await request(`${baseUrl}/api/containers/boxa/env`, json(cookie, 'PUT', { text: 5 }, { 'If-Match': ok.json.etag }));
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

        test('最近被拦截：按最近时间列出，浏览器后台请求打标记，已放行的不再列出；一键允许后立即下发；清空', async () => {
            const { egressPaths } = require('../lib/egress-sidecar');
            const denied = require('../lib/egress-denied');
            const dir = egressPaths(tempHost).denied;
            fs.mkdirSync(dir, { recursive: true });
            const rec = denied.createRecorder({ dir });
            ['pss.bdstatic.com', 'pss.bdstatic.com', 'www.google.com', 'open.bigmodel.cn'].forEach(host => rec.record({ id: boxA.id, host, port: 443, reason: 'domain' }));
            rec.flush();
            await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { preset: 'allowlist', egress: { domains: ['open.bigmodel.cn'] } } }));
            const r = await request(`${baseUrl}/api/containers/boxa/network`, { headers: { Cookie: cookie } });
            expect(r.json.denied.map(d => [d.host, d.count, d.background]).sort()).toEqual([['pss.bdstatic.com', 2, false], ['www.google.com', 1, true]]);

            const allow = await request(`${baseUrl}/api/containers/boxa/network/allow`, json(cookie, 'POST', { domain: 'pss.bdstatic.com' }));
            expect(allow.response.status).toBe(200);
            expect(allow.json.policy.egress.domains).toEqual(['open.bigmodel.cn', 'pss.bdstatic.com']);
            expect(allow.json.denied.map(d => d.host)).toEqual(['www.google.com']);
            expect(JSON.parse(fs.readFileSync(boxA.network, 'utf-8')).egress.domains).toContain('pss.bdstatic.com');
            // 重复允许：不报错；非法域名 400
            expect((await request(`${baseUrl}/api/containers/boxa/network/allow`, json(cookie, 'POST', { domain: 'pss.bdstatic.com' }))).response.status).toBe(200);
            expect((await request(`${baseUrl}/api/containers/boxa/network/allow`, json(cookie, 'POST', { domain: 'bad domain;' }))).response.status).toBe(400);

            const cleared = await request(`${baseUrl}/api/containers/boxa/network/denied`, json(cookie, 'DELETE', {}));
            expect(cleared.json.denied).toEqual([]);
        });

        test('不是 allowlist 的容器不能一键允许', async () => {
            const r = await request(`${baseUrl}/api/containers/boxa/network/allow`, json(cookie, 'POST', { domain: 'a.example.com' }));
            expect(r.response.status).toBe(400);
        });

        test('建议放行的域名来自当前 env 里的 URL（含容器里改过的），已在列表里的不再建议', async () => {
            fs.appendFileSync(boxA.env, 'ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api\nHTTPS_PROXY=http://proxy.corp.example:3128\nLAN=http://192.168.1.5:80\n');
            const r = await request(`${baseUrl}/api/containers/boxa/network`, { headers: { Cookie: cookie } });
            expect(r.json.suggestedDomains).toEqual(['open.bigmodel.cn']);
            await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { preset: 'allowlist', egress: { domains: ['open.bigmodel.cn'] } } }));
            const after = await request(`${baseUrl}/api/containers/boxa/network`, { headers: { Cookie: cookie } });
            expect(after.json.suggestedDomains).toEqual([]);
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
            // 刚创建的状态目录（容器可能正在创建）不算孤儿
            expect((await request(`${baseUrl}/api/containers/orphans`, { headers: { Cookie: cookie } })).json.orphans).toEqual([]);
            expect((await request(`${baseUrl}/api/containers/orphans/${orphan.id}`, json(cookie, 'DELETE'))).response.status).toBe(409);
            state.writeMeta(tempHost, orphan.id, { id: orphan.id, name: 'gone', createdAt: new Date(Date.now() - 3600 * 1000).toISOString() });
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

            // 创建时填的端口暴露：容器就绪、规则下发后立即监听
            const hostPort = await getFreePort();
            const withExpose = await create({ containerName: 'newbox4', network: { expose: [{ bind: '127.0.0.1', hostPort, port: 8080 }] }, confirmRisk: true });
            expect(withExpose.response.status).toBe(200);
            await new Promise((resolve, reject) => { const c = net.connect(hostPort, '127.0.0.1', () => { c.destroy(); resolve(); }); c.on('error', reject); });
        });
    });
});

describe('容器管理接口：不可信的 box/ 文件与风险判定', () => {
    const { pendingRisks } = require('../lib/web/container-manage');
    test('pendingRisks：open、非本机绑定、极宽出站规则需要确认；窄规则不需要', () => {
        const base = normalizePolicy({});
        expect(pendingRisks(base, normalizePolicy({ preset: 'allowlist', egress: { rules: [{ cidr: '0.0.0.0/0' }] } }))).toEqual(['wide']);
        expect(pendingRisks(base, normalizePolicy({ egress: { rules: [{ cidr: '10.0.0.0/8', ports: '80' }] } }))).toEqual(['wide']);
        expect(pendingRisks(base, normalizePolicy({ preset: 'allowlist', egress: { domains: ['*.co.uk'] } }))).toEqual(['wide']);
        expect(pendingRisks(base, normalizePolicy({ egress: { rules: [{ cidr: '192.168.1.50', ports: '8000' }], domains: ['*.example.com'] } }))).toEqual([]);
        const wide = normalizePolicy({ egress: { rules: [{ cidr: '10.0.0.0/8' }] } });
        expect(pendingRisks(wide, wide)).toEqual([]);
    });
});

describe('网络策略里的端口暴露随「保存网络规则」一起生效', () => {
    test('PUT network 带 expose：立即监听；端口被占时 409 + 原因；非本机绑定要 confirmRisk', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-expose-'));
        const st = state.createState({ homeDir: tempHost, network: normalizePolicy({}), netRequired: true, meta: { name: 'boxa' } });
        const port = await getFreePort();
        const hostPort = await getFreePort();
        const handle = await startWebServer({
            serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: 'topsecret', authPassAuto: false,
            dockerCmd: 'docker', hostPath: tempHost, homeDir: tempHost, containerPath: '/workspace',
            imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common',
            execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
            validateHostPath: () => {}, formatDate: () => '0101-0000',
            isValidContainerName: value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value),
            containerExists: name => name === 'boxa', getContainerStatus: () => 'running', waitForContainerReady: async () => {},
            dockerExecArgs: args => (args[0] === 'inspect' && String(args[2]).includes('manyoyo.id') ? st.id : ''),
            networkManager: { ensureBridgeNetwork: async () => {}, apply: async () => ({ status: 'applied' }), ensureReady: async () => ({}), relatedContainers: async () => [], listManaged: async () => [{ id: st.id, name: 'boxa', running: true }] },
            showImagePullHint: () => {}, removeContainer: () => {},
            webHistoryDir: path.join(tempHost, 'web-history'), webConfigPath: path.join(tempHost, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' }
        });
        try {
            const base = `http://127.0.0.1:${handle.port || port}`;
            const login = await request(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'webadmin', password: 'topsecret' }) });
            const cookie = login.response.headers.get('set-cookie').split(';')[0];
            const put = body => request(`${base}/api/containers/boxa/network`, json(cookie, 'PUT', body));

            const ok = await put({ policy: { expose: [{ bind: '127.0.0.1', hostPort, port: 8080 }] } });
            expect(ok.response.status).toBe(200);
            expect(ok.json.forwards).toEqual([{ bind: '127.0.0.1', hostPort, port: 8080 }]);
            await new Promise((resolve, reject) => { const s = net.connect(hostPort, '127.0.0.1', () => { s.destroy(); resolve(); }); s.on('error', reject); });

            const wide = await put({ policy: { expose: [{ bind: '0.0.0.0', hostPort: await getFreePort(), port: 8081 }] } });
            expect(wide.response.status).toBe(400);
            expect(wide.json.risks).toEqual(['publicBind']);

            const blocker = net.createServer();
            const busyPort = await new Promise(resolve => blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port)));
            const busy = await put({ policy: { expose: [{ bind: '127.0.0.1', hostPort, port: 8080 }, { bind: '127.0.0.1', hostPort: busyPort, port: 9000 }] } });
            await new Promise(resolve => blocker.close(resolve));
            expect(busy.response.status).toBe(409);
            expect(busy.json.error).toContain('已被占用');

            const cleared = await put({ policy: { expose: [] } });
            expect(cleared.json.forwards).toEqual([]);
        } finally {
            await handle.close();
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });
});

describe('环境变量文件接口', () => {
    test('GET 返回文件状态（不回传值）；PUT 带 files 时校验绝对路径、写入列表；文件内容改了下一次读取就是新的', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-envfiles-'));
        const file = path.join(dir, 'shared.env');
        fs.writeFileSync(file, 'TOKEN_X=secret-from-file\nBAD=a&b\n');
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-envfiles-home-'));
        const st = state.createState({ homeDir: tmpHome, envFiles: [file], network: normalizePolicy({}), netRequired: true, meta: { name: 'boxa' } });
        const port = await getFreePort();
        const handle = await startWebServer({
            serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: 'topsecret', authPassAuto: false,
            dockerCmd: 'docker', hostPath: tmpHome, homeDir: tmpHome, containerPath: '/workspace',
            imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common',
            execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
            validateHostPath: () => {}, formatDate: () => '0101-0000',
            isValidContainerName: value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value),
            containerExists: name => name === 'boxa', getContainerStatus: () => 'running', waitForContainerReady: async () => {},
            dockerExecArgs: args => (args[0] === 'inspect' && String(args[2]).includes('manyoyo.id') ? st.id : ''),
            networkManager: { ensureBridgeNetwork: async () => {}, apply: async () => ({}), ensureReady: async () => ({}), relatedContainers: async () => [], listManaged: async () => [] },
            showImagePullHint: () => {}, removeContainer: () => {},
            webHistoryDir: path.join(tmpHome, 'web-history'), webConfigPath: path.join(tmpHome, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' }
        });
        try {
            const base = `http://127.0.0.1:${handle.port || port}`;
            const login = await request(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'webadmin', password: 'topsecret' }) });
            const cookie = login.response.headers.get('set-cookie').split(';')[0];
            const get = await request(`${base}/api/containers/boxa/env`, { headers: { Cookie: cookie } });
            expect(get.json.files).toEqual([expect.objectContaining({ path: file, exists: true, count: 1 })]);
            expect(get.json.files[0].invalid).toEqual([expect.objectContaining({ line: 2 })]);
            expect(get.text).not.toContain('secret-from-file');

            const bad = await request(`${base}/api/containers/boxa/env`, json(cookie, 'PUT', { text: '', files: ['relative.env'] }, { 'If-Match': get.json.etag }));
            expect(bad.response.status).toBe(400);
            const file2 = path.join(dir, 'missing.env');
            const put = await request(`${base}/api/containers/boxa/env`, json(cookie, 'PUT', { text: 'A=1', files: [file, file2] }, { 'If-Match': get.json.etag }));
            expect(put.response.status).toBe(200);
            expect(put.json.files.map(f => [f.path, f.exists])).toEqual([[file, true], [file2, false]]);
            expect(state.readEnvFileList(tmpHome, st.id)).toEqual([file, file2]);
        } finally {
            await handle.close();
            fs.rmSync(dir, { recursive: true, force: true });
            fs.rmSync(tmpHome, { recursive: true, force: true });
        }
    });
});
