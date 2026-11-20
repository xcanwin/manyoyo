'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { startWebServer } = require('../lib/web/server');
const state = require('../lib/container-state');
const extensionsStore = require('../lib/extensions-store');
const extensionsApply = require('../lib/extensions-apply');
const { normalizePolicy } = require('../lib/network-policy');
const allowRow = (target, extra = {}) => ({ action: 'allow', target, ports: '', proto: 'all', enabled: true, ...extra });

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
    let relatedQueue;
    let applyError;
    let managed;
    let fakeDocker;

    async function start(overrides = {}) {
        const port = await getFreePort();
        applied = [];
        relatedQueue = [];
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
                resolveRefs: async policy => policy,
                apply: async (name, opts) => { applied.push([name, opts && opts.expectId]); if (applyError) throw new Error(applyError); return { status: 'applied' }; },
                ensureReady: async () => ({ status: 'applied' }),
                relatedContainers: async () => relatedQueue.length ? relatedQueue.shift() : [],
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
            ['GET', '/api/containers/boxa/system-prompt'], ['PUT', '/api/containers/boxa/system-prompt'],
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
            expect(noMatch.json.error).toBe('页面已更新，请刷新页面后再保存');
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

    describe('启动 / 停止容器', () => {
        test('未登录 401；停止走 docker stop，启动走统一的拉起路径；容器不存在 404', async () => {
            const calls = [];
            await handle.close();
            await start({
                dockerExecAsync: async args => { calls.push(args); return ''; },
                getContainerStatus: () => 'exited',
                dockerExecArgs: args => { calls.push(args); return args[0] === 'inspect' ? '' : ''; }
            });
            const anon = await request(`${baseUrl}/api/sessions/boxa/container/stop`, { method: 'POST' });
            expect(anon.response.status).toBe(401);
            const stop = await request(`${baseUrl}/api/sessions/boxa/container/stop`, json(cookie, 'POST', {}));
            expect(stop.response.status).toBe(200);
            expect(calls).toContainEqual(['stop', '-t', '10', 'boxa']);
            const startRes = await request(`${baseUrl}/api/sessions/boxa/container/start`, json(cookie, 'POST', {}));
            expect(startRes.response.status).toBe(200);
            expect(calls).toContainEqual(['start', 'boxa']);
            const missing = await request(`${baseUrl}/api/sessions/nobody/container/stop`, json(cookie, 'POST', {}));
            expect(missing.response.status).toBe(404);
        });
    });

    describe('系统提示词', () => {
        test('没存过时显示按系统设置现算的内容；保存后以容器自己的为准，格式不对 400', async () => {
            const first = await request(`${baseUrl}/api/containers/boxa/system-prompt`, { headers: { Cookie: cookie } });
            expect(first.json).toEqual(expect.objectContaining({ legacy: false, enabled: true }));
            expect(first.json.text).toContain('网页');

            const bad = await request(`${baseUrl}/api/containers/boxa/system-prompt`, json(cookie, 'PUT', { text: 1, enabled: true }));
            expect(bad.response.status).toBe(400);

            const put = await request(`${baseUrl}/api/containers/boxa/system-prompt`, json(cookie, 'PUT', { text: '只给这个容器', enabled: false }));
            expect(put.json).toEqual(expect.objectContaining({ text: '只给这个容器', enabled: false }));
            expect(state.readSystemPrompt(tempHost, boxA.id)).toEqual({ enabled: false, text: '只给这个容器' });
        });

        test('新建时填的提示词写进状态目录；没填就按系统设置现算', async () => {
            const create = ({ run, ...body } = {}) => request(`${baseUrl}/api/sessions`, json(cookie, 'POST', { ...(run ? { run } : {}), createOptions: { hostPath: tempHost, imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common', ...body } }));
            const before = new Set(state.listStateIds(tempHost));
            const withPrompt = await create({ containerName: 'promptbox1', systemPrompt: { enabled: false, text: '创建时写的' } });
            expect(withPrompt.response.status).toBe(200);
            const first = state.listStateIds(tempHost).find(id => !before.has(id));
            expect(state.readSystemPrompt(tempHost, first)).toEqual({ enabled: false, text: '创建时写的' });

            const bad = await create({ containerName: 'promptbox2', systemPrompt: { text: 1 } });
            expect(bad.response.status).toBe(400);

            const seen = new Set(state.listStateIds(tempHost));
            const plain = await create({ containerName: 'promptbox3' });
            expect(plain.response.status).toBe(200);
            const second = state.listStateIds(tempHost).find(id => !seen.has(id));
            expect(state.readSystemPrompt(tempHost, second)).toEqual(expect.objectContaining({ enabled: true }));
            expect(state.readSystemPrompt(tempHost, second).text).toContain('网页');
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
            expect(r.json.peers).toEqual([{ id: boxB.id, name: 'boxb', running: true, ip: '' }]);
            expect(r.json.derived).toEqual([]);
            expect(r.json.unrestricted).toBe(false);
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
            await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { preset: 'allowlist', outbound: [allowRow('open.bigmodel.cn')] } }));
            const r = await request(`${baseUrl}/api/containers/boxa/network`, { headers: { Cookie: cookie } });
            expect(r.json.denied.map(d => [d.host, d.count, d.background]).sort()).toEqual([['pss.bdstatic.com', 2, false], ['www.google.com', 1, true]]);

            const allow = await request(`${baseUrl}/api/containers/boxa/network/allow`, json(cookie, 'POST', { domain: 'pss.bdstatic.com' }));
            expect(allow.response.status).toBe(200);
            expect(allow.json.policy.outbound.map(r => r.target)).toEqual(['pss.bdstatic.com', 'open.bigmodel.cn']);
            expect(allow.json.denied.map(d => d.host)).toEqual(['www.google.com']);
            expect(JSON.parse(fs.readFileSync(boxA.network, 'utf-8')).outbound.map(r => r.target)).toContain('pss.bdstatic.com');
            // 重复允许：不报错；非法域名 400
            expect((await request(`${baseUrl}/api/containers/boxa/network/allow`, json(cookie, 'POST', { domain: 'pss.bdstatic.com' }))).response.status).toBe(200);
            expect((await request(`${baseUrl}/api/containers/boxa/network/allow`, json(cookie, 'POST', { domain: 'bad domain;' }))).response.status).toBe(400);

            const cleared = await request(`${baseUrl}/api/containers/boxa/network/denied`, json(cookie, 'DELETE', {}));
            expect(cleared.json.denied).toEqual([]);
        });

        test('任何模式都能一键允许：收紧下插到出站规则最前面', async () => {
            await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { outbound: [allowRow('192.168.1.5', { ports: '80' })] } }));
            const r = await request(`${baseUrl}/api/containers/boxa/network/allow`, json(cookie, 'POST', { domain: 'a.example.com' }));
            expect(r.response.status).toBe(200);
            expect(r.json.policy.preset).toBe('restricted');
            expect(r.json.policy.outbound.map(row => row.target)).toEqual(['a.example.com', '192.168.1.5']);
        });

        test('一键允许一个已被拒绝规则盖住的域名，仍然插到最前面（第一条命中的生效）', async () => {
            await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { outbound: [{ action: 'deny', target: '*.example.com' }] } }));
            const r = await request(`${baseUrl}/api/containers/boxa/network/allow`, json(cookie, 'POST', { domain: 'a.example.com' }));
            expect(r.json.policy.outbound.map(row => `${row.action} ${row.target}`)).toEqual(['allow a.example.com', 'deny *.example.com']);
        });

        test('建议放行的域名来自当前 env 里的 URL（含容器里改过的），已在列表里的不再建议', async () => {
            fs.appendFileSync(boxA.env, 'ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api\nHTTPS_PROXY=http://proxy.corp.example:3128\nLAN=http://192.168.1.5:80\n');
            const r = await request(`${baseUrl}/api/containers/boxa/network`, { headers: { Cookie: cookie } });
            expect(r.json.suggestedDomains).toEqual(['open.bigmodel.cn']);
            await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { preset: 'allowlist', outbound: [allowRow('open.bigmodel.cn')] } }));
            const after = await request(`${baseUrl}/api/containers/boxa/network`, { headers: { Cookie: cookie } });
            expect(after.json.suggestedDomains).toEqual([]);
        });

        test('配了官方 Key 但没配 BASE_URL：建议放行该 Agent 的官方域名', async () => {
            fs.appendFileSync(boxA.env, 'ANTHROPIC_AUTH_TOKEN=sk-x\n');
            const r = await request(`${baseUrl}/api/containers/boxa/network`, { headers: { Cookie: cookie } });
            expect(r.json.suggestedDomains).toEqual(['api.anthropic.com']);
        });

        test('保存即下发；切到自定义需要二次确认（服务端也校验）；只有“允许 @any”时不再要求网络规则', async () => {
            const hostRule = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { outbound: [allowRow('@host', { ports: '18601', proto: 'tcp' })] } }));
            expect(hostRule.response.status).toBe(200);
            expect(applied).toEqual([['boxa', boxA.id]]);
            expect(state.readNetworkRaw(tempHost, boxA.id).outbound).toEqual([allowRow('@host', { ports: '18601', proto: 'tcp' })]);

            const custom = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { preset: 'custom', outbound: [allowRow('@any')], inbound: [{ action: 'allow', source: '@any', ports: '', proto: 'all', enabled: true }] } }));
            expect(custom.response.status).toBe(400);
            expect(custom.json).toEqual(expect.objectContaining({ needsConfirm: true, risks: ['custom'] }));
            expect(state.readNetworkRaw(tempHost, boxA.id).preset).toBe('restricted');

            const confirmed = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { preset: 'custom', outbound: [allowRow('@any')], inbound: [] }, confirmRisk: true }));
            expect(confirmed.response.status).toBe(200);
            expect(confirmed.json.unrestricted).toBe(true);
            expect(fs.existsSync(boxA.netRequired)).toBe(false);
        });

        test('收紧里新增很宽的允许行需要确认；窄规则、暂停行、拒绝行不需要', async () => {
            const put = (outbound, extra = {}) => request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { outbound }, ...extra }));
            expect((await put([allowRow('@private')])).json.risks).toEqual(['wide']);
            expect((await put([allowRow('@host')])).json.risks).toEqual(['wide']);
            expect((await put([allowRow('@host', { ports: '11434' })])).response.status).toBe(200);
            expect((await put([allowRow('@private', { enabled: false })])).response.status).toBe(200);
            expect((await put([{ action: 'deny', target: '@any', ports: '', proto: 'all', enabled: true }])).response.status).toBe(200);
            expect((await put([allowRow('@private')], { confirmRisk: true })).response.status).toBe(200);
        });

        test('保存时旧规则关联的容器也重算（撤掉“允许 @container:Y”后，Y 出站里的派生行要去掉）', async () => {
            relatedQueue = [['boxb'], []]; // 保存前（旧规则）关联 boxb，保存后（新规则）不再关联
            const r = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: {} }));
            expect(r.response.status).toBe(200);
            expect(applied.map(([name]) => name)).toEqual(['boxa', 'boxb']);
        });

        test('入站里的 @container:<名称> 保存时换成 id；找不到容器 400；容器已删的 id 保留', async () => {
            const byName = await request(`${baseUrl}/api/containers/boxb/network`, json(cookie, 'PUT', { policy: { inbound: [{ action: 'allow', source: '@container:boxa', ports: '7000', proto: 'tcp' }] } }));
            expect(byName.response.status).toBe(200);
            expect(byName.json.policy.inbound[0].source).toBe(`@container:${boxA.id}`);
            const ghost = await request(`${baseUrl}/api/containers/boxb/network`, json(cookie, 'PUT', { policy: { inbound: [{ action: 'allow', source: '@container:nobody', ports: '7000' }] } }));
            expect(ghost.response.status).toBe(400);
            expect(ghost.json.error).toContain('找不到容器');
            const gone = await request(`${baseUrl}/api/containers/boxb/network`, json(cookie, 'PUT', { policy: { inbound: [{ action: 'allow', source: '@container:ffffffffffffffff', ports: '7000' }] } }));
            expect(gone.response.status).toBe(200);
        });

        test('旧格式（v1）的 network.json 读出来是 v2，保存后写成 v2', async () => {
            state.writeNetworkRaw(tempHost, boxA.id, { version: 1, preset: 'restricted', host: [{ ports: '11434', proto: 'tcp' }], egress: { domains: [], rules: [] }, peers: { inbound: [] }, deny: [], expose: [], autostartOnServe: false });
            const r = await request(`${baseUrl}/api/containers/boxa/network`, { headers: { Cookie: cookie } });
            expect(r.json.policy.version).toBe(2);
            expect(r.json.policy.outbound).toEqual([allowRow('@host', { ports: '11434', proto: 'tcp' })]);
            await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: r.json.policy }));
            expect(state.readNetworkRaw(tempHost, boxA.id).version).toBe(2);
        });

        test('下发失败显式报错（502 + 原因），策略已保存；非法策略 400', async () => {
            applyError = '网络规则下发失败: boom';
            const r = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { outbound: [allowRow('@host', { ports: '80' })] } }));
            expect(r.response.status).toBe(502);
            expect(r.json.error).toContain('boom');
            expect(r.json.policy.outbound).toEqual([allowRow('@host', { ports: '80' })]);
            applyError = '';

            const bad = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { outbound: [allowRow('@host', { ports: '80; flush ruleset' })] } }));
            expect(bad.response.status).toBe(400);
            const cont = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { outbound: [allowRow('@manyoyo')] } }));
            expect(cont.response.status).toBe(400);
            expect(cont.json.error).toContain('始终允许');
            const noBody = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', {}));
            expect(noBody.response.status).toBe(400);
        });
    });

    describe('端口暴露', () => {
        test('加：立即监听；非本机绑定要确认；端口被占 409；删：释放端口', async () => {
            const hostPort = await getFreePort();
            const added = await request(`${baseUrl}/api/containers/boxa/expose`, json(cookie, 'POST', { bind: '127.0.0.1', hostPort, port: 8080 }));
            expect(added.response.status).toBe(200);
            expect(added.json.forwards).toEqual([{ bind: '127.0.0.1', hostPort, port: 8080 }]);
            expect(added.json.hostIps[0]).toBe('127.0.0.1');
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

    describe('共享扩展状态', () => {
        test('state.pending=true 时 shared.pending 为 true；完整成功（pending 不在）且哈希一致才为 false', async () => {
            const currentHash = extensionsStore.catalogHash(tempHost);
            extensionsApply.writeState(tempHost, boxA.id, {
                mode: 'mount',
                catalogHash: currentHash,
                pending: true,
                skills: { claude: [], codex: [] },
                mcp: { claude: [], codex: [] },
                conflicts: []
            });
            const failed = await request(`${baseUrl}/api/sessions/boxa/extensions`, { headers: { Cookie: cookie } });
            expect(failed.response.status).toBe(200);
            expect(failed.json.shared).toEqual(expect.objectContaining({ pending: true, mode: 'mount' }));

            extensionsApply.writeState(tempHost, boxA.id, {
                mode: 'mount',
                catalogHash: currentHash,
                pending: false,
                skills: { claude: [], codex: [] },
                mcp: { claude: [], codex: [] },
                conflicts: []
            });
            const ok = await request(`${baseUrl}/api/sessions/boxa/extensions`, { headers: { Cookie: cookie } });
            expect(ok.response.status).toBe(200);
            expect(ok.json.shared).toEqual(expect.objectContaining({ pending: false }));
        });
    });

    describe('网络流量记录', () => {
        const trafficLib = require('../lib/egress-traffic');
        const { egressPaths } = require('../lib/egress-sidecar');

        test('GET /network/traffic 返回记录、汇总与覆盖说明；非法参数 400；DELETE 清空', async () => {
            const r = await request(`${baseUrl}/api/containers/boxa/network/traffic`, { headers: { Cookie: cookie } });
            expect(r.response.status).toBe(200);
            expect(r.json).toEqual(expect.objectContaining({
                records: expect.any(Array),
                summary: expect.objectContaining({ allowed: expect.any(Number), denied: expect.any(Number), hosts: expect.any(Number), bytesIn: expect.any(Number), bytesOut: expect.any(Number) }),
                coverage: expect.objectContaining({ proxied: expect.any(Boolean), auditHttp: expect.any(Boolean), reason: expect.any(String) })
            }));
            expect((await request(`${baseUrl}/api/containers/boxa/network/traffic?limit=0`, { headers: { Cookie: cookie } })).response.status).toBe(400);
            expect((await request(`${baseUrl}/api/containers/boxa/network/traffic?limit=5000`, { headers: { Cookie: cookie } })).response.status).toBe(400);
            expect((await request(`${baseUrl}/api/containers/boxa/network/traffic?decision=bad`, { headers: { Cookie: cookie } })).response.status).toBe(400);
            expect((await request(`${baseUrl}/api/containers/boxa/network/traffic?host=${'a'.repeat(300)}`, { headers: { Cookie: cookie } })).response.status).toBe(400);
            expect((await request(`${baseUrl}/api/containers/nothere/network/traffic`, { headers: { Cookie: cookie } })).response.status).toBe(404);
            const cleared = await request(`${baseUrl}/api/containers/boxa/network/traffic`, json(cookie, 'DELETE'));
            expect(cleared.response.status).toBe(200);
        });

        test('custom 不限制 + auditHttp：覆盖说明按“代理在用”返回 proxied，去掉 auditHttp 才是 unrestricted', async () => {
            const customAny = { action: 'allow', target: '@any', ports: '', proto: 'all', enabled: true };
            const audited = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', {
                policy: { preset: 'custom', outbound: [customAny], inbound: [{ action: 'allow', source: '@any', ports: '', proto: 'all', enabled: true }], auditHttp: true },
                confirmRisk: true
            }));
            expect(audited.response.status).toBe(200);
            const proxied = await request(`${baseUrl}/api/containers/boxa/network/traffic`, { headers: { Cookie: cookie } });
            expect(proxied.json.coverage).toEqual({ proxied: true, auditHttp: true, reason: 'proxied' });

            const plain = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', {
                policy: { preset: 'custom', outbound: [customAny], inbound: [{ action: 'allow', source: '@any', ports: '', proto: 'all', enabled: true }], auditHttp: false },
                confirmRisk: true
            }));
            expect(plain.response.status).toBe(200);
            const unrestricted = await request(`${baseUrl}/api/containers/boxa/network/traffic`, { headers: { Cookie: cookie } });
            expect(unrestricted.json.coverage).toEqual({ proxied: false, auditHttp: false, reason: 'unrestricted' });
        });

        test('合并放行与拒绝记录：时间倒序、host 过滤、summary 基于全部记录；DELETE 清空放行记录', async () => {
            const paths = egressPaths(tempHost);
            fs.mkdirSync(paths.traffic, { recursive: true });
            const recorder = trafficLib.createRecorder({ dir: paths.traffic });
            recorder.record({ id: boxA.id, host: 'api.example.com', port: 443, decision: 'allow', proto: 'tcp', method: 'CONNECT', status: 200, bytesIn: 10, bytesOut: 20, durationMs: 5, ts: '2026-01-01T00:00:00.000Z' });
            recorder.record({ id: boxA.id, host: 'cdn.example.com', port: 80, decision: 'allow', proto: 'http', method: 'GET', status: 200, bytesIn: 5, bytesOut: 30, durationMs: 7, ts: '2026-01-01T00:00:02.000Z' });
            recorder.record({ id: boxB.id, host: 'other.example.com', port: 443, decision: 'allow', proto: 'tcp', method: 'CONNECT', status: 200, bytesIn: 1, bytesOut: 2, durationMs: 3 });
            recorder.stop();

            const all = await request(`${baseUrl}/api/containers/boxa/network/traffic`, { headers: { Cookie: cookie } });
            expect(all.response.status).toBe(200);
            expect(all.json.records.map(r => r.host)).toEqual(['cdn.example.com', 'api.example.com']);
            expect(all.json.summary).toEqual({ allowed: 2, denied: 0, hosts: 2, bytesIn: 15, bytesOut: 50 });
            expect(all.json.coverage).toEqual({ proxied: false, auditHttp: false, reason: 'noDomainRules' });

            const host = await request(`${baseUrl}/api/containers/boxa/network/traffic?host=API.example.com&decision=allow&limit=1`, { headers: { Cookie: cookie } });
            expect(host.json.records.map(r => r.host)).toEqual(['api.example.com']);
            expect(host.json.summary.allowed).toBe(1);
            expect((await request(`${baseUrl}/api/containers/boxa/network/traffic?decision=deny`, { headers: { Cookie: cookie } })).json.records).toEqual([]);

            const put = await request(`${baseUrl}/api/containers/boxa/network`, json(cookie, 'PUT', { policy: { ...state.readNetworkRaw(tempHost, boxA.id), auditHttp: true } }));
            expect(put.response.status).toBe(200);
            expect(put.json.policy.auditHttp).toBe(true);
            expect(state.readNetworkRaw(tempHost, boxA.id).auditHttp).toBe(true);
            const audited = await request(`${baseUrl}/api/containers/boxa/network/traffic`, { headers: { Cookie: cookie } });
            expect(audited.json.coverage).toEqual({ proxied: true, auditHttp: true, reason: 'proxied' });
            expect(applied.some(([name]) => name === 'boxa')).toBe(true);

            expect((await request(`${baseUrl}/api/containers/boxa/network/traffic`, json(cookie, 'DELETE'))).response.status).toBe(200);
            expect((await request(`${baseUrl}/api/containers/boxa/network/traffic`, { headers: { Cookie: cookie } })).json.records).toEqual([]);
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
        test('autostart / network 写进状态目录；自定义或非本机绑定没有 confirmRisk 时 400', async () => {
            const create = ({ run, ...body } = {}) => request(`${baseUrl}/api/sessions`, json(cookie, 'POST', { ...(run ? { run } : {}), createOptions: { hostPath: tempHost, imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common', ...body } }));
            const risky = await create({ containerName: 'newbox1', network: { preset: 'custom', outbound: [allowRow('@any')] } });
            expect(risky.response.status).toBe(400);
            expect(risky.text).toContain('confirmRisk');

            const ok = await create({ containerName: 'newbox2', autostart: 'echo boot\n', autostartOnServe: true, network: { outbound: [allowRow('@host', { ports: '18601', proto: 'tcp' })] } });
            expect(ok.response.status).toBe(200);
            expect(ok.json.applied).toEqual(expect.objectContaining({ autostartEnabled: true, networkPreset: 'restricted' }));
            const ids = state.listStateIds(tempHost).filter(id => ![boxA.id, boxB.id].includes(id));
            expect(ids).toHaveLength(1);
            expect(fs.readFileSync(state.paths(tempHost, ids[0]).autostart, 'utf-8')).toBe('echo boot\n');
            const policy = state.readNetworkRaw(tempHost, ids[0]);
            expect(policy).toEqual(expect.objectContaining({ version: 2, preset: 'restricted', autostartOnServe: true, outbound: [allowRow('@host', { ports: '18601', proto: 'tcp' })] }));
            expect(applied.some(([name]) => name === 'newbox2')).toBe(true);

            const confirmed = await create({ containerName: 'newbox3', network: { preset: 'custom', outbound: [allowRow('@any')] }, confirmRisk: true });
            expect(confirmed.response.status).toBe(200);

            // 创建时填的端口暴露：容器就绪、规则下发后立即监听
            const hostPort = await getFreePort();
            const withExpose = await create({ containerName: 'newbox4', network: { expose: [{ bind: '127.0.0.1', hostPort, port: 8080 }] }, confirmRisk: true });
            expect(withExpose.response.status).toBe(200);
            await new Promise((resolve, reject) => { const c = net.connect(hostPort, '127.0.0.1', () => { c.destroy(); resolve(); }); c.on('error', reject); });
        });
    });

    describe('新建容器运行配置与确认', () => {
        const configPath = () => path.join(tempHost, 'manyoyo.json');
        const preset = (query = '') => request(`${baseUrl}/api/system/new-container-preset${query}`, { headers: { Cookie: cookie } });
        const create = ({ run, ...body } = {}) => request(`${baseUrl}/api/sessions`, json(cookie, 'POST', { ...(run ? { run } : {}), createOptions: { hostPath: tempHost, imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common', ...body } }));
        const idOf = name => state.listStateIds(tempHost).find(id => {
            try { return state.readMeta(tempHost, id).name === name; } catch (e) { return false; }
        });

        test('未登录 401；run 不存在 404；run 名非法 400；配置解析失败 400', async () => {
            expect((await request(`${baseUrl}/api/system/new-container-preset`)).response.status).toBe(401);

            fs.writeFileSync(configPath(), '{ autostart: "boot", network: { preset: "allowlist" } }\n', 'utf-8');
            expect((await preset('?run=nothere')).response.status).toBe(404);
            expect((await preset('?run=%01bad')).response.status).toBe(400);

            fs.writeFileSync(configPath(), '{ autostart: ', 'utf-8');
            const broken = await preset();
            expect(broken.response.status).toBe(400);
            expect(broken.json.error).toBeTruthy();
            expect(broken.text).not.toContain('autostart: "boot"');
        });

        test('按 请求 > runs.<name> > 全局 返回自启动 / autostartOnServe / v2 网络（v1 一次性迁移）', async () => {
            fs.writeFileSync(configPath(), JSON.stringify({
                autostart: 'global-boot\n',
                autostartOnServe: true,
                network: { preset: 'allowlist', egress: { domains: ['global.example.com'] } },
                runs: {
                    qa: {
                        autostart: 'run-boot\n',
                        autostartOnServe: false,
                        network: { outbound: [{ action: 'allow', target: '10.2.0.0/16', ports: '443', proto: 'tcp', enabled: true }] }
                    },
                    plain: {}
                }
            }, null, 2), 'utf-8');

            const globalOnly = await preset();
            expect(globalOnly.response.status).toBe(200);
            expect(globalOnly.json).toEqual(expect.objectContaining({
                run: '',
                autostart: 'global-boot\n',
                autostartOnServe: true
            }));
            // v1 的 domains 在返回时转换成 v2 的允许规则（不写盘）
            expect(globalOnly.json.network).toEqual(expect.objectContaining({ version: 2, preset: 'allowlist', autostartOnServe: true }));
            expect(globalOnly.json.network.outbound).toEqual([expect.objectContaining({ action: 'allow', target: 'global.example.com', enabled: true })]);
            expect(fs.readFileSync(configPath(), 'utf-8')).toContain('"egress"');

            const qa = await preset('?run=qa');
            expect(qa.response.status).toBe(200);
            expect(qa.json).toEqual(expect.objectContaining({ run: 'qa', autostart: 'run-boot\n', autostartOnServe: false }));
            expect(qa.json.network).toEqual(expect.objectContaining({
                version: 2,
                preset: 'restricted',
                autostartOnServe: false,
                outbound: [{ action: 'allow', target: '10.2.0.0/16', ports: '443', proto: 'tcp', enabled: true }]
            }));

            // 运行配置没写自启动就继承全局
            const plain = await preset('?run=plain');
            expect(plain.json).toEqual(expect.objectContaining({ autostart: 'global-boot\n', autostartOnServe: true }));
        });

        test('运行配置里已有的宽规则不重复确认；在运行配置上新增宽规则仍要确认', async () => {
            const wide = { action: 'allow', target: '@host', ports: '', proto: 'all', enabled: true };
            fs.writeFileSync(configPath(), JSON.stringify({
                runs: { qa: { network: { preset: 'allowlist', outbound: [wide] } } }
            }, null, 2), 'utf-8');

            const same = await create({ run: 'qa', containerName: 'preset-same', network: { preset: 'allowlist', outbound: [wide] } });
            expect(same.response.status).toBe(200);
            expect(state.readNetworkRaw(tempHost, idOf('preset-same')).outbound).toEqual([wide]);

            const added = await create({
                run: 'qa',
                containerName: 'preset-added',
                network: { preset: 'allowlist', outbound: [wide, { action: 'allow', target: '@any', ports: '', proto: 'all', enabled: true }] }
            });
            expect(added.response.status).toBe(400);
            expect(added.text).toContain('confirmRisk');

            const confirmed = await create({
                run: 'qa',
                containerName: 'preset-confirmed',
                confirmRisk: true,
                network: { preset: 'allowlist', outbound: [wide, { action: 'allow', target: '@any', ports: '', proto: 'all', enabled: true }] }
            });
            expect(confirmed.response.status).toBe(200);
            expect(state.readNetworkRaw(tempHost, idOf('preset-confirmed')).outbound).toHaveLength(2);
        });

        test('没有勾选界面的入口自动放行自启动 / first 里的 @host 端口；弹窗入口可明确关闭', async () => {
            // 快捷对话、克隆等走同一个接口且不带标记 → 自动放行
            const auto = await create({ containerName: 'auto-ext-1', autostart: 'curl -fsS http://host.docker.internal:9999/health\n' });
            expect(auto.response.status).toBe(200);
            expect(state.readNetworkRaw(tempHost, idOf('auto-ext-1')).outbound[0]).toEqual({ action: 'allow', target: '@host', ports: '9999', proto: 'tcp', enabled: true });

            const firstAuto = await create({ containerName: 'auto-ext-2', first: { shell: 'curl -fsS http://host.docker.internal:9999/first' } });
            expect(firstAuto.response.status).toBe(200);
            expect(state.readNetworkRaw(tempHost, idOf('auto-ext-2')).outbound).toEqual([expect.objectContaining({ target: '@host', ports: '9999', proto: 'tcp' })]);

            // 新建容器弹窗自己勾选地址 → 服务端不自动加（用户取消勾选的选择不能被覆盖）
            const manual = await create({ containerName: 'auto-ext-3', autostart: 'curl -fsS http://host.docker.internal:9999/health\n', autoAllowScriptEndpoints: false });
            expect(manual.response.status).toBe(200);
            expect(state.readNetworkRaw(tempHost, idOf('auto-ext-3')).outbound).toEqual([]);
            // 克隆 / 重建要能保持“不自动放行”
            const history = JSON.parse(fs.readFileSync(path.join(tempHost, 'web-history', 'auto-ext-3.json'), 'utf-8'));
            expect(history.runtimeSnapshot.autoAllowScriptEndpoints).toBe(false);
            const cloneOptions = require('../lib/web/server').__testing.buildCloneCreateOptionsFromSnapshot(history.runtimeSnapshot, history);
            expect(cloneOptions.autoAllowScriptEndpoints).toBe(false);
        });

        test('地址识别：认证 / 参数 / run 校验；扫描自启动、first 命令、first.env 与 first.envFile', async () => {
            const infer = body => request(`${baseUrl}/api/system/new-container-preset/infer`, json(cookie, 'POST', body));
            expect((await request(`${baseUrl}/api/system/new-container-preset/infer`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: '{}' })).response.status).toBe(401);

            const envFile = path.join(tempHost, 'first.env');
            fs.writeFileSync(envFile, 'FILE_TARGET=filehost.internal\nhttp_proxy=http://proxy.internal:3128\n', 'utf-8');
            fs.writeFileSync(configPath(), JSON.stringify({
                runs: {
                    qa: {
                        autostart: 'curl http://10.9.8.7:9000/health',
                        network: { preset: 'allowlist' },
                        first: {
                            shell: 'curl http://host.containers.internal:8080/ok',
                            env: { API_HOST: 'llm.corp.invalid' },
                            envFile: [envFile, 'relative.env', path.join(tempHost, 'missing.env')]
                        }
                    }
                }
            }, null, 2), 'utf-8');

            expect((await infer({ run: 'nothere' })).response.status).toBe(404);
            expect((await infer({ preset: 'nope' })).response.status).toBe(400);
            expect((await infer({ autostart: 5 })).response.status).toBe(400);
            expect((await infer({ autostart: 'x'.repeat(300 * 1024) })).response.status).toBe(400);

            const result = await infer({ run: 'qa' });
            expect(result.response.status).toBe(200);
            const found = result.json.candidates.map(c => `${c.kind}|${c.target}|${c.ports}`);
            expect(found).toEqual(expect.arrayContaining([
                'cidr|10.9.8.7|9000',
                'host|@host|8080',
                'domain|llm.corp.invalid|',
                'domain|filehost.internal|'
            ]));
            expect(found).not.toContain('domain|proxy.internal|3128');
            expect(result.text).not.toContain('/health');
            expect(result.text).not.toContain('/ok');
            expect(result.text).not.toContain('curl');

            // 请求里的 autostart（用户当前编辑的文本）覆盖运行配置
            const overridden = await infer({ run: 'qa', autostart: 'nc db.internal:5432' });
            expect(overridden.response.status).toBe(200);
            expect(overridden.json.candidates.map(c => `${c.kind}|${c.target}|${c.ports}`)).toContain('domain|db.internal|5432');
            expect(overridden.json.candidates.map(c => `${c.kind}|${c.target}|${c.ports}`)).not.toContain('cidr|10.9.8.7|9000');

            // custom 不限制：不生成地址
            const custom = await infer({ run: 'qa', preset: 'custom' });
            expect(custom.response.status).toBe(200);
            expect(custom.json.candidates).toEqual([]);
            expect(custom.json.reason).toBe('unrestricted');
        });

        test('autostart 空串与 autostartOnServe: false 能明确改掉运行配置', async () => {
            fs.writeFileSync(configPath(), JSON.stringify({
                runs: { qa: { autostart: 'run-boot\n', autostartOnServe: true } }
            }, null, 2), 'utf-8');

            const inherited = await create({ run: 'qa', containerName: 'inherit-qa' });
            expect(inherited.response.status).toBe(200);
            const inheritedId = idOf('inherit-qa');
            expect(state.readAutostart(tempHost, inheritedId)).toBe('run-boot\n');
            expect(state.readNetworkRaw(tempHost, inheritedId).autostartOnServe).toBe(true);

            const overridden = await create({ run: 'qa', containerName: 'override-qa', autostart: '', autostartOnServe: false });
            expect(overridden.response.status).toBe(200);
            const overriddenId = idOf('override-qa');
            expect(state.readAutostart(tempHost, overriddenId)).toBe('');
            expect(state.readNetworkRaw(tempHost, overriddenId).autostartOnServe).toBe(false);
        });
    });
});

describe('容器管理接口：不可信的 box/ 文件与风险判定', () => {
    const { pendingRisks } = require('../lib/web/container-manage');
    test('pendingRisks：自定义、非本机绑定、极宽的允许规则需要确认；窄规则、拒绝行、暂停行不需要', () => {
        const base = normalizePolicy({});
        const out = (target, extra = {}) => normalizePolicy({ outbound: [{ action: 'allow', target, ports: '', proto: 'all', ...extra }] });
        expect(pendingRisks(base, out('0.0.0.0/0'))).toEqual(['wide']);
        expect(pendingRisks(base, out('10.0.0.0/8', { ports: '80' }))).toEqual(['wide']);
        expect(pendingRisks(base, out('*.co.uk'))).toEqual(['wide']);
        expect(pendingRisks(base, out('@any'))).toEqual(['wide']);
        expect(pendingRisks(base, out('@metadata'))).toEqual(['wide']);
        expect(pendingRisks(base, out('@host'))).toEqual(['wide']);
        expect(pendingRisks(base, normalizePolicy({ inbound: [{ action: 'allow', source: '@containers' }] }))).toEqual(['wide']);
        expect(pendingRisks(base, normalizePolicy({ inbound: [{ action: 'allow', source: '@host' }] }))).toEqual([]);
        expect(pendingRisks(base, out('@host', { ports: '11434' }))).toEqual([]);
        expect(pendingRisks(base, out('192.168.1.50', { ports: '8000' }))).toEqual([]);
        expect(pendingRisks(base, out('@any', { enabled: false }))).toEqual([]);
        expect(pendingRisks(base, normalizePolicy({ outbound: [{ action: 'deny', target: '@any' }] }))).toEqual([]);
        expect(pendingRisks(base, normalizePolicy({ preset: 'custom' }))).toEqual(['custom']);
        // 已经是自定义时不再逐条问
        const custom = normalizePolicy({ preset: 'custom' });
        expect(pendingRisks(custom, normalizePolicy({ preset: 'custom', outbound: [{ action: 'allow', target: '@private' }] }))).toEqual([]);
        const wide = out('10.0.0.0/8');
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
            networkManager: { ensureBridgeNetwork: async () => {}, resolveRefs: async policy => policy, apply: async () => ({ status: 'applied' }), ensureReady: async () => ({}), relatedContainers: async () => [], listManaged: async () => [{ id: st.id, name: 'boxa', running: true }] },
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
            networkManager: { ensureBridgeNetwork: async () => {}, resolveRefs: async policy => policy, apply: async () => ({}), ensureReady: async () => ({}), relatedContainers: async () => [], listManaged: async () => [] },
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
