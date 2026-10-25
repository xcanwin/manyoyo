const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { startWebServer } = require('../lib/web/server');
const { FileEventStore } = require('../lib/core/event-store');
const { createControlEvent } = require('../lib/core/events');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address && typeof address === 'object' ? address.port : 0;
            server.close(err => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(port);
            });
        });
    });
}

async function request(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const mergedOptions = Object.assign({}, options);
    if (method !== 'GET' && method !== 'HEAD') {
        mergedOptions.headers = Object.assign(
            { 'X-Requested-With': 'XMLHttpRequest' },
            options.headers || {}
        );
    }
    const response = await fetch(url, mergedOptions);
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch (e) {
        json = null;
    }
    return { response, text, json };
}

// 容器网络规则下发需要真实运行时，Web 单测里用替身
function fakeNetworkManager() {
    return {
        ensureBridgeNetwork: async () => {},
        resolveRefs: async policy => policy,
        apply: async () => ({ status: 'applied' }),
        ensureReady: async () => ({ status: 'applied' })
    };
}

function buildServerOptions(tempHost, port, overrides = {}) {
    return {
        serverHost: '127.0.0.1',
        serverPort: port,
        authUser: 'webadmin',
        authPass: 'topsecret',
        authPassAuto: false,
        dockerCmd: 'docker',
        networkManager: fakeNetworkManager(),
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
        containerExists: () => false,
        getContainerStatus: () => 'running',
        waitForContainerReady: async () => {},
        dockerExecArgs: () => '',
        showImagePullHint: () => {},
        removeContainer: () => {},
        webHistoryDir: path.join(tempHost, 'web-history'),
        webConfigPath: path.join(tempHost, 'manyoyo.json'),
        colors: {
            GREEN: '',
            CYAN: '',
            YELLOW: '',
            NC: ''
        },
        ...overrides
    };
}

async function loginAndGetCookie(baseUrl) {
    const login = await request(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'webadmin', password: 'topsecret' })
    });
    expect(login.response.status).toBe(200);
    const setCookie = login.response.headers.get('set-cookie');
    return setCookie.split(';')[0];
}

function writeHistoryFile(webHistoryDir, containerName, data) {
    fs.mkdirSync(webHistoryDir, { recursive: true });
    fs.writeFileSync(path.join(webHistoryDir, `${containerName}.json`), JSON.stringify(data), 'utf-8');
}

