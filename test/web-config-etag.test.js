const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { startWebServer } = require('../lib/web/server');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(err => (err ? reject(err) : resolve(port)));
        });
    });
}

async function request(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = method === 'GET' ? options.headers : { 'X-Requested-With': 'XMLHttpRequest', ...(options.headers || {}) };
    const response = await fetch(url, { ...options, headers });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { response, text, json };
}

function buildServerOptions(tempHost, port, overrides = {}) {
    return {
        serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: 'topsecret', authPassAuto: false,
        dockerCmd: 'docker',
        networkManager: { ensureBridgeNetwork: async () => {}, resolveRefs: async p => p, apply: async () => ({}), ensureReady: async () => ({}) },
        hostPath: tempHost, homeDir: tempHost, containerPath: '/workspace', imageName: 'x/y', imageVersion: '1.0.0-common',
        execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
        validateHostPath: () => {}, formatDate: () => '0101-0000',
        isValidContainerName: v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v),
        containerExists: () => true, getContainerStatus: () => 'running', waitForContainerReady: async () => {},
        dockerExecArgs: () => '', showImagePullHint: () => {}, removeContainer: () => {},
        webHistoryDir: path.join(tempHost, 'web-history'), webConfigPath: path.join(tempHost, 'manyoyo.json'),
        colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' },
        ...overrides
    };
}

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const CONFIG = ['{', '// keep', '"hostPath": "/workspace/demo",', '"env": {', '  "OPENAI_API_KEY": "secret-key-1",', '  "OPENAI_MODEL": "m1"', '},', '"serve": { "quickChat": { "run": "claude", "path": "~/.manyoyo/work/" } }', '}', ''].join('\n');

