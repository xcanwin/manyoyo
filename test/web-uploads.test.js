'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { startWebServer } = require('../lib/web/server');
const containerState = require('../lib/container-state');
const { parseImages, matchesImageMagic, appendImageNote, extForContentType } = require('../lib/web/uploads');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-png-data')]);
const OK_PATH = '/run/manyoyo/uploads/0123456789abcdef01234567.png';

describe('parseImages（路径校验）', () => {
    test('合法路径通过，去重；没给返回空数组', () => {
        expect(parseImages(undefined)).toEqual([]);
        expect(parseImages(null)).toEqual([]);
        expect(parseImages([OK_PATH, OK_PATH, '/run/manyoyo/uploads/a_b-C.jpeg', '/run/manyoyo/uploads/x.webp', '/run/manyoyo/uploads/x.gif']))
            .toHaveLength(4);
        expect(parseImages(['/run/manyoyo/uploads/x.jpg'])).toEqual(['/run/manyoyo/uploads/x.jpg']);
    });

    test.each([
        '/run/manyoyo/uploads/../env',
        '/run/manyoyo/uploads/a.png/x',
        '/etc/passwd',
        '/run/manyoyo/uploads/a.svg',
        '/run/manyoyo/uploads/a b.png',
        '/run/manyoyo/uploads/.png',
        '/run/manyoyo/uploads/a.png\n',
        'run/manyoyo/uploads/a.png',
        '/run/manyoyo/uploads/sub/a.png',
        '/run/manyoyo/uploads/a.png; rm -rf /',
        '/tmp/x/run/manyoyo/uploads/a.png',
        '/etc/../run/manyoyo/uploads/a.png',
        '//run/manyoyo/uploads/a.png'
    ])('拒绝 %j', bad => {
        expect(() => parseImages([bad])).toThrow();
    });

    test('不是数组、超过 5 张、元素不是字符串都拒绝', () => {
        expect(() => parseImages(OK_PATH)).toThrow();
        expect(() => parseImages(Array.from({ length: 6 }, (_, i) => `/run/manyoyo/uploads/a${i}.png`))).toThrow();
        expect(() => parseImages([123])).toThrow();
    });
});