describe('Web Server 磁盘占用接口', () => {
    async function withServer(run, overrides = {}) {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-storage-'));
        const port = await getFreePort();
        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, overrides));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            await run({ baseUrl, tempHost, cookie: await loginAndGetCookie(baseUrl) });
        } finally {
            if (handle && handle.close) await handle.close();
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    }

    test('未登录一律 401，DELETE 不带 X-Requested-With 是 403', async () => {
        await withServer(async ({ baseUrl, cookie }) => {
            expect((await request(`${baseUrl}/api/storage`)).response.status).toBe(401);
            expect((await request(`${baseUrl}/api/storage/size?path=/tmp`)).response.status).toBe(401);
            const noHeader = await fetch(`${baseUrl}/api/storage/dirs`, { method: 'DELETE', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
            expect(noHeader.status).toBe(403);
        });
    });

    test('没先请求列表就查体积 / 看内容 / 删除，一律拒绝', async () => {
        await withServer(async ({ baseUrl, tempHost, cookie }) => {
            const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
            expect((await request(`${baseUrl}/api/storage/size?path=${encodeURIComponent(tempHost)}`, { headers })).response.status).toBe(404);
            expect((await request(`${baseUrl}/api/storage/files?path=${encodeURIComponent(tempHost)}`, { headers })).response.status).toBe(404);
            const del = await request(`${baseUrl}/api/storage/dirs`, { method: 'DELETE', headers, body: JSON.stringify({ path: tempHost }) });
            expect([404, 503]).toContain(del.response.status);
            expect(fs.existsSync(tempHost)).toBe(true);
        });
    });

    test('运行时不可用：列表和删除都是 503，不会当成没人用', async () => {
        await withServer(async ({ baseUrl, cookie }) => {
            const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
            expect((await request(`${baseUrl}/api/storage`, { headers })).response.status).toBe(503);
            const del = await request(`${baseUrl}/api/storage/dirs`, { method: 'DELETE', headers, body: JSON.stringify({ path: '/tmp/x' }) });
            expect(del.response.status).toBe(503);
            const nullBody = await request(`${baseUrl}/api/storage/dirs`, { method: 'DELETE', headers, body: 'null' });
            expect(nullBody.response.status).toBe(503);
        }, { dockerExecAsync: async () => { throw new Error('daemon down'); } });
    });

    test('读配置里的快捷对话目录；只有历史记过的时间戳目录可删，并能真的删掉', async () => {
        const quickRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-quick-'));
        const known = path.join(quickRoot, '20261001-000001');
        const stray = path.join(quickRoot, '20261001-000002');
        fs.mkdirSync(known);
        fs.mkdirSync(stray);
        fs.mkdirSync(path.join(quickRoot, 'my-notes'));
        try {
            await withServer(async ({ baseUrl, tempHost, cookie }) => {
                writeHistoryFile(path.join(tempHost, 'web-history'), 'gone', { remark: '我的备注', applied: { hostPath: known } });
                fs.writeFileSync(path.join(tempHost, 'manyoyo.json'), JSON.stringify({ serve: { quickChat: { path: quickRoot + '/', run: 'x' } } }));
                const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
                const listed = await request(`${baseUrl}/api/storage`, { headers });
                expect(listed.response.status).toBe(200);
                const byName = Object.fromEntries(listed.json.rows.map(row => [path.basename(row.path), row]));
                expect(byName['20261001-000001']).toMatchObject({ managed: true, deletable: true });
                // 关联容器除了名字还带容器备注
                expect(byName['20261001-000001'].sessions).toEqual([{ name: 'gone', state: 'deleted', remark: '我的备注' }]);
                expect(byName['20261001-000002']).toMatchObject({ managed: false, deletable: false });
                const refused = await request(`${baseUrl}/api/storage/dirs`, { method: 'DELETE', headers, body: JSON.stringify({ path: byName['20261001-000002'].path }) });
                expect(refused.response.status).toBe(409);
                expect(fs.existsSync(stray)).toBe(true);
                const removed = await request(`${baseUrl}/api/storage/dirs`, { method: 'DELETE', headers, body: JSON.stringify({ path: byName['20261001-000001'].path }) });
                expect(removed.response.status).toBe(200);
                expect(fs.existsSync(known)).toBe(false);
            }, { dockerExecAsync: async () => '' });
        } finally {
            fs.rmSync(quickRoot, { recursive: true, force: true });
        }
    });
});

describe('磁盘占用：配置里写死的 hostPath', () => {
    test('全局与 runs.<名> 的写死路径不可删，含模板的不算', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-cfgpath-'));
        const port = await getFreePort();
        const workRoot = path.join(tempHost, 'work');
        const fixedA = path.join(workRoot, '20261001-000001');
        const fixedB = path.join(workRoot, '20261001-000002');
        const free = path.join(workRoot, '20261001-000003');
        [fixedA, fixedB, free].forEach(dir => fs.mkdirSync(dir, { recursive: true }));
        fs.writeFileSync(path.join(tempHost, 'manyoyo.json'), JSON.stringify({ hostPath: fixedA, runs: { x: { hostPath: fixedB }, y: { hostPath: `${workRoot}/{now}` } } }));
        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, { dockerExecAsync: async () => '' }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const headers = { Cookie: await loginAndGetCookie(baseUrl), 'Content-Type': 'application/json' };
            const listed = await request(`${baseUrl}/api/storage`, { headers });
            const byName = Object.fromEntries(listed.json.rows.map(row => [path.basename(row.path), row]));
            expect(byName['20261001-000001']).toMatchObject({ status: 'in-use', deletable: false });
            expect(byName['20261001-000002']).toMatchObject({ status: 'in-use', deletable: false });
            expect(byName['20261001-000003']).toMatchObject({ deletable: true });
        } finally {
            if (handle && handle.close) await handle.close();
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });
});

