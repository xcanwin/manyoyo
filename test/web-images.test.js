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

const OUTPUT = [
    'ghcr.io/xcanwin/manyoyo\t2.3.0-common\taaa111\t2 days ago\t2.8GB',
    'ghcr.io/xcanwin/manyoyo\t2.2.0-common\tbbb222\t2 weeks ago\t2.79GB',
    'ghcr.io/xcanwin/manyoyo\t2.2.0-common\tbbb222\t2 weeks ago\t2.79GB',
    'localhost/my/sandbox\t1.0.0-full\tccc333\t1 hour ago\t3GB',
    '<none>\t<none>\tddd444\t3 weeks ago\t2GB',
    'docker.io/library/node\t24-bookworm\teee555\t4 weeks ago\t1GB',
    'ghcr.io/xcanwin/manyoyo\tlatest\tfff666\t1 day ago\t2GB',
    'bad name\t1.0.0-common\tggg777\t1 day ago\t1GB',
    ''
].join('\n');

async function withServer(overrides, fn) {
    const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-images-'));
    const port = await getFreePort();
    let handle = null;
    try {
        handle = await startWebServer({
            serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: 'topsecret', authPassAuto: false,
            dockerCmd: 'docker',
            networkManager: { ensureBridgeNetwork: async () => {}, resolveRefs: async p => p, apply: async () => ({}), ensureReady: async () => ({}) },
            hostPath: tempHost, homeDir: tempHost, containerPath: '/workspace', imageName: 'ghcr.io/xcanwin/manyoyo', imageVersion: '2.3.0-common',
            execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
            validateHostPath: () => {}, formatDate: () => '0101-0000',
            isValidContainerName: v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v),
            containerExists: () => false, getContainerStatus: () => 'running', waitForContainerReady: async () => {}, dockerExecArgs: () => '',
            showImagePullHint: () => {}, removeContainer: () => {},
            webHistoryDir: path.join(tempHost, 'web-history'), webConfigPath: path.join(tempHost, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' },
            ...overrides
        });
        const baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ username: 'webadmin', password: 'topsecret' }) });
        const cookie = login.headers.get('set-cookie').split(';')[0];
        await fn({ baseUrl, cookie });
    } finally {
        if (handle && handle.close) await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
    }
}

describe('GET /api/images', () => {
    test('未登录 401', async () => {
        await withServer({}, async ({ baseUrl }) => {
            expect((await fetch(`${baseUrl}/api/images`)).status).toBe(401);
        });
    });

    test('只列版本号合规的本机镜像，去掉悬空镜像 / 非法名字 / latest，同名同版本去重，并带默认值', async () => {
        const calls = [];
        await withServer({ dockerExecAsync: async args => { calls.push(args); return OUTPUT; } }, async ({ baseUrl, cookie }) => {
            const data = await (await fetch(`${baseUrl}/api/images`, { headers: { Cookie: cookie } })).json();
            expect(data.defaults).toEqual({ imageName: 'ghcr.io/xcanwin/manyoyo', imageVersion: '2.3.0-common' });
            expect(data.images.map(i => `${i.name}:${i.tag}`)).toEqual([
                'ghcr.io/xcanwin/manyoyo:2.3.0-common',
                'ghcr.io/xcanwin/manyoyo:2.2.0-common',
                'localhost/my/sandbox:1.0.0-full'
            ]);
            expect(data.images[0]).toMatchObject({ id: 'aaa111', created: '2 days ago', size: '2.8GB' });
            expect(calls.some(args => args[0] === 'images')).toBe(true);
        });
    });

    test('运行时没就绪 / 命令失败：返回空列表，不报错', async () => {
        await withServer({ runtimeState: { status: 'starting', message: '' }, dockerExecAsync: async () => OUTPUT }, async ({ baseUrl, cookie }) => {
            expect((await (await fetch(`${baseUrl}/api/images`, { headers: { Cookie: cookie } })).json()).images).toEqual([]);
        });
        await withServer({ dockerExecAsync: async () => { throw new Error('boom'); } }, async ({ baseUrl, cookie }) => {
            const res = await fetch(`${baseUrl}/api/images`, { headers: { Cookie: cookie } });
            expect(res.status).toBe(200);
            expect((await res.json()).images).toEqual([]);
        });
    });
});