describe('配置文件保存的版本校验（If-Match）', () => {
    let tempHost, configPath, handle, baseUrl, cookie;

    async function start() {
        const port = await getFreePort();
        handle = await startWebServer(buildServerOptions(tempHost, port, { webConfigPath: configPath }));
        baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await request(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'webadmin', password: 'topsecret' }) });
        cookie = login.response.headers.get('set-cookie').split(';')[0];
    }
    const getConfig = () => request(`${baseUrl}/api/config`, { headers: { Cookie: cookie } });
    const putConfig = (raw, ifMatch) => request(`${baseUrl}/api/config`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(ifMatch === undefined ? {} : { 'If-Match': ifMatch }) },
        body: JSON.stringify({ raw })
    });
    // 模拟 CLI / 另一个标签页：原子替换整份文件
    function externalWrite(text) {
        const tmp = `${configPath}.ext`;
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, configPath);
    }

    beforeEach(() => {
        tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-config-etag-'));
        configPath = path.join(tempHost, 'manyoyo.json');
        fs.writeFileSync(configPath, CONFIG);
        handle = null;
    });
    afterEach(async () => {
        if (handle) await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
    });

    test('GET 返回磁盘原文的 sha256 作为 etag，不泄露内容', async () => {
        await start();
        const res = await getConfig();
        expect(res.json.etag).toBe(sha(CONFIG));
        expect(res.json.etag).not.toContain('secret');
        expect(res.json.raw).not.toContain('secret-key-1');
    });

    test('PUT 不带 If-Match 返回 428，文件不变', async () => {
        await start();
        const res = await putConfig(CONFIG.replace('"m1"', '"m2"'));
        expect(res.response.status).toBe(428);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(CONFIG);
    });

    test('etag 过期返回 409，文件内容不变，响应里带最新内容和最新 etag', async () => {
        await start();
        const first = await getConfig();
        const external = CONFIG.replace('"claude"', '"claude-ds"');
        externalWrite(external);
        const res = await putConfig(first.json.raw.replace('"m1"', '"m2"'), first.json.etag);
        expect(res.response.status).toBe(409);
        expect(res.json.conflict).toBe(true);
        expect(res.json.etag).toBe(sha(external));
        expect(res.json.raw).toContain('"claude-ds"');
        expect(res.text).not.toContain('secret-key-1'); // 409 的响应体同样不能带明文密钥
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(external);
    });

    test('etag 正确：写入成功并返回新的 etag（与随后 GET 一致）；密钥占位符仍会回填', async () => {
        await start();
        const first = await getConfig();
        const res = await putConfig(first.json.raw.replace('"m1"', '"m2"'), first.json.etag);
        expect(res.response.status).toBe(200);
        const saved = fs.readFileSync(configPath, 'utf-8');
        expect(saved).toContain('"OPENAI_MODEL": "m2"');
        expect(saved).toContain('secret-key-1');
        expect(res.json.etag).toBe(sha(saved));
        expect((await getConfig()).json.etag).toBe(res.json.etag);
    });

    test('只有密钥值被外部改了（脱敏文本完全相同）：旧 etag 也必须被拒绝', async () => {
        await start();
        const first = await getConfig();
        externalWrite(CONFIG.replace('secret-key-1', 'secret-key-2'));
        const second = await getConfig();
        expect(second.json.raw).toBe(first.json.raw);
        const res = await putConfig(first.json.raw, first.json.etag);
        expect(res.response.status).toBe(409);
        expect(fs.readFileSync(configPath, 'utf-8')).toContain('secret-key-2');
    });

    test('并发的两个 PUT 带同一个 etag：最多一个成功', async () => {
        await start();
        const first = await getConfig();
        const results = await Promise.all([
            putConfig(first.json.raw.replace('"m1"', '"a"'), first.json.etag),
            putConfig(first.json.raw.replace('"m1"', '"b"'), first.json.etag)
        ]);
        expect(results.map(r => r.response.status).sort()).toEqual([200, 409]);
    });

    test('外部把配置写坏了：旧 etag 收到 409（不是 500），响应里不带内容、不泄露密钥', async () => {
        await start();
        const first = await getConfig();
        externalWrite('{ broken json5 ');
        const res = await putConfig(first.json.raw, first.json.etag);
        expect(res.response.status).toBe(409);
        expect(res.json.conflict).toBe(true);
        expect(res.json.raw).toBe('');
        expect(res.text).not.toContain('secret-key-1');
        expect(fs.readFileSync(configPath, 'utf-8')).toBe('{ broken json5 ');
    });

    test('If-Match 支持带引号、W/ 前缀、大小写不同的哈希和 *', async () => {
        await start();
        const first = await getConfig();
        const upper = first.json.etag.toUpperCase();
        expect((await putConfig(first.json.raw.replace('"m1"', '"a"'), `W/"${upper}"`)).response.status).toBe(200);
        const second = await getConfig();
        expect((await putConfig(second.json.raw.replace('"a"', '"b"'), '*')).response.status).toBe(200);
    });

    test('未登录 401，登录后 200，登出后 401', async () => {
        await start();
        expect((await request(`${baseUrl}/api/config`)).response.status).toBe(401);
        expect((await getConfig()).response.status).toBe(200);
        await request(`${baseUrl}/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
        expect((await getConfig()).response.status).toBe(401);
        const put = await request(`${baseUrl}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': 'x' }, body: JSON.stringify({ raw: '{}' }) });
        expect(put.response.status).toBe(401);
    });

    test('配置文件还不存在：etag 对默认模板计算，用它可以保存', async () => {
        fs.rmSync(configPath);
        await start();
        const first = await getConfig();
        expect(first.json.etag).toMatch(/^[0-9a-f]{64}$/);
        const res = await putConfig('{\n"hostPath": "/workspace/x"\n}\n', first.json.etag);
        expect(res.response.status).toBe(200);
    });
});

