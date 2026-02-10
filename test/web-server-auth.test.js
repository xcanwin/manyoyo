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
    const response = await fetch(url, options);
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch (e) {
        json = null;
    }
    return { response, text, json };
}

describe('Web Server Auth Gateway', () => {
    test('should enforce auth for API and invalidate session after logout', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-auth-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer({
                serverHost: '127.0.0.1',
                serverPort: port,
                authUser: 'webadmin',
                authPass: 'topsecret',
                authPassAuto: false,
                dockerCmd: 'docker',
                hostPath: tempHost,
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
                colors: {
                    GREEN: '',
                    CYAN: '',
                    YELLOW: '',
                    NC: ''
                }
            });

            const baseUrl = `http://127.0.0.1:${handle.port || port}`;

            const unauth = await request(`${baseUrl}/api/sessions`);
            expect(unauth.response.status).toBe(401);
            expect(unauth.json).toEqual(expect.objectContaining({ error: 'UNAUTHORIZED' }));

            const login = await request(`${baseUrl}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'webadmin', password: 'topsecret' })
            });
            expect(login.response.status).toBe(200);
            expect(login.json).toEqual(expect.objectContaining({ ok: true, username: 'webadmin' }));

            const setCookie = login.response.headers.get('set-cookie');
            expect(setCookie).toContain('manyoyo_web_auth=');
            const authCookie = setCookie.split(';')[0];

            const authed = await request(`${baseUrl}/api/sessions`, {
                headers: { Cookie: authCookie }
            });
            expect(authed.response.status).toBe(200);
            expect(authed.json).toEqual(expect.objectContaining({ sessions: [] }));

            const logout = await request(`${baseUrl}/auth/logout`, {
                method: 'POST',
                headers: { Cookie: authCookie }
            });
            expect(logout.response.status).toBe(200);
            expect(logout.json).toEqual(expect.objectContaining({ ok: true }));

            const afterLogout = await request(`${baseUrl}/api/sessions`, {
                headers: { Cookie: authCookie }
            });
            expect(afterLogout.response.status).toBe(401);
            expect(afterLogout.json).toEqual(expect.objectContaining({ error: 'UNAUTHORIZED' }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });
});
