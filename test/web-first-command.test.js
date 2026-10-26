'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { startWebServer } = require('../lib/web/server');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method: options.method || 'GET', headers: options.headers || {} }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (e) { json = null; }
                resolve({ status: res.statusCode, headers: res.headers, json, text });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

function fakeNetworkManager() {
    return {
        ensureBridgeNetwork: async () => {},
        resolveRefs: async policy => policy,
        apply: async () => ({ status: 'applied' }),
        ensureReady: async () => ({ status: 'applied' })
    };
}

describe('网页新建容器执行 first', () => {
    let tempHost;
    let handle;
    let baseUrl;
    let cookie;
    let log;
    let existing;

    function writeConfig(config) {
        fs.writeFileSync(path.join(tempHost, 'manyoyo.json'), JSON.stringify(config));
    }

    async function api(method, route, body) {
        return request(`${baseUrl}${route}`, {
            method,
            headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    }

    function firstCalls() {
        if (!fs.existsSync(log)) return [];
        return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    }

    beforeEach(async () => {
        tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-first-'));
        log = path.join(tempHost, 'exec.log');
        existing = false;
        // 假 docker：记录每次 exec 的命令与 env 文件内容；命令含 FAILME 时失败
        const fakeDocker = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(fakeDocker, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] !== 'exec') process.exit(0);
const envIdx = args.indexOf('--env-file');
const env = envIdx >= 0 ? fs.readFileSync(args[envIdx + 1], 'utf8') : '';
const command = args.slice(args.indexOf('/bin/bash') >= 0 ? args.indexOf('/bin/bash') : args.length);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, env }) + '\\n');
if (command.join(' ').includes('FAILME')) {
    process.stderr.write('setup failed SECRET_VALUE_123 end');
    process.exit(3);
}
process.stdout.write('first ok');
`);
        fs.chmodSync(fakeDocker, 0o755);
        const port = await getFreePort();
        handle = await startWebServer({
            serverHost: '127.0.0.1',
            serverPort: port,
            authUser: 'webadmin',
            authPass: 'topsecret',
            authPassAuto: false,
            dockerCmd: fakeDocker,
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
            containerExists: () => existing,
            getContainerStatus: () => 'running',
            waitForContainerReady: async () => {},
            dockerExecArgs: () => '',
            showImagePullHint: () => {},
            removeContainer: () => {},
            webHistoryDir: path.join(tempHost, 'web-history'),
            webConfigPath: path.join(tempHost, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' }
        });
        baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await request(`${baseUrl}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'webadmin', password: 'topsecret' })
        });
        cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    });

    afterEach(async () => {
        if (handle) await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
    });

    const createOptions = name => ({ containerName: name, hostPath: tempHost, imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common' });
    const systemMessages = async name => (await api('GET', `/api/sessions/${name}/messages`)).json.messages.filter(m => m.role === 'system').map(m => m.content);

    test('全局与 runs.<name> 的 first 合并（标量覆盖、env 按 key 覆盖），新建时执行一次且带上 first.env', async () => {
        writeConfig({
            first: { shellPrefix: 'G_PREFIX', shell: 'echo global', env: { A: 'g', B: 'g' } },
            runs: { demo: { first: { shell: 'echo run', env: { B: 'r', C: 'r' } } } }
        });
        const res = await api('POST', '/api/sessions', { run: 'demo', createOptions: createOptions('my-first-a') });
        expect(res.status).toBe(200);
        const calls = firstCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0].command).toEqual(['/bin/bash', '-c', 'G_PREFIX echo run']);
        expect(calls[0].env).toContain('A=g');
        expect(calls[0].env).toContain('B=r');
        expect(calls[0].env).toContain('C=r');
        expect(calls[0].env).not.toContain('B=g');
        // 新会话还没对话：成功不写系统消息（否则聊天页不是空的，输入框不再居中）
        expect(await systemMessages('my-first-a')).toEqual([]);
    });

    test('没配 first 时不执行；新会话建好后没有“容器已创建并启动”之类的系统消息', async () => {
        writeConfig({});
        await api('POST', '/api/sessions', { createOptions: createOptions('my-first-none') });
        expect(firstCalls()).toHaveLength(0);
        expect(await systemMessages('my-first-none')).toEqual([]);
    });

    test('已有容器（不是新建）不执行 first', async () => {
        writeConfig({ first: { shell: 'echo once' } });
        existing = true;
        await api('GET', '/api/sessions/my-first-old/fs/list?path=/');
        expect(firstCalls().filter(c => c.command.join(' ').includes('echo once'))).toHaveLength(0);
    });

    test('失败：写系统消息（脱敏、带退出码），不抛错，创建仍成功', async () => {
        writeConfig({ first: { shell: 'FAILME', env: { TOKEN: 'SECRET_VALUE_123' } } });
        const res = await api('POST', '/api/sessions', { createOptions: createOptions('my-first-fail') });
        expect(res.status).toBe(200);
        const messages = await systemMessages('my-first-fail');
        const failure = messages.find(m => m.startsWith('首次命令失败（退出码 3）'));
        expect(failure).toBeDefined();
        expect(failure).toContain('setup failed');
        expect(failure).not.toContain('SECRET_VALUE_123');
    });

    test('first 不是对象返回 400', async () => {
        writeConfig({ first: 'echo hi' });
        const res = await api('POST', '/api/sessions', { createOptions: createOptions('my-first-bad') });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(firstCalls()).toHaveLength(0);
    });

    test('创建相同配置的容器同样执行 first（新容器）', async () => {
        writeConfig({ first: { shell: 'echo clone-me' } });
        await api('POST', '/api/sessions', { createOptions: createOptions('my-first-src') });
        expect(firstCalls()).toHaveLength(1);
        const clone = await api('POST', '/api/sessions/my-first-src/clone-config', { containerName: 'my-first-copy' });
        expect(clone.status).toBe(200);
        expect(firstCalls()).toHaveLength(2);
        expect(firstCalls()[1].command).toEqual(['/bin/bash', '-c', 'echo clone-me']);
    });

    test('只带 run 和三个路径字段创建：first 执行一次（快捷对话的请求形状）', async () => {
        writeConfig({ runs: { quick: { first: { shell: 'echo quick-first' } } } });
        const res = await api('POST', '/api/sessions', { run: 'quick', createOptions: { hostPath: tempHost, containerPath: tempHost, containerName: 'my-easy-1' } });
        expect(res.status).toBe(200);
        expect(firstCalls().filter(c => c.command.join(' ').includes('echo quick-first'))).toHaveLength(1);
    });

    test('runs.<名>.plugins.playwright 覆盖全局并生效；不进快照', async () => {
        writeConfig({
            plugins: { playwright: { locale: 'en-US', timezoneId: 'America/New_York' } },
            runs: { pw: { plugins: { playwright: { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' } } } }
        });
        const res = await api('POST', '/api/sessions', { run: 'pw', createOptions: createOptions('my-pw-a') });
        expect(res.status).toBe(200);
        const dir = path.join(tempHost, '.manyoyo', 'plugin', 'playwright', 'current');
        const written = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
        expect(written).toContain('Asia/Tokyo');
        expect(written).not.toContain('America/New_York');
        const history = fs.readFileSync(path.join(tempHost, 'web-history', 'my-pw-a.json'), 'utf8');
        expect(history).not.toContain('Asia/Tokyo');
    });

    test('容器被删后按快照重建：同样用快照里记的运行配置的 plugins.playwright', async () => {
        writeConfig({
            plugins: { playwright: { locale: 'en-US', timezoneId: 'America/New_York' } },
            runs: { pw: { plugins: { playwright: { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' } } } }
        });
        await api('POST', '/api/sessions', { run: 'pw', createOptions: createOptions('my-pw-b') });
        const dir = path.join(tempHost, '.manyoyo', 'plugin', 'playwright', 'current');
        fs.rmSync(dir, { recursive: true, force: true });
        await api('GET', '/api/sessions/my-pw-b/fs/list?path=/');
        const written = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
        expect(written).toContain('Asia/Tokyo');
    });

    test('运行配置不存在：创建返回 400，不悄悄用全局默认配置', async () => {
        writeConfig({});
        const res = await api('POST', '/api/sessions', { run: 'nope', createOptions: createOptions('my-nope') });
        expect(res.status).toBe(400);
        expect(res.json.error).toContain('未找到运行配置: runs.nope');
    });

    test('保存快捷对话设置时 run 不存在返回 400，存在则保存', async () => {
        writeConfig({ runs: { ok: {} } });
        const bad = await api('PUT', '/api/system/quick-chat-config', { path: path.join(tempHost, 'work'), run: 'nope' });
        expect(bad.status).toBe(400);
        expect(bad.json.error).toContain('未找到运行配置');
        const good = await api('PUT', '/api/system/quick-chat-config', { path: path.join(tempHost, 'work'), run: 'ok' });
        expect(good.status).toBe(200);
    });
});
