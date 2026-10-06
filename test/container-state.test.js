'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('../lib/container-state');
const { parseEnvEntry } = require('../lib/runtime-normalizers');
const { buildContainerRunArgs } = require('../lib/container-run');

describe('container-state', () => {
    let home;
    beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-state-')); });
    afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

    test('parseEnvText：统一语法（引号成对去掉、空格不必加引号），非法行单独报出；语料见 env-text.test.js', () => {
        const parsed = state.parseEnvText('A=1\n# c\n\nQ="a b"\nE=x=y\n1BAD=x\nnoequals\nA 1=x\nEMPTY=\n');
        expect(parsed.entries.map(e => [e.key, e.value])).toEqual([['A', '1'], ['Q', 'a b'], ['E', 'x=y'], ['EMPTY', '']]);
        expect(parsed.invalid.map(i => i.line)).toEqual([6, 7, 8]);
    });

    test('createState: 目录 0700、env/managed.env 0600、init 0755，id 是 16 位 hex', () => {
        const st = state.createState({ homeDir: home, envLines: ['A=1'], autostart: 'echo hi', netRequired: true });
        expect(state.isValidId(st.id)).toBe(true);
        const mode = file => fs.statSync(file).mode & 0o777;
        expect(mode(st.dir)).toBe(0o700);
        expect(mode(st.env)).toBe(0o600);
        expect(mode(st.managedEnv)).toBe(0o600);
        expect(mode(st.init)).toBe(0o755);
        expect(fs.readFileSync(st.env, 'utf-8')).toBe('A=1\n');
        expect(fs.existsSync(st.netRequired)).toBe(true);
        state.setNetRequired(home, st.id, false);
        expect(fs.existsSync(st.netRequired)).toBe(false);
    });

    test('同名重建得到新 id，不继承旧 env', () => {
        const a = state.createState({ homeDir: home, envLines: ['OLD=1'], meta: { name: 'same' } });
        state.removeState(home, a.id);
        const b = state.createState({ homeDir: home, envLines: [], meta: { name: 'same' } });
        expect(b.id).not.toBe(a.id);
        expect(state.readEnv(home, b.id).entries).toEqual([]);
    });

    test('writeEnv: If-Match 不一致抛 CONFLICT；写入走严格校验', () => {
        const st = state.createState({ homeDir: home, envLines: ['A=1'] });
        const before = state.readEnv(home, st.id);
        fs.appendFileSync(st.env, 'D=x\n');
        expect(() => state.writeEnv(home, st.id, 'A=2', { ifMatch: before.etag, parseEnvEntry })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        const cur = state.readEnv(home, st.id);
        state.writeEnv(home, st.id, 'A=2\nC=3', { ifMatch: cur.etag, parseEnvEntry });
        expect(fs.readFileSync(st.env, 'utf-8')).toBe('A=2\nC=3\n');
        expect(() => state.writeEnv(home, st.id, '1BAD=x', { parseEnvEntry })).toThrow(/KEY=VALUE/);
        expect(() => state.writeEnv(home, st.id, 'X=a;b', { parseEnvEntry })).toThrow();
    });

    test('孤儿识别与非法 id 拒绝（防目录穿越）', () => {
        const a = state.createState({ homeDir: home });
        const b = state.createState({ homeDir: home });
        expect(state.findOrphans(home, [a.id])).toEqual([b.id]);
        expect(() => state.stateDir(home, '../x')).toThrow();
        expect(state.removeState(home, '../..')).toBe(false);
    });

    test('自启动日志只读尾部', () => {
        const st = state.createState({ homeDir: home });
        fs.writeFileSync(st.autostartLog, `${'x'.repeat(100000)}\nTAIL`);
        const tail = state.readAutostartLogTail(home, st.id, 1024);
        expect(tail.length).toBe(1024);
        expect(tail.endsWith('TAIL')).toBe(true);
    });

    test('envArgs 拆分：NO_PROXY 留在容器级，其余进 box/env', () => {
        const flat = ['--env', 'A=1', '--env', 'NO_PROXY=x', '--env', 'B=2'];
        expect(state.userEnvLines(flat)).toEqual(['A=1', 'B=2']);
        expect(state.stripEnvKeys(flat, new Set(['A', 'B']))).toEqual(['--env', 'NO_PROXY=x']);
    });
});

describe('buildContainerRunArgs 状态目录参数', () => {
    const base = { state: { id: '0123456789abcdef', box: '/s/box', sys: '/s/sys' }, containerName: 'c', hostPath: '/h', containerPath: '/w', imageName: 'i', imageVersion: '1.0.0-common', containerEnvs: [] };
    test('PID 1 换成 init，挂载 box(rw)/sys(ro)/gate(tmpfs)，打 manyoyo.id 标签，不再有 tail', () => {
        const args = buildContainerRunArgs(base);
        expect(args.slice(args.indexOf('--entrypoint'), args.indexOf('--entrypoint') + 2)).toEqual(['--entrypoint', '/run/manyoyo-sys/init.sh']);
        expect(args).toEqual(expect.arrayContaining(['/s/box:/run/manyoyo', '/s/sys:/run/manyoyo-sys:ro', '--tmpfs', '/run/manyoyo-gate', 'manyoyo.id=0123456789abcdef']));
        expect(args).not.toContain('tail');
        expect(args[args.length - 1]).toBe('i:1.0.0-common');
    });
    test('缺少状态目录直接报错', () => {
        expect(() => buildContainerRunArgs({ ...base, state: undefined })).toThrow(/状态目录/);
    });
});

describe('box/ 里的不可信文件', () => {
    const { execFileSync } = require('child_process');
    let home;
    beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-box-')); });
    afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

    test('FIFO / 符号链接 / 目录 / 超大文件：读取不阻塞、不跟随、返回空并标记 unsafe', () => {
        const st = state.createState({ homeDir: home, envLines: ['A=1'] });
        fs.rmSync(st.env);
        execFileSync('mkfifo', [st.env]);
        const fifo = state.readEnv(home, st.id);
        expect(fifo.text).toBe('');
        expect(fifo.unsafe).toMatch(/不是普通文件/);

        fs.rmSync(st.env);
        const secret = path.join(home, 'host-secret');
        fs.writeFileSync(secret, 'LEAK=1\n');
        fs.symlinkSync(secret, st.env);
        const link = state.readEnv(home, st.id);
        expect(link.text).toBe('');
        expect(link.unsafe).toMatch(/符号链接/);
        expect(state.readAutostartLogTail(home, st.id)).toBe('');

        fs.rmSync(st.env);
        fs.writeFileSync(st.env, 'x'.repeat(state.MAX_ENV_BYTES + 1));
        expect(state.readEnv(home, st.id).unsafe).toMatch(/过大/);
    });

    test('写入不跟随符号链接：PUT 用新文件替换链接，宿主机上被指向的文件不被改动', () => {
        const st = state.createState({ homeDir: home, envLines: ['A=1'] });
        const target = path.join(home, 'bashrc');
        fs.writeFileSync(target, 'ORIGINAL\n');
        fs.rmSync(st.env);
        fs.symlinkSync(target, st.env);
        state.writeEnv(home, st.id, 'B=2\n', { parseEnvEntry });
        expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL\n');
        expect(fs.lstatSync(st.env).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(st.env, 'utf-8')).toBe('B=2\n');

        fs.rmSync(st.autostart);
        fs.symlinkSync(target, st.autostart);
        state.writeAutostart(home, st.id, 'echo hi');
        expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL\n');
    });

    test('exec 组 env 时读到被替换成符号链接的 box/env 不会把宿主机文件注入进去', () => {
        const { buildExecArgs } = require('../lib/container-exec');
        const st = state.createState({ homeDir: home, envLines: ['A=1'] });
        const secret = path.join(home, 'host-secret');
        fs.writeFileSync(secret, 'LEAK=1\n');
        fs.rmSync(st.env);
        fs.symlinkSync(secret, st.env);
        const built = buildExecArgs({ homeDir: home, dockerExecArgs: () => st.id }, 'c', { command: ['env'] });
        expect(built.args).not.toContain('--env-file');
        built.cleanup();
    });
});

describe('不凭空建状态目录', () => {
    test('对不存在的 id 写下发状态 / managed.env / 门闩标记会报错且不留目录', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ghost-'));
        try {
            const id = '0123456789abcdef';
            expect(() => state.writeNetStatus(home, id, { status: 'error' })).toThrow(/状态目录不存在/);
            expect(() => state.writeManagedEnv(home, id, [])).toThrow(/状态目录不存在/);
            expect(() => state.setNetRequired(home, id, true)).toThrow(/状态目录不存在/);
            expect(fs.existsSync(path.join(home, '.manyoyo', 'containers', id))).toBe(false);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});


describe('环境变量文件（每次 exec 现读）', () => {
    let home;
    beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-envfiles-')); });
    afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

    test('路径列表：只收绝对路径、去重、有数量上限；读取时统一语法并报出被跳过的行与读不到的文件', () => {
        expect(() => state.normalizeEnvFileList(['relative.env'])).toThrow(/绝对路径/);
        expect(() => state.normalizeEnvFileList(Array.from({ length: 21 }, (_, i) => `/tmp/f${i}`))).toThrow(/最多/);
        const good = path.join(home, 'good.env');
        fs.writeFileSync(good, 'export A="x y"\nB=2\nC=bad&value\nnoequals\n');
        const st = state.createState({ homeDir: home, envFiles: [good, good, path.join(home, 'missing.env')] });
        const files = state.readEnvFiles(home, st.id);
        expect(files.map(f => f.path)).toEqual([good, path.join(home, 'missing.env')]);
        expect(files[0].entries.map(e => [e.key, e.value])).toEqual([['A', 'x y'], ['B', '2']]);
        expect(files[0].invalid.length).toBe(2);
        expect(files[1]).toEqual(expect.objectContaining({ exists: false, error: '文件不存在' }));
        // 自启动用的快照
        expect(fs.readFileSync(st.filesEnv, 'utf-8')).toBe('A=x y\nB=2\n');
    });
});

describe('sys 目录里的容器内脚本', () => {
    test('创建时写入 init.sh 与 env.sh（reload-env 的来源），init 加载它并记录就绪 / 无自启动日志', () => {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const state = require('../lib/container-state');
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-env-'));
        try {
            const { id } = state.createState({ homeDir: home });
            const p = state.paths(home, id);
            expect(fs.readFileSync(p.envLoader, 'utf-8')).toContain('reload-env()');
            const init = fs.readFileSync(p.init, 'utf-8');
            expect(init).toContain('. "$SYS/env.sh"');
            expect(init).toContain('网络规则已就绪');
            expect(init).toContain('没有自启动命令');
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});