describe('文件保存的版本校验（fs/write 的 If-Match）', () => {
    let tempHost, workDir, handle, baseUrl, cookie, argLog;

    // 假运行时：真的用 bash 执行 exec 收到的命令（里面是 node 脚本），请求的路径用宿主机上的真实临时目录
    function writeRealExecDocker() {
        const fake = path.join(tempHost, 'fake-docker.js');
        argLog = path.join(tempHost, 'exec-args.log');
        fs.writeFileSync(fake, `#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] !== 'exec') process.exit(0);
fs.appendFileSync(${JSON.stringify(argLog)}, JSON.stringify(args) + '\\n');
const command = args[args.length - 1];
const r = spawnSync('/bin/bash', ['-c', command], { encoding: 'utf8' });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status === null ? 1 : r.status);
`, { mode: 0o755 });
        return fake;
    }

    async function start() {
        const port = await getFreePort();
        handle = await startWebServer(buildServerOptions(tempHost, port, { dockerCmd: writeRealExecDocker() }));
        baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await request(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'webadmin', password: 'topsecret' }) });
        cookie = login.response.headers.get('set-cookie').split(';')[0];
    }
    const readFile = (file) => request(`${baseUrl}/api/sessions/demo/fs/read?path=${encodeURIComponent(file)}&full=1`, { headers: { Cookie: cookie } });
    const writeFile = (file, content, ifMatch) => request(`${baseUrl}/api/sessions/demo/fs/write`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(ifMatch === undefined ? {} : { 'If-Match': ifMatch }) },
        body: JSON.stringify({ path: file, content })
    });

    beforeEach(() => {
        tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-fs-etag-'));
        workDir = path.join(tempHost, 'work');
        fs.mkdirSync(workDir);
        handle = null;
    });
    afterEach(async () => {
        if (handle) await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
    });

    test('读取返回内容的 sha256 作为 etag；带上它可以保存，保存后返回新的 etag', async () => {
        const file = path.join(workDir, 'a.txt');
        fs.writeFileSync(file, 'hello\n');
        await start();
        const read = await readFile(file);
        expect(read.json.etag).toBe(sha('hello\n'));
        const saved = await writeFile(file, 'changed\n', read.json.etag);
        expect(saved.response.status).toBe(200);
        expect(fs.readFileSync(file, 'utf-8')).toBe('changed\n');
        expect(saved.json.etag).toBe(sha('changed\n'));
        expect((await readFile(file)).json.etag).toBe(saved.json.etag);
    });

    test('不带 If-Match 返回 428，文件不变', async () => {
        const file = path.join(workDir, 'a.txt');
        fs.writeFileSync(file, 'hello\n');
        await start();
        const res = await writeFile(file, 'changed\n');
        expect(res.response.status).toBe(428);
        expect(fs.readFileSync(file, 'utf-8')).toBe('hello\n');
    });

    test('容器里的文件被改过（etag 过期）返回 409 conflict，文件保持对方的内容', async () => {
        const file = path.join(workDir, 'a.txt');
        fs.writeFileSync(file, 'hello\n');
        await start();
        const read = await readFile(file);
        fs.writeFileSync(file, 'agent edited\n');
        const res = await writeFile(file, 'mine\n', read.json.etag);
        expect(res.response.status).toBe(409);
        expect(res.json.conflict).toBe(true);
        expect(fs.readFileSync(file, 'utf-8')).toBe('agent edited\n');
    });

    test('路径参数不经过 shell：带引号、$()、反引号的文件名照常读写，不会执行其中的命令', async () => {
        // 文件名里不能有 /，所以注入的命令用相对路径：若被执行，pwned 会出现在服务进程的工作目录
        const marker = path.join(process.cwd(), 'pwned-by-filename');
        fs.rmSync(marker, { force: true });
        const file = path.join(workDir, "a'b $(touch pwned-by-filename) `touch pwned-by-filename`.txt");
        fs.writeFileSync(file, 'x');
        await start();
        const read = await readFile(file);
        expect(read.response.status).toBe(200);
        const saved = await writeFile(file, 'y', read.json.etag);
        expect(saved.response.status).toBe(200);
        expect(fs.readFileSync(file, 'utf-8')).toBe('y');
        expect(fs.existsSync(marker)).toBe(false);
        // exec 的参数里，路径只出现在 heredoc 脚本的字符串字面量里，不是单独的 shell 参数
        const calls = fs.readFileSync(argLog, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line));
        expect(calls.every(args => args[args.length - 1].startsWith("node <<'__MANYOYO_NODE__'"))).toBe(true);
    });

    test('新建的空文件：读取得到空内容的 etag，可以直接保存', async () => {
        const file = path.join(workDir, 'new.txt');
        await start();
        const created = await request(`${baseUrl}/api/sessions/demo/fs/create`, {
            method: 'POST',
            headers: { Cookie: cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: file })
        });
        expect(created.response.status).toBe(200);
        const read = await readFile(file);
        expect(read.json.etag).toBe(sha(''));
        expect((await writeFile(file, 'now with text', read.json.etag)).response.status).toBe(200);
    });

    test('2MB 以上的文件：明确提示过大（400），不是冲突，也不会把整个文件读进内存比对', async () => {
        const file = path.join(workDir, 'big.txt');
        fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 10));
        await start();
        const res = await writeFile(file, 'small', sha('whatever'));
        expect(res.response.status).toBe(400);
        expect(res.json.error).toContain('过大');
        expect(fs.statSync(file).size).toBeGreaterThan(2 * 1024 * 1024);
    });

    test('If-Match: * 表示不比对版本（文件存在即可写）', async () => {
        const file = path.join(workDir, 'a.txt');
        fs.writeFileSync(file, 'hello\n');
        await start();
        expect((await writeFile(file, 'changed\n', '*')).response.status).toBe(200);
        expect(fs.readFileSync(file, 'utf-8')).toBe('changed\n');
    });

    test('未登录 401', async () => {
        await start();
        const res = await request(`${baseUrl}/api/sessions/demo/fs/write`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': 'x' }, body: JSON.stringify({ path: '/x', content: 'y' })
        });
        expect(res.response.status).toBe(401);
    });
});
