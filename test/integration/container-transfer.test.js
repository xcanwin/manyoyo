'use strict';

// 导出 / 导入（真实容器运行时 + 真实 manyoyo serve 进程，两个互相隔离的 HOME）。
// 运行时不可用或镜像缺失时自动跳过。容器名统一 myx-e2e-<随机>-*，结束时只删自己建的。
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { imageVersion } = require('../../package.json');
const { selectContainerRuntime } = require('../../lib/container-runtime');
const { readTarEntries, encodeEntryHeader, END_BLOCKS, pad } = require('../../lib/archive/tar');

const IMAGE_NAME = 'ghcr.io/xcanwin/manyoyo';
let runtime = null;
let skipReason = '';
try {
    runtime = selectContainerRuntime();
    const env = { ...process.env, ...runtime.env };
    if (spawnSync(runtime.command, ['info'], { stdio: 'ignore', timeout: 15000, env }).status !== 0) skipReason = `${runtime.command} info 失败`;
    else if (spawnSync(runtime.command, ['image', 'inspect', `${IMAGE_NAME}:${imageVersion}`], { stdio: 'ignore', env }).status !== 0) skipReason = `本机没有镜像 ${IMAGE_NAME}:${imageVersion}`;
} catch (e) {
    skipReason = e.message;
}
if (skipReason) console.warn(`[container-transfer 集成测试已跳过] ${skipReason}`);
const maybe = skipReason ? describe.skip : describe;

const rt = (args, options = {}) => spawnSync(runtime.command, args, { encoding: 'utf-8', env: { ...process.env, ...runtime.env }, timeout: 60000, ...options });
const getPort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function listEntries(buffer) {
    const raw = buffer.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])) ? zlib.zstdDecompressSync(buffer) : zlib.gunzipSync(buffer);
    const out = {};
    for await (const { meta, body } of readTarEntries(Readable.from([raw]))) {
        const parts = []; for await (const p of body) parts.push(p);
        out[meta.name] = { type: meta.type, content: Buffer.concat(parts).toString() };
    }
    return out;
}