describe('容器被删后的重建不再退回 serve 启动目录', () => {
    async function recreate({ history, validateHostPath }) {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-recreate-'));
        const port = await getFreePort();
        const runCalls = [];
        let created = false;
        let handle = null;
        try {
            if (history) writeHistoryFile(path.join(tempHost, 'web-history'), 'gone-1', history(tempHost));
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                hostPath: '/srv/serve-cwd',
                validateHostPath: validateHostPath || (() => {}),
                containerExists: () => created,
                dockerExecArgs: args => {
                    if (args[0] === 'run') { runCalls.push(args); created = true; }
                    return '';
                }
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const cookie = await loginAndGetCookie(baseUrl);
            const res = await request(`${baseUrl}/api/sessions/gone-1/fs/list?path=/`, { headers: { Cookie: cookie } });
            return { runCalls, status: res.response.status, tempHost };
        } finally {
            if (handle && handle.close) await handle.close();
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    }

    test('历史里有创建参数：按历史里的 hostPath 重建，不用 serve 的启动目录', async () => {
        const { runCalls } = await recreate({
            history: tempHost => ({ runtimeSnapshot: { hostPath: path.join(tempHost, 'proj'), containerPath: '/workspace' } })
        });
        const joined = runCalls.map(args => args.join(' ')).join('\n');
        expect(joined).toContain('proj:/workspace');
        expect(joined).not.toContain('/srv/serve-cwd');
    });

    test('没有历史、容器也不在：报错，不新建（不再猜参数）', async () => {
        const { runCalls, status } = await recreate({});
        expect(runCalls).toHaveLength(0);
        expect(status).toBeGreaterThanOrEqual(400);
    });
});

describe('POST /api/sessions 不带 hostPath', () => {
    test('默认挂 <quickChatPath>/<时间>，serve 的启动目录不出现在 run 参数里', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-createdef-'));
        const port = await getFreePort();
        const quick = path.join(tempHost, 'quick');
        const runCalls = [];
        let created = false;
        let handle = null;
        try {
            fs.writeFileSync(path.join(tempHost, 'manyoyo.json'), JSON.stringify({ serve: { quickChat: { path: quick, run: 'x' } } }));
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                hostPath: '/srv/serve-cwd',
                containerExists: () => created,
                formatDate: () => '20261001-000060',
                dockerExecArgs: args => {
                    if (args[0] === 'run') { runCalls.push(args); created = true; }
                    return '';
                }
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const res = await request(`${baseUrl}/api/sessions`, {
                method: 'POST',
                headers: { Cookie: await loginAndGetCookie(baseUrl), 'Content-Type': 'application/json' },
                body: JSON.stringify({ createOptions: { containerName: 'def-1' } })
            });
            expect(res.response.status).toBe(200);
            const joined = runCalls.map(args => args.join(' ')).join('\n');
            expect(joined).toContain(`${quick}/20261001-000060:`);
            expect(joined).not.toContain('/srv/serve-cwd');
            expect(fs.existsSync(path.join(quick, '20261001-000060'))).toBe(true);
        } finally {
            if (handle && handle.close) await handle.close();
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });
});

describe('删除容器连同历史时清掉空工作目录', () => {
    async function removeWith({ withHistory, fill }) {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-rm-'));
        const port = await getFreePort();
        const workDir = path.join(tempHost, '.manyoyo-work', '20261001-000050');
        fs.mkdirSync(workDir, { recursive: true });
        if (fill) fs.writeFileSync(path.join(workDir, 'keep.txt'), 'x');
        let exists = true;
        let handle = null;
        try {
            writeHistoryFile(path.join(tempHost, 'web-history'), 'gone-2', { applied: { hostPath: workDir } });
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                containerExists: () => exists,
                removeContainer: () => { exists = false; },
                dockerExecAsync: async () => ''
            }));
            fs.writeFileSync(path.join(tempHost, 'manyoyo.json'), JSON.stringify({ serve: { quickChat: { path: path.join(tempHost, '.manyoyo-work'), run: 'x' } } }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const cookie = await loginAndGetCookie(baseUrl);
            const res = await request(`${baseUrl}/api/sessions/gone-2/remove`, {
                method: 'POST',
                headers: { Cookie: cookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ removeHistory: withHistory })
            });
            return { body: res.json, workDirExists: fs.existsSync(workDir) };
        } finally {
            if (handle && handle.close) await handle.close();
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    }

    test('连同历史删除：空工作目录一起删', async () => {
        const result = await removeWith({ withHistory: true, fill: false });
        expect(result.body).toMatchObject({ removed: true, removedWorkDir: true });
        expect(result.workDirExists).toBe(false);
    });

    test('工作目录里有文件：不动', async () => {
        const result = await removeWith({ withHistory: true, fill: true });
        expect(result.body.removedWorkDir).toBe(false);
        expect(result.workDirExists).toBe(true);
    });

    test('保留历史时不动工作目录', async () => {
        const result = await removeWith({ withHistory: false, fill: false });
        expect(result.body.removedWorkDir).toBe(false);
        expect(result.workDirExists).toBe(true);
    });
});

