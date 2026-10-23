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
        const req = http.request(url, {
            method: options.method || 'GET',
            headers: options.headers || {}
        }, res => {
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

describe('GET /api/sessions/:name/fs/stat', () => {
    let tempHost;
    let handle;
    let baseUrl;
    let cookie;
    let status = 'running';
    let startCalls;

    beforeAll(async () => {
        tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-fs-stat-'));
        fs.mkdirSync(path.join(tempHost, 'dir'));
        fs.writeFileSync(path.join(tempHost, 'a.txt'), 'x');
        // 假 docker：exec 时直接在宿主机上执行命令，路径即宿主机路径
        const fakeDocker = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(fakeDocker, `#!/usr/bin/env node
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
if (args[0] !== 'exec') process.exit(1);
const r = spawnSync('sh', ['-c', args[args.length - 1]], { stdio: 'inherit', cwd: ${JSON.stringify(tempHost)} });
process.exit(r.status || 0);
`);
        fs.chmodSync(fakeDocker, 0o755);
        startCalls = 0;
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
            containerExists: () => true,
            getContainerStatus: () => status,
            waitForContainerReady: async () => {},
            dockerExecArgs: args => { if (args[0] === 'start') startCalls += 1; return ''; },
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

    afterAll(async () => {
        if (handle) await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
    });

    const stat = p => request(`${baseUrl}/api/sessions/test/fs/stat?path=${encodeURIComponent(p)}`, { headers: { Cookie: cookie } });

    test('未登录返回 401', async () => {
        const res = await request(`${baseUrl}/api/sessions/test/fs/stat?path=/`);
        expect(res.status).toBe(401);
    });

    test('文件、目录、不存在的路径', async () => {
        status = 'running';
        expect((await stat(path.join(tempHost, 'a.txt'))).json).toEqual({ exists: true, type: 'file' });
        expect((await stat(path.join(tempHost, 'dir'))).json).toEqual({ exists: true, type: 'dir' });
        const missing = await stat('/context');
        expect(missing.status).toBe(200);
        expect(missing.json).toEqual({ exists: false });
    });

    test('相对路径按容器工作目录解析', async () => {
        status = 'running';
        expect((await stat('a.txt')).json).toEqual({ exists: true, type: 'file' });
    });

    test('容器没在运行时不拉起容器，直接返回不存在', async () => {
        status = 'exited';
        const res = await stat(path.join(tempHost, 'a.txt'));
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ exists: false });
        expect(startCalls).toBe(0);
        status = 'running';
    });

    test('path 为空返回不存在', async () => {
        const res = await stat('');
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ exists: false });
    });
});
