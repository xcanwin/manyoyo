'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { createAuthStore, authSessionsFilePath } = require('../lib/web/auth-store');
const { startWebServer } = require('../lib/web/server');

const HOUR = 3600 * 1000;

describe('createAuthStore', () => {
    let dir;
    let file;
    let clock;
    const make = (overrides = {}) => createAuthStore({ file, user: 'u', pass: 'p', ttlMs: 12 * HOUR, now: () => clock, flushDelayMs: 10, ...overrides });

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-auth-store-'));
        file = path.join(dir, 'serve', 'auth.json');
        clock = 1_000_000;
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('创建后能 touch；重新创建 store（重启）仍然有效；remove 后失效', () => {
        const a = make();
        const token = a.create('u');
        expect(a.touch(token)).toEqual({ username: 'u' });
        expect(make().touch(token)).toEqual({ username: 'u' });
        a.remove(token);
        expect(a.touch(token)).toBeNull();
        expect(make().touch(token)).toBeNull();
    });

    test('文件 0600、不含 token 明文、只存哈希', () => {
        const token = make().create('u');
        const text = fs.readFileSync(file, 'utf8');
        expect(text).not.toContain(token);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        const data = JSON.parse(text);
        expect(Object.keys(data.sessions)[0]).toMatch(/^[0-9a-f]{64}$/);
        expect(data.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(text).not.toContain('"p"');
    });

    test('改了用户名或密码：整份作废，改回去也不复活', () => {
        const token = make().create('u');
        expect(make({ pass: 'other' }).touch(token)).toBeNull();
        expect(make({ user: 'x' }).touch(token)).toBeNull();
        expect(make().touch(token)).toBeNull();
    });

    test('过期的不会被读回；过期时返回 null', () => {
        const store = make();
        const token = store.create('u');
        clock += 13 * HOUR;
        expect(store.touch(token)).toBeNull();
        expect(make().touch(token)).toBeNull();
    });

    test('损坏 / 权限不对的文件当作空的并告警，不抛错', () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{not json', { mode: 0o600 });
        const warn = jest.fn();
        expect(() => make({ warn })).not.toThrow();
        expect(warn).toHaveBeenCalled();
        const token = make().create('u');
        fs.chmodSync(file, 0o644);
        const warn2 = jest.fn();
        expect(make({ warn: warn2 }).touch(token)).toBeNull();
        expect(warn2).toHaveBeenCalled();
    });

    test('滑动续期不是每次都写盘：新到期时间比已落盘的晚不到 1 小时不写', async () => {
        const store = make();
        const token = store.create('u');
        const before = fs.statSync(file).mtimeMs;
        const text = fs.readFileSync(file, 'utf8');
        clock += 10 * 60 * 1000;
        store.touch(token);
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(fs.readFileSync(file, 'utf8')).toBe(text);
        expect(fs.statSync(file).mtimeMs).toBe(before);
        clock += 2 * HOUR;
        store.touch(token);
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(fs.readFileSync(file, 'utf8')).not.toBe(text);
    });

    test('没给 file：只在内存里', () => {
        const store = createAuthStore({ user: 'u', pass: 'p', ttlMs: HOUR });
        const token = store.create('u');
        expect(store.touch(token)).toEqual({ username: 'u' });
    });

    test('文件名按监听地址区分，IPv6 地址里的冒号被替换', () => {
        expect(authSessionsFilePath('/h', '127.0.0.1', 3000)).toBe('/h/.manyoyo/serve/auth-sessions-127.0.0.1_3000.json');
        expect(authSessionsFilePath('/h', '::1', 3000)).toBe('/h/.manyoyo/serve/auth-sessions-__1_3000.json');
    });
});

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

async function req(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { Connection: 'close', ...(options.headers || {}) };
    if (method !== 'GET') headers['X-Requested-With'] = 'XMLHttpRequest';
    const response = await fetch(url, { ...options, headers });
    return { status: response.status, headers: response.headers };
}

describe('serve 重启后登录会话', () => {
    let dir;
    let port;
    const start = async (pass = 'topsecret') => startWebServer({
        serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: pass, authPassAuto: false,
        authSessionsFile: path.join(dir, '.manyoyo', 'serve', `auth-sessions-127.0.0.1_${port}.json`),
        dockerCmd: 'docker',
        networkManager: { ensureBridgeNetwork: async () => {}, resolveRefs: async p => p, apply: async () => ({}), ensureReady: async () => ({}) },
        hostPath: dir, homeDir: dir, containerPath: '/workspace', imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common',
        execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
        validateHostPath: () => {}, formatDate: () => '0101-0000',
        isValidContainerName: v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v),
        containerExists: () => false, getContainerStatus: () => 'running', waitForContainerReady: async () => {}, dockerExecArgs: () => '',
        showImagePullHint: () => {}, removeContainer: () => {},
        webHistoryDir: path.join(dir, 'web-history'), webConfigPath: path.join(dir, 'manyoyo.json'),
        colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' }
    });
    const login = async (pass = 'topsecret') => {
        const response = await fetch(`http://127.0.0.1:${port}/auth/login`, { method: 'POST', headers: { Connection: 'close', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ username: 'webadmin', password: pass }) });
        return String(response.headers.get('set-cookie') || '').split(';')[0];
    };
    const api = cookie => req(`http://127.0.0.1:${port}/api/sessions`, { headers: cookie ? { Cookie: cookie } : {} });

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-auth-restart-'));
        port = await getFreePort();
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('未登录 401 → 登录可访问 → 重启后仍可访问 → 登出后失效（重启后也失效）', async () => {
        let handle = await start();
        expect((await api('')).status).toBe(401);
        const cookie = await login();
        expect((await api(cookie)).status).toBe(200);
        await handle.close();

        handle = await start();
        expect((await api(cookie)).status).toBe(200);
        expect((await req(`http://127.0.0.1:${port}/auth/logout`, { method: 'POST', headers: { Cookie: cookie } })).status).toBe(200);
        expect((await api(cookie)).status).toBe(401);
        await handle.close();

        handle = await start();
        expect((await api(cookie)).status).toBe(401);
        await handle.close();
    });

    test('换密码重启后失效；文件里没有 token 明文', async () => {
        let handle = await start();
        const cookie = await login();
        const token = decodeURIComponent(cookie.split('=')[1]);
        const text = fs.readFileSync(path.join(dir, '.manyoyo', 'serve', `auth-sessions-127.0.0.1_${port}.json`), 'utf8');
        expect(text).not.toContain(token);
        await handle.close();

        handle = await start('another-pass-123');
        expect((await api(cookie)).status).toBe(401);
        await handle.close();
    });
});
