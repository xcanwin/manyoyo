'use strict';

// 宿主级共享技能 / MCP 的接口：临时 HOME，不碰真实 ~/.manyoyo。
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
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

describe('共享技能 / MCP 接口', () => {
    let tempHome;
    let handle;
    let baseUrl;
    let cookie;

    beforeEach(async () => {
        tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-shared-ext-'));
        const port = await getFreePort();
        handle = await startWebServer({
            serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: 'topsecret', authPassAuto: false,
            dockerCmd: 'docker', hostPath: tempHome, homeDir: tempHome, containerPath: '/workspace',
            imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common',
            execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
            validateHostPath: () => {}, formatDate: () => '0101-0000',
            isValidContainerName: value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value),
            containerExists: () => false, getContainerStatus: () => 'running', waitForContainerReady: async () => {},
            dockerExecArgs: () => '',
            networkManager: {
                ensureBridgeNetwork: async () => {},
                resolveRefs: async policy => policy,
                apply: async () => ({ status: 'applied' }),
                ensureReady: async () => ({ status: 'applied' })
            },
            showImagePullHint: () => {}, removeContainer: () => {},
            webHistoryDir: path.join(tempHome, 'web-history'), webConfigPath: path.join(tempHome, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' }
        });
        baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await request(`${baseUrl}/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'webadmin', password: 'topsecret' })
        });
        cookie = login.response.headers.get('set-cookie').split(';')[0];
    });

    afterEach(async () => {
        if (handle) await handle.close();
        handle = null;
        fs.rmSync(tempHome, { recursive: true, force: true });
    });

    test('未登录 401；GET 返回空共享库；技能增删改查与 0600 / 0700', async () => {
        expect((await request(`${baseUrl}/api/extensions`)).response.status).toBe(401);

        const empty = await request(`${baseUrl}/api/extensions`, { headers: { Cookie: cookie } });
        expect(empty.response.status).toBe(200);
        expect(empty.json).toEqual({ skills: [], mcp: [] });

        const created = await request(`${baseUrl}/api/extensions/skills`, json(cookie, 'POST', {
            agent: 'claude',
            name: 'demo',
            content: '---\nname: demo\ndescription: 演示技能\n---\n这是正文\n'
        }));
        expect(created.response.status).toBe(200);
        const list = await request(`${baseUrl}/api/extensions`, { headers: { Cookie: cookie } });
        expect(list.json.skills).toEqual([expect.objectContaining({ agent: 'claude', name: 'demo', description: '演示技能' })]);

        const read = await request(`${baseUrl}/api/extensions/skills/claude/demo`, { headers: { Cookie: cookie } });
        expect(read.response.status).toBe(200);
        expect(read.json.content).toContain('这是正文');

        const skillFile = path.join(tempHome, '.manyoyo', 'extensions', 'skills', 'claude', 'demo', 'SKILL.md');
        expect(fs.statSync(skillFile).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(skillFile)).mode & 0o777).toBe(0o700);

        const bad = await request(`${baseUrl}/api/extensions/skills`, json(cookie, 'POST', { agent: 'claude', name: '../x', content: 'x' }));
        expect(bad.response.status).toBe(400);
        const removed = await request(`${baseUrl}/api/extensions/skills/claude/demo`, json(cookie, 'DELETE'));
        expect(removed.response.status).toBe(200);
        expect(fs.existsSync(skillFile)).toBe(false);
    });

    test('MCP：校验、密钥只回掩码、留空保留原值', async () => {
        const created = await request(`${baseUrl}/api/extensions/mcp`, json(cookie, 'POST', {
            name: 'echo',
            agents: ['claude', 'codex'],
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'echo-mcp'],
            env: [{ key: 'API_KEY', value: 'sk-test-12345678' }]
        }));
        expect(created.response.status).toBe(200);
        const list = await request(`${baseUrl}/api/extensions`, { headers: { Cookie: cookie } });
        expect(list.json.mcp).toEqual([expect.objectContaining({ name: 'echo', agents: ['claude', 'codex'], transport: 'stdio' })]);
        expect(list.text).not.toContain('sk-test-12345678');

        const detail = await request(`${baseUrl}/api/extensions/mcp/${created.json.id}`, { headers: { Cookie: cookie } });
        expect(detail.response.status).toBe(200);
        expect(detail.json.env).toEqual([{ key: 'API_KEY', masked: '****5678' }]);
        expect(detail.text).not.toContain('1234');

        const kept = await request(`${baseUrl}/api/extensions/mcp/${created.json.id}`, json(cookie, 'PUT', {
            name: 'echo',
            agents: ['claude', 'codex'],
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'echo-mcp'],
            env: [{ key: 'API_KEY', value: '__KEEP__' }]
        }));
        expect(kept.response.status).toBe(200);
        const store = JSON.parse(fs.readFileSync(path.join(tempHome, '.manyoyo', 'extensions', 'mcp.json'), 'utf-8'));
        expect(store.servers[0].env.API_KEY).toBe('sk-test-12345678');
        expect(fs.statSync(path.join(tempHome, '.manyoyo', 'extensions', 'mcp.json')).mode & 0o777).toBe(0o600);

        const badTransport = await request(`${baseUrl}/api/extensions/mcp`, json(cookie, 'POST', {
            name: 'bad', agents: ['codex', 'claude'], transport: 'sse', command: 'x'
        }));
        expect(badTransport.response.status).toBe(400);
        const badHeaders = await request(`${baseUrl}/api/extensions/mcp`, json(cookie, 'POST', {
            name: 'bad2', agents: ['codex'], transport: 'http', url: 'https://example.com/mcp', headers: [{ key: 'X-Key', value: 'v' }]
        }));
        expect(badHeaders.response.status).toBe(400);
        const userinfo = await request(`${baseUrl}/api/extensions/mcp`, json(cookie, 'POST', {
            name: 'bad3', agents: ['claude'], transport: 'http', url: 'https://user:pass@example.com/mcp'
        }));
        expect(userinfo.response.status).toBe(400);
    });
});
