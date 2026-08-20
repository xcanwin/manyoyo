const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { startWebServer } = require('../lib/web/server');
const { FileEventStore } = require('../lib/core/event-store');
const { createControlEvent } = require('../lib/core/events');

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
    return setCookie.split(';')[0];
}

function writeHistoryFile(webHistoryDir, containerName, data) {
    fs.mkdirSync(webHistoryDir, { recursive: true });
    fs.writeFileSync(path.join(webHistoryDir, `${containerName}.json`), JSON.stringify(data, null, 4), 'utf-8');
}

function buildAgentMessage(role, content) {
    return {
        id: `${role}-${content}`,
        role,
        content,
        timestamp: '2025-01-01T00:00:00.000Z'
    };
}

describe('Web Server Session Clone/Duplicate/Cascade Delete', () => {
    test('runtimeSnapshot must never leak into GET /api/sessions, detail or audit responses', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-runtime-snapshot-'));
        const port = await getFreePort();
        let handle = null;

        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const created = await request(`${baseUrl}/api/sessions`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    createOptions: {
                        containerName: 'secret-holder',
                        hostPath: tempHost,
                        env: { SUPER_SECRET_TOKEN: 'do-not-leak-me' }
                    }
                })
            });
            expect(created.response.status).toBe(200);

            const historyPath = path.join(tempHost, 'web-history', 'secret-holder.json');
            const historyJson = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
            expect(historyJson.runtimeSnapshot).toEqual(expect.objectContaining({
                env: expect.objectContaining({ SUPER_SECRET_TOKEN: 'do-not-leak-me' })
            }));

            const listRes = await request(`${baseUrl}/api/sessions`, { headers: { Cookie: authCookie } });
            expect(listRes.text).not.toContain('do-not-leak-me');
            expect(listRes.text).not.toContain('runtimeSnapshot');

            const detailRes = await request(`${baseUrl}/api/sessions/secret-holder/detail`, { headers: { Cookie: authCookie } });
            expect(detailRes.response.status).toBe(200);
            expect(detailRes.text).not.toContain('do-not-leak-me');
            expect(detailRes.text).not.toContain('runtimeSnapshot');

            const auditRes = await request(`${baseUrl}/api/sessions/secret-holder/audit`, { headers: { Cookie: authCookie } });
            expect(auditRes.response.status).toBe(200);
            expect(auditRes.text).not.toContain('do-not-leak-me');
            expect(auditRes.text).not.toContain('runtimeSnapshot');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('clone-config creates a new container with the same runtime config but empty chat history', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-clone-config-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');
        const dockerExecArgs = jest.fn(() => '');
        const waitForContainerReady = jest.fn(async () => {});

        writeHistoryFile(webHistoryDir, 'source-a', {
            containerName: 'source-a',
            updatedAt: '2025-01-01T00:00:00.000Z',
            agentPromptCommand: '',
            applied: {
                containerName: 'source-a',
                hostPath: tempHost,
                containerPath: '/workspace',
                imageName: 'localhost/xcanwin/manyoyo',
                imageVersion: '1.0.0-common',
                containerMode: '',
                shellPrefix: '',
                shell: '',
                shellSuffix: '',
                defaultCommand: '/bin/bash',
                yolo: '',
                envCount: 1,
                volumeCount: 0,
                portCount: 0
            },
            runtimeSnapshot: {
                hostPath: tempHost,
                containerPath: '/workspace',
                imageName: 'localhost/xcanwin/manyoyo',
                imageVersion: '1.0.0-common',
                containerMode: '',
                shellPrefix: '',
                shell: '',
                shellSuffix: '',
                agentPromptCommand: '',
                yolo: '',
                env: { FOO: 'bar' },
                envFile: [],
                volumes: [],
                ports: []
            },
            agents: {
                default: {
                    agentId: 'default',
                    agentName: 'AGENT 1',
                    agentPromptCommand: '',
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    messages: [buildAgentMessage('user', 'hello from source'), buildAgentMessage('assistant', 'hi there')],
                    events: [],
                    lastResumeAt: null,
                    lastResumeOk: null,
                    lastResumeError: '',
                    engineSessionId: ''
                }
            }
        });

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, { dockerExecArgs, waitForContainerReady }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const cloneRes = await request(`${baseUrl}/api/sessions/source-a/clone-config`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            expect(cloneRes.response.status).toBe(200);
            expect(cloneRes.json).toEqual(expect.objectContaining({
                name: 'source-a-copy1',
                sourceContainerName: 'source-a',
                cloneFidelity: 'full'
            }));

            const runArgs = dockerExecArgs.mock.calls.map(call => call[0]).find(args => args.includes('--name'));
            expect(runArgs).toEqual(expect.arrayContaining(['--name', 'source-a-copy1', '--env', 'FOO=bar']));

            const cloneHistoryPath = path.join(webHistoryDir, 'source-a-copy1.json');
            const cloneHistory = JSON.parse(fs.readFileSync(cloneHistoryPath, 'utf-8'));
            expect(cloneHistory.applied.hostPath).toBe(tempHost);
            const cloneMessages = (cloneHistory.agents && cloneHistory.agents.default && cloneHistory.agents.default.messages) || [];
            expect(cloneMessages.some(m => m.content === 'hello from source')).toBe(false);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('clone-config auto-generates -copy1 / -copy2 suffix on repeated calls without a name', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-clone-suffix-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');

        writeHistoryFile(webHistoryDir, 'source-b', {
            containerName: 'source-b',
            updatedAt: null,
            agentPromptCommand: '',
            applied: { containerName: 'source-b', hostPath: tempHost, containerPath: '/workspace' },
            runtimeSnapshot: {
                hostPath: tempHost, containerPath: '/workspace', imageName: 'localhost/xcanwin/manyoyo',
                imageVersion: '1.0.0-common', containerMode: '', shellPrefix: '', shell: '', shellSuffix: '',
                agentPromptCommand: '', yolo: '', env: {}, envFile: [], volumes: [], ports: []
            },
            agents: {}
        });

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const first = await request(`${baseUrl}/api/sessions/source-b/clone-config`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            expect(first.json.name).toBe('source-b-copy1');

            const second = await request(`${baseUrl}/api/sessions/source-b/clone-config`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            expect(second.json.name).toBe('source-b-copy2');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('clone-config does not reuse a deleted lower copy number, keeps counting from the max seen', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-clone-suffix-gap-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');

        const baseHistory = containerName => ({
            containerName,
            updatedAt: null,
            agentPromptCommand: '',
            applied: { containerName, hostPath: tempHost, containerPath: '/workspace' },
            runtimeSnapshot: {
                hostPath: tempHost, containerPath: '/workspace', imageName: 'localhost/xcanwin/manyoyo',
                imageVersion: '1.0.0-common', containerMode: '', shellPrefix: '', shell: '', shellSuffix: '',
                agentPromptCommand: '', yolo: '', env: {}, envFile: [], volumes: [], ports: []
            },
            agents: {}
        });

        writeHistoryFile(webHistoryDir, 'source-g', baseHistory('source-g'));
        // 模拟已经存在 -copy1 和 -copy2，随后 -copy1 被删除，只留下 -copy2。
        writeHistoryFile(webHistoryDir, 'source-g-copy2', baseHistory('source-g-copy2'));

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const res = await request(`${baseUrl}/api/sessions/source-g/clone-config`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            expect(res.json.name).toBe('source-g-copy3');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('clone-config rejects a requested containerName that already exists', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-clone-conflict-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');

        writeHistoryFile(webHistoryDir, 'source-c', {
            containerName: 'source-c',
            applied: { containerName: 'source-c', hostPath: tempHost },
            runtimeSnapshot: {
                hostPath: tempHost, containerPath: '/workspace', imageName: 'localhost/xcanwin/manyoyo',
                imageVersion: '1.0.0-common', containerMode: '', shellPrefix: '', shell: '', shellSuffix: '',
                agentPromptCommand: '', yolo: '', env: {}, envFile: [], volumes: [], ports: []
            },
            agents: {}
        });
        writeHistoryFile(webHistoryDir, 'already-taken', {
            containerName: 'already-taken',
            applied: { containerName: 'already-taken', hostPath: tempHost },
            agents: {}
        });

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const res = await request(`${baseUrl}/api/sessions/source-c/clone-config`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ containerName: 'already-taken' })
            });
            expect(res.response.status).toBe(409);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('clone-config and duplicate require the default agent (container-level operation)', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-clone-agent-guard-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');

        writeHistoryFile(webHistoryDir, 'source-d', {
            containerName: 'source-d',
            applied: { containerName: 'source-d', hostPath: tempHost },
            agents: { default: { agentId: 'default' }, 'agent-2': { agentId: 'agent-2' } }
        });

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const res = await request(`${baseUrl}/api/sessions/source-d~agent-2/clone-config`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            expect(res.response.status).toBe(400);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('duplicate copies every agent history verbatim with the same agentId, and flags resumeMayFail', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-duplicate-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');

        writeHistoryFile(webHistoryDir, 'source-e', {
            containerName: 'source-e',
            updatedAt: '2025-01-01T00:00:00.000Z',
            agentPromptCommand: 'claude -p {prompt}',
            applied: { containerName: 'source-e', hostPath: tempHost, containerPath: '/workspace' },
            runtimeSnapshot: {
                hostPath: tempHost, containerPath: '/workspace', imageName: 'localhost/xcanwin/manyoyo',
                imageVersion: '1.0.0-common', containerMode: '', shellPrefix: '', shell: '', shellSuffix: '',
                agentPromptCommand: '', yolo: '', env: {}, envFile: [], volumes: [], ports: []
            },
            agents: {
                default: {
                    agentId: 'default',
                    agentName: 'AGENT 1',
                    messages: [buildAgentMessage('user', 'first agent message')],
                    events: [],
                    engineSessionId: 'engine-abc'
                },
                'agent-2': {
                    agentId: 'agent-2',
                    agentName: 'AGENT 2',
                    messages: [buildAgentMessage('user', 'second agent message')],
                    events: [],
                    engineSessionId: 'engine-xyz'
                }
            }
        });

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const dupRes = await request(`${baseUrl}/api/sessions/source-e/duplicate`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ containerName: 'source-e-dup' })
            });
            expect(dupRes.response.status).toBe(200);
            expect(dupRes.json).toEqual(expect.objectContaining({ name: 'source-e-dup', resumeMayFail: true }));

            const dupHistory = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'source-e-dup.json'), 'utf-8'));
            expect(dupHistory.agents.default.messages.map(m => m.content)).toEqual(['first agent message']);
            expect(dupHistory.agents.default.engineSessionId).toBe('engine-abc');
            expect(dupHistory.agents['agent-2'].messages.map(m => m.content)).toEqual(['second agent message']);
            expect(dupHistory.agents['agent-2'].agentId).toBe('agent-2');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('container-remark sets and clears a container-level remark, reflected in GET /api/sessions', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-container-remark-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');

        writeHistoryFile(webHistoryDir, 'remark-target', {
            containerName: 'remark-target',
            applied: { containerName: 'remark-target', hostPath: tempHost },
            agents: { default: { agentId: 'default', agentName: 'AGENT 1', messages: [] } }
        });

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const setRes = await request(`${baseUrl}/api/sessions/remark-target/container-remark`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ remark: '  生产环境，谨慎操作  ' })
            });
            expect(setRes.response.status).toBe(200);
            expect(setRes.json).toEqual({ containerName: 'remark-target', remark: '生产环境，谨慎操作' });

            const listRes = await request(`${baseUrl}/api/sessions`, { headers: { Cookie: authCookie } });
            const target = listRes.json.sessions.find(item => item.name === 'remark-target');
            expect(target.containerRemark).toBe('生产环境，谨慎操作');

            const clearRes = await request(`${baseUrl}/api/sessions/remark-target/container-remark`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ remark: '' })
            });
            expect(clearRes.json.remark).toBe('');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('container-remark rejects a non-default agent session key', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-container-remark-guard-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');

        writeHistoryFile(webHistoryDir, 'remark-guard', {
            containerName: 'remark-guard',
            applied: { containerName: 'remark-guard', hostPath: tempHost },
            agents: { default: { agentId: 'default' }, 'agent-2': { agentId: 'agent-2' } }
        });

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const res = await request(`${baseUrl}/api/sessions/remark-guard~agent-2/container-remark`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ remark: 'x' })
            });
            expect(res.response.status).toBe(400);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('agent-remark sets a per-agent remark independently for default and non-default agents', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-agent-remark-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');

        writeHistoryFile(webHistoryDir, 'agent-remark-target', {
            containerName: 'agent-remark-target',
            applied: { containerName: 'agent-remark-target', hostPath: tempHost },
            agents: {
                default: { agentId: 'default', agentName: 'AGENT 1', messages: [] },
                'agent-2': { agentId: 'agent-2', agentName: 'AGENT 2', messages: [] }
            }
        });

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const defaultRes = await request(`${baseUrl}/api/sessions/agent-remark-target/agent-remark`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ remark: '主对话' })
            });
            expect(defaultRes.json).toEqual({ name: 'agent-remark-target', remark: '主对话' });

            const secondRes = await request(`${baseUrl}/api/sessions/agent-remark-target~agent-2/agent-remark`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ remark: '调试分支' })
            });
            expect(secondRes.json).toEqual({ name: 'agent-remark-target~agent-2', remark: '调试分支' });

            const listRes = await request(`${baseUrl}/api/sessions`, { headers: { Cookie: authCookie } });
            const defaultSession = listRes.json.sessions.find(item => item.name === 'agent-remark-target');
            const secondSession = listRes.json.sessions.find(item => item.name === 'agent-remark-target~agent-2');
            expect(defaultSession.agentRemark).toBe('主对话');
            expect(secondSession.agentRemark).toBe('调试分支');
            expect(defaultSession.containerRemark).toBe('');
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });
});