describe('新建容器的默认值接口', () => {
    async function fetchDefaults(config) {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-newdef-'));
        const port = await getFreePort();
        let handle = null;
        try {
            if (config) fs.writeFileSync(path.join(tempHost, 'manyoyo.json'), JSON.stringify(config));
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const unauth = await request(`${baseUrl}/api/system/new-container-defaults`);
            const res = await request(`${baseUrl}/api/system/new-container-defaults`, { headers: { Cookie: await loginAndGetCookie(baseUrl) } });
            return { tempHost, unauth: unauth.response.status, body: res.json };
        } finally {
            if (handle && handle.close) await handle.close();
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    }

    test('什么都没配：默认模板 + 默认工作目录；未登录 401；不会预先创建目录', async () => {
        const { tempHost, unauth, body } = await fetchDefaults(null);
        expect(unauth).toBe(401);
        expect(body).toEqual({
            containerName: 'my-easy-{now}',
            hostPath: '{quickChatPath}/{now}',
            containerPath: '{quickChatPath}/{now}',
            quickChatPath: path.join(tempHost, 'work')
        });
        expect(fs.existsSync(path.join(tempHost, 'work'))).toBe(false);
    });

    test('配了快捷对话目录（带 ~ 和尾斜杠）：quickChatPath 用它', async () => {
        const quick = await fetchDefaults({ serve: { quickChat: { path: '~/manyoyo_work/', run: 'x' } } });
        expect(quick.body.quickChatPath).toBe(path.join(quick.tempHost, 'manyoyo_work'));
    });

    test('配置里写了 hostPath / containerName：用配置的；没写 containerPath 就与宿主机目录相同', async () => {
        const { body } = await fetchDefaults({ hostPath: '/srv/mine', containerName: 'my-dev-{now}' });
        expect(body).toMatchObject({ containerName: 'my-dev-{now}', hostPath: '/srv/mine', containerPath: '' });
    });
});

describe('按模板创建容器', () => {
    test('配置里 hostPath 是 {quickChatPath}/{now}：创建时展开并建目录，容器名用同一个 {now}', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-tpl-'));
        const port = await getFreePort();
        const runCalls = [];
        let created = false;
        let handle = null;
        try {
            fs.writeFileSync(path.join(tempHost, 'manyoyo.json'), JSON.stringify({ hostPath: '{quickChatPath}/{now}', containerName: 'my-easy-{now}' }));
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                containerExists: () => created,
                dockerExecArgs: args => {
                    if (args[0] === 'run') { runCalls.push(args.join(' ')); created = true; }
                    return '';
                }
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const cookie = await loginAndGetCookie(baseUrl);
            const res = await request(`${baseUrl}/api/sessions`, {
                method: 'POST',
                headers: { Cookie: cookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            expect(res.response.status).toBe(200);
            expect(res.json.name).toBe('my-easy-0101-0000');
            const dir = path.join(tempHost, 'work', '0101-0000');
            expect(fs.existsSync(dir)).toBe(true);
            expect(runCalls.join('\n')).toContain(`${dir}:`);
        } finally {
            if (handle && handle.close) await handle.close();
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });
});
