'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable, Writable } = require('stream');
const { execFileSync } = require('child_process');
const { encodeEntryHeader, readTarEntries, END_BLOCKS, pad } = require('../lib/archive/tar');
const { exportArchive, addHostTree, TarWriter, zstdAvailable } = require('../lib/archive/export');
const containerState = require('../lib/container-state');

function tarOf(entries) {
    const parts = [];
    for (const e of entries) {
        const body = Buffer.from(e.content || '');
        parts.push(encodeEntryHeader({ name: e.name, type: e.type || 'file', size: body.length, linkname: e.linkname }), body, Buffer.alloc(pad(body.length)));
    }
    parts.push(END_BLOCKS);
    return Buffer.concat(parts);
}

function collectingSink() {
    const chunks = [];
    const sink = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
    return { sink, buffer: () => Buffer.concat(chunks) };
}

async function readArchive(buffer) {
    const raw = zstdAvailable() ? zlib.zstdDecompressSync(buffer) : zlib.gunzipSync(buffer);
    const out = {};
    for await (const { meta, body } of readTarEntries(Readable.from([raw]))) {
        const parts = [];
        for await (const piece of body) parts.push(piece);
        out[meta.name] = { type: meta.type, content: Buffer.concat(parts).toString(), linkname: meta.linkname };
    }
    return out;
}

describe('lib/archive/export 宿主机遍历', () => {
    let base;
    beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-exp-')); });
    afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

    async function walk(root, hooks) {
        const { sink, buffer } = collectingSink();
        const writer = new TarWriter(sink);
        const stats = {};
        await addHostTree(writer, root, 'w/0', stats, hooks);
        await writer.finish();
        const entries = {};
        for await (const { meta, body } of readTarEntries(Readable.from([buffer()]))) {
            const parts = [];
            for await (const piece of body) parts.push(piece);
            entries[meta.name] = { type: meta.type, content: Buffer.concat(parts).toString(), linkname: meta.linkname };
        }
        return { entries, stats };
    }

    test('符号链接按链接本身存、哨兵内容不在归档里；FIFO 不卡住（5 秒内完成）', async () => {
        const work = path.join(base, 'work');
        fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(work, 'a.txt'), 'hello');
        fs.writeFileSync(path.join(base, 'sentinel.txt'), 'TOP-SECRET-SENTINEL');
        fs.symlinkSync(path.join(base, 'sentinel.txt'), path.join(work, 'link'));
        fs.symlinkSync(base, path.join(work, 'dirlink'));
        execFileSync('mkfifo', [path.join(work, 'sub', 'pipe')]);
        const started = Date.now();
        const { entries, stats } = await walk(work);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(entries['w/0/a.txt'].content).toBe('hello');
        expect(entries['w/0/link']).toMatchObject({ type: 'symlink', linkname: path.join(base, 'sentinel.txt') });
        expect(entries['w/0/dirlink'].type).toBe('symlink');
        expect(JSON.stringify(entries)).not.toContain('TOP-SECRET-SENTINEL');
        expect(entries['w/0/sub/pipe']).toBeUndefined();
        expect(stats.skippedSpecial).toBe(1);
    });

    test('子目录在另一个文件系统（st_dev 不同）时不进入', async () => {
        const work = path.join(base, 'work');
        fs.mkdirSync(path.join(work, 'mnt'), { recursive: true });
        fs.writeFileSync(path.join(work, 'mnt', 'inside.txt'), 'other-fs');
        fs.writeFileSync(path.join(work, 'ok.txt'), 'ok');
        const mntPath = path.join(work, 'mnt');
        const lstat = p => {
            const st = fs.lstatSync(p);
            return p === mntPath ? Object.create(st, { dev: { value: st.dev + 1 } }) : st;
        };
        const { entries, stats } = await walk(work, { lstat });
        expect(entries['w/0/ok.txt']).toBeTruthy();
        expect(entries['w/0/mnt/inside.txt']).toBeUndefined();
        expect(stats.skippedOtherFs).toBe(1);
    });
});

