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

async function requestNdjsonStream(url, options = {}, onEvent) {
    const method = (options.method || 'GET').toUpperCase();
    const mergedOptions = Object.assign({}, options);
    if (method !== 'GET' && method !== 'HEAD') {
        mergedOptions.headers = Object.assign(
            { 'X-Requested-With': 'XMLHttpRequest' },
            options.headers || {}
        );
    }
    const response = await fetch(url, mergedOptions);
    const reader = response.body && typeof response.body.getReader === 'function'
        ? response.body.getReader()
        : null;
    let pending = '';
    if (!reader) {
        return { response, events: [] };
    }
    const decoder = new TextDecoder();
    const events = [];
    while (true) {
        const result = await reader.read();
        if (result.done) {
            break;
        }
        pending += decoder.decode(result.value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
            const text = String(line || '').trim();
            if (!text) continue;
            const payload = JSON.parse(text);
            events.push(payload);
            if (typeof onEvent === 'function') {
                await onEvent(payload, events);
            }
        }
    }
    const rest = decoder.decode();
    if (rest) {
        pending += rest;
    }
    const finalText = String(pending || '').trim();
    if (finalText) {
        const payload = JSON.parse(finalText);
        events.push(payload);
        if (typeof onEvent === 'function') {
            await onEvent(payload, events);
        }
    }
    return { response, events };
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

    test('should redirect unauthenticated page requests to login and answer favicon quietly', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-page-auth-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;

            const pageRes = await request(`${baseUrl}/`, { redirect: 'manual' });
            expect(pageRes.response.status).toBe(302);
            expect(pageRes.response.headers.get('location')).toBe('/auth/login');

            const faviconRes = await request(`${baseUrl}/favicon.ico`, { redirect: 'manual' });
            expect(faviconRes.response.status).toBe(204);
            expect(faviconRes.text).toBe('');
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
            const unauthFileBrowser = await request(`${baseUrl}/app/frontend/file-browser.js`);
            expect(unauthFileBrowser.response.status).toBe(401);
            const unauthEditorBundle = await request(`${baseUrl}/app/frontend/codemirror.bundle.js`);
            expect(unauthEditorBundle.response.status).toBe(401);

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

            const authedFileBrowser = await request(`${baseUrl}/app/frontend/file-browser.js`, {
                headers: { Cookie: authCookie }
            });
            expect(authedFileBrowser.response.status).toBe(200);
            expect(authedFileBrowser.response.headers.get('content-type')).toContain('application/javascript');
            expect(authedFileBrowser.text).toContain('window.ManyoyoFileBrowser');

            const authedEditorBundle = await request(`${baseUrl}/app/frontend/codemirror.bundle.js`, {
                headers: { Cookie: authCookie }
            });
            expect(authedEditorBundle.response.status).toBe(200);
            expect(authedEditorBundle.response.headers.get('content-type')).toContain('application/javascript');
            expect(authedEditorBundle.text).toContain('window.ManyoyoCodeEditor');

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

    test('should list and read container files via web api', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-container-fs-'));
        const port = await getFreePort();
        const fakeDocker = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(fakeDocker, `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args[4] || '';
if (args[0] !== 'exec') {
    process.stderr.write('unexpected docker args');
    process.exit(1);
}
if (command.includes('__MANYOYO_FS_LIST__')) {
    process.stdout.write(JSON.stringify({
        path: '/workspace',
        parentPath: '/',
        entries: [
            { name: 'docs', path: '/workspace/docs', kind: 'directory', size: 0, mtimeMs: 1710000000000 },
            { name: 'README.md', path: '/workspace/README.md', kind: 'file', size: 128, mtimeMs: 1710000001000 }
        ]
    }));
    process.exit(0);
}
if (command.includes('__MANYOYO_FS_READ__')) {
    process.stdout.write(JSON.stringify({
        path: '/workspace/README.md',
        kind: 'text',
        size: 23,
        language: 'markdown',
        content: '# hello\\nthis is readme\\n',
        truncated: false
    }));
    process.exit(0);
}
process.stderr.write('unknown command');
process.exit(2);
`, 'utf-8');
        fs.chmodSync(fakeDocker, 0o755);
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                dockerCmd: fakeDocker,
                containerExists: () => true,
                getContainerStatus: () => 'running'
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const listRes = await request(`${baseUrl}/api/sessions/test/fs/list?path=${encodeURIComponent('/workspace')}`, {
                headers: { Cookie: authCookie }
            });
            expect(listRes.response.status).toBe(200);
            expect(listRes.json).toEqual(expect.objectContaining({
                path: '/workspace',
                parentPath: '/',
                entries: expect.arrayContaining([
                    expect.objectContaining({ name: 'docs', kind: 'directory', path: '/workspace/docs' }),
                    expect.objectContaining({ name: 'README.md', kind: 'file', path: '/workspace/README.md' })
                ])
            }));

            const readRes = await request(`${baseUrl}/api/sessions/test/fs/read?path=${encodeURIComponent('/workspace/README.md')}`, {
                headers: { Cookie: authCookie }
            });
            expect(readRes.response.status).toBe(200);
            expect(readRes.json).toEqual(expect.objectContaining({
                path: '/workspace/README.md',
                kind: 'text',
                language: 'markdown',
                content: '# hello\nthis is readme\n',
                truncated: false
            }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should keep sidebar tree bodies hidden when hidden attribute is set', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-sidebar-tree-style-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.response.status).toBe(200);
            expect(appStyle.response.headers.get('content-type')).toContain('text/css');
            expect(appStyle.text).toContain('.tree-node-children[hidden]');
            expect(appStyle.text).toMatch(/\.tree-node-children\[hidden\][\s\S]*display:\s*none/);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should toggle sidebar tree locally without rerendering the whole session list', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-sidebar-tree-script-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.response.headers.get('content-type')).toContain('application/javascript');
            expect(appScript.text).toContain('function createTreePrefixSegment() {');
            expect(appScript.text).toContain('function setDisclosureExpanded(control, expanded) {');
            expect(appScript.text).toContain('function renderSessionTreeNodes(nodes, parentNode, ancestorHasNext, itemCounter) {');
            expect(appScript.text).toContain('const nextExpanded = childrenNode.hidden;');
            expect(appScript.text).toContain('setDisclosureExpanded(item, nextExpanded);');
            expect(appScript.text).toContain('childrenNode.hidden = !nextExpanded;');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should sync containerPath to selected hostPath and remove container picker button', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-create-path-sync-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const appHtml = await request(`${baseUrl}/`, {
                headers: { Cookie: authCookie }
            });
            expect(appHtml.response.status).toBe(200);
            expect(appHtml.text).not.toContain('id="pickContainerPathBtn"');
            expect(appHtml.text).not.toContain('/app/frontend/path-picker-utils.js');

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).toContain('createHostPath.value = picker.currentPath;');
            expect(appScript.text).toContain('createContainerPath.value = picker.currentPath;');
            expect(appScript.text).not.toContain("openDirectoryPicker('container')");
            expect(appScript.text).not.toContain('pickContainerPathBtn');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should ship simplified sidebar tree guides with tree semantics', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-sidebar-tree-a11y-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const appHtml = await request(`${baseUrl}/`, {
                headers: { Cookie: authCookie }
            });
            expect(appHtml.response.status).toBe(200);
            expect(appHtml.text).toContain('id="sessionList" role="tree" aria-label="会话树"');

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).toContain("button.innerHTML = '<svg viewBox=\"0 0 12 12\"");
            expect(appScript.text).toContain("button.setAttribute('role', 'treeitem');");
            expect(appScript.text).toContain("childrenNode.setAttribute('role', 'group');");
            expect(appScript.text).toContain("hoverMenu.className = 'tree-node-hover-menu';");
            expect(appScript.text).toContain("addAgentBtn.className = 'secondary tree-node-menu-item';");
            expect(appScript.text).toContain('function updateSidebarActiveSelection() {');
            expect(appScript.text).toContain('updateSidebarActiveSelection();');

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.response.status).toBe(200);
            expect(appStyle.text).toContain('--tree-guide:');
            expect(appStyle.text).toContain('.disclosure-toggle svg');
            expect(appStyle.text).toContain('.tree-node-hover-menu');
            expect(appStyle.text).toContain('.tree-node-row-container:hover .tree-node-hover-menu');
            expect(appStyle.text).not.toContain('.tree-node-action');
            expect(appStyle.text).not.toContain('animation-delay: calc(var(--item-index, 0) * 24ms);');
            expect(appStyle.text).not.toContain('.tree-prefix-toggle.is-expanded::after');
            expect(appStyle.text).not.toContain('translateX(-2.5px)');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should ship unified trace card rendering for toolchain events', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-trace-card-assets-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).toContain("card.className = 'trace-card trace-tone-' + resolveTraceTone(event);");
            expect(appScript.text).toContain("card.className = 'trace-card trace-tone-' + resolveResidualTraceTone(line) + ' trace-card-residual';");
            expect(appScript.text).toContain("bodyParts.push({ label: '命令', value: event.command });");
            expect(appScript.text).toContain("bodyParts.push({ label: '退出码', value: String(event.exitCode) });");
            expect(appScript.text).toContain("bodyParts.push({ label: '工具', value: [event.server, event.tool].filter(Boolean).join('.') });");
            expect(appScript.text).not.toContain('function shouldCompactTraceEvent(traceEvent)');
            expect(appScript.text).not.toContain('trace-card-compact');

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.response.status).toBe(200);
            expect(appStyle.text).toContain('details.trace-card > .trace-card-summary');
            expect(appStyle.text).toContain('.trace-card.trace-card-residual');
            expect(appStyle.text).not.toContain('.trace-card.trace-card-compact');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should expose multi-agent sessions under one container and create new agent sessions', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-multi-agent-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');
        const historyPath = path.join(webHistoryDir, 'demo.json');
        fs.mkdirSync(webHistoryDir, { recursive: true });
        fs.writeFileSync(historyPath, JSON.stringify({
            containerName: 'demo',
            agentPromptCommand: 'codex exec --skip-git-repo-check {prompt}',
            applied: {
                containerName: 'demo',
                hostPath: tempHost,
                containerPath: '/workspace/demo'
            },
            agents: {
                default: {
                    agentId: 'default',
                    agentName: 'AGENT 1',
                    createdAt: '2026-03-30T00:00:00.000Z',
                    updatedAt: '2026-03-30T00:00:00.000Z',
                    messages: [
                        {
                            id: 'msg-1',
                            role: 'user',
                            content: 'hello',
                            timestamp: '2026-03-30T00:00:00.000Z',
                            mode: 'agent'
                        }
                    ],
                    lastResumeAt: null,
                    lastResumeOk: null,
                    lastResumeError: ''
                },
                'agent-2': {
                    agentId: 'agent-2',
                    agentName: 'AGENT 2',
                    createdAt: '2026-03-30T00:10:00.000Z',
                    updatedAt: '2026-03-30T00:10:00.000Z',
                    messages: [
                        {
                            id: 'msg-2',
                            role: 'assistant',
                            content: 'done',
                            timestamp: '2026-03-30T00:10:00.000Z',
                            mode: 'agent'
                        }
                    ],
                    lastResumeAt: null,
                    lastResumeOk: null,
                    lastResumeError: ''
                }
            }
        }, null, 2), 'utf-8');

        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                containerExists: name => name === 'demo',
                dockerExecArgs: args => {
                    if (Array.isArray(args) && args[0] === 'ps') {
                        return 'demo\tUp 2 minutes\tlocalhost/xcanwin/manyoyo:1.0.0-common\n';
                    }
                    return '';
                }
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const sessionsRes = await request(`${baseUrl}/api/sessions`, {
                headers: { Cookie: authCookie }
            });
            expect(sessionsRes.response.status).toBe(200);
            expect(sessionsRes.json.sessions).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    name: 'demo',
                    containerName: 'demo',
                    agentId: 'default',
                    agentName: 'AGENT 1',
                    hostPath: tempHost,
                    containerPath: '/workspace/demo'
                }),
                expect.objectContaining({
                    name: 'demo~agent-2',
                    containerName: 'demo',
                    agentId: 'agent-2',
                    agentName: 'AGENT 2',
                    hostPath: tempHost,
                    containerPath: '/workspace/demo'
                })
            ]));

            const createdAgent = await request(`${baseUrl}/api/sessions/demo/agents`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({})
            });
            expect(createdAgent.response.status).toBe(200);
            expect(createdAgent.json).toEqual(expect.objectContaining({
                name: 'demo~agent-3',
                containerName: 'demo',
                agentId: 'agent-3',
                agentName: 'AGENT 3'
            }));

            const afterCreate = await request(`${baseUrl}/api/sessions`, {
                headers: { Cookie: authCookie }
            });
            expect(afterCreate.response.status).toBe(200);
            expect(afterCreate.json.sessions[0]).toEqual(expect.objectContaining({
                name: 'demo~agent-3',
                agentId: 'agent-3',
                agentName: 'AGENT 3'
            }));
            expect(afterCreate.json.sessions).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    name: 'demo~agent-3',
                    containerName: 'demo',
                    agentId: 'agent-3',
                    agentName: 'AGENT 3',
                    messageCount: 0
                })
            ]));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should sort latest agent by creation time instead of last updated time', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-created-order-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');
        const historyPath = path.join(webHistoryDir, 'demo.json');
        fs.mkdirSync(webHistoryDir, { recursive: true });
        fs.writeFileSync(historyPath, JSON.stringify({
            containerName: 'demo',
            applied: {
                containerName: 'demo',
                hostPath: tempHost,
                containerPath: '/workspace/demo'
            },
            agents: {
                default: {
                    agentId: 'default',
                    agentName: 'AGENT 1',
                    createdAt: '2026-03-30T00:00:00.000Z',
                    updatedAt: '2026-03-30T00:30:00.000Z',
                    messages: []
                },
                'agent-2': {
                    agentId: 'agent-2',
                    agentName: 'AGENT 2',
                    createdAt: '2026-03-30T00:10:00.000Z',
                    updatedAt: '2026-03-30T01:00:00.000Z',
                    messages: []
                },
                'agent-3': {
                    agentId: 'agent-3',
                    agentName: 'AGENT 3',
                    createdAt: '2026-03-30T00:20:00.000Z',
                    updatedAt: '2026-03-30T00:40:00.000Z',
                    messages: []
                }
            }
        }, null, 2), 'utf-8');

        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                containerExists: name => name === 'demo',
                dockerExecArgs: args => {
                    if (Array.isArray(args) && args[0] === 'ps') {
                        return 'demo\tUp 2 minutes\tlocalhost/xcanwin/manyoyo:1.0.0-common\n';
                    }
                    return '';
                }
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const sessionsRes = await request(`${baseUrl}/api/sessions`, {
                headers: { Cookie: authCookie }
            });
            expect(sessionsRes.response.status).toBe(200);
            expect(sessionsRes.json.sessions.slice(0, 3).map(function (session) {
                return session.name;
            })).toEqual(['demo~agent-3', 'demo~agent-2', 'demo']);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should expose AGENT-focused labels, created-order fallback, and create entry in web shell assets', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-label-assets-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const appHtml = await request(`${baseUrl}/`, {
                headers: { Cookie: authCookie }
            });
            expect(appHtml.response.status).toBe(200);
            expect(appHtml.text).toContain('id="openCreateMenuBtn" class="secondary">新建容器</button>');
            expect(appHtml.text.indexOf('id="openCreateMenuBtn"')).toBeLessThan(appHtml.text.indexOf('id="removeBtn"'));
            expect(appHtml.text.indexOf('id="removeBtn"')).toBeLessThan(appHtml.text.indexOf('id="addAgentBtn"'));
            expect(appHtml.text).toContain('id="removeBtn" class="danger">删除容器</button>');
            expect(appHtml.text).toContain('id="addAgentBtn" class="secondary">新建 AGENT</button>');
            expect(appHtml.text).toContain('id="removeAllBtn" class="danger">删除 AGENT</button>');

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).toContain('creatingAgent: false');
            expect(appScript.text).toContain("addAgentBtn.textContent = state.creatingAgent ? '新建中...' : '新建 AGENT';");
            expect(appScript.text).toContain("const openCreateMenuBtn = document.getElementById('openCreateMenuBtn');");
            expect(appScript.text).toContain('openCreateMenuBtn.disabled = state.createLoading || state.createSubmitting;');
            expect(appScript.text).toContain("openCreateMenuBtn.addEventListener('click', function () {");
            expect(appScript.text).toContain('function findLatestCreatedSessionName(sessions, preferredContainerName) {');
            expect(appScript.text).toContain('state.active = findLatestCreatedSessionName(state.sessions, preferredContainerName) || state.sessions[0].name;');
            expect(appScript.text).toContain('preferredContainerName: targetContainerName,');
            expect(appScript.text).toContain("sendState.textContent = '正在新建 AGENT…';");
            expect(appScript.text).toContain("const yes = confirm('确认删除 AGENT ' + targetAgent + ' ?');");
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should infer agent template for existing multi-agent container from container default label', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-infer-agent-template-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');
        const historyPath = path.join(webHistoryDir, 'demo.json');
        fs.mkdirSync(webHistoryDir, { recursive: true });
        fs.writeFileSync(historyPath, JSON.stringify({
            containerName: 'demo',
            agents: {
                default: {
                    agentId: 'default',
                    agentName: 'AGENT 1',
                    updatedAt: '2026-03-30T00:00:00.000Z',
                    messages: [],
                    lastResumeAt: null,
                    lastResumeOk: null,
                    lastResumeError: ''
                },
                'agent-2': {
                    agentId: 'agent-2',
                    agentName: 'AGENT 2',
                    updatedAt: '2026-03-30T00:10:00.000Z',
                    messages: [],
                    lastResumeAt: null,
                    lastResumeOk: null,
                    lastResumeError: ''
                }
            }
        }, null, 2), 'utf-8');

        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                containerExists: name => name === 'demo',
                dockerExecArgs: args => {
                    if (Array.isArray(args) && args[0] === 'ps') {
                        return 'demo\tUp 2 minutes\tlocalhost/xcanwin/manyoyo:1.0.0-full\n';
                    }
                    if (Array.isArray(args) && args[0] === 'inspect') {
                        return 'codex --dangerously-bypass-approvals-and-sandbox\n';
                    }
                    return '';
                }
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const sessionsRes = await request(`${baseUrl}/api/sessions`, {
                headers: { Cookie: authCookie }
            });
            expect(sessionsRes.response.status).toBe(200);
            expect(sessionsRes.json.sessions).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    name: 'demo',
                    agentEnabled: true,
                    agentProgram: 'codex',
                    resumeSupported: true
                }),
                expect.objectContaining({
                    name: 'demo~agent-2',
                    agentEnabled: true,
                    agentProgram: 'codex',
                    resumeSupported: true
                })
            ]));

            const detailRes = await request(`${baseUrl}/api/sessions/demo~agent-2/detail`, {
                headers: { Cookie: authCookie }
            });
            expect(detailRes.response.status).toBe(200);
            expect(detailRes.json.detail).toEqual(expect.objectContaining({
                agentEnabled: true,
                agentProgram: 'codex',
                resumeSupported: true,
                agentPromptCommand: 'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check {prompt}'
            }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should list host directories for web directory picker', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-dir-picker-'));
        const port = await getFreePort();
        const alphaDir = path.join(tempHost, 'alpha');
        const betaDir = path.join(tempHost, 'beta');
        const nestedDir = path.join(alphaDir, 'nested');
        fs.mkdirSync(nestedDir, { recursive: true });
        fs.mkdirSync(betaDir, { recursive: true });
        fs.writeFileSync(path.join(tempHost, 'note.txt'), 'ignore me', 'utf-8');
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const rootList = await request(
                `${baseUrl}/api/fs/directories?path=${encodeURIComponent(tempHost)}`,
                { headers: { Cookie: authCookie } }
            );
            expect(rootList.response.status).toBe(200);
            expect(rootList.json).toEqual(expect.objectContaining({
                currentPath: tempHost,
                entries: expect.arrayContaining([
                    expect.objectContaining({ name: 'alpha', path: alphaDir }),
                    expect.objectContaining({ name: 'beta', path: betaDir })
                ])
            }));
            expect(rootList.json.entries.some(item => item.name === 'note.txt')).toBe(false);

            const nestedList = await request(
                `${baseUrl}/api/fs/directories?path=${encodeURIComponent(nestedDir)}&basePath=${encodeURIComponent(alphaDir)}`,
                { headers: { Cookie: authCookie } }
            );
            expect(nestedList.response.status).toBe(200);
            expect(nestedList.json).toEqual(expect.objectContaining({
                currentPath: nestedDir,
                basePath: alphaDir,
                parentPath: alphaDir
            }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should return masked raw JSON5 config and keep secret placeholders on web save', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-config-'));
        const port = await getFreePort();
        const configPath = path.join(tempHost, 'manyoyo.json');
        fs.writeFileSync(configPath, [
            '{',
            '// test',
            '"hostPath": "/tmp",',
            '"env": {',
            '  "OPENAI_API_KEY": "secret-key",',
            '  "OPENAI_MODEL": "gpt-5.4"',
            '},',
            '"runs": {',
            '  "codex": {',
            '    "shell": "codex --dangerously-bypass-approvals-and-sandbox",',
            '    "env": {',
            '      "JINA_TOKEN": "secret-jina",',
            '      "OPENAI_MODEL": "gpt-5.4-mini"',
            '    }',
            '  }',
            '}',
            '}',
            ''
        ].join('\n'), 'utf-8');
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
            expect(configRes.json.raw).toContain('// test');
            expect(configRes.json.raw).toContain('"OPENAI_API_KEY": "***HIDDEN_SECRET***"');
            expect(configRes.json.raw).toContain('"JINA_TOKEN": "***HIDDEN_SECRET***"');
            expect(configRes.json.raw).not.toContain('secret-key');
            expect(configRes.json.raw).not.toContain('secret-jina');
            expect(configRes.json.defaults).toEqual(expect.objectContaining({
                hostPath: '/tmp'
            }));
            expect(configRes.json.defaults.env).toEqual(expect.objectContaining({
                OPENAI_API_KEY: '***',
                OPENAI_MODEL: 'gpt-5.4'
            }));
            expect(configRes.json.parsed.runs.codex.env).toEqual(expect.objectContaining({
                JINA_TOKEN: '***',
                OPENAI_MODEL: 'gpt-5.4-mini'
            }));
            expect(configRes.json).toEqual(expect.objectContaining({
                editable: true
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
                body: JSON.stringify({
                    raw: [
                        '{',
                        '// test',
                        '"hostPath": "/workspace/demo",',
                        '"env": {',
                        '  "OPENAI_API_KEY": "***HIDDEN_SECRET***",',
                        '  "OPENAI_MODEL": "gpt-5.4"',
                        '},',
                        '"runs": {',
                        '  "codex": {',
                        '    "shell": "codex --dangerously-bypass-approvals-and-sandbox",',
                        '    "env": {',
                        '      "JINA_TOKEN": "***HIDDEN_SECRET***",',
                        '      "OPENAI_MODEL": "gpt-5.4-mini"',
                        '    }',
                        '  }',
                        '}',
                        '}',
                        ''
                    ].join('\n')
                })
            });
            expect(validSave.response.status).toBe(200);
            expect(validSave.json).toEqual(expect.objectContaining({ saved: true, path: configPath }));

            const savedText = fs.readFileSync(configPath, 'utf-8');
            expect(savedText).toContain('// test');
            expect(savedText).toContain('"hostPath": "/workspace/demo"');
            expect(savedText).toContain('"OPENAI_API_KEY": "secret-key"');
            expect(savedText).toContain('"JINA_TOKEN": "secret-jina"');
            expect(savedText).not.toContain('"OPENAI_API_KEY": "***HIDDEN_SECRET***"');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should build web session from server-side run config without exposing secret env values to client', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-run-config-'));
        const port = await getFreePort();
        const configPath = path.join(tempHost, 'manyoyo.json');
        const dockerExecArgs = jest.fn(() => '');
        const waitForContainerReady = jest.fn(async () => {});
        fs.writeFileSync(configPath, [
            '{',
            '  "imageName": "localhost/xcanwin/manyoyo",',
            '  "imageVersion": "1.8.8-common",',
            '  "env": {',
            '    "OPENAI_API_KEY": "secret-key",',
            '    "OPENAI_MODEL": "gpt-5.4"',
            '  },',
            '  "volumes": [',
            `    "${tempHost}:/workspace/base"`,
            '  ],',
            '  "ports": [',
            '    "8080:80"',
            '  ],',
            '  "runs": {',
            '    "codex": {',
            '      "containerName": "my-run-{now}",',
            '      "shell": "codex --dangerously-bypass-approvals-and-sandbox",',
            '      "containerPath": "/workspace/run",',
            '      "env": {',
            '        "JINA_TOKEN": "secret-jina"',
            '      },',
            '      "volumes": [',
            `        "${tempHost}:/workspace/run"`,
            '      ]',
            '    }',
            '  }',
            '}',
            ''
        ].join('\n'), 'utf-8');
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                webConfigPath: configPath,
                dockerExecArgs,
                waitForContainerReady,
                formatDate: () => '0330-1234'
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
                    run: 'codex',
                    createOptions: {
                        hostPath: tempHost
                    }
                })
            });

            expect(created.response.status).toBe(200);
            expect(created.json).toEqual(expect.objectContaining({
                name: 'my-run-0330-1234',
                applied: expect.objectContaining({
                    containerName: 'my-run-0330-1234',
                    containerPath: '/workspace/run',
                    imageVersion: '1.8.8-common',
                    envCount: 3,
                    volumeCount: 2,
                    portCount: 1,
                    agentEnabled: true
                })
            }));

            expect(waitForContainerReady).toHaveBeenCalledWith('my-run-0330-1234');
            const runArgs = dockerExecArgs.mock.calls[0][0];
            expect(runArgs).toEqual(expect.arrayContaining([
                '--name',
                'my-run-0330-1234',
                '--workdir',
                '/workspace/run',
                '--env',
                'OPENAI_API_KEY=secret-key',
                '--env',
                'OPENAI_MODEL=gpt-5.4',
                '--env',
                'JINA_TOKEN=secret-jina',
                '--publish',
                '8080:80',
                '--volume',
                `${tempHost}:/workspace/base`,
                '--volume',
                `${tempHost}:/workspace/run`
            ]));

            const configRes = await request(`${baseUrl}/api/config`, {
                headers: { Cookie: authCookie }
            });
            expect(configRes.response.status).toBe(200);
            expect(configRes.json.parsed.runs.codex.env.JINA_TOKEN).toBe('***');
            expect(configRes.json.defaults.env.OPENAI_API_KEY).toBe('***');
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
                agentPromptCommand: 'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check {prompt}',
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
                    agentPromptCommand: 'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check {prompt}',
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
                agentPromptCommand: 'IS_SANDBOX=1 claude --dangerously-skip-permissions -p {prompt}'
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

    test('should infer gemini and opencode yolo agent prompts when creating web sessions', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-create-other-yolo-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const geminiCreated = await request(`${baseUrl}/api/sessions`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    createOptions: {
                        containerName: 'my-web-create-gemini-yolo',
                        hostPath: tempHost,
                        imageName: 'localhost/xcanwin/manyoyo',
                        imageVersion: '1.7.4-common',
                        yolo: 'gm'
                    }
                })
            });
            expect(geminiCreated.response.status).toBe(200);
            expect(geminiCreated.json).toEqual(expect.objectContaining({
                applied: expect.objectContaining({
                    agentEnabled: true,
                    defaultCommand: 'gemini --yolo'
                })
            }));
            const geminiHistory = JSON.parse(
                fs.readFileSync(path.join(tempHost, 'web-history', 'my-web-create-gemini-yolo.json'), 'utf-8')
            );
            expect(geminiHistory).toEqual(expect.objectContaining({
                agentProgram: 'gemini',
                agentPromptCommand: 'gemini --yolo -p {prompt}'
            }));

            const opencodeCreated = await request(`${baseUrl}/api/sessions`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    createOptions: {
                        containerName: 'my-web-create-opencode-yolo',
                        hostPath: tempHost,
                        imageName: 'localhost/xcanwin/manyoyo',
                        imageVersion: '1.7.4-common',
                        yolo: 'oc'
                    }
                })
            });
            expect(opencodeCreated.response.status).toBe(200);
            expect(opencodeCreated.json).toEqual(expect.objectContaining({
                applied: expect.objectContaining({
                    agentEnabled: true,
                    defaultCommand: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode'
                })
            }));
            const opencodeHistory = JSON.parse(
                fs.readFileSync(path.join(tempHost, 'web-history', 'my-web-create-opencode-yolo.json'), 'utf-8')
            );
            expect(opencodeHistory).toEqual(expect.objectContaining({
                agentProgram: 'opencode',
                agentPromptCommand: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode run {prompt}'
            }));
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
            expect(String(runRes.json.output || '')).toContain('codex exec --json');
            expect(String(runRes.json.output || '')).not.toContain('--output-last-message');
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

    test('should rewrite claude gemini and opencode agent templates to structured json execution', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-structured-template-'));
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
            path.join(webHistoryDir, 'claude-demo.json'),
            JSON.stringify({
                containerName: 'claude-demo',
                updatedAt: null,
                messages: [],
                agentPromptCommand: 'IS_SANDBOX=1 claude --dangerously-skip-permissions -p {prompt}'
            }, null, 4),
            'utf-8'
        );
        fs.writeFileSync(
            path.join(webHistoryDir, 'gemini-demo.json'),
            JSON.stringify({
                containerName: 'gemini-demo',
                updatedAt: null,
                messages: [],
                agentPromptCommand: 'gemini --yolo -p {prompt}'
            }, null, 4),
            'utf-8'
        );
        fs.writeFileSync(
            path.join(webHistoryDir, 'opencode-demo.json'),
            JSON.stringify({
                containerName: 'opencode-demo',
                updatedAt: null,
                messages: [],
                agentPromptCommand: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode run {prompt}'
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

            const claudeRes = await request(`${baseUrl}/api/sessions/claude-demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'hello' })
            });
            expect(claudeRes.response.status).toBe(200);
            expect(String(claudeRes.json.output || '')).toContain('claude --verbose --output-format stream-json --dangerously-skip-permissions -p');
            expect(String(claudeRes.json.output || '')).toContain("'hello'");

            const geminiRes = await request(`${baseUrl}/api/sessions/gemini-demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'hello' })
            });
            expect(geminiRes.response.status).toBe(200);
            expect(String(geminiRes.json.output || '')).toContain('gemini --output-format stream-json --yolo -p');
            expect(String(geminiRes.json.output || '')).toContain("'hello'");

            const opencodeRes = await request(`${baseUrl}/api/sessions/opencode-demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'hello' })
            });
            expect(opencodeRes.response.status).toBe(200);
            expect(String(opencodeRes.json.output || '')).toContain('OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode run --format json');
            expect(String(opencodeRes.json.output || '')).toContain("'hello'");
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should keep codex agent reply clean by using the json agent message', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-codex-clean-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  process.stdout.write('{"type":"thread.started"}\\n');
  process.stdout.write('OpenAI Codex v0.115.0 (research preview)\\n');
  process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"当前这个会话里，我是基于 gpt-5.4 的 Codex。"}}\\n');
  process.stdout.write('tokens used\\n9,215\\n');
  process.stderr.write('mcp: playwright-mcp-host-headless failed\\n');
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

    test('should stream structured trace events for claude gemini and opencode agents', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-structured-stream-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  if (command.includes('claude ')) {
    process.stdout.write('{"type":"system","subtype":"init","session_id":"claude-session"}\\n');
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"我先看看目录。"}]}}\\n');
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls -la"}}]}}\\n');
    process.stdout.write('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}\\n');
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"这是 Claude 最终答案。"}]}}\\n');
    process.stdout.write('{"type":"result","subtype":"success","session_id":"claude-session"}\\n');
    process.exit(0);
    return;
  }
  if (command.includes('gemini ')) {
    process.stdout.write('{"type":"init","timestamp":"2026-03-30T12:00:00.000Z","session_id":"gemini-session","model":"gemini-2.5-pro"}\\n');
    process.stdout.write('{"type":"message","timestamp":"2026-03-30T12:00:01.000Z","role":"assistant","content":"我先看看目录。"}\\n');
    process.stdout.write('{"type":"tool_use","timestamp":"2026-03-30T12:00:02.000Z","tool_name":"run_shell_command","tool_id":"tool_1","parameters":{"command":"ls -la"}}\\n');
    process.stdout.write('{"type":"tool_result","timestamp":"2026-03-30T12:00:03.000Z","tool_id":"tool_1","status":"success","output":"ok"}\\n');
    process.stdout.write('{"type":"message","timestamp":"2026-03-30T12:00:04.000Z","role":"assistant","content":"这是 Gemini 最终答案。"}\\n');
    process.stdout.write('{"type":"result","timestamp":"2026-03-30T12:00:05.000Z","status":"success"}\\n');
    process.exit(0);
    return;
  }
  if (command.includes('opencode ')) {
    process.stdout.write('{"type":"session.start","session_id":"opencode-session"}\\n');
    process.stdout.write('{"type":"message","role":"assistant","content":"我先看看目录。"}\\n');
    process.stdout.write('{"type":"tool_use","tool_name":"bash","tool_id":"tool_1","parameters":{"command":"ls -la"}}\\n');
    process.stdout.write('{"type":"tool_result","tool_id":"tool_1","status":"success","output":"ok"}\\n');
    process.stdout.write('{"type":"message","role":"assistant","content":"这是 OpenCode 最终答案。"}\\n');
    process.stdout.write('{"type":"result","status":"success"}\\n');
    process.exit(0);
    return;
  }
}
process.exit(0);
`,
            'utf-8'
        );
        fs.chmodSync(fakeDockerPath, 0o755);

        const webHistoryDir = path.join(tempHost, 'web-history');
        fs.mkdirSync(webHistoryDir, { recursive: true });
        const cases = [
            {
                sessionName: 'claude-demo',
                template: 'IS_SANDBOX=1 claude --dangerously-skip-permissions -p {prompt}',
                provider: 'claude',
                expectedResult: '这是 Claude 最终答案。',
                expectedToolStartTrace: '[工具开始] Bash (command=ls -la)',
                expectedToolCompleteTrace: '[工具完成] Bash (success)'
            },
            {
                sessionName: 'gemini-demo',
                template: 'gemini --yolo -p {prompt}',
                provider: 'gemini',
                expectedResult: '这是 Gemini 最终答案。',
                expectedToolStartTrace: '[工具开始] run_shell_command (command=ls -la)',
                expectedToolCompleteTrace: '[工具完成] run_shell_command (success)'
            },
            {
                sessionName: 'opencode-demo',
                template: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode run {prompt}',
                provider: 'opencode',
                expectedResult: '这是 OpenCode 最终答案。',
                expectedToolStartTrace: '[工具开始] bash (command=ls -la)',
                expectedToolCompleteTrace: '[工具完成] bash (success)'
            }
        ];
        for (const item of cases) {
            fs.writeFileSync(
                path.join(webHistoryDir, `${item.sessionName}.json`),
                JSON.stringify({
                    containerName: item.sessionName,
                    updatedAt: null,
                    messages: [],
                    agentPromptCommand: item.template
                }, null, 4),
                'utf-8'
            );
        }

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

            for (const item of cases) {
                const streamRes = await requestNdjsonStream(`${baseUrl}/api/sessions/${item.sessionName}/agent/stream`, {
                    method: 'POST',
                    headers: {
                        Cookie: authCookie,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ prompt: '帮我看看当前目录' })
                });
                expect(streamRes.response.status).toBe(200);
                expect(streamRes.events).toEqual(expect.arrayContaining([
                    expect.objectContaining({ type: 'meta', agentProgram: item.provider }),
                    expect.objectContaining({ type: 'trace', text: '[说明] 我先看看目录。' }),
                    expect.objectContaining({ type: 'trace', text: item.expectedToolStartTrace }),
                    expect.objectContaining({ type: 'trace', text: item.expectedToolCompleteTrace }),
                    expect.objectContaining({ type: 'result', output: item.expectedResult })
                ]));

                const persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, `${item.sessionName}.json`), 'utf-8'));
                const traceMessage = (persisted.messages || []).find(message => message && message.streamTrace === true);
                expect(traceMessage).toEqual(expect.objectContaining({
                    role: 'assistant',
                    mode: 'agent',
                    streamTrace: true
                }));
                expect(String(traceMessage.content || '')).toContain(item.expectedToolStartTrace);
                const assistantMessage = (persisted.messages || []).find(message => message && message.role === 'assistant' && message.streamTrace !== true);
                expect(assistantMessage).toEqual(expect.objectContaining({
                    content: item.expectedResult
                }));
            }
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should stream codex agent trace events before final result', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-codex-stream-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  process.stdout.write('{"type":"thread.started"}\\n');
  process.stdout.write('{"type":"turn.started"}\\n');
  process.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"我先看看当前目录。"}}\\n');
  process.stdout.write('{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc ls -la","status":"in_progress"}}\\n');
  process.stdout.write('{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc ls -la","status":"completed","exit_code":0}}\\n');
  process.stdout.write('{"type":"item.started","item":{"id":"item_2","type":"mcp_tool_call","server":"jina-mcp-server","tool":"search_web","arguments":{"query":"OpenAI latest news","num":5},"status":"in_progress"}}\\n');
  process.stdout.write('{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"jina-mcp-server","tool":"search_web","arguments":{"query":"OpenAI latest news","num":5},"status":"completed"}}\\n');
  process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"这是最终答案。"}}\\n');
  process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\\n');
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

            const streamRes = await requestNdjsonStream(`${baseUrl}/api/sessions/demo/agent/stream`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: '帮我看看当前目录' })
            });
            expect(streamRes.response.status).toBe(200);
            expect(streamRes.events).toEqual(expect.arrayContaining([
                expect.objectContaining({ type: 'meta', agentProgram: 'codex' }),
                expect.objectContaining({ type: 'trace', text: '[会话] Codex 已开始处理' }),
                expect.objectContaining({ type: 'trace', text: '[回合] 开始生成响应' }),
                expect.objectContaining({ type: 'trace', text: '[说明] 我先看看当前目录。' }),
                expect.objectContaining({
                    type: 'trace',
                    text: '[命令开始] /bin/bash -lc ls -la',
                    traceEvent: expect.objectContaining({
                        provider: 'codex',
                        kind: 'command',
                        itemType: 'command_execution',
                        phase: 'started',
                        command: '/bin/bash -lc ls -la'
                    })
                }),
                expect.objectContaining({
                    type: 'trace',
                    text: '[命令完成] /bin/bash -lc ls -la (completed)',
                    traceEvent: expect.objectContaining({
                        provider: 'codex',
                        kind: 'command',
                        itemType: 'command_execution',
                        phase: 'completed',
                        command: '/bin/bash -lc ls -la',
                        exitCode: 0
                    })
                }),
                expect.objectContaining({
                    type: 'trace',
                    text: '[MCP开始] jina-mcp-server.search_web (query=OpenAI latest news, num=5)',
                    traceEvent: expect.objectContaining({
                        provider: 'codex',
                        kind: 'mcp',
                        itemType: 'mcp_tool_call',
                        phase: 'started',
                        server: 'jina-mcp-server',
                        tool: 'search_web',
                        argumentSummary: 'query=OpenAI latest news, num=5'
                    })
                }),
                expect.objectContaining({
                    type: 'trace',
                    text: '[MCP完成] jina-mcp-server.search_web (query=OpenAI latest news, num=5)',
                    traceEvent: expect.objectContaining({
                        provider: 'codex',
                        kind: 'mcp',
                        itemType: 'mcp_tool_call',
                        phase: 'completed',
                        server: 'jina-mcp-server',
                        tool: 'search_web',
                        argumentSummary: 'query=OpenAI latest news, num=5'
                    })
                }),
                expect.objectContaining({ type: 'result', output: '这是最终答案。' })
            ]));

            const persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            const traceMessage = (persisted.messages || []).find(message => message && message.streamTrace === true);
            expect(traceMessage).toEqual(expect.objectContaining({
                role: 'assistant',
                mode: 'agent',
                streamTrace: true
            }));
            expect(String(traceMessage.content || '')).toContain('[MCP开始] jina-mcp-server.search_web');
            expect(Array.isArray(traceMessage.traceEvents)).toBe(true);
            expect(traceMessage.traceEvents).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    provider: 'codex',
                    kind: 'command',
                    command: '/bin/bash -lc ls -la'
                }),
                expect.objectContaining({
                    provider: 'codex',
                    kind: 'mcp',
                    server: 'jina-mcp-server',
                    tool: 'search_web'
                })
            ]));
            const assistantMessage = (persisted.messages || []).find(message => message && message.role === 'assistant' && message.streamTrace !== true);
            expect(assistantMessage).toEqual(expect.objectContaining({
                content: '这是最终答案。'
            }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should persist pending prompt and trace during agent streaming for refresh recovery', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-refresh-recovery-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  process.stdout.write('{"type":"system","subtype":"init","session_id":"claude-session"}\\n');
  setTimeout(() => {
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"第一段回复。"}]}}\\n');
  }, 40);
  setTimeout(() => {
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"第二段回复。"}]}}\\n');
  }, 120);
  setTimeout(() => {
    process.stdout.write('{"type":"result","subtype":"success","session_id":"claude-session"}\\n');
    process.exit(0);
  }, 220);
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
                agentPromptCommand: 'IS_SANDBOX=1 claude --dangerously-skip-permissions -p {prompt}'
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
            let checkedPendingHistory = false;
            let checkedStreamingReply = false;

            const streamRes = await requestNdjsonStream(`${baseUrl}/api/sessions/demo/agent/stream`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: '请持续输出' })
            }, async payload => {
                if (!checkedPendingHistory && payload && payload.type === 'meta') {
                    checkedPendingHistory = true;
                    const historyRes = await request(`${baseUrl}/api/sessions/demo/messages`, {
                        headers: { Cookie: authCookie }
                    });
                    expect(historyRes.response.status).toBe(200);
                    const pendingUser = (historyRes.json.messages || []).find(message => message && message.role === 'user');
                    expect(pendingUser).toEqual(expect.objectContaining({
                        content: '请持续输出',
                        pending: true,
                        mode: 'agent'
                    }));
                    const pendingTrace = (historyRes.json.messages || []).find(message => message && message.streamTrace === true);
                    expect(pendingTrace).toEqual(expect.objectContaining({
                        pending: true,
                        streamTrace: true
                    }));
                    expect(String(pendingTrace.content || '')).toContain('[执行过程]');
                }
                if (!checkedStreamingReply && payload && payload.type === 'content_delta' && payload.content === '第一段回复。') {
                    checkedStreamingReply = true;
                    const historyRes = await request(`${baseUrl}/api/sessions/demo/messages`, {
                        headers: { Cookie: authCookie }
                    });
                    expect(historyRes.response.status).toBe(200);
                    const streamingReply = (historyRes.json.messages || []).find(message => message && message.streamingReply === true);
                    expect(streamingReply).toEqual(expect.objectContaining({
                        content: '第一段回复。',
                        pending: true,
                        mode: 'agent',
                        role: 'assistant',
                        streamingReply: true
                    }));
                }
            });

            expect(streamRes.response.status).toBe(200);
            expect(checkedPendingHistory).toBe(true);
            expect(checkedStreamingReply).toBe(true);

            const finalHistoryRes = await request(`${baseUrl}/api/sessions/demo/messages`, {
                headers: { Cookie: authCookie }
            });
            expect(finalHistoryRes.response.status).toBe(200);
            expect((finalHistoryRes.json.messages || []).some(message => message && message.pending === true)).toBe(false);
            expect((finalHistoryRes.json.messages || []).some(message => message && message.streamingReply === true)).toBe(false);
            const finalAssistant = (finalHistoryRes.json.messages || []).find(message => message && message.role === 'assistant' && message.streamTrace !== true);
            expect(finalAssistant).toEqual(expect.objectContaining({
                content: '第二段回复。'
            }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should stop running agent stream on demand', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-stop-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  process.stdout.write('{"type":"thread.started"}\\n');
  process.stdout.write('{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc long-task","status":"in_progress"}}\\n');
  const timer = setTimeout(() => {
    process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"正常结束"}}\\n');
    process.exit(0);
  }, 5000);
  process.on('SIGTERM', () => {
    clearTimeout(timer);
    process.stderr.write('stopped by test\\n');
    process.exit(143);
  });
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
            let stopSent = false;

            const streamPromise = requestNdjsonStream(`${baseUrl}/api/sessions/demo/agent/stream`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: '运行一个很长的任务' })
            }, async payload => {
                if (!stopSent && payload && payload.type === 'meta') {
                    stopSent = true;
                    const stopRes = await request(`${baseUrl}/api/sessions/demo/agent/stop`, {
                        method: 'POST',
                        headers: {
                            Cookie: authCookie,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({})
                    });
                    expect(stopRes.response.status).toBe(200);
                    expect(stopRes.json).toEqual(expect.objectContaining({ ok: true, stopping: true }));
                }
            });

            const streamRes = await streamPromise;
            expect(streamRes.response.status).toBe(200);
            expect(stopSent).toBe(true);
            expect(streamRes.events).toEqual(expect.arrayContaining([
                expect.objectContaining({ type: 'result', interrupted: true })
            ]));

            const stopAgain = await request(`${baseUrl}/api/sessions/demo/agent/stop`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({})
            });
            expect(stopAgain.response.status).toBe(404);
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

    test('should save container and agent-specific prompt templates and execute with agent override', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-template-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        const execLogPath = path.join(tempHost, 'exec-log.json');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  fs.writeFileSync(${JSON.stringify(execLogPath)}, JSON.stringify(args), 'utf-8');
  process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"覆盖模板生效"}]}}\\n');
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
                agentPromptCommand: 'codex exec --skip-git-repo-check {prompt}',
                agents: {
                    'agent-2': {
                        agentId: 'agent-2',
                        agentName: 'AGENT 2',
                        messages: []
                    }
                }
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

            const saveRes = await request(`${baseUrl}/api/sessions/demo~agent-2/agent-template`, {
                method: 'PUT',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    containerAgentPromptCommand: 'codex exec --skip-git-repo-check {prompt}',
                    agentPromptCommandOverride: 'claude -p {prompt}'
                })
            });
            expect(saveRes.response.status).toBe(200);
            expect(saveRes.json).toEqual(expect.objectContaining({
                saved: true,
                name: 'demo~agent-2',
                detail: expect.objectContaining({
                    agentPromptCommand: 'claude -p {prompt}',
                    containerAgentPromptCommand: 'codex exec --skip-git-repo-check {prompt}',
                    agentPromptCommandOverride: 'claude -p {prompt}',
                    agentPromptSource: 'agent',
                    agentProgram: 'claude',
                    resumeSupported: true
                })
            }));

            const streamRes = await requestNdjsonStream(`${baseUrl}/api/sessions/demo~agent-2/agent/stream`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: '你好' })
            });
            expect(streamRes.response.status).toBe(200);
            expect(streamRes.events).toEqual(expect.arrayContaining([
                expect.objectContaining({ type: 'meta', agentProgram: 'claude' }),
                expect.objectContaining({ type: 'result', output: '覆盖模板生效' })
            ]));

            const execArgs = JSON.parse(fs.readFileSync(execLogPath, 'utf-8'));
            const execCommand = execArgs[execArgs.length - 1];
            expect(execCommand).toContain('claude');
            expect(execCommand).toContain('--verbose');
            expect(execCommand).toContain('--output-format stream-json');
            expect(execCommand).not.toContain('codex exec');

            const clearRes = await request(`${baseUrl}/api/sessions/demo~agent-2/agent-template`, {
                method: 'PUT',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    agentPromptCommandOverride: ''
                })
            });
            expect(clearRes.response.status).toBe(200);
            expect(clearRes.json).toEqual(expect.objectContaining({
                detail: expect.objectContaining({
                    agentPromptCommand: 'codex exec --skip-git-repo-check {prompt}',
                    containerAgentPromptCommand: 'codex exec --skip-git-repo-check {prompt}',
                    agentPromptCommandOverride: '',
                    agentPromptSource: 'container',
                    agentProgram: 'codex',
                    resumeSupported: true
                })
            }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should stop running claude structured agent stream on demand', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-claude-stop-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  process.stdout.write('{"type":"system","subtype":"init","session_id":"claude-session"}\\n');
  process.stdout.write('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"sleep 10"}}]}}\\n');
  const timer = setTimeout(() => {
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"正常结束"}}]}\\n');
    process.stdout.write('{"type":"result","subtype":"success","session_id":"claude-session"}\\n');
    process.exit(0);
  }, 10000);
  process.on('SIGTERM', () => {
    clearTimeout(timer);
    process.stderr.write('claude stopped by test\\n');
    process.exit(143);
  });
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
                agentPromptCommand: 'IS_SANDBOX=1 claude --dangerously-skip-permissions -p {prompt}'
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

            let stopSent = false;
            const streamPromise = requestNdjsonStream(`${baseUrl}/api/sessions/demo/agent/stream`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: '执行一个长任务' })
            }, async payload => {
                if (!stopSent && payload && payload.type === 'trace' && payload.text === '[工具开始] Bash (command=sleep 10)') {
                    stopSent = true;
                    const stopRes = await request(`${baseUrl}/api/sessions/demo/agent/stop`, {
                        method: 'POST',
                        headers: {
                            Cookie: authCookie,
                            'Content-Type': 'application/json'
                        }
                    });
                    expect(stopRes.response.status).toBe(200);
                    expect(stopRes.json).toEqual(expect.objectContaining({ ok: true, stopping: true }));
                }
            });

            const streamRes = await streamPromise;
            expect(streamRes.response.status).toBe(200);
            expect(stopSent).toBe(true);
            expect(streamRes.events).toEqual(expect.arrayContaining([
                expect.objectContaining({ type: 'meta', agentProgram: 'claude' }),
                expect.objectContaining({ type: 'trace', text: '[工具开始] Bash (command=sleep 10)' }),
                expect.objectContaining({ type: 'result', interrupted: true })
            ]));

            const stopAgain = await request(`${baseUrl}/api/sessions/demo/agent/stop`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                }
            });
            expect(stopAgain.response.status).toBe(404);

            const persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            const traceMessage = (persisted.messages || []).find(message => message && message.streamTrace === true);
            expect(traceMessage).toEqual(expect.objectContaining({
                streamTrace: true
            }));
            expect(String(traceMessage.content || '')).toContain('[任务] 已停止');
            const assistantMessage = (persisted.messages || []).find(message => message && message.role === 'assistant' && message.streamTrace !== true);
            expect(assistantMessage).toEqual(expect.objectContaining({
                interrupted: true
            }));
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
            expect(String(turn2.json.output || '')).toContain("claude --verbose --output-format stream-json -p 'who am i'");
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

    test('should expand generic claude agent template from applied default command for new agents', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-claude-default-command-'));
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
                agentPromptCommand: 'claude -p {prompt}',
                applied: {
                    defaultCommand: 'IS_SANDBOX=1 claude --dangerously-skip-permissions'
                }
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

            const createdAgent = await request(`${baseUrl}/api/sessions/demo/agents`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({})
            });
            expect(createdAgent.response.status).toBe(200);
            expect(createdAgent.json).toEqual(expect.objectContaining({
                name: 'demo~agent-2',
                agentId: 'agent-2'
            }));

            const runRes = await request(`${baseUrl}/api/sessions/demo~agent-2/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'hello' })
            });
            expect(runRes.response.status).toBe(200);
            expect(String(runRes.json.output || '')).toContain('IS_SANDBOX=1 claude');
            expect(String(runRes.json.output || '')).toContain('--dangerously-skip-permissions');
            expect(String(runRes.json.output || '')).toContain("--verbose --output-format stream-json");
            expect(String(runRes.json.output || '')).toContain("-p 'hello'");

            const persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            expect(persisted).toEqual(expect.objectContaining({
                agentPromptCommand: 'IS_SANDBOX=1 claude --dangerously-skip-permissions -p {prompt}'
            }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should emit content_delta events during agent streaming for claude gemini and opencode', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-content-delta-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  if (command.includes('claude ')) {
    process.stdout.write('{"type":"system","subtype":"init","session_id":"claude-session"}\\n');
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"第一段回复。"}]}}\\n');
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}\\n');
    process.stdout.write('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}\\n');
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"第二段回复。"}]}}\\n');
    process.stdout.write('{"type":"result","subtype":"success"}\\n');
    process.exit(0);
    return;
  }
  if (command.includes('gemini ')) {
    process.stdout.write('{"type":"init","session_id":"gemini-session","model":"gemini-2.5-pro"}\\n');
    process.stdout.write('{"type":"message","role":"assistant","content":"Gemini 第一段。","delta":true}\\n');
    process.stdout.write('{"type":"message","role":"assistant","content":"Gemini 第二段。","delta":true}\\n');
    process.stdout.write('{"type":"result","status":"success"}\\n');
    process.exit(0);
    return;
  }
  if (command.includes('opencode ')) {
    process.stdout.write('{"type":"session.start","session_id":"opencode-session"}\\n');
    process.stdout.write('{"type":"message","role":"assistant","content":"OC 第一段。","delta":true}\\n');
    process.stdout.write('{"type":"message","role":"assistant","content":"OC 第二段。","delta":true}\\n');
    process.stdout.write('{"type":"result","status":"success"}\\n');
    process.exit(0);
    return;
  }
}
process.exit(0);
`,
            'utf-8'
        );
        fs.chmodSync(fakeDockerPath, 0o755);

        const webHistoryDir = path.join(tempHost, 'web-history');
        fs.mkdirSync(webHistoryDir, { recursive: true });
        const cases = [
            {
                sessionName: 'claude-delta',
                template: 'IS_SANDBOX=1 claude --dangerously-skip-permissions -p {prompt}',
                expectedDeltas: ['第一段回复。', '第二段回复。']
            },
            {
                sessionName: 'gemini-delta',
                template: 'gemini --yolo -p {prompt}',
                expectedDeltas: ['Gemini 第一段。', 'Gemini 第一段。Gemini 第二段。']
            },
            {
                sessionName: 'opencode-delta',
                template: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode run {prompt}',
                expectedDeltas: ['OC 第一段。', 'OC 第一段。OC 第二段。']
            }
        ];
        for (const item of cases) {
            fs.writeFileSync(
                path.join(webHistoryDir, `${item.sessionName}.json`),
                JSON.stringify({
                    containerName: item.sessionName,
                    updatedAt: null,
                    messages: [],
                    agentPromptCommand: item.template
                }, null, 4),
                'utf-8'
            );
        }

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

            for (const item of cases) {
                const streamRes = await requestNdjsonStream(`${baseUrl}/api/sessions/${item.sessionName}/agent/stream`, {
                    method: 'POST',
                    headers: {
                        Cookie: authCookie,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ prompt: '测试' })
                });
                expect(streamRes.response.status).toBe(200);
                const contentDeltas = streamRes.events.filter(e => e.type === 'content_delta');
                expect(contentDeltas.length).toBeGreaterThanOrEqual(item.expectedDeltas.length);
                for (let i = 0; i < item.expectedDeltas.length; i++) {
                    const matchingDelta = contentDeltas.find(d => d.content === item.expectedDeltas[i]);
                    expect(matchingDelta).toBeTruthy();
                    expect(matchingDelta.content).toBe(item.expectedDeltas[i]);
                }
            }
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });
});
