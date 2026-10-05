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

    test('parseEnvText: 按第一个 = 切分、不去引号、跳过注释，非法行单独报出', () => {
        const parsed = state.parseEnvText('A=1\n# c\n\nQ="a b"\nE=x=y\n1BAD=x\nnoequals\nA 1=x\nEMPTY=\n');
        expect(parsed.entries.map(e => [e.key, e.value])).toEqual([['A', '1'], ['Q', '"a b"'], ['E', 'x=y'], ['EMPTY', '']]);
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