describe('lib/archive/export 整体', () => {
    let home;
    let historyDir;
    let work;
    let sentinel;
    const ID = 'aaaaaaaaaaaaaaaa';
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-exp-home-'));
        historyDir = path.join(home, '.manyoyo', 'web-history');
        work = path.join(home, 'work');
        fs.mkdirSync(path.join(historyDir, 'events'), { recursive: true });
        fs.mkdirSync(path.join(historyDir, 'projections'), { recursive: true });
        fs.mkdirSync(work, { recursive: true });
        fs.writeFileSync(path.join(work, 'main.py'), 'print(1)');
        fs.writeFileSync(path.join(work, '.env'), 'WORK_DOTENV=keep-me-in-workdir-1234');
        sentinel = path.join(home, 'sentinel.txt');
        fs.writeFileSync(sentinel, 'SENTINEL-DATA');
        fs.symlinkSync(sentinel, path.join(work, 'evil'));
        const state = containerState.createState({ homeDir: home, id: ID, envLines: ['ANTHROPIC_AUTH_TOKEN=sk-secret-1234', 'ANTHROPIC_MODEL=m', 'MY_PASSWD=hunter2-password', 'GH_PAT=ghp-personal-token-xyz', 'DB_URL=postgres://dbuser:dbpass-secret@db:5432/app'], autostart: 'API_KEY=sk-inline-secret echo hi' });
        fs.mkdirSync(path.join(state.box, 'uploads'));
        fs.writeFileSync(path.join(state.box, 'uploads', 'a.png'), 'PNG');
        fs.writeFileSync(path.join(historyDir, 'box1.json'), '{}');
        fs.writeFileSync(path.join(historyDir, 'events', 'box1.jsonl'), '{"seq":1,"text":"my key is hunter2-password and sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV"}\n');
        fs.writeFileSync(path.join(historyDir, 'events', `box1${encodeURIComponent('~')}agent-2.jsonl`), '{"seq":1}\n');
        fs.writeFileSync(path.join(historyDir, 'events', 'box10.jsonl'), 'other container');
    });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

    const DIFF_LINES = [
        'A /usr/local/bin/mytool', 'A /root/.codex/sessions/s.jsonl', 'A /root/.codex/.tmp/big', 'A /root/.codex/skills/x.md',
        'A /root/.claude/projects/p/abc.jsonl', 'A /tmp/junk', 'A /workspace/in-mount', 'D /etc/old.conf',
        'A /root/.codex/auth.json', 'A /root/.claude/.credentials.json'
    ];

    // 假运行时：一个“容器文件系统”（绝对路径 → 内容），cp 像真的一样把 scope 下的所有文件按“相对 scope 上一级”的名字打成 tar
    const DEFAULT_FILES = {
        '/usr/local/bin/mytool': 'BIN',
        '/usr/local/bin/not-in-diff': 'IMAGE-FILE',
        '/root/.codex/sessions/s.jsonl': 'SESSION',
        '/root/.codex/.tmp/big': 'CACHE',
        '/root/.codex/skills/x.md': 'SKILL',
        '/root/.codex/image-own': 'FROM-IMAGE',
        '/root/.codex/auth.json': 'OAUTH-REFRESH-TOKEN',
        '/root/.claude/projects/p/abc.jsonl': 'CLAUDE-SESSION',
        '/root/.claude/.credentials.json': 'OAUTH-CLAUDE',
        '/workspace/in-mount': 'MOUNTED'
    };

    function fakeRuntime(over = {}) {
        const calls = { pause: [], unpause: [], cp: [], order: [], stop: [] };
        const diff = over.diff || DIFF_LINES;
        const files = { ...(over.files || DEFAULT_FILES) };
        return {
            calls,
            files,
            inspect: async () => ({ id: ID, image: 'img:1', status: over.status || 'running', mounts: ['/workspace', '/run/manyoyo'] }),
            pause: async name => { calls.order.push('pause'); calls.pause.push(name); },
            unpause: async name => { calls.order.push('unpause'); calls.unpause.push(name); },
            stop: async name => calls.stop.push(name),
            diff: async (name, { onEntry }) => { diff.forEach(line => { const m = /^([ACD]) (.*)$/.exec(line); onEntry(m[1], m[2]); }); },
            cp: (name, scope) => {
                calls.cp.push(scope);
                calls.order.push(`cp ${scope}`);
                const under = Object.keys(files).filter(file => file === scope || file.startsWith(`${scope}/`)).sort();
                if (!under.length) return { stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve({ code: 1, stderr: 'no such file' }) };
                const parent = path.posix.dirname(scope);
                const entries = under.map(file => ({ name: path.posix.relative(parent, file), content: files[file] }));
                return { stream: Readable.from([tarOf(entries)]), done: Promise.resolve({ code: 0, stderr: '' }) };
            }
        };
    }

    const baseHistory = () => ({ containerName: 'box1', remark: '备注', applied: { hostPath: work, containerPath: '/workspace' }, runtimeSnapshot: { hostPath: work, containerPath: '/workspace', agentPromptCommand: 'ANTHROPIC_AUTH_TOKEN=sk-cmd-secret claude -p {prompt}', env: { ANTHROPIC_AUTH_TOKEN: 'sk-secret-1234', ANTHROPIC_MODEL: 'm', MY_PASSWD: 'hunter2-password', GH_PAT: 'ghp-personal-token-xyz', DB_URL: 'postgres://dbuser:dbpass-secret@db:5432/app' } }, agents: {}, chat: 'I pasted sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV and hunter2-password here' });

    async function doExport(items, extra = {}) {
        const runtime = extra.runtime || fakeRuntime();
        const { sink, buffer } = collectingSink();
        const history = extra.history || baseHistory();
        const result = await exportArchive({
            out: extra.out || sink,
            containers: [{ name: 'box1' }],
            items,
            includeSecrets: extra.includeSecrets !== false,
            compression: 'fast',
            deps: { homeDir: home, webHistoryDir: historyDir, runtime, containerState, version: 'test', loadHistory: () => history },
            hooks: extra.hooks
        });
        return { entries: extra.out ? null : await readArchive(buffer()), runtime, result };
    }

    test('完整档：只带 diff 里的、范围内的、非缓存、非挂载点的内容；哨兵与 FIFO 不在里面', async () => {
        const { entries } = await doExport(['history', 'agentSessions', 'settings', 'uploads', 'agentExtras', 'workdir', 'systemLayer']);
        const names = Object.keys(entries);
        expect(names[0]).toBe('manifest.json');
        expect(names[names.length - 1]).toBe('END.json');
        expect(entries['c/0/layer/usr/local/bin/mytool'].content).toBe('BIN');
        expect(entries['c/0/layer/root/.codex/sessions/s.jsonl'].content).toBe('SESSION');
        expect(entries['c/0/layer/root/.codex/skills/x.md'].content).toBe('SKILL');
        expect(entries['c/0/layer/root/.claude/projects/p/abc.jsonl'].content).toBe('CLAUDE-SESSION');
        // 过滤：不在 diff 里（镜像自带）、缓存、挂载点
        expect(names.some(n => n.includes('not-in-diff'))).toBe(false);
        expect(names.some(n => n.includes('image-own'))).toBe(false);
        expect(names.some(n => n.includes('.codex/.tmp'))).toBe(false);
        expect(names.some(n => n.includes('in-mount'))).toBe(false);
        expect(JSON.parse(entries['c/0/layer-deleted.json'].content)).toEqual(['/etc/old.conf']);
        // 宿主机侧
        expect(entries['w/0/main.py'].content).toBe('print(1)');
        expect(entries['w/0/evil'].type).toBe('symlink');
        expect(JSON.stringify(entries)).not.toContain('SENTINEL-DATA');
        expect(entries['c/0/box/uploads/a.png'].content).toBe('PNG');
        expect(entries['c/0/events/box1.jsonl']).toBeTruthy();
        expect(entries[`c/0/events/box1${encodeURIComponent('~')}agent-2.jsonl`]).toBeTruthy();
        expect(names.some(n => n.includes('box10'))).toBe(false);
    });

    test('轻量档：只有聊天记录、会话记录、设置；没有 Agent 其余改动、系统层、图片、工作目录', async () => {
        const { entries } = await doExport(['history', 'agentSessions', 'settings']);
        const names = Object.keys(entries);
        expect(names).toContain('c/0/history.json');
        expect(names).toContain('c/0/layer/root/.codex/sessions/s.jsonl');
        expect(names).toContain('c/0/state/env');
        expect(names.some(n => n.includes('skills/x.md'))).toBe(false);
        expect(names.some(n => n.includes('mytool'))).toBe(false);
        expect(names.some(n => n.startsWith('w/'))).toBe(false);
        expect(names.some(n => n.includes('uploads'))).toBe(false);
        expect(names.some(n => n.includes('layer-deleted'))).toBe(false);
    });

    test('只取真正改动的路径：只改了 /usr/lib 里一个文件，就只 cp 这一个文件；镜像自带的 Agent 目录不读', async () => {
        const runtime = fakeRuntime({
            diff: ['C /usr', 'C /usr/lib', 'C /usr/lib/qa-marker', 'A /opt/newdir', 'A /opt/newdir/x', 'C /root', 'C /root/.codex', 'A /root/.codex/sessions/s.jsonl'],
            files: { '/usr/lib/qa-marker': 'MARK', '/usr/lib/other-image-file': 'IMG', '/opt/newdir/x': 'X', '/root/.codex/sessions/s.jsonl': 'SESSION', '/root/.codex/image-own': 'FROM-IMAGE' }
        });
        const { entries } = await doExport(['agentSessions', 'systemLayer'], { runtime });
        expect(runtime.calls.cp.sort()).toEqual(['/opt/newdir', '/root/.codex/sessions/s.jsonl', '/usr/lib/qa-marker']);
        expect(entries['c/0/layer/usr/lib/qa-marker'].content).toBe('MARK');
        expect(entries['c/0/layer/opt/newdir/x'].content).toBe('X');
        expect(entries['c/0/layer/root/.codex/sessions/s.jsonl'].content).toBe('SESSION');
    });

    describe('不含密钥', () => {
        const RICH_TREES = {
            '/root/.claude/settings.json': JSON.stringify({ model: 'm', env: { ANTHROPIC_AUTH_TOKEN: 'settings-token-abcdef123', ANTHROPIC_MODEL: 'mm' } }),
            '/root/.claude/projects/p/abc.jsonl': '{"text":"agent said sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV and settings-token-abcdef123"}\n',
            '/root/.claude/.credentials.json': 'OAUTH-CLAUDE',
            '/root/.claude.json': JSON.stringify({ primaryApiKey: 'sk-primary-key-0123456789', customApiKeyResponses: { approved: ['abcdefghijklmnopqrst'], rejected: [] }, projects: { '/w': {} } }),
            '/root/.codex/config.toml': 'model = "m"\napi_token = "toml-secret-token-1"\n[mcp]\nmy_key = "toml-key-secret-2"\n',
            '/root/.codex/sessions/s.jsonl': 'SESSION',
            '/root/.npmrc': '//registry/:_authToken=npm-secret',
            '/root/.git-credentials': 'https://u:p@github.com',
            '/root/.netrc': 'machine x password y',
            '/root/.docker/config.json': '{"auths":{}}',
            '/root/.pypirc': 'password: z',
            '/root/.aws/credentials': 'aws_secret_access_key=abc',
            '/root/.kube/config': 'token: kube',
            '/root/.config/gh/hosts.yml': 'oauth_token: gh',
            '/root/.ssh/id_ed25519': 'PRIVATE-KEY-BODY',
            '/root/.ssh/id_ed25519.pub': 'ssh-ed25519 AAAA pub',
            '/root/.ssh/known_hosts': 'github.com ssh-rsa AAAA',
            '/root/.ssh/config': 'Host x',
            '/root/.ssh/authorized_keys': 'ssh-rsa AUTH'
        };
        const RICH_DIFF = [
            'A /root/.claude/settings.json', 'A /root/.claude/projects/p/abc.jsonl', 'A /root/.claude/.credentials.json', 'A /root/.claude.json',
            'A /root/.codex/config.toml', 'A /root/.codex/sessions/s.jsonl',
            'A /root/.npmrc', 'A /root/.git-credentials', 'A /root/.netrc', 'A /root/.docker/config.json', 'A /root/.pypirc', 'A /root/.aws/credentials', 'A /root/.kube/config', 'A /root/.config/gh/hosts.yml',
            'A /root/.ssh/id_ed25519', 'A /root/.ssh/id_ed25519.pub', 'A /root/.ssh/known_hosts', 'A /root/.ssh/config', 'A /root/.ssh/authorized_keys'
        ];
        const ALL = ['history', 'agentSessions', 'settings', 'agentExtras', 'workdir', 'systemLayer'];

        test('变量名：PASSWD / PAT / URL 里的密码也清空，其它保留；勾选包含密钥时原样保留（守卫）', async () => {
            const { entries } = await doExport(['history', 'settings'], { includeSecrets: false });
            const env = entries['c/0/state/env'].content;
            expect(env).not.toContain('sk-secret-1234');
            expect(env).not.toContain('hunter2-password');
            expect(env).not.toContain('ghp-personal-token-xyz');
            expect(env).not.toContain('dbpass-secret');
            expect(env).toContain('ANTHROPIC_MODEL=m');
            expect(env).toContain('postgres://dbuser@db:5432/app');
            const history = JSON.parse(entries['c/0/history.json'].content);
            expect(history.runtimeSnapshot.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: '', MY_PASSWD: '', GH_PAT: '', ANTHROPIC_MODEL: 'm', DB_URL: 'postgres://dbuser@db:5432/app' });
            const withSecrets = await doExport(['history', 'settings'], { includeSecrets: true });
            expect(withSecrets.entries['c/0/state/env'].content).toContain('sk-secret-1234');
            expect(withSecrets.entries['c/0/state/env'].content).toContain('dbpass-secret');
            expect(withSecrets.entries['c/0/history.json'].content).toContain('hunter2-password');
        });

        test('凭据文件整份跳过；.ssh 里只留公钥 / known_hosts / config', async () => {
            const runtime = fakeRuntime({ diff: RICH_DIFF, files: RICH_TREES });
            const { entries } = await doExport(ALL, { includeSecrets: false, runtime });
            const names = Object.keys(entries);
            for (const gone of ['.credentials.json', '.npmrc', '.git-credentials', '.netrc', 'docker/config.json', '.pypirc', '.aws/credentials', '.kube/config', 'gh/hosts.yml', 'id_ed25519\0', 'authorized_keys']) {
                expect(names.some(n => n.endsWith(gone.replace('\0', '')) && !n.endsWith('.pub'))).toBe(false);
            }
            expect(names.some(n => n.endsWith('.ssh/id_ed25519'))).toBe(false);
            expect(names).toContain('c/0/layer/root/.ssh/id_ed25519.pub');
            expect(names).toContain('c/0/layer/root/.ssh/known_hosts');
            expect(names).toContain('c/0/layer/root/.ssh/config');
            // 对照组：勾选包含密钥时全在
            const withSecrets = await doExport(ALL, { includeSecrets: true, runtime: fakeRuntime({ diff: RICH_DIFF, files: RICH_TREES }) });
            for (const kept of ['.npmrc', '.git-credentials', '.ssh/id_ed25519', '.claude/.credentials.json']) expect(Object.keys(withSecrets.entries).some(n => n.endsWith(kept))).toBe(true);
        });

        test('配置文件按字段清空（保留文件）：claude settings.json 的 env、.claude.json 的 primaryApiKey、codex config.toml', async () => {
            const runtime = fakeRuntime({ diff: RICH_DIFF, files: RICH_TREES });
            const { entries } = await doExport(ALL, { includeSecrets: false, runtime });
            const settings = JSON.parse(entries['c/0/layer/root/.claude/settings.json'].content);
            expect(settings.env).toEqual({ ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_MODEL: 'mm' });
            expect(settings.model).toBe('m');
            const claudeJson = JSON.parse(entries['c/0/layer/root/.claude.json'].content);
            expect(claudeJson.primaryApiKey).toBe('');
            expect(claudeJson.customApiKeyResponses).toEqual({ approved: [], rejected: [] });
            expect(claudeJson.projects).toEqual({ '/w': {} });
            const toml = entries['c/0/layer/root/.codex/config.toml'].content;
            expect(toml).toContain('model = "m"');
            expect(toml).not.toContain('toml-secret-token-1');
            expect(toml).not.toContain('toml-key-secret-2');
        });

        test('按值抹除：聊天记录、事件文件、Agent 会话记录里已知密钥的值和常见格式（sk-…）被去掉；工作目录里的 .env 原样带上', async () => {
            const runtime = fakeRuntime({ diff: RICH_DIFF, files: RICH_TREES });
            const { entries } = await doExport(ALL, { includeSecrets: false, runtime });
            const everything = JSON.stringify(entries);
            for (const secret of ['sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV', 'settings-token-abcdef123', 'sk-primary-key-0123456789', 'sk-secret-1234', 'hunter2-password', 'dbpass-secret', 'ghp-personal-token-xyz', 'toml-secret-token-1']) {
                expect(everything).not.toContain(secret);
            }
            expect(JSON.parse(entries['c/0/history.json'].content).chat).toBe('I pasted  and  here');
            expect(entries['c/0/events/box1.jsonl'].content).toContain('"seq":1');
            expect(entries['w/0/.env'].content).toBe('WORK_DOTENV=keep-me-in-workdir-1234');
            expect(entries['c/0/layer/root/.claude/projects/p/abc.jsonl'].content).toBe('{"text":"agent said  and "}\n');
            // 对照组
            const withSecrets = await doExport(ALL, { includeSecrets: true, runtime: fakeRuntime({ diff: RICH_DIFF, files: RICH_TREES }) });
            expect(JSON.stringify(withSecrets.entries)).toContain('hunter2-password');
            expect(JSON.stringify(withSecrets.entries)).toContain('settings-token-abcdef123');
        });
    });

    test('不带密钥时准备阶段要读容器里的配置文件：cp 只读第一个条目就会堵住不退出，必须读到内容后杀掉它，不能等它自己结束', async () => {
        const runtime = fakeRuntime({ diff: ['A /root/.claude.json', 'A /root/.codex/sessions/s.jsonl'], files: { '/root/.codex/sessions/s.jsonl': 'SESSION', '/root/.claude.json': JSON.stringify({ primaryApiKey: 'sk-primary-key-0123456789', projects: {} }) } });
        const realCp = runtime.cp;
        const killed = [];
        let calls = 0;
        runtime.cp = (name, scope) => {
            calls += scope === '/root/.claude.json' ? 1 : 0;
            if (scope !== '/root/.claude.json' || calls > 1) return realCp(name, scope); // 第一次是准备阶段读配置文件，第二次才是正式导出
            // 像真实的 podman cp：条目读完之后进程还堵在写结束块上，只有被杀才会退出
            let kill;
            const done = new Promise(resolve => { kill = () => { killed.push(scope); resolve({ code: null, stderr: '' }); }; });
            return { stream: Readable.from((async function* () { yield tarOf([{ name: '.claude.json', content: JSON.stringify({ primaryApiKey: 'sk-primary-key-0123456789', projects: {} }) }]).subarray(0, 1024); await new Promise(() => {}); })()), done, kill };
        };
        const { entries } = await Promise.race([
            doExport(['history', 'agentSessions'], { includeSecrets: false, runtime }),
            new Promise((resolve, reject) => setTimeout(() => reject(new Error('准备阶段卡住了')), 3000))
        ]);
        expect(killed).toContain('/root/.claude.json');
        expect(entries['c/0/history.json']).toBeTruthy();
    });

    test('只在读容器内数据期间暂停：读完立刻恢复，之后读工作目录时容器已在运行', async () => {
        const runtime = fakeRuntime();
        const pausedAtWorkdir = [];
        let paused = false;
        const origPause = runtime.pause;
        const origUnpause = runtime.unpause;
        runtime.pause = async n => { paused = true; return origPause(n); };
        runtime.unpause = async n => { paused = false; return origUnpause(n); };
        await doExport(['history', 'agentSessions', 'workdir'], {
            runtime,
            hooks: { onStage: info => { if (info.stage === '工作目录' || info.stage === '聊天记录') pausedAtWorkdir.push([info.stage, paused]); } }
        });
        expect(runtime.calls.order[0]).toBe('pause');
        expect(runtime.calls.order[runtime.calls.order.length - 1]).toBe('unpause');
        expect(pausedAtWorkdir).toEqual([['聊天记录', false], ['工作目录', false]]);
        expect(runtime.calls.pause).toEqual(['box1']);
        expect(runtime.calls.unpause).toEqual(['box1']);
        const stopped = await doExport(['history', 'agentSessions'], { runtime: fakeRuntime({ status: 'stopped' }) });
        expect(stopped.runtime.calls.pause).toEqual([]);
    });

    test('出错也恢复暂停', async () => {
        const broken = fakeRuntime();
        broken.cp = () => { throw new Error('boom'); };
        await expect(doExport(['history', 'agentSessions'], { runtime: broken })).rejects.toThrow('boom');
        expect(broken.calls.unpause).toEqual(['box1']);
    });

    test('暂停失败：不会停止容器；容器已不在运行就当已停止读，仍在运行就不暂停直接读并给出提示', async () => {
        const gone = fakeRuntime();
        gone.pause = async () => { throw new Error('No such process'); };
        let calls = 0;
        gone.inspect = async () => ({ id: ID, image: 'img:1', status: (calls++ === 0) ? 'running' : 'stopped', mounts: [] });
        const a = await doExport(['history', 'agentSessions'], { runtime: gone });
        expect(gone.calls.stop).toEqual([]);
        expect(a.result.warnings).toEqual([]);
        expect(a.entries['c/0/layer/root/.codex/sessions/s.jsonl'].content).toBe('SESSION');

        const alive = fakeRuntime();
        alive.pause = async () => { throw new Error('cgroup 不支持暂停'); };
        const onPause = [];
        const unpauseHook = [];
        const b = await doExport(['history', 'agentSessions'], { runtime: alive, hooks: { onPause: name => onPause.push(name), onUnpause: name => unpauseHook.push(name) } });
        expect(alive.calls.stop).toEqual([]);
        expect(alive.calls.unpause).toEqual([]);
        expect(b.result.stats.pauseUnusable).toBe(1);
        expect(b.result.warnings.length).toBe(1);
        expect(b.result.warnings[0]).toContain('box1');
        expect(onPause).toEqual(['box1']);
        expect(unpauseHook).toEqual(['box1']); // 没暂停成功，任务记录里不能留着
        expect(b.entries['c/0/layer/root/.codex/sessions/s.jsonl'].content).toBe('SESSION');
    });

    test('暂停后读不到容器文件：立刻恢复运行，改成不暂停直接读，数据照样带全', async () => {
        const runtime = fakeRuntime();
        runtime.canRead = async () => false;
        const { entries, result } = await doExport(['history', 'agentSessions'], { runtime });
        expect(runtime.calls.pause).toEqual(['box1']);
        expect(runtime.calls.unpause).toEqual(['box1']);
        expect(result.stats.pauseUnusable).toBe(1);
        expect(entries['c/0/layer/root/.codex/sessions/s.jsonl'].content).toBe('SESSION');
    });

    test('暂停后读不到文件、恢复运行又失败：容器仍登记为暂停（收尾会再试、崩溃恢复靠任务记录），整个导出失败，不会带着读不全的数据继续', async () => {
        const runtime = fakeRuntime();
        runtime.canRead = async () => false;
        let attempts = 0;
        runtime.unpause = async name => { attempts += 1; runtime.calls.unpause.push(name); throw new Error('unpause 失败'); };
        const registered = [];
        const unregistered = [];
        await expect(doExport(['history', 'agentSessions'], { runtime, hooks: { onPause: name => registered.push(name), onUnpause: name => unregistered.push(name) } })).rejects.toThrow(/恢复运行也失败/);
        expect(registered).toEqual(['box1']);
        expect(unregistered).toEqual([]); // 没恢复成功，任务记录里必须留着
        expect(attempts).toBeGreaterThanOrEqual(2); // 当场试了一次，收尾又试了一次
        expect(runtime.calls.stop).toEqual([]);
    });

    test('超过 32MB 的文本走临时文件逐行处理：没改动的行原样保留（CRLF、没有结尾换行、非 UTF-8 字节），只改含密钥的行', async () => {
        const big = path.join(historyDir, 'events', 'box1.jsonl');
        const line = 'x'.repeat(1000);
        const parts = [];
        for (let i = 0; i < 34000; i += 1) parts.push(`${i}:${line}\r\n`);
        parts.splice(17000, 0, 'my key sk-abcdefghijklmnop12345 end\r\n');
        parts.push('last line no newline \xff\xfe');
        fs.writeFileSync(big, Buffer.from(parts.join(''), 'latin1'));
        const { sink, buffer } = collectingSink();
        await exportArchive({ out: sink, containers: [{ name: 'box1' }], items: ['history'], includeSecrets: false, compression: 'fast', deps: { homeDir: home, webHistoryDir: historyDir, runtime: fakeRuntime(), containerState, version: 'test', loadHistory: () => baseHistory() } });
        const raw = zlib.zstdDecompressSync(buffer());
        const pos = raw.indexOf('my key ');
        expect(pos).toBeGreaterThan(0);
        const text = raw.toString('latin1');
        expect(text).toContain('my key  end\r\n');
        expect(text).not.toContain('sk-abcdefghijklmnop12345');
        expect(text).toContain(`0:${line}\r\n`);
        expect(text).toContain('last line no newline \xff\xfe');
        expect(text.includes('last line no newline \xff\xfe\n')).toBe(false);
    }, 60000);

    test('取消：check 抛错时中止并恢复暂停', async () => {
        const runtime = fakeRuntime();
        await expect(doExport(['history', 'agentSessions'], { runtime, hooks: { check: () => { if (runtime.calls.cp.length > 0) throw new Error('已取消'); } } })).rejects.toThrow('已取消');
        expect(runtime.calls.pause).toEqual(['box1']);
        expect(runtime.calls.unpause).toEqual(['box1']);
    });

    test('准备阶段可以取消：diff 收到 signal，取消后不会开始写', async () => {
        const runtime = fakeRuntime();
        const controller = new AbortController();
        runtime.diff = (name, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('已取消')));
            setTimeout(() => controller.abort(), 20);
        });
        const written = [];
        const sink = new Writable({ write(chunk, enc, cb) { written.push(chunk); cb(); } });
        const { prepareExport } = require('../lib/archive/export');
        await expect(prepareExport({ containers: [{ name: 'box1' }], items: ['agentSessions'], includeSecrets: true, signal: controller.signal, deps: { homeDir: home, runtime, containerState, loadHistory: baseHistory } })).rejects.toThrow('已取消');
        expect(written).toEqual([]);
        expect(runtime.calls.pause).toEqual([]);
        void sink;
    });

    test('心跳：容器里的数据迟迟不来时，每隔约 2 秒把压缩器里已有的字节冲刷出去', async () => {
        const runtime = fakeRuntime();
        const realCp = runtime.cp;
        runtime.cp = (name, scope) => {
            const inner = realCp(name, scope);
            async function* slow() {
                const whole = Buffer.concat(await (async () => { const parts = []; for await (const chunk of inner.stream) parts.push(chunk); return parts; })());
                if (!whole.length) return;
                yield whole.subarray(0, 700);
                await new Promise(resolve => setTimeout(resolve, 3600));
                yield whole.subarray(700);
            }
            return { stream: Readable.from(slow()), done: inner.done };
        };
        const stamps = [];
        const out = new Writable({ write(chunk, enc, cb) { stamps.push(Date.now()); cb(); } });
        const started = Date.now();
        await doExport(['agentSessions'], { runtime, out });
        // 开头的清单写完就冲刷过一次；之后已进压缩器的数据在静默 2 秒后再冲刷一次，不用等压缩器自己攒满
        const early = stamps.filter(t => t - started < 3400);
        expect(early.length).toBeGreaterThanOrEqual(2);
    }, 30000);

    test('中途出错：输出端以错误结束（不是正常结束成一个不完整的文件）', async () => {
        const runtime = fakeRuntime();
        runtime.cp = () => ({ stream: Readable.from((async function* () { yield tarOf([{ name: 'x', content: 'x' }]).subarray(0, 600); throw new Error('读到一半断了'); })()), done: Promise.resolve({ code: 0, stderr: '' }) });
        const out = new Writable({ write(chunk, enc, cb) { cb(); } });
        await expect(doExport(['agentSessions'], { runtime, out })).rejects.toThrow();
        expect(out.destroyed).toBe(true);
        expect(out.writableFinished).toBe(false);
    });
});