describe('图片类型与文件头', () => {
    test('Content-Type 只收四种，别的（含 svg）不收', () => {
        expect(extForContentType('image/png')).toBe('png');
        expect(extForContentType('image/jpeg; charset=x')).toBe('jpg');
        expect(extForContentType('IMAGE/WEBP')).toBe('webp');
        expect(extForContentType('image/gif')).toBe('gif');
        expect(extForContentType('image/svg+xml')).toBe('');
        expect(extForContentType('text/html')).toBe('');
        expect(extForContentType('constructor')).toBe('');
    });

    test('文件头必须和声明的类型一致', () => {
        expect(matchesImageMagic('png', PNG)).toBe(true);
        expect(matchesImageMagic('png', Buffer.from('<svg>'))).toBe(false);
        expect(matchesImageMagic('jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
        expect(matchesImageMagic('gif', Buffer.from('GIF89a....'))).toBe(true);
        expect(matchesImageMagic('webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe(true);
        expect(matchesImageMagic('webp', PNG)).toBe(false);
    });

    test('提示词末尾附路径列表', () => {
        expect(appendImageNote('看图', [OK_PATH])).toBe(`看图\n\n附图（请用 Read 工具查看）：\n- ${OK_PATH}`);
        expect(appendImageNote('看图', [])).toBe('看图');
    });
});

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

async function waitFor(fn, timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const value = await fn();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('waitFor timeout');
}

function writeFakeDocker(tempHost) {
    const file = path.join(tempHost, 'fake-docker.js');
    fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'exec' && args.includes('/bin/bash')) {
  fs.appendFileSync(${JSON.stringify(path.join(tempHost, 'commands.log'))}, args[args.length - 1] + '\\n=====\\n');
  process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"收到"}}\\n');
}
process.exit(0);
`);
    fs.chmodSync(file, 0o755);
    return file;
}

async function withServer({ hasState = true, template = 'codex exec --skip-git-repo-check {prompt}' } = {}, fn) {
    const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-uploads-'));
    const histDir = path.join(tempHost, 'web-history');
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(path.join(histDir, 'demo.json'), JSON.stringify({ containerName: 'demo', updatedAt: null, messages: [], agentPromptCommand: template }));
    const stateInfo = hasState ? containerState.createState({ homeDir: tempHost, envLines: [], meta: { name: 'demo' } }) : null;
    const port = await getFreePort();
    let handle = null;
    try {
        handle = await startWebServer({
            serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: 'topsecret', authPassAuto: false,
            dockerCmd: writeFakeDocker(tempHost),
            networkManager: { ensureBridgeNetwork: async () => {}, resolveRefs: async p => p, apply: async () => ({}), ensureReady: async () => ({}) },
            hostPath: tempHost, homeDir: tempHost, containerPath: '/workspace', imageName: 'localhost/xcanwin/manyoyo', imageVersion: '1.0.0-common',
            execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
            validateHostPath: () => {}, formatDate: () => '0101-0000',
            isValidContainerName: v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v),
            containerExists: () => true, getContainerStatus: () => 'running', waitForContainerReady: async () => {},
            dockerExecArgs: args => (args[0] === 'inspect' && stateInfo ? `${stateInfo.id}\n` : ''),
            showImagePullHint: () => {}, removeContainer: () => {},
            webHistoryDir: histDir, webConfigPath: path.join(tempHost, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' }, agentStopGraceMs: 100
        });
        const baseUrl = `http://127.0.0.1:${handle.port || port}`;
        const login = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ username: 'webadmin', password: 'topsecret' }) });
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const upload = (body, headers = {}) => fetch(`${baseUrl}/api/sessions/demo/uploads`, { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'image/png', ...headers }, body });
        const send = body => fetch(`${baseUrl}/api/sessions/demo/agent/stream`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) });
        const uploadsDir = stateInfo ? path.join(stateInfo.box, 'uploads') : '';
        await fn({ baseUrl, upload, send, tempHost, uploadsDir, cookie });
    } finally {
        if (handle && handle.close) await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
    }
}

describe('POST /api/sessions/:name/uploads', () => {
    test('上传成功：返回容器内路径，宿主机文件字节一致、文件名由服务端生成', async () => {
        await withServer({}, async ({ upload, uploadsDir }) => {
            const res = await upload(PNG, { 'X-Filename': '../../evil.png' });
            expect(res.status).toBe(200);
            const { path: containerPath } = await res.json();
            expect(containerPath).toMatch(/^\/run\/manyoyo\/uploads\/[0-9a-f]{24}\.png$/);
            const files = fs.readdirSync(uploadsDir);
            expect(files).toEqual([path.basename(containerPath)]);
            expect(fs.readFileSync(path.join(uploadsDir, files[0])).equals(PNG)).toBe(true);
        });
    });

    test('未登录 401；缺少 X-Requested-With 403', async () => {
        await withServer({}, async ({ baseUrl, cookie }) => {
            const anon = await fetch(`${baseUrl}/api/sessions/demo/uploads`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Requested-With': 'XMLHttpRequest' }, body: PNG });
            expect(anon.status).toBe(401);
            const noCsrf = await fetch(`${baseUrl}/api/sessions/demo/uploads`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'image/png' }, body: PNG });
            expect(noCsrf.status).toBe(403);
        });
    });

    test('类型不对 415（含 svg）；文件头不符 400；空内容 400', async () => {
        await withServer({}, async ({ upload, uploadsDir }) => {
            expect((await upload(Buffer.from('<svg/>'), { 'Content-Type': 'image/svg+xml' })).status).toBe(415);
            expect((await upload(Buffer.from('not an image at all'))).status).toBe(400);
            expect((await upload(Buffer.alloc(0))).status).toBe(400);
            expect(fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : []).toEqual([]);
        });
    });

    test('超过 10MB：413，半截文件被删', async () => {
        await withServer({}, async ({ upload, uploadsDir }) => {
            const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 + 1024)]);
            const res = await upload(big);
            expect(res.status).toBe(413);
            expect(fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : []).toEqual([]);
        });
    }, 30000);

    test('没有状态目录的旧容器：409 并提示重建', async () => {
        await withServer({ hasState: false }, async ({ upload }) => {
            const res = await upload(PNG);
            expect(res.status).toBe(409);
            expect((await res.json()).error).toContain('重建');
        });
    });
});