describe('Web Server Container/Agent Removal with optional history', () => {
    test('/remove without removeHistory keeps the history file, events and projections intact', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-remove-keep-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');
        const removeContainer = jest.fn();

        writeHistoryFile(webHistoryDir, 'keep-me', {
            containerName: 'keep-me',
            applied: { containerName: 'keep-me', hostPath: tempHost },
            agents: {
                default: {
                    agentId: 'default',
                    agentName: 'AGENT 1',
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    messages: [buildAgentMessage('user', 'hi')]
                }
            }
        });
        const eventStore = new FileEventStore(webHistoryDir);
        eventStore.append(createControlEvent({ type: 'session.ready', aggregateId: 'keep-me', seq: 1 }));

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                containerExists: () => true,
                removeContainer
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const res = await request(`${baseUrl}/api/sessions/keep-me/remove`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            expect(res.response.status).toBe(200);
            expect(res.json).toEqual(expect.objectContaining({ removed: true, removedHistory: false }));
            expect(removeContainer).toHaveBeenCalledWith('keep-me');

            expect(fs.existsSync(path.join(webHistoryDir, 'keep-me.json'))).toBe(true);
            expect(fs.existsSync(eventStore.getEventFilePath('keep-me'))).toBe(true);
            expect(fs.existsSync(eventStore.getProjectionFilePath('keep-me'))).toBe(true);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('/remove with removeHistory removes the container, the history file, and every agent event/projection', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-remove-history-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');
        const removeContainer = jest.fn();

        writeHistoryFile(webHistoryDir, 'wipe-me', {
            containerName: 'wipe-me',
            applied: { containerName: 'wipe-me', hostPath: tempHost },
            agents: {
                default: {
                    agentId: 'default',
                    agentName: 'AGENT 1',
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    messages: [buildAgentMessage('user', 'hi')]
                },
                'agent-2': {
                    agentId: 'agent-2',
                    agentName: 'AGENT 2',
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    messages: [buildAgentMessage('user', 'yo')]
                }
            }
        });
        const eventStore = new FileEventStore(webHistoryDir);
        eventStore.append(createControlEvent({ type: 'session.ready', aggregateId: 'wipe-me', seq: 1 }));
        eventStore.append(createControlEvent({ type: 'session.ready', aggregateId: 'wipe-me~agent-2', seq: 1 }));

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                containerExists: () => true,
                removeContainer
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const res = await request(`${baseUrl}/api/sessions/wipe-me/remove`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ removeHistory: true })
            });
            expect(res.response.status).toBe(200);
            expect(res.json).toEqual(expect.objectContaining({ removed: true, removedHistory: true }));
            expect(removeContainer).toHaveBeenCalledWith('wipe-me');

            expect(fs.existsSync(path.join(webHistoryDir, 'wipe-me.json'))).toBe(false);
            expect(fs.existsSync(eventStore.getEventFilePath('wipe-me'))).toBe(false);
            expect(fs.existsSync(eventStore.getProjectionFilePath('wipe-me'))).toBe(false);
            expect(fs.existsSync(eventStore.getEventFilePath('wipe-me~agent-2'))).toBe(false);
            expect(fs.existsSync(eventStore.getProjectionFilePath('wipe-me~agent-2'))).toBe(false);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('/remove is idempotent when the container was already removed concurrently', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-remove-idempotent-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');
        const removeContainer = jest.fn(() => {
            throw new Error('Command failed: docker rm -f already-gone');
        });

        writeHistoryFile(webHistoryDir, 'already-gone', {
            containerName: 'already-gone',
            applied: { containerName: 'already-gone', hostPath: tempHost },
            agents: {
                default: {
                    agentId: 'default',
                    agentName: 'AGENT 1',
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    messages: []
                }
            }
        });

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                containerExists: () => true,
                removeContainer
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const res = await request(`${baseUrl}/api/sessions/already-gone/remove`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            expect(res.response.status).toBe(200);
            expect(res.json).toEqual(expect.objectContaining({ removed: true }));
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('/remove-with-history with removeHistory hard-deletes a non-default agent and its event/projection files', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-remove-agent-history-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');

        writeHistoryFile(webHistoryDir, 'multi-agent', {
            containerName: 'multi-agent',
            applied: { containerName: 'multi-agent', hostPath: tempHost },
            agents: {
                default: {
                    agentId: 'default',
                    agentName: 'AGENT 1',
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    messages: []
                },
                'agent-2': {
                    agentId: 'agent-2',
                    agentName: 'AGENT 2',
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    messages: [buildAgentMessage('user', 'bye')]
                }
            }
        });
        const eventStore = new FileEventStore(webHistoryDir);
        eventStore.append(createControlEvent({ type: 'session.ready', aggregateId: 'multi-agent~agent-2', seq: 1 }));

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                containerExists: () => true
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const res = await request(`${baseUrl}/api/sessions/multi-agent~agent-2/remove-with-history`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ removeHistory: true })
            });
            expect(res.response.status).toBe(200);
            expect(res.json).toEqual(expect.objectContaining({ removedHistory: true }));

            const savedHistory = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'multi-agent.json'), 'utf-8'));
            expect(savedHistory.agents['agent-2']).toBeUndefined();
            expect(fs.existsSync(eventStore.getEventFilePath('multi-agent~agent-2'))).toBe(false);
            expect(fs.existsSync(eventStore.getProjectionFilePath('multi-agent~agent-2'))).toBe(false);

            const listRes = await request(`${baseUrl}/api/sessions`, { headers: { Cookie: authCookie } });
            expect(listRes.json.sessions.some(item => item.name === 'multi-agent~agent-2')).toBe(false);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('/remove-with-history without removeHistory archives the agent, keeps files on disk, and hides it from the API', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-archive-agent-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');

        writeHistoryFile(webHistoryDir, 'multi-agent-2', {
            containerName: 'multi-agent-2',
            applied: { containerName: 'multi-agent-2', hostPath: tempHost },
            agents: {
                default: {
                    agentId: 'default',
                    agentName: 'AGENT 1',
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    messages: []
                },
                'agent-2': {
                    agentId: 'agent-2',
                    agentName: 'AGENT 2',
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    messages: [buildAgentMessage('user', 'keep this around')]
                }
            }
        });

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                containerExists: () => true
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const res = await request(`${baseUrl}/api/sessions/multi-agent-2~agent-2/remove-with-history`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ removeHistory: false })
            });
            expect(res.response.status).toBe(200);
            expect(res.json).toEqual(expect.objectContaining({ removedHistory: false }));

            const savedHistory = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'multi-agent-2.json'), 'utf-8'));
            expect(savedHistory.agents['agent-2'].archived).toBe(true);
            expect(savedHistory.agents['agent-2'].messages.map(m => m.content)).toEqual(['keep this around']);

            const listRes = await request(`${baseUrl}/api/sessions`, { headers: { Cookie: authCookie } });
            expect(listRes.json.sessions.some(item => item.name === 'multi-agent-2~agent-2')).toBe(false);

            const detailRes = await request(`${baseUrl}/api/sessions/multi-agent-2~agent-2/detail`, { headers: { Cookie: authCookie } });
            expect(detailRes.response.status).toBe(200);
            expect(detailRes.json.detail).toBeNull();

            const messagesRes = await request(`${baseUrl}/api/sessions/multi-agent-2~agent-2/messages`, { headers: { Cookie: authCookie } });
            expect(messagesRes.response.status).toBe(200);
            expect(messagesRes.json.messages).toEqual([]);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('archiving the only default agent keeps the container visible as a synthetic empty entry instead of vanishing', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-archive-default-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');

        writeHistoryFile(webHistoryDir, 'lonely', {
            containerName: 'lonely',
            applied: { containerName: 'lonely', hostPath: tempHost },
            agents: {
                default: {
                    agentId: 'default',
                    agentName: 'AGENT 1',
                    createdAt: '2025-01-01T00:00:00.000Z',
                    updatedAt: '2025-01-01T00:00:00.000Z',
                    messages: [buildAgentMessage('user', 'hi')]
                }
            }
        });

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port, {
                containerExists: () => true,
                dockerExecArgs: args => {
                    if (Array.isArray(args) && args[0] === 'ps') {
                        return 'lonely\tUp 2 minutes\tlocalhost/xcanwin/manyoyo:1.0.0-common\n';
                    }
                    return '';
                }
            }));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const res = await request(`${baseUrl}/api/sessions/lonely/remove-with-history`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ removeHistory: false })
            });
            expect(res.response.status).toBe(200);

            const listRes = await request(`${baseUrl}/api/sessions`, { headers: { Cookie: authCookie } });
            const lonelySessions = listRes.json.sessions.filter(item => item.containerName === 'lonely');
            expect(lonelySessions).toHaveLength(1);
            expect(lonelySessions[0]).toEqual(expect.objectContaining({
                name: 'lonely',
                agentId: 'default',
                messageCount: 0,
                synthetic: true
            }));

            const savedHistory = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'lonely.json'), 'utf-8'));
            expect(savedHistory.agents.default.archived).toBe(true);
            expect(savedHistory.agents.default.messages.map(m => m.content)).toEqual(['hi']);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });

    test('creating a container immediately persists a real (non-synthetic) default agent', async () => {
        const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-create-persists-default-'));
        const port = await getFreePort();
        const webHistoryDir = path.join(tempHost, 'web-history');

        let handle = null;
        try {
            handle = await startWebServer(buildServerOptions(tempHost, port));
            const baseUrl = `http://127.0.0.1:${handle.port || port}`;
            const authCookie = await loginAndGetCookie(baseUrl);

            const created = await request(`${baseUrl}/api/sessions`, {
                method: 'POST',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    createOptions: { containerName: 'brand-new', hostPath: tempHost }
                })
            });
            expect(created.response.status).toBe(200);

            const savedHistory = JSON.parse(fs.readFileSync(path.join(webHistoryDir, 'brand-new.json'), 'utf-8'));
            expect(savedHistory.agents.default).toEqual(expect.objectContaining({ agentId: 'default', archived: false }));

            const listRes = await request(`${baseUrl}/api/sessions`, { headers: { Cookie: authCookie } });
            const defaultSession = listRes.json.sessions.find(item => item.containerName === 'brand-new');
            expect(defaultSession.synthetic).not.toBe(true);
        } finally {
            if (handle && typeof handle.close === 'function') {
                await handle.close();
            }
            fs.rmSync(tempHost, { recursive: true, force: true });
        }
    });
});