maybe('容器导出 / 导入（真实容器 + 真实 serve）', () => {
    const tag = crypto.randomBytes(3).toString('hex');
    const names = [];
    const servers = [];
    let root;

    async function startServe(label) {
        const home = path.join(root, `home${label}`);
        fs.mkdirSync(path.join(home, '.manyoyo'), { recursive: true });
        const port = await getPort();
        const real = os.homedir();
        const child = spawn('node', [path.join(__dirname, '..', '..', 'bin', 'manyoyo.js'), 'serve', `127.0.0.1:${port}`, '-U', 'u', '-P', 'p'], {
            env: { ...process.env, HOME: home, XDG_DATA_HOME: process.env.XDG_DATA_HOME || path.join(real, '.local', 'share'), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(real, '.config'), XDG_STATE_HOME: process.env.XDG_STATE_HOME || path.join(real, '.local', 'state'), XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || path.join(real, '.cache') },
            stdio: 'ignore'
        });
        const server = { home, port, child, base: `http://127.0.0.1:${port}`, cookie: '' };
        servers.push(server);
        for (let i = 0; i < 60; i += 1) {
            try {
                const r = await fetch(`${server.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'u', password: 'p' }) });
                if (r.status === 200) { server.cookie = r.headers.get('set-cookie').split(';')[0]; break; }
            } catch (e) { /* 还没起来 */ }
            await sleep(250);
        }
        expect(server.cookie).not.toBe('');
        server.api = async (method, route, body, headers = {}) => {
            const r = await fetch(`${server.base}${route}`, { method, headers: { Cookie: server.cookie, 'X-Requested-With': 'XMLHttpRequest', ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
            const buf = Buffer.from(await r.arrayBuffer());
            let json = null; try { json = JSON.parse(buf.toString()); } catch (e) { json = null; }
            return { status: r.status, json, buf };
        };
        return server;
    }

    beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-int-')); });
    afterAll(() => {
        servers.forEach(s => { try { s.child.kill('SIGKILL'); } catch (e) { /* ignore */ } });
        names.forEach(name => { rt(['unpause', name]); rt(['rm', '-f', name]); });
        fs.rmSync(root, { recursive: true, force: true });
    });

    let A;
    let work;
    let sentinel;
    const nameA = `myx-e2e-${tag}-a`;
    const nameB = `myx-e2e-${tag}-b`;

    test('准备：建容器，放入会话记录、缓存、系统层改动、工作目录里的链接和 FIFO', async () => {
        A = await startServe('A');
        work = path.join(root, 'workA');
        fs.mkdirSync(work);
        sentinel = path.join(root, 'sentinel.txt');
        fs.writeFileSync(sentinel, 'SENTINEL-DATA');
        fs.writeFileSync(path.join(work, 'main.py'), 'print(1)');
        fs.symlinkSync(sentinel, path.join(work, 'evil'));
        spawnSync('mkfifo', [path.join(work, 'pipe')]);
        names.push(nameA);
        const created = await A.api('POST', '/api/sessions', { createOptions: { containerName: nameA, hostPath: work, containerPath: work } });
        expect(created.status).toBe(200);
        const setup = rt(['exec', nameA, 'bash', '-c', `mkdir -p /root/.claude/projects/x /root/.codex/sessions /root/.codex/.tmp /usr/local/bin && echo '{"a":1}' > /root/.claude/projects/x/11111111-1111-1111-1111-111111111111.jsonl && echo s > /root/.codex/sessions/s.jsonl && dd if=/dev/urandom of=/root/.codex/.tmp/big bs=1M count=5 2>/dev/null && printf '#!/bin/sh\\necho hi\\n' > /usr/local/bin/mytool && chmod +x /usr/local/bin/mytool && echo c > /tmp/junk`]);
        expect(setup.status).toBe(0);
        const id = rt(['inspect', '-f', '{{index .Config.Labels "manyoyo.id"}}', nameA]).stdout.trim();
        const uploads = path.join(A.home, '.manyoyo', 'containers', id, 'box', 'uploads');
        fs.mkdirSync(uploads, { recursive: true });
        fs.writeFileSync(path.join(uploads, 'a.png'), 'PNG');
    }, 180000);

    async function doExport(tier, extra = {}) {
        const created = await A.api('POST', '/api/exports', { containers: [nameA], tier, output: 'download', ...extra });
        expect(created.status).toBe(200);
        const res = await A.api('GET', created.json.downloadUrl);
        expect(res.status).toBe(200);
        return { buffer: res.buf, entries: await listEntries(res.buf) };
    }

    test('三档导出：轻量只有聊天记录 / 会话记录 / 设置；标准加图片、工作目录、Agent 改动；完整加系统层；都没有缓存、哨兵内容、FIFO', async () => {
        const light = await doExport('light');
        const lightNames = Object.keys(light.entries);
        expect(lightNames).toContain('c/0/history.json');
        expect(lightNames).toContain('c/0/layer/root/.claude/projects/x/11111111-1111-1111-1111-111111111111.jsonl');
        expect(lightNames).toContain('c/0/layer/root/.codex/sessions/s.jsonl');
        expect(lightNames.some(n => n.startsWith('w/') || n.includes('uploads') || n.includes('mytool'))).toBe(false);

        const standard = await doExport('standard');
        const stdNames = Object.keys(standard.entries);
        expect(stdNames).toContain('c/0/box/uploads/a.png');
        expect(stdNames).toContain(`w/0/main.py`);
        expect(stdNames.some(n => n.includes('mytool'))).toBe(false);

        const full = await doExport('full');
        const fullNames = Object.keys(full.entries);
        expect(fullNames).toContain('c/0/layer/usr/local/bin/mytool');
        for (const result of [light, standard, full]) {
            const all = Object.keys(result.entries);
            expect(all.some(n => n.includes('.codex/.tmp'))).toBe(false);
            expect(all.some(n => n.includes('/tmp/junk') || n.endsWith('layer/tmp/junk'))).toBe(false);
            expect(all.some(n => n.endsWith('/pipe'))).toBe(false);
            expect(JSON.stringify(result.entries)).not.toContain('SENTINEL-DATA');
        }
        expect(full.entries['w/0/evil'].type).toBe('symlink');
    }, 240000);

    test('运行中的容器导出期间是暂停状态，结束后恢复运行；已停止的导出后仍是停止', async () => {
        fs.writeFileSync(path.join(work, 'big.bin'), crypto.randomBytes(200 * 1024 * 1024));
        const created = await A.api('POST', '/api/exports', { containers: [nameA], tier: 'standard', output: 'download' });
        const url = `${A.base}${created.json.downloadUrl}`;
        const res = await fetch(url, { headers: { Cookie: A.cookie } });
        const reader = res.body.getReader();
        await reader.read();
        await sleep(300);
        expect(rt(['inspect', '-f', '{{.State.Status}}', nameA]).stdout.trim()).toBe('paused');
        for (;;) { const { done } = await reader.read(); if (done) break; }
        for (let i = 0; i < 40 && rt(['inspect', '-f', '{{.State.Status}}', nameA]).stdout.trim() !== 'running'; i += 1) await sleep(250);
        expect(rt(['inspect', '-f', '{{.State.Status}}', nameA]).stdout.trim()).toBe('running');
        fs.rmSync(path.join(work, 'big.bin'));

        rt(['stop', '-t', '1', nameA]);
        await doExport('light');
        expect(rt(['inspect', '-f', '{{.State.Status}}', nameA]).stdout.trim()).toBe('exited');
        rt(['start', nameA]);
    }, 240000);

    test('导出时 serve 被 kill -9：容器仍是暂停；重启 serve 后自动恢复，任务显示已中断', async () => {
        fs.writeFileSync(path.join(work, 'big.bin'), crypto.randomBytes(200 * 1024 * 1024));
        const created = await A.api('POST', '/api/exports', { containers: [nameA], tier: 'standard', output: 'download' });
        const res = await fetch(`${A.base}${created.json.downloadUrl}`, { headers: { Cookie: A.cookie } });
        const reader = res.body.getReader();
        await reader.read();
        await sleep(300);
        expect(rt(['inspect', '-f', '{{.State.Status}}', nameA]).stdout.trim()).toBe('paused');
        A.child.kill('SIGKILL');
        reader.cancel().catch(() => {});
        await sleep(500);
        expect(rt(['inspect', '-f', '{{.State.Status}}', nameA]).stdout.trim()).toBe('paused');
        fs.rmSync(path.join(work, 'big.bin'));
        const home = A.home;
        servers.splice(servers.indexOf(A), 1);
        // 在同一个 HOME 上重新起 serve
        const again = await (async () => {
            const port = await getPort();
            const real = os.homedir();
            const child = spawn('node', [path.join(__dirname, '..', '..', 'bin', 'manyoyo.js'), 'serve', `127.0.0.1:${port}`, '-U', 'u', '-P', 'p'], {
                env: { ...process.env, HOME: home, XDG_DATA_HOME: process.env.XDG_DATA_HOME || path.join(real, '.local', 'share'), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(real, '.config'), XDG_STATE_HOME: process.env.XDG_STATE_HOME || path.join(real, '.local', 'state'), XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || path.join(real, '.cache') },
                stdio: 'ignore'
            });
            const server = { home, port, child, base: `http://127.0.0.1:${port}`, cookie: '' };
            servers.push(server);
            for (let i = 0; i < 60 && !server.cookie; i += 1) {
                try {
                    const r = await fetch(`${server.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'u', password: 'p' }) });
                    if (r.status === 200) server.cookie = r.headers.get('set-cookie').split(';')[0];
                } catch (e) { /* 等待 */ }
                await sleep(250);
            }
            server.api = async (method, route) => {
                const r = await fetch(`${server.base}${route}`, { method, headers: { Cookie: server.cookie, 'X-Requested-With': 'XMLHttpRequest' } });
                return { status: r.status, json: await r.json().catch(() => null) };
            };
            return server;
        })();
        expect(rt(['inspect', '-f', '{{.State.Status}}', nameA]).stdout.trim()).toBe('running');
        const jobs = await again.api('GET', '/api/jobs');
        expect(jobs.json.jobs.map(job => job.status)).toContain('interrupted');
        A = Object.assign(again, { api: (method, route, body, headers) => {
            return fetch(`${again.base}${route}`, { method, headers: { Cookie: again.cookie, 'X-Requested-With': 'XMLHttpRequest', ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) }, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) })
                .then(async r => { const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString()); } catch (e) { json = null; } return { status: r.status, json, buf }; });
        } });
    }, 240000);

    test('导入到另一个 HOME：文件、权限、工作目录、历史都在，缓存没有；截断的归档与恶意归档什么都不留', async () => {
        const full = (await doExport('full')).buffer;
        const B = await startServe('B');
        const workB = path.join(root, 'workB');
        names.push(nameB);
        const plan = (name, host) => encodeURIComponent(JSON.stringify({ containers: { 0: { name, hostPath: host, imageMode: 'same', confirm: {} } } }));
        const post = (body, name, host) => B.api('POST', `/api/imports?plan=${plan(name, host)}`, body, { 'Content-Type': 'application/octet-stream' });

        // 截断：撤销干净
        const cut = await post(full.subarray(0, Math.floor(full.length / 2)), nameB, workB);
        expect(cut.status).toBeGreaterThanOrEqual(400);
        expect(fs.existsSync(workB)).toBe(false);
        expect(rt(['inspect', nameB]).status).not.toBe(0);
        const tmpDir = path.join(B.home, '.manyoyo', 'tmp');
        expect(fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []).toEqual([]);

        // 恶意：../ 条目
        const outside = path.join(root, 'outside');
        fs.mkdirSync(outside);
        const manifest = { format: 1, items: ['history', 'workdir'], containers: [{ idx: 0, name: nameA, image: '', containerPath: work, hostPath: work, work: 0 }], workdirs: [{ n: 0 }] };
        const entry = (name, content) => { const body = Buffer.from(content); return Buffer.concat([encodeEntryHeader({ name, type: 'file', size: body.length }), body, Buffer.alloc(pad(body.length))]); };
        const evil = zlib.gzipSync(Buffer.concat([entry('manifest.json', JSON.stringify(manifest)), entry('w/0/../../../outside/pwn', 'x'), END_BLOCKS]));
        const bad = await post(evil, nameB, workB);
        expect(bad.status).toBeGreaterThanOrEqual(400);
        expect(fs.readdirSync(outside)).toEqual([]);

        // 完整导入
        const ok = await post(full, nameB, workB);
        expect(ok.status).toBe(200);
        expect(fs.readFileSync(path.join(workB, 'main.py'), 'utf8')).toBe('print(1)');
        expect(fs.existsSync(path.join(workB, 'evil'))).toBe(false);
        const check = rt(['exec', nameB, 'bash', '-c', 'cat /root/.codex/sessions/s.jsonl; /usr/local/bin/mytool; ls /root/.codex/.tmp 2>&1 | head -1; stat -c "%U %a" /usr/local/bin/mytool']);
        expect(check.stdout).toContain('s\nhi\n');
        expect(check.stdout).toContain('root 755');
        expect(check.stdout).not.toMatch(/big/);
        const sessions = await B.api('GET', '/api/sessions');
        expect(sessions.json.sessions.some(s => s.containerName === nameB)).toBe(true);
    }, 300000);
});
