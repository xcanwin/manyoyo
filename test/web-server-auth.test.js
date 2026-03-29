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
    const method = (options.method || 'GET').toUpperCase();
    const mergedOptions = Object.assign({}, options);
    // 非只读请求自动携带 X-Requested-With 头，与前端 api() 行为保持一致（CSRF 防护）
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

function buildServerOptions(tempHost, port, overrides = {}) {
    return {
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
    expect(setCookie).toContain('manyoyo_web_auth=');
    return setCookie.split(';')[0];
}

describe('Web Server Auth Gateway', () => {
    test('should enforce auth for API and invalidate session after logout', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-auth-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));

            const baseUrl = `http://127.0.0.1:${handle.port || port}`;

            const unauth = await request(`${baseUrl}/api/sessions`);
            expect(unauth.response.status).toBe(401);
            expect(unauth.json).toEqual(expect.objectContaining({ error: 'UNAUTHORIZED' }));

            const authCookie = await loginAndGetCookie(baseUrl);

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

    test('should allow serve startup even when default cwd validator would reject root path', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-root-start-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                validateHostPath: hostPath => {
                    if (!hostPath) {
                        throw new Error('hostPath 不能为空');
                    }
                    if (hostPath === '/' || hostPath === '/root' || hostPath === '/home') {
                        throw new Error('不允许挂载根目录或home目录。');
                    }
                },
                hostPath: '/'
            }));

            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const unauth = await request(`${baseUrl}/api/sessions`);
            expect(unauth.response.status).toBe(401);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should require auth for markdown assets and allow after login', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-vendor-marked-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;

            const unauthVendor = await request(`${baseUrl}/app/vendor/marked.min.js`);
            expect(unauthVendor.response.status).toBe(401);
            const unauthRenderer = await request(`${baseUrl}/app/frontend/markdown-renderer.js`);
            expect(unauthRenderer.response.status).toBe(401);
            const unauthStyle = await request(`${baseUrl}/app/frontend/markdown.css`);
            expect(unauthStyle.response.status).toBe(401);

            const authCookie = await loginAndGetCookie(baseUrl);
            const authedVendor = await request(`${baseUrl}/app/vendor/marked.min.js`, {
                headers: { Cookie: authCookie }
            });
            expect(authedVendor.response.status).toBe(200);
            expect(authedVendor.response.headers.get('content-type')).toContain('application/javascript');
            expect(authedVendor.text).toContain('marked');

            const authedRenderer = await request(`${baseUrl}/app/frontend/markdown-renderer.js`, {
                headers: { Cookie: authCookie }
            });
            expect(authedRenderer.response.status).toBe(200);
            expect(authedRenderer.response.headers.get('content-type')).toContain('application/javascript');
            expect(authedRenderer.text).toContain('window.ManyoyoMarkdown');

            const authedStyle = await request(`${baseUrl}/app/frontend/markdown.css`, {
                headers: { Cookie: authCookie }
            });
            expect(authedStyle.response.status).toBe(200);
            expect(authedStyle.response.headers.get('content-type')).toContain('text/css');
            expect(authedStyle.text).toContain('.md-content');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should support get and save JSON5 config in web api', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-config-'));
        const port = await getFreePort();
        const configPath = path.join(tempHost, 'manyoyo.json');
        fs.writeFileSync(configPath, '{\n// test\n"hostPath": "/tmp"\n}\n', 'utf-8');
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, { webConfigPath: configPath }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const configRes = await request(`${baseUrl}/api/config`, {
                headers: { Cookie: authCookie }
            });
            expect(configRes.response.status).toBe(200);
            expect(configRes.json).toEqual(expect.objectContaining({
                path: configPath,
                parseError: null
            }));
            expect(configRes.json.raw).toContain('"hostPath": "/tmp"');
            expect(configRes.json.defaults).toEqual(expect.objectContaining({
                hostPath: '/tmp',
                ports: []
            }));

            const invalidSave = await request(`${baseUrl}/api/config`, {
                method: 'PUT',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ raw: '{ invalid-json5 ' })
            });
            expect(invalidSave.response.status).toBe(400);
            expect(invalidSave.json).toEqual(expect.objectContaining({ error: '配置格式错误' }));

            const invalidPortsSave = await request(`${baseUrl}/api/config`, {
                method: 'PUT',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ raw: '{\n"ports": "8080:80"\n}\n' })
            });
            expect(invalidPortsSave.response.status).toBe(400);
            expect(invalidPortsSave.json).toEqual(expect.objectContaining({ error: '配置格式错误' }));

            const validSave = await request(`${baseUrl}/api/config`, {
                method: 'PUT',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ raw: '{\n"containerName": "my-web",\n"imageVersion": "1.2.3-common"\n}\n' })
            });
            expect(validSave.response.status).toBe(200);
            expect(validSave.json).toEqual(expect.objectContaining({ saved: true, path: configPath }));

            const savedText = fs.readFileSync(configPath, 'utf-8');
            expect(savedText).toContain('"containerName": "my-web"');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should create session with createOptions and keep legacy name compatibility', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-create-'));
        const port = await getFreePort();
        const dockerExecArgs = jest.fn(() => '');
        const waitForContainerReady = jest.fn(async () => {});
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                dockerExecArgs,
                waitForContainerReady
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const created = await request(`${baseUrl}/api/sessions`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    createOptions: {
                        containerName: 'my-web-create',
                        hostPath: tempHost,
                        containerPath: '/workspace/custom',
                        imageName: 'localhost/xcanwin/manyoyo',
                        imageVersion: '1.7.4-common',
                        shell: 'codex --dangerously-bypass-approvals-and-sandbox',
                        env: { A: '1' },
                        volumes: [`${tempHost}:/workspace/custom`],
                        ports: ['8080:80', '53:53/udp']
                    }
                })
            });

            expect(created.response.status).toBe(200);
            expect(created.json).toEqual(expect.objectContaining({
                name: 'my-web-create',
                applied: expect.objectContaining({ portCount: 2, agentEnabled: true })
            }));
            expect(waitForContainerReady).toHaveBeenCalledWith('my-web-create');
            expect(dockerExecArgs).toHaveBeenCalled();
            const runArgs = dockerExecArgs.mock.calls[0][0];
            expect(Array.isArray(runArgs)).toBe(true);
            expect(runArgs).toEqual(expect.arrayContaining([
                'run',
                '--name',
                'my-web-create',
                '--workdir',
                '/workspace/custom'
            ]));
            expect(runArgs).toEqual(expect.arrayContaining([
                '--publish',
                '8080:80',
                '--publish',
                '53:53/udp'
            ]));
            const historyPath = path.join(tempHost, 'web-history', 'my-web-create.json');
            const historyJson = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
            expect(historyJson).toEqual(expect.objectContaining({
                agentPromptCommand: 'codex exec --skip-git-repo-check {prompt}',
                applied: expect.objectContaining({
                    containerName: 'my-web-create',
                    hostPath: tempHost,
                    containerPath: '/workspace/custom',
                    defaultCommand: 'codex --dangerously-bypass-approvals-and-sandbox'
                })
            }));

            const detailRes = await request(`${baseUrl}/api/sessions/my-web-create/detail`, {
                headers: { Cookie: authCookie }
            });
            expect(detailRes.response.status).toBe(200);
            expect(detailRes.json).toEqual(expect.objectContaining({
                name: 'my-web-create',
                detail: expect.objectContaining({
                    name: 'my-web-create',
                    agentPromptCommand: 'codex exec --skip-git-repo-check {prompt}',
                    applied: expect.objectContaining({
                        containerName: 'my-web-create',
                        hostPath: tempHost,
                        containerPath: '/workspace/custom',
                        imageVersion: '1.7.4-common',
                        agentEnabled: true,
                        envCount: 1,
                        volumeCount: 1,
                        portCount: 2
                    })
                })
            }));

            const legacy = await request(`${baseUrl}/api/sessions`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name: 'my-legacy-name' })
            });
            expect(legacy.response.status).toBe(200);
            expect(legacy.json).toEqual(expect.objectContaining({ name: 'my-legacy-name' }));

            const yoloCreated = await request(`${baseUrl}/api/sessions`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    createOptions: {
                        containerName: 'my-web-create-yolo',
                        hostPath: tempHost,
                        imageName: 'localhost/xcanwin/manyoyo',
                        imageVersion: '1.7.4-common',
                        yolo: 'c'
                    }
                })
            });
            expect(yoloCreated.response.status).toBe(200);
            expect(yoloCreated.json).toEqual(expect.objectContaining({
                applied: expect.objectContaining({ agentEnabled: true })
            }));
            const yoloHistoryPath = path.join(tempHost, 'web-history', 'my-web-create-yolo.json');
            const yoloHistory = JSON.parse(fs.readFileSync(yoloHistoryPath, 'utf-8'));
            expect(yoloHistory).toEqual(expect.objectContaining({
                agentPromptCommand: 'claude -p {prompt}'
            }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should reject create session when hostPath resolves to root directory', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-create-root-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                validateHostPath: hostPath => {
                    if (!hostPath) {
                        throw new Error('hostPath 不能为空');
                    }
                    if (hostPath === '/' || hostPath === '/root' || hostPath === '/home') {
                        throw new Error('不允许挂载根目录或home目录。');
                    }
                }
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const created = await request(`${baseUrl}/api/sessions`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    createOptions: {
                        containerName: 'my-web-root',
                        hostPath: '/'
                    }
                })
            });

            expect(created.response.status).toBe(400);
            expect(created.json).toEqual(expect.objectContaining({ error: '不允许挂载根目录或home目录。' }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should expand home alias in web create volumes before docker run', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-create-home-volume-'));
        const port = await getFreePort();
        const dockerExecArgs = jest.fn(() => '');
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                dockerExecArgs,
                waitForContainerReady: async () => {}
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const created = await request(`${baseUrl}/api/sessions`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    createOptions: {
                        containerName: 'my-web-home-volume',
                        hostPath: tempHost,
                        imageName: 'localhost/xcanwin/manyoyo',
                        imageVersion: '1.7.4-common',
                        volumes: ['~/.manyoyo/.cache/ms-playwright:/root/.cache/ms-playwright']
                    }
                })
            });

            expect(created.response.status).toBe(200);
            expect(dockerExecArgs).toHaveBeenCalled();
            const runArgs = dockerExecArgs.mock.calls[0][0];
            expect(runArgs).toEqual(expect.arrayContaining([
                '--volume',
                `${path.join(os.homedir(), '.manyoyo/.cache/ms-playwright')}:/root/.cache/ms-playwright`
            ]));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should keep web api responsive while run command is executing', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-run-nonblock-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  const delay = command.includes('sleep 2') ? 2000 : 0;
  setTimeout(() => {
    if (command.includes('id')) {
      process.stdout.write('uid=0(root) gid=0(root) groups=0(root)\\n');
    }
    process.exit(0);
  }, delay);
  return;
}
process.exit(0);
`,
            'utf-8'
        );
        fs.chmodSync(fakeDockerPath, 0o755);

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                dockerCmd: fakeDockerPath,
                containerExists: () => true,
                getContainerStatus: () => 'running'
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const runPromise = request(`${baseUrl}/api/sessions/demo/run`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ command: 'sleep 2 && id' })
            });

            await new Promise(resolve => setTimeout(resolve, 160));

            const start = Date.now();
            const configRes = await request(`${baseUrl}/api/config`, {
                headers: { Cookie: authCookie }
            });
            const elapsed = Date.now() - start;

            expect(configRes.response.status).toBe(200);
            expect(elapsed).toBeLessThan(900);

            const runRes = await runPromise;
            expect(runRes.response.status).toBe(200);
            expect(runRes.json).toEqual(expect.objectContaining({ exitCode: 0 }));
            expect(String(runRes.json.output || '')).toContain('uid=0(root)');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should expose agentEnabled and execute prompt with escaped template in agent api', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-run-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  process.stdout.write(command + '\\n');
  process.exit(0);
  return;
}
process.exit(0);
`,
            'utf-8'
        );
        fs.chmodSync(fakeDockerPath, 0o755);

        const webHistoryDir = path.join(tempHost, 'web-history');
        fs.mkdirSync(webHistoryDir, { recursive: true });
        fs.writeFileSync(
            path.join(webHistoryDir, 'demo.json'),
            JSON.stringify({
                containerName: 'demo',
                updatedAt: '2025-01-01T00:00:00.000Z',
                messages: [],
                agentPromptCommand: 'echo AGENT:{prompt}'
            }, null, 4),
            'utf-8'
        );

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                dockerCmd: fakeDockerPath,
                containerExists: () => true,
                getContainerStatus: () => 'running',
                webHistoryDir
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const sessionsRes = await request(`${baseUrl}/api/sessions`, {
                headers: { Cookie: authCookie }
            });
            expect(sessionsRes.response.status).toBe(200);
            const target = (sessionsRes.json.sessions || []).find(item => item.name === 'demo');
            expect(target).toEqual(expect.objectContaining({ agentEnabled: true }));

            const runRes = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: `hello 'world'` })
            });
            expect(runRes.response.status).toBe(200);
            expect(String(runRes.json.output || '')).toContain("echo AGENT:'hello ");
            expect(String(runRes.json.output || '')).toContain("'\"'\"'world'\"'\"''");
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should rewrite codex agent template to skip git repo check before execution', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-codex-template-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  process.stdout.write(command + '\\n');
  process.exit(0);
  return;
}
process.exit(0);
`,
            'utf-8'
        );
        fs.chmodSync(fakeDockerPath, 0o755);

        const webHistoryDir = path.join(tempHost, 'web-history');
        fs.mkdirSync(webHistoryDir, { recursive: true });
        fs.writeFileSync(
            path.join(webHistoryDir, 'demo.json'),
            JSON.stringify({
                containerName: 'demo',
                updatedAt: null,
                messages: [],
                agentPromptCommand: 'codex exec {prompt}'
            }, null, 4),
            'utf-8'
        );

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                dockerCmd: fakeDockerPath,
                containerExists: () => true,
                getContainerStatus: () => 'running',
                webHistoryDir
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const runRes = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'hello' })
            });
            expect(runRes.response.status).toBe(200);
            expect(String(runRes.json.output || '')).toContain('codex exec --output-last-message');
            expect(String(runRes.json.output || '')).toContain("--skip-git-repo-check 'hello'");

            const persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            expect(persisted).toEqual(expect.objectContaining({
                agentPromptCommand: 'codex exec --skip-git-repo-check {prompt}'
            }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should keep codex agent reply clean by using the last message output', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-codex-clean-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  const outputFileMatch = command.match(/--output-last-message\\s+'([^']+)'/);
  if (outputFileMatch) {
    fs.writeFileSync(outputFileMatch[1], '当前这个会话里，我是基于 gpt-5.4 的 Codex。\\n', 'utf-8');
    process.stdout.write('OpenAI Codex v0.115.0 (research preview)\\n');
    process.stdout.write('tokens used\\n9,215\\n');
    process.stderr.write('mcp: playwright-mcp-host-headless failed\\n');
    process.stdout.write('\\n__MANYOYO_LAST_MESSAGE_BEGIN__\\n');
    process.stdout.write(fs.readFileSync(outputFileMatch[1], 'utf-8'));
    process.stdout.write('__MANYOYO_LAST_MESSAGE_END__\\n');
    process.exit(0);
    return;
  }
  process.exit(0);
  return;
}
process.exit(0);
`,
            'utf-8'
        );
        fs.chmodSync(fakeDockerPath, 0o755);

        const webHistoryDir = path.join(tempHost, 'web-history');
        fs.mkdirSync(webHistoryDir, { recursive: true });
        fs.writeFileSync(
            path.join(webHistoryDir, 'demo.json'),
            JSON.stringify({
                containerName: 'demo',
                updatedAt: null,
                messages: [],
                agentPromptCommand: 'codex exec --skip-git-repo-check {prompt}'
            }, null, 4),
            'utf-8'
        );

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                dockerCmd: fakeDockerPath,
                containerExists: () => true,
                getContainerStatus: () => 'running',
                webHistoryDir
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const runRes = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: '你是哪个大模型' })
            });
            expect(runRes.response.status).toBe(200);
            expect(runRes.json).toEqual(expect.objectContaining({
                output: '当前这个会话里，我是基于 gpt-5.4 的 Codex。'
            }));
            expect(String(runRes.json.output || '')).not.toContain('OpenAI Codex v0.115.0');
            expect(String(runRes.json.output || '')).not.toContain('tokens used');
            expect(String(runRes.json.output || '')).not.toContain('playwright-mcp-host-headless');

            const persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            const assistantMessage = (persisted.messages || []).find(message => message && message.role === 'assistant');
            expect(assistantMessage).toEqual(expect.objectContaining({
                content: '当前这个会话里，我是基于 gpt-5.4 的 Codex。'
            }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should reject agent api when template missing or prompt empty', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-invalid-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');
        fs.mkdirSync(webHistoryDir, { recursive: true });
        fs.writeFileSync(
            path.join(webHistoryDir, 'demo.json'),
            JSON.stringify({
                containerName: 'demo',
                updatedAt: null,
                messages: []
            }, null, 4),
            'utf-8'
        );
        fs.writeFileSync(
            path.join(webHistoryDir, 'demo2.json'),
            JSON.stringify({
                containerName: 'demo2',
                updatedAt: null,
                messages: [],
                agentPromptCommand: 'echo {prompt}'
            }, null, 4),
            'utf-8'
        );

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                containerExists: () => true,
                getContainerStatus: () => 'running',
                webHistoryDir
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const noTemplateRes = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'hello' })
            });
            expect(noTemplateRes.response.status).toBe(400);
            expect(noTemplateRes.json).toEqual(expect.objectContaining({
                error: '当前会话未配置 agentPromptCommand'
            }));

            const emptyPromptRes = await request(`${baseUrl}/api/sessions/demo2/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: '' })
            });
            expect(emptyPromptRes.response.status).toBe(400);
            expect(emptyPromptRes.json).toEqual(expect.objectContaining({ error: 'prompt 不能为空' }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should inject recent agent history for subsequent turns when resume is unavailable', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-context-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  process.stdout.write(command + '\\n');
  process.exit(0);
  return;
}
process.exit(0);
`,
            'utf-8'
        );
        fs.chmodSync(fakeDockerPath, 0o755);

        const webHistoryDir = path.join(tempHost, 'web-history');
        fs.mkdirSync(webHistoryDir, { recursive: true });
        fs.writeFileSync(
            path.join(webHistoryDir, 'demo.json'),
            JSON.stringify({
                containerName: 'demo',
                updatedAt: null,
                messages: [],
                agentPromptCommand: 'echo AGENT:{prompt}'
            }, null, 4),
            'utf-8'
        );

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                dockerCmd: fakeDockerPath,
                containerExists: () => true,
                getContainerStatus: () => 'running',
                webHistoryDir
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const turn1 = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'first question' })
            });
            expect(turn1.response.status).toBe(200);
            expect(turn1.json).toEqual(expect.objectContaining({
                contextMode: 'first-turn',
                resumeAttempted: false,
                resumeSucceeded: false
            }));

            const turn2 = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'second question' })
            });
            expect(turn2.response.status).toBe(200);
            expect(turn2.json).toEqual(expect.objectContaining({
                contextMode: 'history-injected',
                resumeAttempted: false,
                resumeSucceeded: false
            }));
            expect(String(turn2.json.output || '')).toContain('当前问题: second question');
            expect(String(turn2.json.output || '')).toContain('用户: first question');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should fallback to history injection when resume fails', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-resume-fallback-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  if (command.trim() === 'claude -r') {
    process.stderr.write('resume failed\\n');
    process.exit(1);
    return;
  }
  process.stdout.write(command + '\\n');
  process.exit(0);
  return;
}
process.exit(0);
`,
            'utf-8'
        );
        fs.chmodSync(fakeDockerPath, 0o755);

        const webHistoryDir = path.join(tempHost, 'web-history');
        fs.mkdirSync(webHistoryDir, { recursive: true });
        fs.writeFileSync(
            path.join(webHistoryDir, 'demo.json'),
            JSON.stringify({
                containerName: 'demo',
                updatedAt: null,
                messages: [],
                agentPromptCommand: 'claude -p {prompt}'
            }, null, 4),
            'utf-8'
        );

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                dockerCmd: fakeDockerPath,
                containerExists: () => true,
                getContainerStatus: () => 'running',
                webHistoryDir
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const turn1 = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'hello' })
            });
            expect(turn1.response.status).toBe(200);

            const turn2 = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'who am i' })
            });
            expect(turn2.response.status).toBe(200);
            expect(turn2.json).toEqual(expect.objectContaining({
                contextMode: 'history-injected',
                resumeAttempted: true,
                resumeSucceeded: false
            }));
            expect(String(turn2.json.output || '')).toContain('当前问题: who am i');

            const persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            expect(persisted).toEqual(expect.objectContaining({
                agentProgram: 'claude',
                resumeSupported: true,
                lastResumeOk: false
            }));
            expect(String(persisted.lastResumeError || '')).toContain('resume failed');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should skip history injection when resume succeeds', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-resume-ok-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  if (command.trim() === 'claude -r') {
    process.stdout.write('resume ok\\n');
    process.exit(0);
    return;
  }
  process.stdout.write(command + '\\n');
  process.exit(0);
  return;
}
process.exit(0);
`,
            'utf-8'
        );
        fs.chmodSync(fakeDockerPath, 0o755);

        const webHistoryDir = path.join(tempHost, 'web-history');
        fs.mkdirSync(webHistoryDir, { recursive: true });
        fs.writeFileSync(
            path.join(webHistoryDir, 'demo.json'),
            JSON.stringify({
                containerName: 'demo',
                updatedAt: null,
                messages: [],
                agentPromptCommand: 'claude -p {prompt}'
            }, null, 4),
            'utf-8'
        );

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                dockerCmd: fakeDockerPath,
                containerExists: () => true,
                getContainerStatus: () => 'running',
                webHistoryDir
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const turn1 = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'hello' })
            });
            expect(turn1.response.status).toBe(200);

            const turn2 = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'who am i' })
            });
            expect(turn2.response.status).toBe(200);
            expect(turn2.json).toEqual(expect.objectContaining({
                contextMode: 'resume',
                resumeAttempted: true,
                resumeSucceeded: true
            }));
            expect(String(turn2.json.output || '')).toContain("claude -p 'who am i'");
            expect(String(turn2.json.output || '')).not.toContain('以下是当前会话最近对话历史');

            const persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            expect(persisted).toEqual(expect.objectContaining({
                agentProgram: 'claude',
                resumeSupported: true,
                lastResumeOk: true
            }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });
});