describe('排队项里的图片', () => {
    test('落盘后读回仍带图片；不合法的路径被丢掉', () => {
        const { normalizeStoredQueue } = require('../lib/web/agent-queue');
        const queue = normalizeStoredQueue([
            { id: 'q-1', text: 'a', when: 'turn', clientMessageId: 'x', images: [OK_PATH, '/etc/passwd', 5] },
            { id: 'q-2', text: 'b', when: 'turn' }
        ]);
        expect(queue[0].images).toEqual([OK_PATH]);
        expect(queue[1].images).toBeUndefined();
    });
});

describe('上传目录被换成符号链接', () => {
    test('拒绝写入，不跟着写到宿主机别的目录', async () => {
        await withServer({}, async ({ upload, uploadsDir, tempHost }) => {
            const outside = path.join(tempHost, 'outside');
            fs.mkdirSync(outside);
            fs.mkdirSync(path.dirname(uploadsDir), { recursive: true });
            fs.symlinkSync(outside, uploadsDir);
            const res = await upload(PNG);
            expect(res.status).toBe(500);
            expect(fs.readdirSync(outside)).toEqual([]);
        });
    });
});

describe('images 随提示词发送', () => {
    test('非法 images 返回 400，不执行', async () => {
        await withServer({}, async ({ send, tempHost }) => {
            for (const bad of [['/run/manyoyo/uploads/../env'], ['/etc/passwd'], ['/run/manyoyo/uploads/a.svg'], 'x']) {
                const res = await send({ prompt: 'hi', images: bad, clientMessageId: `cm-${Math.random().toString(16).slice(2, 12)}` });
                expect(res.status).toBe(400);
            }
            expect(fs.existsSync(path.join(tempHost, 'commands.log'))).toBe(false);
        });
    });

    test('Codex：命令带 --image=<路径>，提示词里不附路径；用户消息存 images', async () => {
        await withServer({}, async ({ send, tempHost, baseUrl, cookie }) => {
            const res = await send({ prompt: 'HELLOIMG', images: [OK_PATH], clientMessageId: 'cm-codex-0001' });
            await res.text();
            const log = fs.readFileSync(path.join(tempHost, 'commands.log'), 'utf8');
            expect(log).toContain(`--image='${OK_PATH}'`);
            expect(log).not.toContain('附图');
            const messages = await waitFor(async () => {
                const view = await (await fetch(`${baseUrl}/api/sessions/demo/messages`, { headers: { Cookie: cookie } })).json();
                return view.messages.every(m => m.pending !== true) ? view.messages : null;
            });
            expect(messages.find(m => m.role === 'user').images).toEqual([OK_PATH]);
        });
    });

    test('Claude：提示词末尾附“请用 Read 工具查看”和路径，命令里没有 --image', async () => {
        await withServer({ template: 'claude -p {prompt}' }, async ({ send, tempHost }) => {
            const res = await send({ prompt: '看这张图', images: [OK_PATH], clientMessageId: 'cm-claude-0001' });
            await res.text();
            const log = fs.readFileSync(path.join(tempHost, 'commands.log'), 'utf8');
            expect(log).toContain('请用 Read 工具查看');
            expect(log).toContain(OK_PATH);
            expect(log).not.toContain('--image');
        });
    });

    test('没带 images：命令和从前一样', async () => {
        await withServer({}, async ({ send, tempHost }) => {
            await (await send({ prompt: 'plain', clientMessageId: 'cm-plain-0001' })).text();
            const log = fs.readFileSync(path.join(tempHost, 'commands.log'), 'utf8');
            expect(log).not.toContain('--image');
            expect(log).not.toContain('附图');
        });
    });
});
