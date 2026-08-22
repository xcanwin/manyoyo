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
            expect(authedEditorBundle.text).toContain('getValue()');

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
        const readmeStore = path.join(tempHost, 'README.md');
        const workspaceStore = path.join(tempHost, 'workspace');
        fs.writeFileSync(readmeStore, '# hello\nthis is readme\n', 'utf-8');
        fs.mkdirSync(workspaceStore, { recursive: true });
        fs.writeFileSync(fakeDocker, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const command = args[4] || '';
const readmeStore = ${JSON.stringify(readmeStore)};
const workspaceStore = ${JSON.stringify(workspaceStore)};
function toHostWorkspacePath(targetPath) {
    const requested = String(targetPath || '').trim();
    if (!requested.startsWith('/workspace')) {
        throw new Error('unexpected workspace path: ' + requested);
    }
    const relative = requested.slice('/workspace'.length).replace(/^[/]+/, '');
    return relative ? path.join(workspaceStore, relative) : workspaceStore;
}
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
    const readmeContent = fs.readFileSync(readmeStore, 'utf-8');
    process.stdout.write(JSON.stringify({
        path: '/workspace/README.md',
        kind: 'text',
        size: Buffer.byteLength(readmeContent, 'utf8'),
        language: 'markdown',
        content: readmeContent,
        truncated: false
    }));
    process.exit(0);
}
if (command.includes('__MANYOYO_FS_WRITE__')) {
    const matched = command.match(/const nextContent = ([\\s\\S]+?);\\n\\ntry \\{/);
    if (!matched) {
        process.stderr.write('missing content');
        process.exit(3);
    }
    const readmeContent = JSON.parse(matched[1]);
    fs.writeFileSync(readmeStore, readmeContent, 'utf-8');
    process.stdout.write(JSON.stringify({
        path: '/workspace/README.md',
        saved: true,
        size: Buffer.byteLength(readmeContent, 'utf8')
    }));
    process.exit(0);
}
if (command.includes('__MANYOYO_FS_MKDIR__')) {
    const matched = command.match(/const requestedPath = ([\\s\\S]+?);\\n\\ntry \\{/);
    if (!matched) {
        process.stderr.write('missing path');
        process.exit(4);
    }
    const targetPath = JSON.parse(matched[1]);
    const hostTargetPath = toHostWorkspacePath(targetPath);
    fs.mkdirSync(hostTargetPath, { recursive: true });
    const stat = fs.statSync(hostTargetPath);
    process.stdout.write(JSON.stringify({
        path: targetPath,
        name: path.basename(targetPath),
        kind: 'directory',
        size: 0,
        mtimeMs: stat.mtimeMs,
        created: true
    }));
    process.exit(0);
}
if (command.includes('__MANYOYO_FS_CREATE__')) {
    const matched = command.match(/const requestedPath = ([\\s\\S]+?);\\n\\ntry \\{/);
    if (!matched) {
        process.stderr.write('missing path');
        process.exit(5);
    }
    const targetPath = JSON.parse(matched[1]);
    const hostTargetPath = toHostWorkspacePath(targetPath);
    fs.writeFileSync(hostTargetPath, '', 'utf-8');
    const stat = fs.statSync(hostTargetPath);
    process.stdout.write(JSON.stringify({
        path: targetPath,
        name: path.basename(targetPath),
        kind: 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        created: true
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
                truncated: false,
                editable: true
            }));

            const writeRes = await request(`${baseUrl}/api/sessions/test/fs/write`, {
                method: 'PUT',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    path: '/workspace/README.md',
                    content: '# changed\nsaved\n'
                })
            });
            expect(writeRes.response.status).toBe(200);
            expect(writeRes.json).toEqual(expect.objectContaining({
                path: '/workspace/README.md',
                saved: true
            }));

            const readAfterWriteRes = await request(`${baseUrl}/api/sessions/test/fs/read?path=${encodeURIComponent('/workspace/README.md')}&full=1`, {
                headers: { Cookie: authCookie }
            });
            expect(readAfterWriteRes.response.status).toBe(200);
            expect(readAfterWriteRes.json).toEqual(expect.objectContaining({
                path: '/workspace/README.md',
                kind: 'text',
                language: 'markdown',
                content: '# changed\nsaved\n',
                truncated: false,
                editable: true
            }));

            const mkdirRes = await request(`${baseUrl}/api/sessions/test/fs/mkdir`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    path: '/workspace/new-dir'
                })
            });
            expect(mkdirRes.response.status).toBe(200);
            expect(mkdirRes.json).toEqual(expect.objectContaining({
                path: '/workspace/new-dir',
                name: 'new-dir',
                kind: 'directory',
                created: true
            }));

            const createFileRes = await request(`${baseUrl}/api/sessions/test/fs/create`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    path: '/workspace/new-file.txt'
                })
            });
            expect(createFileRes.response.status).toBe(200);
            expect(createFileRes.json).toEqual(expect.objectContaining({
                path: '/workspace/new-file.txt',
                name: 'new-file.txt',
                kind: 'file',
                size: 0,
                created: true
            }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should surface resolved symlink target and kind via fs/list, following multi-hop chains', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-fs-symlink-'));
        const port = await getFreePort();
        const fakeDocker = path.join(tempHost, 'fake-docker.js');
        const browseDir = path.join(tempHost, 'browse');
        fs.mkdirSync(browseDir, { recursive: true });
        const realFile = path.join(browseDir, 'real.txt');
        fs.writeFileSync(realFile, 'secret content', 'utf-8');
        // 三级链式符号链接：chained-link.txt -> link2 -> link1 -> real.txt
        fs.symlinkSync(realFile, path.join(browseDir, 'link1'));
        fs.symlinkSync(path.join(browseDir, 'link1'), path.join(browseDir, 'link2'));
        fs.symlinkSync(path.join(browseDir, 'link2'), path.join(browseDir, 'chained-link.txt'));
        fs.symlinkSync(path.join(browseDir, 'does-not-exist'), path.join(browseDir, 'broken-link.txt'));

        // 这里让 fake docker 真正执行 buildContainerFileListCommand 生成的脚本本体（而不是手写返回值），
        // 因为要验证的正是该脚本里新加的符号链接解析逻辑本身是否正确（多级链、断链）。
        fs.writeFileSync(fakeDocker, `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args[4] || '';
if (args[0] !== 'exec') {
    process.stderr.write('unexpected docker args');
    process.exit(1);
}
if (command.includes('__MANYOYO_FS_LIST__')) {
    const matched = command.match(/node <<'__MANYOYO_NODE__'\\n([\\s\\S]*)\\n__MANYOYO_NODE__/);
    if (!matched) {
        process.stderr.write('missing script body');
        process.exit(2);
    }
    eval(matched[1]);
    process.exit(0);
}
process.stderr.write('unknown command');
process.exit(9);
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

            const listRes = await request(`${baseUrl}/api/sessions/test/fs/list?path=${encodeURIComponent(browseDir)}`, {
                headers: { Cookie: authCookie }
            });
            expect(listRes.response.status).toBe(200);

            const chained = listRes.json.entries.find(entry => entry.name === 'chained-link.txt');
            expect(chained).toEqual(expect.objectContaining({
                kind: 'symlink',
                symlinkTarget: fs.realpathSync(realFile),
                symlinkTargetKind: 'file'
            }));

            const broken = listRes.json.entries.find(entry => entry.name === 'broken-link.txt');
            expect(broken).toEqual(expect.objectContaining({
                kind: 'symlink',
                symlinkTarget: null,
                symlinkTargetKind: null
            }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should stream whitelisted image files via fs/raw and reject non-image extensions without touching the container', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-fs-raw-'));
        const port = await getFreePort();
        const fakeDocker = path.join(tempHost, 'fake-docker.js');
        const execLog = path.join(tempHost, 'exec.log');
        const workspaceStore = path.join(tempHost, 'workspace');
        fs.mkdirSync(workspaceStore, { recursive: true });
        const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x20, 0xab, 0xcd]);
        fs.writeFileSync(path.join(workspaceStore, 'photo.png'), imageBytes);
        fs.writeFileSync(path.join(workspaceStore, 'notes.txt'), 'plain text');
        fs.writeFileSync(execLog, '');
        fs.writeFileSync(fakeDocker, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(execLog)}, args.join(' ') + '\\n');
const workspaceStore = ${JSON.stringify(workspaceStore)};
function toHostWorkspacePath(targetPath) {
    const requested = String(targetPath || '').trim();
    if (!requested.startsWith('/workspace')) {
        throw new Error('unexpected workspace path: ' + requested);
    }
    const relative = requested.slice('/workspace'.length).replace(/^[/]+/, '');
    return relative ? path.join(workspaceStore, relative) : workspaceStore;
}
if (args[0] !== 'exec') {
    process.stderr.write('unexpected docker args');
    process.exit(1);
}
if (args[2] === 'cat') {
    const requestedPath = args[4];
    try {
        const hostPath = toHostWorkspacePath(requestedPath);
        const content = fs.readFileSync(hostPath);
        process.stdout.write(content);
        process.exit(0);
    } catch (e) {
        process.stderr.write('cat failed: ' + e.message);
        process.exit(1);
    }
}
const command = args[4] || '';
if (command.includes('__MANYOYO_FS_STAT__')) {
    const matched = command.match(/const requestedPath = ([\\s\\S]+?);\\n\\ntry \\{/);
    const requestedPath = JSON.parse(matched[1]);
    try {
        const hostPath = toHostWorkspacePath(requestedPath);
        const stat = fs.statSync(hostPath);
        if (!stat.isFile()) {
            throw new Error('目标不是文件: ' + requestedPath);
        }
        process.stdout.write(JSON.stringify({ path: requestedPath, size: stat.size }));
        process.exit(0);
    } catch (e) {
        process.stdout.write(JSON.stringify({ error: e.message }));
        process.exit(0);
    }
}
if (command.includes('__MANYOYO_FS_READ__')) {
    const matched = command.match(/const requestedPath = ([\\s\\S]+?);\\nconst maxBytes/);
    const requestedPath = JSON.parse(matched[1]);
    try {
        const hostPath = toHostWorkspacePath(requestedPath);
        const stat = fs.statSync(hostPath);
        if (path.extname(requestedPath).toLowerCase() === '.png') {
            process.stdout.write(JSON.stringify({ path: requestedPath, kind: 'image', size: stat.size }));
        } else {
            process.stdout.write(JSON.stringify({ path: requestedPath, kind: 'text', size: stat.size, truncated: false, content: fs.readFileSync(hostPath, 'utf-8') }));
        }
        process.exit(0);
    } catch (e) {
        process.stdout.write(JSON.stringify({ error: e.message }));
        process.exit(0);
    }
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

            const unauthRes = await fetch(`${baseUrl}/api/sessions/test/fs/raw?path=${encodeURIComponent('/workspace/photo.png')}`);
            expect(unauthRes.status).toBe(401);

            const authCookie = await loginAndGetCookie(baseUrl);

            const badExtRes = await fetch(`${baseUrl}/api/sessions/test/fs/raw?path=${encodeURIComponent('/workspace/notes.txt')}`, {
                headers: { Cookie: authCookie }
            });
            expect(badExtRes.status).toBe(400);
            expect(fs.readFileSync(execLog, 'utf-8')).toBe('');

            const missingRes = await fetch(`${baseUrl}/api/sessions/test/fs/raw?path=${encodeURIComponent('/workspace/missing.png')}`, {
                headers: { Cookie: authCookie }
            });
            expect(missingRes.status).toBe(404);

            const imageRes = await fetch(`${baseUrl}/api/sessions/test/fs/raw?path=${encodeURIComponent('/workspace/photo.png')}`, {
                headers: { Cookie: authCookie }
            });
            expect(imageRes.status).toBe(200);
            expect(imageRes.headers.get('content-type')).toBe('image/png');
            expect(imageRes.headers.get('content-length')).toBe(String(imageBytes.length));
            expect(imageRes.headers.get('x-content-type-options')).toBe('nosniff');
            const receivedBytes = Buffer.from(await imageRes.arrayBuffer());
            expect(receivedBytes.equals(imageBytes)).toBe(true);

            const imageReadRes = await fetch(`${baseUrl}/api/sessions/test/fs/read?path=${encodeURIComponent('/workspace/photo.png')}`, {
                headers: { Cookie: authCookie }
            });
            expect(imageReadRes.status).toBe(200);
            const imageReadJson = await imageReadRes.json();
            expect(imageReadJson).toEqual(expect.objectContaining({
                path: '/workspace/photo.png',
                kind: 'image',
                size: imageBytes.length
            }));
            expect(imageReadJson.content).toBeUndefined();
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should cap concurrent fs/raw streams per container and release the slot on client abort', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-fs-raw-concurrency-'));
        const port = await getFreePort();
        const fakeDocker = path.join(tempHost, 'fake-docker.js');
        const startedLog = path.join(tempHost, 'started.log');
        const workspaceStore = path.join(tempHost, 'workspace');
        fs.mkdirSync(workspaceStore, { recursive: true });
        const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
        fs.writeFileSync(path.join(workspaceStore, 'photo.png'), imageBytes);
        fs.writeFileSync(startedLog, '');
        fs.writeFileSync(fakeDocker, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const workspaceStore = ${JSON.stringify(workspaceStore)};
function toHostWorkspacePath(targetPath) {
    const requested = String(targetPath || '').trim();
    if (!requested.startsWith('/workspace')) {
        throw new Error('unexpected workspace path: ' + requested);
    }
    const relative = requested.slice('/workspace'.length).replace(/^[/]+/, '');
    return relative ? path.join(workspaceStore, relative) : workspaceStore;
}
if (args[0] !== 'exec') {
    process.stderr.write('unexpected docker args');
    process.exit(1);
}
if (args[2] === 'cat') {
    const requestedPath = args[4];
    fs.appendFileSync(${JSON.stringify(startedLog)}, '1\\n');
    setTimeout(() => {
        try {
            const hostPath = toHostWorkspacePath(requestedPath);
            const content = fs.readFileSync(hostPath);
            process.stdout.write(content);
            process.exit(0);
        } catch (e) {
            process.stderr.write('cat failed: ' + e.message);
            process.exit(1);
        }
    }, 300);
} else {
    const command = args[4] || '';
    if (command.includes('__MANYOYO_FS_STAT__')) {
        const matched = command.match(/const requestedPath = ([\\s\\S]+?);\\n\\ntry \\{/);
        const requestedPath = JSON.parse(matched[1]);
        try {
            const hostPath = toHostWorkspacePath(requestedPath);
            const stat = fs.statSync(hostPath);
            process.stdout.write(JSON.stringify({ path: requestedPath, size: stat.size }));
            process.exit(0);
        } catch (e) {
            process.stdout.write(JSON.stringify({ error: e.message }));
            process.exit(0);
        }
    } else {
        process.stderr.write('unknown command');
        process.exit(2);
    }
}
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
            const rawUrl = `${baseUrl}/api/sessions/test/fs/raw?path=${encodeURIComponent('/workspace/photo.png')}`;

            const serverSource = fs.readFileSync(path.join(__dirname, '../lib/web/server.js'), 'utf-8');
            expect(serverSource).toContain('const WEB_FILE_RAW_MAX_CONCURRENT_PER_CONTAINER = 4;');
            const MAX_CONCURRENT = 4;

            const abortController = new AbortController();
            const inFlight = [];
            for (let i = 0; i < MAX_CONCURRENT; i++) {
                const options = { headers: { Cookie: authCookie } };
                if (i === 0) {
                    options.signal = abortController.signal;
                }
                inFlight.push(fetch(rawUrl, options));
            }

            const waitStart = Date.now();
            while (fs.readFileSync(startedLog, 'utf-8').trim().split('\n').filter(Boolean).length < MAX_CONCURRENT) {
                if (Date.now() - waitStart > 2000) {
                    throw new Error('timed out waiting for concurrent cat processes to start');
                }
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            const overflowRes = await fetch(rawUrl, { headers: { Cookie: authCookie } });
            expect(overflowRes.status).toBe(429);

            abortController.abort();
            await expect(inFlight[0]).rejects.toThrow();

            await new Promise(resolve => setTimeout(resolve, 50));
            const afterAbortRes = await fetch(rawUrl, { headers: { Cookie: authCookie } });
            expect(afterAbortRes.status).toBe(200);
            await afterAbortRes.arrayBuffer();

            const remaining = await Promise.all(inFlight.slice(1));
            for (const res of remaining) {
                expect(res.status).toBe(200);
                await res.arrayBuffer();
            }
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should read large json files via web api without truncating container json payload', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-container-fs-large-json-'));
        const port = await getFreePort();
        const fakeDocker = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(fakeDocker, `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args[4] || '';
const largeJsonText = JSON.stringify({
    lockfileVersion: 3,
    packages: {
        '': {
            name: 'manyoyo',
            version: '1.0.0'
        }
    },
    filler: 'x'.repeat(24000)
}, null, 2);
if (args[0] !== 'exec') {
    process.stderr.write('unexpected docker args');
    process.exit(1);
}
if (command.includes('__MANYOYO_FS_READ__')) {
    process.stdout.write(JSON.stringify({
        path: '/workspace/package-lock.json',
        kind: 'text',
        size: largeJsonText.length,
        language: 'json',
        content: largeJsonText,
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

            const readRes = await request(`${baseUrl}/api/sessions/test/fs/read?path=${encodeURIComponent('/workspace/package-lock.json')}`, {
                headers: { Cookie: authCookie }
            });
            expect(readRes.response.status).toBe(200);
            expect(readRes.json).toEqual(expect.objectContaining({
                path: '/workspace/package-lock.json',
                kind: 'text',
                language: 'json',
                truncated: false
            }));
            expect(String(readRes.json.content || '')).toContain('"lockfileVersion": 3');
            expect(String(readRes.json.content || '').length).toBeGreaterThan(20000);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should keep web file preview limit large enough for package-lock style text files', () => {
        const serverSource = fs.readFileSync(path.join(__dirname, '../lib/web/server.js'), 'utf-8');
        expect(serverSource).toContain('const WEB_FILE_PREVIEW_MAX_BYTES = 512 * 1024;');
        expect(serverSource).toContain('const WEB_FILE_EDIT_MAX_BYTES = 2 * 1024 * 1024;');
    });

    test('should expose editable-small-file and readonly-large-file behavior in file browser assets', () => {
        const fileBrowserSource = fs.readFileSync(path.join(__dirname, '../lib/web/frontend/file-browser.js'), 'utf-8');
        const editorSource = fs.readFileSync(path.join(__dirname, '../lib/web/frontend/codemirror-entry.js'), 'utf-8');
        const editorBundleSource = fs.readFileSync(path.join(__dirname, '../lib/web/frontend/codemirror.bundle.js'), 'utf-8');
        const appHtmlSource = fs.readFileSync(path.join(__dirname, '../lib/web/frontend/app.html'), 'utf-8');
        const appSource = fs.readFileSync(path.join(__dirname, '../lib/web/frontend/app.js'), 'utf-8');
        const appStyleSource = fs.readFileSync(path.join(__dirname, '../lib/web/frontend/app.css'), 'utf-8');
        expect(fileBrowserSource).toContain("const FILE_EDIT_MAX_BYTES = 2 * 1024 * 1024;");
        expect(fileBrowserSource).toContain('data-action="save" disabled>保存</button>');
        expect(fileBrowserSource).toContain('data-role="path" value="/"');
        expect(fileBrowserSource).toContain('data-action="visit">访问</button>');
        expect(fileBrowserSource).toContain('data-action="mkdir">新建目录</button>');
        expect(fileBrowserSource).not.toContain('data-action="up"');
        expect(fileBrowserSource).not.toContain('data-action="refresh"');
        expect(fileBrowserSource).toContain("await confirmFn(`文件较大（${formatBytes(fileSize)}），继续后将以只读方式全量预览，无法保存。是否继续？`)");
        expect(fileBrowserSource).toContain("'&full=1'");
        expect(fileBrowserSource).toContain("/fs/write");
        expect(fileBrowserSource).toContain("/fs/mkdir");
        expect(fileBrowserSource).toContain("/fs/create");
        expect(fileBrowserSource).toContain('data-action="new-file">新建文件</button>');
        expect(fileBrowserSource).toContain('请输入新文件名称');
        expect(fileBrowserSource).toContain('function updatePreviewMeta()');
        expect(fileBrowserSource).toContain('state.selectedFile.size = new TextEncoder().encode(nextValue).length;');
        expect(fileBrowserSource).toContain("parts.push('符号链接');");
        expect(fileBrowserSource).toContain('function openSymlinkEntry(entry)');
        expect(fileBrowserSource).toContain('function sanitizeDisplayText(value)');
        expect(fileBrowserSource).toContain('escapeHtml(sanitizeDisplayText(entry.name || entry.path || \'未命名\'))');
        expect(fileBrowserSource).toContain("if (entry.kind === 'symlink') {\n                        openSymlinkEntry(entry);");
        expect(fileBrowserSource).toContain('files-entry-parent');
        expect(fileBrowserSource).toContain('请输入新目录名称');
        expect(fileBrowserSource).toContain('saveBtn.disabled = !isEditablePreview();');
        expect(fileBrowserSource).toContain("if (event.key === 'Enter')");
        expect(fileBrowserSource).not.toContain("listNode.innerHTML = '<div class=\"files-empty\">当前目录为空。</div>';");
        expect(fileBrowserSource).not.toContain("renderPreviewEmpty(state.currentPath, '请选择左侧文件进行预览。');");
        expect(editorSource).toContain('getValue() {');
        expect(editorBundleSource).toContain('getValue()');
        expect(appHtmlSource).toContain('<div id="configEditor" class="config-editor"></div>');
        expect(appHtmlSource).not.toContain('<textarea id="configEditor"');
        expect(appSource).toContain('function ensureConfigCodeEditor() {');
        expect(appSource).toContain("state.configEditor = window.ManyoyoCodeEditor.create(configEditor, {");
        expect(appSource).toContain("language: 'javascript'");
        expect(appSource).toContain('body: JSON.stringify({ raw: getConfigEditorValue() })');
        expect(appStyleSource).toContain('.files-toolbar-path-group');
        expect(appStyleSource).toContain('.files-toolbar-path-input');
        expect(appStyleSource).toContain('.files-toolbar-meta');
        expect(appStyleSource).toContain('flex-wrap: nowrap;');
        expect(appStyleSource).toContain('flex-wrap: wrap;');
        expect(appStyleSource).toContain('overflow-wrap: anywhere;');
        expect(appStyleSource).toContain('.files-entry:hover');
        expect(appStyleSource).toContain('box-shadow: inset 3px 0 0');
        expect(appStyleSource).toContain('grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);');
        expect(appStyleSource).toContain('grid-template-columns: minmax(0, 1fr) auto;');
        expect(appStyleSource).toContain('.files-editor-host .cm-gutters');
        expect(appStyleSource).toContain('.files-list > .files-empty');
        expect(appStyleSource).toContain('.files-entry-parent');
        expect(appStyleSource).toContain('.config-editor .cm-editor');
        expect(appStyleSource).toContain('overflow-wrap: anywhere;');
        expect(appStyleSource).toContain('text-align: right;');
    });

    test('should ship breadcrumb bar and session card layout styles', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-sidebar-nav-style-'));
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
            expect(appStyle.text).toContain('.crumb-bar {');
            expect(appStyle.text).toContain('.crumb-item {');
            expect(appStyle.text).toContain('.crumb-item.is-current {');
            expect(appStyle.text).toContain('.crumb-jump-active {');
            expect(appStyle.text).toContain('.session-card {');
            expect(appStyle.text).toContain('.session-card-button {');
            // 面包屑上的"全部容器"/"回到当前会话"是 <button>，通用 button:hover 会带来深色背景，
            // 不显式覆盖 hover 背景色的话会和文字同色系撞色看不清（同一类问题在 .msg-copy-btn:hover 已修过一次）
            expect(appStyle.text).toMatch(/\.crumb-item:hover\s*\{[^}]*background:/);
            expect(appStyle.text).toMatch(/\.crumb-jump-active:hover\s*\{[^}]*background:/);
            // 更多操作触发按钮的可点击区域太小，容易误点，需要比图标本身大一圈
            expect(appStyle.text).toMatch(/\.tree-node-menu-trigger\s*\{[^}]*width:\s*(2[8-9]|[3-9]\d)px/);
            expect(appStyle.text).toMatch(/\.tree-node-menu-trigger\s*\{[^}]*height:\s*(2[8-9]|[3-9]\d)px/);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should navigate sidebar container/agent levels locally without re-fetching sessions', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-sidebar-nav-script-'));
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
            // 下钻/返回只是切换 state.navLevel/navContainer 并本地重渲染，不重新请求 /api/sessions
            expect(appScript.text).toContain('function navigateTo(level, params) {');
            expect(appScript.text).toContain('persistSidebarNavState();\n        renderSessions();');
            expect(appScript.text).toContain('function renderContainerLevel(groups) {');
            expect(appScript.text).toContain('function renderAgentLevel(containerGroup) {');
            expect(appScript.text).toContain('function renderBreadcrumb() {');
            // 容器卡片"无备注只有一行补充信息"时要用和 agent 卡片一样的 meta（更醒目），
            // 只有"已设置备注、原名降级为次要信息"时才用 subMeta（更淡），两边字段映射规则必须一致
            expect(appScript.text).toContain("meta: containerGroup.containerRemark ? containerGroup.containerName : containerGroup.hostPath,");
            expect(appScript.text).toContain("subMeta: containerGroup.containerRemark ? containerGroup.hostPath : '',");
            // 更多操作下拉面板在滚动列表底部会被 #sessionList 的 overflow 裁切，
            // 需要在展开时把面板挂到 body 上用 position:fixed 定位，脱离滚动容器的裁切范围
            expect(appScript.text).toContain("document.body.appendChild(panel);");
            expect(appScript.text).toContain("panel.style.position = 'fixed';");
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should only stick chat scroll to bottom on user-initiated sends, not on passive streaming updates', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-chat-scroll-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const chatBehaviorScript = await request(`${baseUrl}/app/frontend/chat-behavior.js`, {
                headers: { Cookie: authCookie }
            });
            expect(chatBehaviorScript.response.status).toBe(200);
            expect(chatBehaviorScript.response.headers.get('content-type')).toContain('application/javascript');
            expect(chatBehaviorScript.text).toContain('window.ManyoyoChatBehavior');
            expect(chatBehaviorScript.text).toContain('function isNearBottom(');

            const appHtml = await request(`${baseUrl}/`, {
                headers: { Cookie: authCookie }
            });
            expect(appHtml.text).toContain('<script src="/app/frontend/chat-behavior.js"></script>');

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).toContain('window.ManyoyoChatBehavior.isNearBottom(');

            // 用户主动发送（推流开始、命令/AGENT 消息入队）仍强制滚到底部
            expect(appScript.text).toContain('clearAgentRecoveryPoll();\n        renderMessages(state.messages, { stickToBottom: true });');
            expect(appScript.text).toContain('state.messages.push(pendingMessage);\n        renderMessages(state.messages, { stickToBottom: true });');

            // 被动/流式更新（trace 行、增量、结果、失败回滚）不再强制滚动，改为遵循是否已在底部
            expect(appScript.text).not.toContain("updateAgentTraceMessageLocal(sessionName, traceMessageId, traceLines.join('\\n'), traceEvent);\n            if (state.active === sessionName) {\n                renderMessages(state.messages, { stickToBottom: true });");
            expect(appScript.text).not.toContain("updateStreamingReplyLocal(sessionName, streamingReplyId, content);\n                        if (state.active === sessionName) {\n                            renderMessages(state.messages, { stickToBottom: true });");
            expect(appScript.text).not.toContain("appendAssistantMessageLocal(sessionName, finalResult, 'agent');\n        if (state.active === sessionName) {\n            renderMessages(state.messages, { stickToBottom: true });");
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should collapse the whole trace flow by default with a manual expand toggle', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-trace-flow-toggle-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const chatBehaviorScript = await request(`${baseUrl}/app/frontend/chat-behavior.js`, {
                headers: { Cookie: authCookie }
            });
            expect(chatBehaviorScript.text).toContain('function summarizeTraceFlow(');
            expect(chatBehaviorScript.text).toContain('function buildStructuredTraceResidualLines(');

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).toContain('const traceFlowExpandedState = new Map();');
            expect(appScript.text).toContain("toggle.className = 'trace-flow-toggle';");
            // 过程中的"状态"残留行（如"上下文模式: xxx"、"[任务] 已完成"）只在仍处于流式执行（pending）时展示，
            // 任务结束后只保留结构化的 traceEvent 卡片，避免完整回复出现后还留一堆过程噪音
            expect(appScript.text).toContain("if (pending) {\n            window.ManyoyoChatBehavior.buildStructuredTraceResidualLines(message).forEach(function (line) {");
            expect(appScript.text).toContain('const mergedTraceEvents = window.ManyoyoChatBehavior.mergeToolTraceEvents(traceEvents);');
            expect(appScript.text).toContain('window.ManyoyoChatBehavior.summarizeTraceFlow(mergedTraceEvents, { pending });');
            expect(appScript.text).toContain("toggle.addEventListener('toggle', function () {");
            expect(appScript.text).toContain('traceFlowExpandedState.set(messageId, toggle.open);');

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.text).toContain('.trace-flow-toggle {');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should render cumulative usage stats card in the detail panel', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-usage-panel-'));
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
            expect(appScript.text).toContain("renderKeyValueCard(detailSummary, '用量统计', detail.usageTotal ? [");
            expect(appScript.text).toContain("{ label: '累计输入 tokens', value: String(detail.usageTotal.inputTokens) }");
            expect(appScript.text).toContain("{ label: '累计输出 tokens', value: String(detail.usageTotal.outputTokens) }");
            expect(appScript.text).toContain("typeof detail.usageTotal.costUsd === 'number' ? `$${detail.usageTotal.costUsd.toFixed(4)}` : '暂不支持'");
            expect(appScript.text).toContain('暂无数据（当前 Agent 程序不支持用量统计，或还未执行过对话）');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should expose copy-to-clipboard actions for user messages and agent markdown replies', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-copy-actions-'));
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
            expect(appScript.text).toContain('function copyTextToClipboard(text) {');
            expect(appScript.text).toContain('function appendMessageCopyActions(container, items) {');
            expect(appScript.text).toContain("navigator.clipboard.writeText(text);");
            expect(appScript.text).toContain("{ label: '复制', getText: function () { return msg.content; } }");
            expect(appScript.text).toContain("{ label: '复制文本', getText: function () { return markdownNode.innerText || markdownNode.textContent || ''; } }");
            expect(appScript.text).toContain("{ label: '复制 Markdown', getText: function () { return msg.content; } }");
            // 复制按钮挂在气泡（bubble）上，用悬浮浮层展示，而不是常驻在时间戳那一行（meta）
            expect(appScript.text).toContain('appendMessageCopyActions(bubble, [');
            expect(appScript.text).not.toContain('appendMessageCopyActions(meta, [');

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.text).toContain('.msg-copy-btn {');
            // 默认不占用布局空间，只在悬浮聊天块时才浮现在下方
            expect(appStyle.text).toMatch(/\.msg-actions\s*\{[^}]*position:\s*absolute;/);
            expect(appStyle.text).toMatch(/\.msg-actions\s*\{[^}]*top:\s*100%;/);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should collapse terminal/files/detail/config/check tabs into a workspace switcher popover', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-workspace-switcher-'));
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
            expect(appHtml.text).toContain('id="workspaceSwitcherToggle"');
            expect(appHtml.text).toContain('id="workspaceSwitcherPanel"');
            expect(appHtml.text).toContain('id="viewActivityBtn"');
            // 5 个非活动目的地都挪进了弹出面板，不再直接铺在 header 里
            expect(appHtml.text).toMatch(/id="workspaceSwitcherPanel"[^>]*>[\s\S]*id="viewTerminalBtn"/);
            expect(appHtml.text).toMatch(/id="workspaceSwitcherPanel"[^>]*>[\s\S]*id="viewCheckBtn"/);

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            // setActiveTab 与 isActiveSessionHistoryOnly 守卫逻辑本身完全未改动
            expect(appScript.text).toContain('function setActiveTab(tab) {');
            expect(appScript.text).toContain('if (!state.terminal.connected && !state.terminal.connecting && !isActiveSessionHistoryOnly()) {');
            expect(appScript.text).toContain('function setWorkspaceSwitcherMenu(open) {');
            expect(appScript.text).toContain("workspaceSwitcherToggle.addEventListener('click', function () {");
            expect(appScript.text).toContain('closeWorkspaceSwitcherMenu();\n            setActiveTab(\'terminal\');');

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.text).toContain('.workspace-switcher-panel {');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should not auto-focus inputs on mobile when switching tabs/modes or opening the CLI modal', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-mobile-focus-'));
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

            // 切到终端页：移动端不应自动 focus 终端，避免自动弹出输入法
            expect(appScript.text).toContain(
                "if (state.terminal.term && !isMobileLayout()) {\n                state.terminal.term.focus();\n            }"
            );
            // WebSocket 连接建立时（connectTerminal 的 open 回调）同样不应在移动端自动 focus 终端
            expect(appScript.text).toContain(
                "if (state.terminal.term) {\n                if (!isMobileLayout()) {\n                    state.terminal.term.focus();\n                }\n                scheduleTerminalFit(true);\n            }"
            );

            // 切到活动页 / 系统命令 / Agent 对话：移动端不应自动 focus 输入框
            expect(appScript.text).toContain(
                "closeWorkspaceSwitcherMenu();\n            setActiveTab('activity');\n            if (!isMobileLayout()) {\n                commandInput.focus();\n            }"
            );
            expect(appScript.text).toContain(
                "closeComposerOptionsMenu();\n            syncUi();\n            if (!isMobileLayout()) {\n                commandInput.focus();\n            }"
            );

            // 打开 CLI 模板弹窗：移动端不应自动 focus 下拉框（会自动展开选项）
            expect(appScript.text).toContain(
                "state.agentTemplateModalOpen = true;\n        fillAgentTemplateForm(detail);\n        syncUi();\n        if (isMobileLayout()) {\n            return;\n        }"
            );
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should collapse Agent/命令/CLI/模型 into a single "选项" dropdown above "发送", opening upward and closed by default', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-composer-options-'));
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
            expect(appHtml.text).not.toContain('composer-toolbar');
            expect(appHtml.text).toMatch(
                /<button[^>]*id="composerOptionsToggle"[^>]*>选项<\/button>\s*<div class="composer-options-panel" id="composerOptionsPanel" hidden>\s*<button type="button" id="activityAgentBtn" class="secondary is-active">Agent对话<\/button>\s*<button type="button" id="activityCommandBtn" class="secondary">系统命令<\/button>\s*<button type="button" id="agentTemplateBtn" class="secondary">CLI · —<\/button>\s*<button type="button" id="activityModelChip" class="secondary">模型 · —<\/button>/
            );
            // "选项"必须在"发送"之前（DOM 序），对应视觉上"选项在发送上方"
            expect(appHtml.text.indexOf('id="composerOptionsToggle"')).toBeLessThan(appHtml.text.indexOf('id="sendBtn"'));

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).not.toContain('function syncComposerExpanded()');
            expect(appScript.text).not.toContain('shouldExpandComposer');
            expect(appScript.text).toContain('function setComposerOptionsMenu(open) {');
            expect(appScript.text).toContain('function closeComposerOptionsMenu() {');
            expect(appScript.text).toContain("composerOptionsToggle.addEventListener('click', function () {");
            // 选中 Agent对话/系统命令、点击 CLI 之后都要收起下拉框
            expect(appScript.text).toContain('closeComposerOptionsMenu();\n            syncUi();\n            if (!isMobileLayout()) {\n                commandInput.focus();\n            }');
            // 模型 chip 现在是可点击按钮，点击打开模型选择弹窗
            expect(appScript.text).toContain('async function openModelModal() {');
            expect(appScript.text).toContain("await api('/api/sessions/' + encodeURIComponent(state.active) + '/models');");
            expect(appScript.text).toContain("await api('/api/sessions/' + encodeURIComponent(state.active) + '/model', {");
            expect(appScript.text).toContain('activityModelChip.addEventListener(\'click\', function () {');

            const chatBehaviorScript = await request(`${baseUrl}/app/frontend/chat-behavior.js`, {
                headers: { Cookie: authCookie }
            });
            expect(chatBehaviorScript.text).not.toContain('shouldExpandComposer');

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.response.status).toBe(200);
            expect(appStyle.text).not.toContain('.composer-toolbar');
            expect(appStyle.text).not.toContain('.composer-mode-switch');
            // 触发按钮贴在 composer 底部，下拉框必须往上展开，不能往下超出视口
            expect(appStyle.text).toMatch(/\.composer-options-panel\s*\{[^}]*bottom:\s*calc\(100% \+ 8px\);/);
            // 模型弹窗里的 <select> 用的是通用 .text-block 包裹，必须补上 select 样式，否则渲染成无样式的浏览器默认下拉框
            expect(appStyle.text).toContain('.text-block select {');
            // .text-block 自带 display: flex，会盖掉浏览器默认的 [hidden]{display:none}，
            // 必须显式补一条 [hidden] 规则，否则"自定义模型名称"输入框在下拉选中已知模型时也不会隐藏
            expect(appStyle.text).toContain('.text-block[hidden] {\n    display: none;\n}');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should keep the header divider-free with tight padding on both desktop and mobile', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-mobile-header-trim-'));
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
            // 桌面端 header 无分割线、留白收紧
            expect(appStyle.text).toMatch(/\.header\s*\{[^}]*padding:\s*0 8px 4px;/);
            expect(appStyle.text).not.toMatch(/\.header\s*\{[^}]*border-bottom:/);
            // 移动端只保留"会话"和"···"两个小按钮，同样收紧留白、不带分割线
            const mobileHeaderMatch = appStyle.text.match(/@media \(max-width: 640px\) \{[\s\S]*?\.header\s*\{([^}]*)\}/);
            expect(mobileHeaderMatch).not.toBeNull();
            expect(mobileHeaderMatch[1]).toMatch(/padding:\s*4px 12px;/);
            expect(mobileHeaderMatch[1]).not.toMatch(/border-bottom:/);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should consolidate repeated panel background gradients into a shared token', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-surface-tokens-'));
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
            expect(appStyle.text).toContain('--surface-panel: linear-gradient(');

            const panelBgUsages = appStyle.text.split('background: var(--surface-panel);').length - 1;
            expect(panelBgUsages).toBe(4);

            // 右侧聊天列不再保留顶栏分割线：#messages 的包围边框、header/composer 的分割线均已去除，
            // 靠背景色差异区分内容区与输入区，减少视觉上的线条堆叠
            expect(appStyle.text).not.toContain('--line-medium');
            expect(appStyle.text).not.toContain('border-top: 1px solid var(--line-medium);');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should not wrap #messages with a full border box (only the header keeps a divider line)', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-messages-no-border-'));
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
            expect(appStyle.text).toMatch(/#messages\s*\{(?:(?!\})[\s\S])*\}/);
            const messagesRule = appStyle.text.match(/#messages\s*\{((?:(?!\})[\s\S])*)\}/)[1];
            expect(messagesRule).not.toContain('border:');
            expect(messagesRule).toContain('border-radius: 14px;');

            const composerRule = appStyle.text.match(/\.composer\s*\{((?:(?!\})[\s\S])*)\}/)[1];
            expect(composerRule).not.toContain('border-top');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should unify container corner radius (10px) and pill badge radius (999px) in the chat cluster', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-radius-language-'));
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
            // 容器语言：消息气泡 / 执行过程整体折叠 / 单条 trace 卡片 / 复制按钮统一为 10px
            expect(appStyle.text).toMatch(/\.bubble\s*\{[^}]*border-radius:\s*10px/);
            expect(appStyle.text).toMatch(/\.trace-flow-toggle\s*\{[^}]*border-radius:\s*10px/);
            expect(appStyle.text).toMatch(/\.trace-card\s*\{[^}]*border-radius:\s*10px/);
            expect(appStyle.text).toMatch(/\.msg-copy-btn\s*\{[^}]*border-radius:\s*10px/);
            // 徽标语言：执行过程徽标统一为 999px 全圆 pill
            // （旧版会话列表的 .session-status 徽标已随树形侧边栏改造整体移除，
            // 会话状态现在是 .tree-node-status 纯色文字，不是 pill 背景块，见阶段6.1）
            expect(appStyle.text).toMatch(/\.trace-card-badge\s*\{[^}]*border-radius:\s*999px/);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should remove the persistent header title/meta and sync document.title to the active agent instead', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-header-title-'));
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
            expect(appHtml.text).not.toContain('id="activeTitle"');
            expect(appHtml.text).not.toContain('id="activeMeta"');

            const chatBehaviorScript = await request(`${baseUrl}/app/frontend/chat-behavior.js`, {
                headers: { Cookie: authCookie }
            });
            expect(chatBehaviorScript.text).toContain('function buildDocumentTitle(');

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).not.toContain("document.getElementById('activeTitle')");
            expect(appScript.text).not.toContain("document.getElementById('activeMeta')");
            expect(appScript.text).not.toContain('function buildActiveMeta(');
            expect(appScript.text).toContain('document.title = window.ManyoyoChatBehavior.buildDocumentTitle(');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should collapse the chat header into a single row (会话/活动/··· only, no title bar or "更多" menu)', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-header-single-row-'));
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
            // 会话（移动端）、···（workspace-switcher）同属一个 .workbench-tabs 行；
            // "活动"已收进 workspace-switcher-panel，作为下拉里的第一个选项，不再单独占用顶栏
            expect(appHtml.text).toMatch(
                /<div class="workbench-tabs" id="workbenchTabs"[^>]*>\s*<button[^>]*id="mobileSessionToggle"[^>]*>会话<\/button>\s*<div class="workspace-switcher">/
            );
            expect(appHtml.text).toMatch(
                /<div class="workspace-switcher-panel" id="workspaceSwitcherPanel" hidden>\s*<button type="button" id="viewActivityBtn"/
            );
            expect(appHtml.text).not.toContain('header-main-top');
            expect(appHtml.text).not.toContain('id="mobileActionsToggle"');
            expect(appHtml.text).not.toContain('id="headerActions"');
            expect(appHtml.text).not.toContain('Container Session Console');

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.response.status).toBe(200);
            expect(appStyle.text).not.toContain('.header-main-top');
            expect(appStyle.text).not.toContain('.header-menu');
            expect(appStyle.text).not.toContain('.header-actions');
            expect(appStyle.text).not.toContain('.mobile-actions-toggle');
            expect(appStyle.text).not.toContain('.brand-sub');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should remove the composer hint/status footer and stop stealing input focus after a reply finishes', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-composer-foot-focus-'));
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
            // "发送"按钮的禁用/灰色状态已经能表达是否发送中，不再需要单独的提示文案/状态标签
            expect(appHtml.text).not.toContain('id="composerHint"');
            expect(appHtml.text).not.toContain('id="sendState"');
            expect(appHtml.text).not.toContain('composer-foot');

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).not.toContain("getElementById('composerHint')");
            expect(appScript.text).not.toContain("getElementById('sendState')");
            // 发送/agent 回复完成后的 finally 块不应再抢焦点回输入框
            expect(appScript.text).toMatch(/state\.sending = false;\s*\n\s*syncUi\(\);\s*\n\s*\}\s*\n\s*\}\);\s*\n\s*\n\s*commandInput\.addEventListener\('keydown'/);

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.response.status).toBe(200);
            expect(appStyle.text).not.toContain('.composer-foot');
            expect(appStyle.text).not.toContain('.send-state');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should merge the standalone "停止" button into "发送" (single button that relabels/turns danger-outline while an agent run is active)', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-send-stop-merge-'));
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
            expect(appHtml.text).toContain('type="submit" id="sendBtn"');
            expect(appHtml.text).not.toContain('id="stopBtn"');

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).not.toContain("getElementById('stopBtn')");
            // 提交事件里先判断"当前是否正在跑 agent"，是的话把这次提交当成停止指令，
            // 而不是走发送逻辑；停止指令复用同一个 /agent/stop 接口
            expect(appScript.text).toContain("if (mode === 'agent' && activeAgentRunning) {");
            expect(appScript.text).toContain("'/api/sessions/' + encodeURIComponent(state.active) + '/agent/stop'");
            // 运行期间按钮重新打上标签、切换成危险色描边样式，而不是维持两个按钮各自禁用/启用
            expect(appScript.text).toContain("sendBtn.textContent = state.agentRun.stopping ? '停止中…' : '停止';");
            expect(appScript.text).toContain("sendBtn.classList.add('danger-outline');");
            expect(appScript.text).toContain("sendBtn.classList.remove('danger-outline');");

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.response.status).toBe(200);
            expect(appStyle.text).not.toContain('#stopBtn');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should render the trace message as a structured drawer immediately (no raw-text flash before the first trace event arrives)', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-trace-no-flash-'));
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
            // 之前要求 traceEvents.length 才走结构化渲染，导致 traceEvents 还是空数组时
            // （刚创建 trace 消息、第一条 status 事件还没到）落回 <pre> 纯文本渲染，产生短暂的样式闪烁
            expect(appScript.text).toContain('const shouldRenderStructuredTrace = Boolean(msg && msg.streamTrace);');
            expect(appScript.text).not.toContain('&& Array.isArray(msg.traceEvents)\n            && msg.traceEvents.length');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should merge "AGENT 过程" into "AGENT 回复" for display (single block, trace before reply content, no separate 过程 label)', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-trace-merge-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const chatBehaviorScript = await request(`${baseUrl}/app/frontend/chat-behavior.js`, {
                headers: { Cookie: authCookie }
            });
            expect(chatBehaviorScript.response.status).toBe(200);
            expect(chatBehaviorScript.text).toContain('function mergeTraceIntoReply(messages) {');
            // 合并后的消息用 trace 的时间戳作为唯一显示时间
            expect(chatBehaviorScript.text).toContain('Object.assign({}, next, { timestamp: msg.timestamp, pairedTrace: msg })');

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).toContain('function renderMessages(rawMessages, options) {');
            expect(appScript.text).toContain('const messages = window.ManyoyoChatBehavior.mergeTraceIntoReply(rawMessages);');
            // trace 内容渲染在回复气泡内部、回复正文之前，不再单独起一行 "AGENT 过程"
            expect(appScript.text).toContain('if (msg && msg.pairedTrace) {\n            appendStructuredTraceContent(bubble, msg.pairedTrace);\n        }');

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.response.status).toBe(200);
            // trace 抽屉和紧跟其后的回复正文之间留一点间隔，避免两者几乎贴在一起
            expect(appStyle.text).toMatch(/\.trace-structured\s*\{[^}]*margin-bottom:\s*10px;/);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should show "AGENT 回复" from the start (not "AGENT 过程"), default the trace drawer to collapsed, and fix copy-button hover contrast/rounding/panel background', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-trace-polish-'));
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
            // 独立的 trace 消息（还没有配对的回复）也直接显示 "AGENT 回复"，不再有单独的
            // "AGENT 过程" 标签在合并后才变成 "AGENT 回复"（避免标签闪一下变化）
            expect(appScript.text).not.toContain("return 'AGENT 过程';");
            // 执行过程默认收纳；只有出现错误时才默认展开，不再因为"还没有 trace 事件"就默认展开
            expect(appScript.text).toContain('const defaultOpen = hasError;');
            expect(appScript.text).not.toContain('const defaultOpen = hasError || traceEvents.length === 0;');

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.response.status).toBe(200);
            // 复制按钮悬浮态必须显式声明背景色，否则会被通用的 button:hover（深色背景）
            // 盖过去，导致和同样变色的文字撞色看不清
            expect(appStyle.text).toMatch(/\.msg-copy-btn:hover\s*\{[^}]*background:\s*#f0e6d3;/);
            // composer 的父级 <form> 补上圆角，和 #messages 统一成同一套"外层容器"语言
            expect(appStyle.text).toMatch(/\.composer\s*\{[^}]*border-radius:\s*14px;/);
            // .main 包裹 #messages / .composer 的这一层背景改用同一个 --surface-panel token，
            // 不再单独定义一个偏深的渐变，消除缝隙处的颜色断层
            expect(appStyle.text).toMatch(/\.main\s*\{[^}]*background:\s*var\(--surface-panel\);/);
            expect(appStyle.text).not.toContain('linear-gradient(165deg, rgba(255, 251, 243, 0.95) 0%, rgba(247, 237, 223, 0.95) 100%)');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should reserve layout space for the copy-action overlay (instead of fighting z-index wars with the next sibling) and only elevate the last message above the sticky mobile composer', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-msg-actions-zindex-'));
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
            // 触屏设备一次性显示所有消息的浮层（没有 :hover 概念），如果靠"悬浮时统一提升
            // z-index"，同时被抬到同一个值的消息会按 DOM 序打平——后一条盖住前一条，
            // 早消息的浮层反而被下一条消息的时间戳挡住。改成给带浮层的消息本身留够
            // margin-bottom，让浮层完整落在消息间的空白里，从根源上不再需要抢层级
            expect(appStyle.text).toMatch(/\.msg:has\(\.msg-actions\)\s*\{\s*\n\s*margin-bottom:\s*20px;/);
            // 唯一还需要抢层级的是"最后一条消息 vs 吸底 composer"：composer 在移动端是
            // position: sticky + z-index: 3，只有最后一条消息的浮层可能伸进它的区域
            expect(appStyle.text).toMatch(/\.msg:last-child\s*\{[^}]*z-index:\s*4;/);
            expect(appStyle.text).toMatch(/\.composer\s*\{[^}]*z-index:\s*3;/);
            // 仅靠 z-index 不够：#messages 用 overflow-y: auto 裁切超出自身盒子的内容，
            // z-index 再高也救不回被裁掉的像素。最后一条消息的浮层会伸到气泡下方，
            // 必须给 #messages 留够 padding-bottom，滚到底部时浮层才有地方完整显示，不被裁掉
            expect(appStyle.text).toMatch(/#messages\s*\{[^}]*padding:\s*14px 14px 44px;/);
            // "选项"下拉面板同样会被覆盖：移动端 .composer 自身的 position: sticky + z-index: 3
            // 会建立一个新的层叠上下文，把面板的 z-index: 8 困在内部，从外部看仍然只等同于 3，
            // 打开下拉时需要把 composer 本身的层级也一起抬到明显更高
            expect(appStyle.text).toMatch(/body\.composer-options-open \.composer\s*\{\s*\n[\s\S]*?z-index:\s*20;/);
            // margin 会在气泡底部和浮层之间留一段"死区"（不属于任何元素，无法被 :hover 命中），
            // 鼠标快速下移穿过这段空隙时会先丢失 .msg:hover，浮层还没碰到就先淡出消失；
            // 改成 padding-top，让留白仍属于 .msg-actions 自身的可命中范围
            expect(appStyle.text).toMatch(/\.msg-actions\s*\{[^}]*padding-top:\s*4px;/);
            expect(appStyle.text).not.toMatch(/\.msg-actions\s*\{[^}]*margin-top:\s*4px;/);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should pin the workspace switcher toggle to the right edge of the workbench-tabs row, and mobileSessionToggle to the left', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-workbench-alignment-'));
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
            // .workbench-tabs 撑满一整行；.workspace-switcher（"···"）用 margin-left: auto 贴住行的右边，
            // 无论前面有没有"会话"按钮（移动端才有），都始终贴右；"会话"保持默认贴左
            expect(appStyle.text).toMatch(/\.workbench-tabs\s*\{[^}]*flex:\s*1;/);
            expect(appStyle.text).toMatch(/\.workspace-switcher\s*\{[^}]*margin-left:\s*auto;/);
            // 触发按钮贴右后，弹出面板也必须锚定在按钮右边缘向左展开，否则宽屏下会超出视口右侧
            expect(appStyle.text).toMatch(/\.workspace-switcher-panel\s*\{[^}]*right:\s*0;/);
            expect(appStyle.text).not.toMatch(/\.workspace-switcher-panel\s*\{[^}]*left:\s*0;/);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should flatten session tree items (no card border/gradient, flat selected state)', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-tree-flat-'));
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
            expect(appStyle.text).toMatch(/\.session-card-button\s*\{[^}]*border:\s*1px solid transparent;/);
            expect(appStyle.text).toMatch(/\.session-card-button\s*\{[^}]*background:\s*transparent;/);
            expect(appStyle.text).toMatch(/\.session-card-button\.active\s*\{\s*background:\s*var\(--tree-active\);\s*\}/);
            expect(appStyle.text).not.toContain('.tree-node-button-directory,');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should expose a per-row "..." menu with delete for both container and agent tree nodes, reachable on touch devices too', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-tree-menu-delete-'));
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
            // 通用菜单构造函数，容器行与 AGENT 行共用
            expect(appScript.text).toContain('function createTreeNodeMenu(items) {');
            expect(appScript.text).toContain('function closeOpenTreeNodeMenu() {');
            // 容器行：新建 AGENT + 删除容器；AGENT 行：删除 AGENT
            expect(appScript.text).toContain("label: '新建 AGENT',");
            expect(appScript.text).toContain("label: '删除容器',");
            expect(appScript.text).toContain("label: '删除 AGENT',");
            expect(appScript.text).toContain('removeContainerByName(containerGroup.containerName);');
            expect(appScript.text).toContain('removeAgentSessionByName(session.name, agentTitle);');
            // 任意会话删除（不局限当前 active）：只有目标就是当前会话时才需要替补/重载消息
            expect(appScript.text).toContain('const isActive = target === state.active;');
            expect(appScript.text).toContain('const wasActiveContainer = parseSessionKey(state.active).containerName === target;');
            // 点外部/Escape 关闭
            expect(appScript.text).toContain('if (openTreeNodeMenu && !openTreeNodeMenu.containsTarget(target)) {');
            expect(appScript.text).toContain('if (event.key === \'Escape\' && openTreeNodeMenu) {');

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            // 触屏设备兜底：无 hover 能力时菜单触发按钮必须默认可见
            expect(appStyle.text).toMatch(/@media \(hover: none\) \{\s*\.tree-node-menu \{\s*opacity: 1;/);
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
            expect(appHtml.text).toContain('id="directoryPickerPathInput"');
            expect(appHtml.text).toContain('id="directoryPickerVisitBtn"');
            expect(appHtml.text).toContain('id="directoryPickerMkdirBtn"');
            expect(appHtml.text).toContain('id="directoryPickerStatus"');
            expect(appHtml.text).not.toContain('id="directoryPickerUpBtn"');
            expect(appHtml.text).not.toContain('id="directoryPickerCurrent"');

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).toContain('createHostPath.value = picker.currentPath;');
            expect(appScript.text).toContain('createContainerPath.value = picker.currentPath;');
            expect(appScript.text).toContain("directoryPickerPathInput.value = picker.pathDraft || picker.currentPath || '/'");
            expect(appScript.text).toContain("setDirectoryPickerStatus('共 ' + picker.entries.length + ' 项');");
            expect(appScript.text).toContain('<span class="files-entry-title">..</span>');
            expect(appScript.text).toContain("await api('/api/fs/directories/mkdir', {");
            expect(appScript.text).not.toContain("openDirectoryPicker('container')");
            expect(appScript.text).not.toContain('pickContainerPathBtn');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should ship breadcrumb-based container/agent navigation with card semantics', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-sidebar-nav-a11y-'));
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
            expect(appHtml.text).toContain('<nav class="crumb-bar" id="sessionBreadcrumb" aria-label="导航路径"></nav>');
            expect(appHtml.text).toContain('id="sessionList" aria-label="容器与 AGENT 列表"');
            expect(appHtml.text).not.toContain('role="tree"');

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).toContain("wrap.className = 'tree-node-menu';");
            expect(appScript.text).toContain("trigger.className = 'secondary tree-node-menu-trigger';");
            expect(appScript.text).toContain('function updateSidebarActiveSelection() {');
            expect(appScript.text).toContain('updateSidebarActiveSelection();');
            expect(appScript.text).not.toContain("button.setAttribute('role', 'treeitem');");
            expect(appScript.text).not.toContain("childrenNode.setAttribute('role', 'group');");

            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.response.status).toBe(200);
            expect(appStyle.text).not.toContain('--tree-guide:');
            expect(appStyle.text).not.toContain('.disclosure-toggle');
            expect(appStyle.text).toContain('.tree-node-menu {');
            expect(appStyle.text).toContain('.session-card:hover .tree-node-menu,');
            // AGENT/容器卡片都须是定位上下文，否则 .tree-node-menu（position: absolute）会脱离本卡片、
            // 相对不相关的祖先定位，导致"···"触发按钮错位并遮挡侧边栏滚动条
            expect(appStyle.text).toMatch(/\.session-card\s*\{\s*\n\s*position:\s*relative;/);
            // .tree-node-menu 的 translateY(-50%) 会隐式建立层叠上下文，若不显式设置 z-index，
            // 面板的 z-index:9 只在该上下文内部生效，从外部看等同于 z-index:auto，
            // 会被后面的、同样 position:relative 的卡片按 DOM 序盖在上面
            expect(appStyle.text).toMatch(/\.tree-node-menu\s*\{[^}]*z-index:\s*9;/);
            // 已展开的菜单面板必须高于同级其它卡片悬浮时才显现的触发按钮（z-index:9），
            // 否则鼠标移到后面的卡片时，其"···"按钮会按 DOM 序盖住前面仍展开的菜单
            expect(appStyle.text).toMatch(/\.tree-node-menu\.is-open\s*\{\s*\n\s*z-index:\s*20;/);
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
            expect(appScript.text).toContain("bodyParts.push({ label: '结果', value: event.result });");
            expect(appScript.text).toContain("bodyParts.push({ label: '错误', value: event.error });");
            expect(appScript.text).toContain("if (event.kind === 'tool') {");
            expect(appScript.text).not.toContain("event.kind === 'tool' && (event.provider === 'codex' || event.provider === 'opencode')");
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

    test('should not fallback non-default agent updatedAt to container history when creating a new agent', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-updated-fallback-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');
        const historyPath = path.join(webHistoryDir, 'demo.json');
        fs.mkdirSync(webHistoryDir, { recursive: true });
        fs.writeFileSync(historyPath, JSON.stringify({
            containerName: 'demo',
            updatedAt: '2026-03-30T00:20:00.000Z',
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
                    updatedAt: '2026-03-30T00:10:00.000Z',
                    messages: []
                },
                'agent-2': {
                    agentId: 'agent-2',
                    agentName: 'AGENT 2',
                    createdAt: '2026-03-30T00:10:00.000Z',
                    updatedAt: '2026-03-30T00:15:00.000Z',
                    messages: []
                },
                'agent-3': {
                    agentId: 'agent-3',
                    agentName: 'AGENT 3',
                    createdAt: '2026-03-30T00:20:00.000Z',
                    updatedAt: null,
                    messages: []
                },
                'agent-4': {
                    agentId: 'agent-4',
                    agentName: 'AGENT 4',
                    createdAt: '2026-03-30T00:30:00.000Z',
                    updatedAt: '2026-03-30T00:35:00.000Z',
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
                name: 'demo~agent-5',
                agentId: 'agent-5',
                agentName: 'AGENT 5'
            }));

            const sessionsRes = await request(`${baseUrl}/api/sessions`, {
                headers: { Cookie: authCookie }
            });
            expect(sessionsRes.response.status).toBe(200);

            const sessions = Array.isArray(sessionsRes.json && sessionsRes.json.sessions)
                ? sessionsRes.json.sessions
                : [];
            const agent3 = sessions.find(item => item && item.name === 'demo~agent-3');
            const agent4 = sessions.find(item => item && item.name === 'demo~agent-4');
            const agent5 = sessions.find(item => item && item.name === 'demo~agent-5');

            expect(agent3).toEqual(expect.objectContaining({
                name: 'demo~agent-3',
                updatedAt: null
            }));
            expect(agent4).toEqual(expect.objectContaining({
                name: 'demo~agent-4',
                updatedAt: '2026-03-30T00:35:00.000Z'
            }));
            expect(agent5).toEqual(expect.objectContaining({
                name: 'demo~agent-5',
                agentName: 'AGENT 5'
            }));
            expect(typeof agent5.updatedAt).toBe('string');
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
            expect(appHtml.text).toContain('id="openCreateBtn"');
            expect(appHtml.text).not.toContain('id="removeBtn"');
            expect(appHtml.text).not.toContain('id="removeAllBtn"');
            // 顶部"更多"菜单（刷新/新建容器/新建 AGENT）已删除，二者均有替代入口
            // （侧边栏"新建"按钮、会话行的"···"菜单），见阶段五后续收敛
            expect(appHtml.text).not.toContain('id="openCreateMenuBtn"');
            expect(appHtml.text).not.toContain('id="addAgentBtn"');
            expect(appHtml.text).not.toContain('id="refreshBtn"');
            expect(appHtml.text).not.toContain('id="mobileActionsToggle"');
            expect(appHtml.text).not.toContain('id="headerActions"');

            const appScript = await request(`${baseUrl}/app/frontend/app.js`, {
                headers: { Cookie: authCookie }
            });
            expect(appScript.response.status).toBe(200);
            expect(appScript.text).toContain('creatingAgent: false');
            expect(appScript.text).not.toContain("getElementById('addAgentBtn')");
            expect(appScript.text).not.toContain("getElementById('openCreateMenuBtn')");
            expect(appScript.text).not.toContain("getElementById('refreshBtn')");
            expect(appScript.text).not.toContain("getElementById('mobileActionsToggle')");
            expect(appScript.text).not.toContain("getElementById('headerActions')");
            expect(appScript.text).toContain('function findLatestCreatedSessionName(sessions, preferredContainerName) {');
            expect(appScript.text).toContain('function findPreferredSessionNameAfterRemoval(sessions, removedName) {');
            expect(appScript.text).toContain('const fallbackSessionName = isActive');
            expect(appScript.text).toContain("const containerCount = new Set(state.sessions.map(function (session) {");
            expect(appScript.text).toContain("`${containerCount} 个容器 / ${agentCount} 个 AGENT`");
            expect(appScript.text).toContain('state.active = findLatestCreatedSessionName(state.sessions, preferredContainerName) || state.sessions[0].name;');
            expect(appScript.text).toContain("function removeContainerByName(containerName) {");
            expect(appScript.text).toContain("function removeAgentSessionByName(sessionName, agentLabel) {");
            expect(appScript.text).toContain('function confirmRemoveChoice(options) {');
            // 三态确认弹窗的正文文字不能和标题一样大（不能沿用 <p> 默认字号），要有专门样式
            expect(appHtml.text).toContain('<p id="removeConfirmMessage" class="modal-message"></p>');
            const appStyle = await request(`${baseUrl}/app/frontend/app.css`, {
                headers: { Cookie: authCookie }
            });
            expect(appStyle.text).toMatch(/\.modal-message\s*\{[^}]*font-size:\s*1[0-4]px/);
            // 原生 alert/confirm/prompt 会阻塞整个页面 JS，全部改用同款非阻塞小弹窗
            expect(appHtml.text).toContain('id="genericDialogModal"');
            expect(appHtml.text).toContain('id="genericDialogInput"');
            expect(appStyle.text).toContain('.modal-dialog-input');
            expect(appScript.text).toContain('function openGenericDialog(config) {');
            expect(appScript.text).toContain('function showNotice(message, title) {');
            expect(appScript.text).toContain('function showConfirm(message, title) {');
            expect(appScript.text).toContain('function showPrompt(message, defaultValue, title) {');
            // 逐一替换掉会阻塞整个页面的原生弹窗；openGenericDialog 内部"DOM 缺失时"的
            // alert()/confirm()/window.prompt() 兜底不在本次排查范围内，这里抽查几个具体替换点
            expect(appScript.text).toContain('await showNotice(state.sessionDetailError');
            expect(appScript.text).toContain('await showNotice(e.message);');
            expect(appScript.text).toContain("await showPrompt('请输入新目录名称');");
            expect(appScript.text).toContain("await showPrompt('设置容器备注（留空清除备注）', current);");
            expect(appScript.text).toContain("await showPrompt('设置 AGENT 备注（留空清除备注）', current);");
            expect(appScript.text).toContain('confirmFn: showConfirm');
            expect(appScript.text).toContain('promptFn: showPrompt');
            // genericDialogModal 可能从其它已打开的 modal（如目录选择器）内部触发（例如新建目录），
            // 和其它 .modal-backdrop 共用 z-index:80 时按 DOM 顺序落在后面的反而盖住它，
            // 必须显式给一个更高的 z-index 保证它永远浮在最上层
            expect(appStyle.text).toMatch(/#genericDialogModal\s*\{[^}]*z-index:\s*9\d/);

            const fileBrowserScript = await request(`${baseUrl}/app/frontend/file-browser.js`, {
                headers: { Cookie: authCookie }
            });
            expect(fileBrowserScript.response.status).toBe(200);
            expect(fileBrowserScript.text).toContain('confirmFn');
            expect(fileBrowserScript.text).toContain('promptFn');
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

    test('should expose session control event audit via GET /api/sessions/:name/audit', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-session-audit-'));
        const port = await getFreePort();

        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                containerExists: name => name === 'demo',
                dockerExecArgs: args => {
                    if (Array.isArray(args) && args[0] === 'ps') {
                        return 'demo\tUp 2 minutes\tlocalhost/xcanwin/manyoyo:1.0.0-full\n';
                    }
                    return '';
                }
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const auditRes = await request(`${baseUrl}/api/sessions/demo/audit`, {
                headers: { Cookie: authCookie }
            });
            expect(auditRes.response.status).toBe(200);
            expect(auditRes.json).toEqual(expect.objectContaining({
                name: 'demo',
                audit: expect.objectContaining({
                    runSpec: null,
                    events: expect.any(Array),
                    projection: expect.any(Object)
                })
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

    test('should create host directories for web directory picker', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-dir-picker-mkdir-'));
        const port = await getFreePort();
        const targetDir = path.join(tempHost, 'created-from-web');
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const mkdirRes = await request(`${baseUrl}/api/fs/directories/mkdir`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ path: targetDir })
            });
            expect(mkdirRes.response.status).toBe(200);
            expect(mkdirRes.json).toEqual(expect.objectContaining({
                path: targetDir,
                created: true
            }));
            expect(fs.existsSync(targetDir)).toBe(true);

            const listRes = await request(
                `${baseUrl}/api/fs/directories?path=${encodeURIComponent(tempHost)}`,
                { headers: { Cookie: authCookie } }
            );
            expect(listRes.response.status).toBe(200);
            expect(listRes.json).toEqual(expect.objectContaining({
                entries: expect.arrayContaining([
                    expect.objectContaining({ name: 'created-from-web', path: targetDir })
                ])
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
            expect(String(claudeRes.json.output || '')).toMatch(
                /claude --verbose --output-format stream-json --dangerously-skip-permissions -p/
            );
            expect(String(claudeRes.json.output || '')).not.toContain('--session-id');
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
    process.stdout.write('{"type":"step_start","sessionID":"opencode-session","part":{"id":"part_1","sessionID":"opencode-session","messageID":"message_1","type":"step-start"}}\\n');
    process.stdout.write('{"type":"tool_use","sessionID":"opencode-session","part":{"id":"part_2","sessionID":"opencode-session","messageID":"message_1","type":"tool","callID":"call_1","tool":"bash","state":{"status":"completed","input":{"command":"ls -la"},"output":"ok","title":"List files","metadata":{},"time":{"start":1,"end":2}}}}\\n');
    process.stdout.write('{"type":"text","sessionID":"opencode-session","part":{"id":"part_3","sessionID":"opencode-session","messageID":"message_1","type":"text","text":"这是 OpenCode 最终答案。","time":{"start":2,"end":3}}}\\n');
    process.stdout.write('{"type":"step_finish","sessionID":"opencode-session","part":{"id":"part_4","sessionID":"opencode-session","messageID":"message_1","type":"step-finish","reason":"stop","cost":0,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}\\n');
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
                expectedAgentTrace: '[说明] 我先看看目录。',
                expectedToolStartTrace: '[工具开始] Bash (command=ls -la)',
                expectedToolCompleteTrace: '[工具完成] Bash (success)',
                expectedToolId: 'toolu_1'
            },
            {
                sessionName: 'gemini-demo',
                template: 'gemini --yolo -p {prompt}',
                provider: 'gemini',
                expectedResult: '这是 Gemini 最终答案。',
                expectedAgentTrace: '[说明] 我先看看目录。',
                expectedToolStartTrace: '[工具开始] run_shell_command (command=ls -la)',
                expectedToolCompleteTrace: '[工具完成] run_shell_command (success)',
                expectedToolId: 'tool_1'
            },
            {
                sessionName: 'opencode-demo',
                template: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode run {prompt}',
                provider: 'opencode',
                expectedResult: '这是 OpenCode 最终答案。',
                expectedAgentTrace: '[说明] 这是 OpenCode 最终答案。',
                expectedToolCompleteTrace: '[工具完成] bash (completed)',
                expectedToolId: 'call_1'
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
                const expectedEvents = [
                    expect.objectContaining({ type: 'meta', agentProgram: item.provider }),
                    expect.objectContaining({ type: 'trace', text: item.expectedAgentTrace }),
                    expect.objectContaining({ type: 'trace', text: item.expectedToolCompleteTrace }),
                    expect.objectContaining({ type: 'result', output: item.expectedResult })
                ];
                if (item.expectedToolStartTrace) {
                    expectedEvents.push(expect.objectContaining({ type: 'trace', text: item.expectedToolStartTrace }));
                }
                expect(streamRes.events).toEqual(expect.arrayContaining(expectedEvents));

                // 同一工具调用的开始/完成事件须携带一致的 toolId，前端才能原地合并成同一张卡片
                expect(streamRes.events).toEqual(expect.arrayContaining([
                    expect.objectContaining({
                        type: 'trace',
                        text: item.expectedToolCompleteTrace,
                        traceEvent: expect.objectContaining({ toolId: item.expectedToolId })
                    })
                ]));
                if (item.expectedToolStartTrace) {
                    expect(streamRes.events).toEqual(expect.arrayContaining([
                        expect.objectContaining({
                            type: 'trace',
                            text: item.expectedToolStartTrace,
                            traceEvent: expect.objectContaining({ toolId: item.expectedToolId })
                        })
                    ]));
                }

                if (item.provider === 'opencode') {
                    expect(streamRes.events).toEqual(expect.arrayContaining([
                        expect.objectContaining({ type: 'trace', text: '[回合] 开始生成响应' }),
                        expect.objectContaining({
                            type: 'trace',
                            text: '[工具完成] bash (completed)',
                            traceEvent: expect.objectContaining({
                                provider: 'opencode',
                                kind: 'tool',
                                toolName: 'bash',
                                arguments: { command: 'ls -la' },
                                result: 'ok'
                            })
                        }),
                        expect.objectContaining({ type: 'trace', text: '[回合] 响应完成' })
                    ]));
                }

                const persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, `${item.sessionName}.json`), 'utf-8'));
                const traceMessage = (persisted.messages || []).find(message => message && message.streamTrace === true);
                expect(traceMessage).toEqual(expect.objectContaining({
                    role: 'assistant',
                    mode: 'agent',
                    streamTrace: true
                }));
                expect(String(traceMessage.content || '')).toContain(item.expectedToolStartTrace || item.expectedToolCompleteTrace);
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

    test('should extract per-turn usage for claude/codex/opencode and leave gemini unsupported', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-usage-stats-'));
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
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"完成了。"}]}}\\n');
    process.stdout.write('{"type":"result","subtype":"success","session_id":"claude-session","total_cost_usd":0.0123,"usage":{"input_tokens":100,"output_tokens":50}}\\n');
    process.exit(0);
    return;
  }
  if (command.includes('gemini ')) {
    process.stdout.write('{"type":"init","session_id":"gemini-session"}\\n');
    process.stdout.write('{"type":"message","role":"assistant","content":"完成了。"}\\n');
    process.stdout.write('{"type":"result","status":"success"}\\n');
    process.exit(0);
    return;
  }
  if (command.includes('codex ')) {
    process.stdout.write('{"type":"thread.started"}\\n');
    process.stdout.write('{"type":"turn.started"}\\n');
    process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"完成了。"}}\\n');
    process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":80}}\\n');
    process.exit(0);
    return;
  }
  if (command.includes('opencode ')) {
    process.stdout.write('{"type":"step_start","sessionID":"opencode-session","part":{"id":"part_1","sessionID":"opencode-session","messageID":"message_1","type":"step-start"}}\\n');
    process.stdout.write('{"type":"text","sessionID":"opencode-session","part":{"id":"part_2","sessionID":"opencode-session","messageID":"message_1","type":"text","text":"完成了。","time":{"start":1,"end":2}}}\\n');
    process.stdout.write('{"type":"step_finish","sessionID":"opencode-session","part":{"id":"part_3","sessionID":"opencode-session","messageID":"message_1","type":"step-finish","reason":"stop","cost":0.0045,"tokens":{"input":300,"output":120,"reasoning":10,"cache":{"read":0,"write":0}}}}\\n');
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
                sessionName: 'claude-usage',
                template: 'IS_SANDBOX=1 claude --dangerously-skip-permissions -p {prompt}',
                expectedUsage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0123 }
            },
            {
                sessionName: 'gemini-usage',
                template: 'gemini --yolo -p {prompt}',
                expectedUsage: null
            },
            {
                sessionName: 'codex-usage',
                template: 'codex exec --skip-git-repo-check {prompt}',
                expectedUsage: { inputTokens: 200, outputTokens: 80, costUsd: null }
            },
            {
                sessionName: 'opencode-usage',
                template: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode run {prompt}',
                expectedUsage: { inputTokens: 300, outputTokens: 120, costUsd: 0.0045 }
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
                    headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: '你好' })
                });
                expect(streamRes.response.status).toBe(200);

                const persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, `${item.sessionName}.json`), 'utf-8'));
                const assistantMessage = (persisted.messages || []).find(message => message && message.role === 'assistant' && message.streamTrace !== true);
                expect(assistantMessage).toBeTruthy();
                if (item.expectedUsage) {
                    expect(assistantMessage.usage).toEqual(item.expectedUsage);
                } else {
                    expect(assistantMessage.usage).toBeUndefined();
                }

                const detailRes = await request(`${baseUrl}/api/sessions/${item.sessionName}/detail`, {
                    headers: { Cookie: authCookie }
                });
                expect(detailRes.response.status).toBe(200);
                expect(detailRes.json.detail.usageTotal).toEqual(item.expectedUsage);
            }
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should accumulate usageTotal across multiple turns', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-usage-accumulate-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  if (command.includes("-r ")) {
    process.stdout.write('{"type":"system","subtype":"init","session_id":"claude-session"}\\n');
    process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"第二轮完成。"}]}}\\n');
    process.stdout.write('{"type":"result","subtype":"success","session_id":"claude-session","total_cost_usd":0.02,"usage":{"input_tokens":10,"output_tokens":5}}\\n');
    process.exit(0);
    return;
  }
  process.stdout.write('{"type":"system","subtype":"init","session_id":"claude-session"}\\n');
  process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"第一轮完成。"}]}}\\n');
  process.stdout.write('{"type":"result","subtype":"success","session_id":"claude-session","total_cost_usd":0.01,"usage":{"input_tokens":20,"output_tokens":15}}\\n');
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

            await requestNdjsonStream(`${baseUrl}/api/sessions/demo/agent/stream`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: '第一轮' })
            });
            await requestNdjsonStream(`${baseUrl}/api/sessions/demo/agent/stream`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: '第二轮' })
            });

            const detailRes = await request(`${baseUrl}/api/sessions/demo/detail`, {
                headers: { Cookie: authCookie }
            });
            expect(detailRes.response.status).toBe(200);
            expect(detailRes.json.detail.usageTotal).toEqual({
                inputTokens: 30,
                outputTokens: 20,
                costUsd: 0.03
            });
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
  process.stdout.write('{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc ls -la","status":"completed","exit_code":0,"aggregated_output":"command output"}}\\n');
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
                        command: '/bin/bash -lc ls -la',
                        toolId: 'item_1'
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
                        exitCode: 0,
                        result: 'command output',
                        toolId: 'item_1'
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
                        argumentSummary: 'query=OpenAI latest news, num=5',
                        toolId: 'item_2'
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
                        argumentSummary: 'query=OpenAI latest news, num=5',
                        toolId: 'item_2'
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

    test('should extract the native session id claude assigns on the first turn and resume via -r on the next turn without probing', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-native-resume-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        const sessionId = 'aaaaaaaa-1111-4111-8111-abcdefabcdef';
        // 首轮不传任何会话参数，假 docker 模拟真实 claude 在 stream-json 首行自带 session_id；
        // 裸 `-r`（不带 session id）在 --print 模式下真实 claude CLI 会直接报错退出，
        // 这里让假 docker 模拟同样的行为，一旦实现退回旧的探测方式测试就会失败。
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  if (/(^|\\s)-r(\\s|$)/.test(command)) {
    if (!/-r [0-9a-f-]{36}/.test(command)) {
      process.stderr.write('Error: --resume requires a valid session ID or session title when used with --print.\\n');
      process.exit(1);
      return;
    }
    process.stdout.write(command + '\\n');
    process.exit(0);
    return;
  }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: '${sessionId}' }) + '\\n');
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
            expect(turn1.json).toEqual(expect.objectContaining({
                contextMode: 'first-turn',
                resumeAttempted: false,
                resumeSucceeded: false
            }));
            expect(String(turn1.json.output || '')).not.toContain('--session-id');
            expect(String(turn1.json.output || '')).not.toContain('-r ');

            const persistedAfterTurn1 = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            expect(persistedAfterTurn1.agents.default.engineSessionId).toBe(sessionId);

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
            expect(String(turn2.json.output || '')).toContain(
                `claude --verbose --output-format stream-json -r ${sessionId} -p 'who am i'`
            );
            expect(String(turn2.json.output || '')).not.toContain('以下是当前会话最近对话历史');
            expect(String(turn2.json.output || '')).not.toContain('--session-id');

            const persistedAfterTurn2 = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            expect(persistedAfterTurn2.agents.default.engineSessionId).toBe(sessionId);
            expect(persistedAfterTurn2).toEqual(expect.objectContaining({
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

    test('should persist the codex thread id and resume the same exec session on the next turn', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-codex-native-resume-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        const threadId = '019ffc74-9ac1-7373-b81c-cace14a3f86e';
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  if (command.trim() === 'codex resume') {
    process.exit(0);
    return;
  }
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '${threadId}' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: command } }) + '\\n');
  process.exit(0);
  return;
}
if (args[0] === 'inspect') {
  process.stdout.write(JSON.stringify({ State: { Status: 'running' } }));
  process.exit(0);
  return;
}
if (args[0] === 'ps') {
  process.stdout.write('demo|Up 1 minute|manyoyo:test|codex\\n');
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

            const turn1 = await requestNdjsonStream(`${baseUrl}/api/sessions/demo/agent/stream`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'remember me' })
            });
            expect(turn1.response.status).toBe(200);
            expect(turn1.events).toEqual(expect.arrayContaining([
                expect.objectContaining({ type: 'meta', contextMode: 'first-turn' }),
                expect.objectContaining({
                    type: 'result',
                    output: expect.stringContaining("codex exec --json --skip-git-repo-check 'remember me'")
                })
            ]));
            let persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            expect(persisted.agents.default.engineSessionId).toBe(threadId);

            const turn2 = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'what did I say' })
            });
            expect(turn2.response.status).toBe(200);
            expect(turn2.json).toEqual(expect.objectContaining({
                contextMode: 'resume',
                resumeAttempted: true,
                resumeSucceeded: true
            }));
            expect(turn2.json.output).toContain(
                `codex exec resume --json --skip-git-repo-check '${threadId}' 'what did I say'`
            );
            expect(turn2.json.output).not.toContain('以下是当前会话最近对话历史');
            persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            expect(persisted.agents.default.engineSessionId).toBe(threadId);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should fetch the live model catalog for claude/codex/opencode and return empty for gemini', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-model-catalog-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[args.length - 1] || '');
  if (command.includes('claude ') && command.includes('--input-format')) {
    let buf = '';
    process.stdin.on('data', chunk => {
      buf += chunk.toString();
      let idx = buf.indexOf('\\n');
      while (idx !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\\n');
        if (!line.trim()) continue;
        const payload = JSON.parse(line);
        if (payload.request && payload.request.subtype === 'initialize') {
          process.stdout.write(JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: payload.request_id,
              response: {
                models: [
                  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · 常规任务' },
                  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5 · 复杂任务' }
                ]
              }
            }
          }) + '\\n');
        }
      }
    });
    return;
  }
  if (command.includes('codex app-server')) {
    let buf = '';
    process.stdin.on('data', chunk => {
      buf += chunk.toString();
      let idx = buf.indexOf('\\n');
      while (idx !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\\n');
        if (!line.trim()) continue;
        const payload = JSON.parse(line);
        if (payload.method === 'initialize') {
          process.stdout.write(JSON.stringify({ id: payload.id, result: { userAgent: 'test' } }) + '\\n');
        }
        if (payload.method === 'model/list') {
          process.stdout.write(JSON.stringify({
            id: payload.id,
            result: {
              data: [
                { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: '最强代理编码模型', isDefault: true },
                { id: 'gpt-5.2', model: 'gpt-5.2', displayName: 'GPT-5.2', description: '专业长任务', isDefault: false }
              ],
              nextCursor: null
            }
          }) + '\\n');
        }
      }
    });
    return;
  }
  if (command.trim() === 'opencode models') {
    process.stdout.write('anthropic/claude-sonnet-5\\nopenai/gpt-5.2\\n');
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
        const cases = [
            {
                sessionName: 'claude-catalog',
                template: 'IS_SANDBOX=1 claude --dangerously-skip-permissions -p {prompt}',
                expectedModels: [
                    { value: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · 常规任务' },
                    { value: 'opus[1m]', label: 'Opus (1M context)', description: 'Opus 5 · 复杂任务' }
                ]
            },
            {
                sessionName: 'codex-catalog',
                template: 'codex exec --skip-git-repo-check {prompt}',
                expectedModels: [
                    { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: '最强代理编码模型' },
                    { value: 'gpt-5.2', label: 'GPT-5.2', description: '专业长任务' }
                ]
            },
            {
                sessionName: 'opencode-catalog',
                template: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode run {prompt}',
                expectedModels: [
                    { value: 'anthropic/claude-sonnet-5', label: 'anthropic/claude-sonnet-5', description: '' },
                    { value: 'openai/gpt-5.2', label: 'openai/gpt-5.2', description: '' }
                ]
            },
            {
                sessionName: 'gemini-catalog',
                template: 'gemini --yolo -p {prompt}',
                expectedModels: []
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
                const res = await request(`${baseUrl}/api/sessions/${item.sessionName}/models`, {
                    headers: { Cookie: authCookie }
                });
                expect(res.response.status).toBe(200);
                expect(res.json.models).toEqual(item.expectedModels);
            }
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should set the selected model, reject unsafe values, and inject --model into the next turn command', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-model-select-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: command }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'claude-session' }) + '\\n');
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

            const rejectRes = await request(`${baseUrl}/api/sessions/demo/model`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'sonnet; rm -rf /' })
            });
            expect(rejectRes.response.status).toBe(400);

            const setRes = await request(`${baseUrl}/api/sessions/demo/model`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'opus[1m]' })
            });
            expect(setRes.response.status).toBe(200);
            expect(setRes.json.model).toBe('opus[1m]');

            const detailRes = await request(`${baseUrl}/api/sessions/demo/detail`, {
                headers: { Cookie: authCookie }
            });
            expect(detailRes.json.detail.model).toBe('opus[1m]');

            const runRes = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'hi' })
            });
            expect(runRes.response.status).toBe(200);
            expect(String(runRes.json.output || '')).toContain('--model opus[1m]');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should persist the opencode session id and resume it through run without an interactive probe', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-opencode-native-resume-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        const commandLogPath = path.join(tempHost, 'commands.log');
        const sessionId = 'ses_opencode_native_resume';
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  fs.appendFileSync('${commandLogPath}', command + '\\n');
  if (command.trim().endsWith('opencode -c')) {
    process.stderr.write('interactive opencode probe must not run\\n');
    process.exit(1);
    return;
  }
  process.stdout.write(JSON.stringify({
    type: 'text',
    sessionID: '${sessionId}',
    part: { type: 'text', text: command, time: { end: Date.now() } }
  }) + '\\n');
  process.exit(0);
  return;
}
if (args[0] === 'inspect') {
  process.stdout.write(JSON.stringify({ State: { Status: 'running' } }));
  process.exit(0);
  return;
}
if (args[0] === 'ps') {
  process.stdout.write('demo|Up 1 minute|manyoyo:test|opencode\\n');
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
                agentPromptCommand: 'OPENCODE_PERMISSION=\'{"*":"allow"}\' opencode --model opencode/big-pickle run {prompt}'
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
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'remember opencode context' })
            });
            expect(turn1.response.status).toBe(200);
            expect(turn1.json).toEqual(expect.objectContaining({
                contextMode: 'first-turn',
                resumeAttempted: false,
                resumeSucceeded: false
            }));
            expect(turn1.json.output).toBe(
                "OPENCODE_PERMISSION='{\"*\":\"allow\"}' opencode --model opencode/big-pickle run --format json 'remember opencode context'"
            );
            let persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            expect(persisted.agents.default.engineSessionId).toBe(sessionId);

            const turn2 = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'what did I ask' })
            });
            expect(turn2.response.status).toBe(200);
            expect(turn2.json).toEqual(expect.objectContaining({
                contextMode: 'resume',
                resumeAttempted: true,
                resumeSucceeded: true
            }));
            expect(turn2.json.output).toBe(
                `OPENCODE_PERMISSION='{"*":"allow"}' opencode --model opencode/big-pickle run --format json --session '${sessionId}' 'what did I ask'`
            );
            expect(turn2.json.output).not.toContain('以下是当前会话最近对话历史');
            persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            expect(persisted.agents.default.engineSessionId).toBe(sessionId);
            expect(fs.readFileSync(commandLogPath, 'utf-8')).not.toContain('opencode -c');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('should inject history once to bootstrap a native session id for pre-existing claude sessions', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-native-resume-bootstrap-'));
        const port = await getFreePort();
        const fakeDockerPath = path.join(tempHost, 'fake-docker.js');
        const sessionId = 'bbbbbbbb-2222-4222-8222-abcdefabcdef';
        fs.writeFileSync(
            fakeDockerPath,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'exec') {
  const command = String(args[4] || '');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: '${sessionId}' }) + '\\n');
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
                // 模拟升级前遗留的会话：已有历史消息，但尚未记录 engineSessionId
                messages: [
                    { role: 'user', content: 'first question', mode: 'agent' },
                    { role: 'assistant', content: 'first answer', mode: 'agent' }
                ],
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

            const turn = await request(`${baseUrl}/api/sessions/demo/agent`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt: 'second question' })
            });
            expect(turn.response.status).toBe(200);
            expect(turn.json).toEqual(expect.objectContaining({
                contextMode: 'history-injected',
                resumeAttempted: false,
                resumeSucceeded: false
            }));
            expect(String(turn.json.output || '')).toContain('用户: first question');
            expect(String(turn.json.output || '')).toContain('当前问题: second question');
            expect(String(turn.json.output || '')).not.toContain('--session-id');

            const persisted = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'demo.json'), 'utf-8'));
            expect(persisted.agents.default.engineSessionId).toBe(sessionId);
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
