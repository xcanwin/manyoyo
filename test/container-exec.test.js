'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('../lib/container-state');
const { buildExecArgs, composeEnvLines, resolveContainerId } = require('../lib/container-exec');

describe('container-exec', () => {
    let home;
    beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-exec-')); });
    afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

    test('composeEnvLines: managed < box < extra，非法行丢弃并报出', () => {
        const { lines, invalid } = composeEnvLines('A=m\nP=m', 'A=box\n1BAD=x\nB=1', ['B=extra']);
        expect(lines).toEqual(['A=box', 'P=m', 'B=extra']);
        expect(invalid.map(i => i.source)).toEqual(['box']);
    });

    test('有 manyoyo.id：env 经 0600 临时文件传入（不出现在参数里），改文件后下一次生效，cleanup 删除', () => {
        const st = state.createState({ homeDir: home, envLines: ['SECRET=s1'] });
        const dockerExecArgs = jest.fn(() => `${st.id}\n`);
        const first = buildExecArgs({ homeDir: home, dockerExecArgs }, 'c1', { interactive: true, tty: true, command: ['/bin/bash'] });
        expect(first.args.slice(0, 3)).toEqual(['exec', '-i', '-t']);
        expect(first.args.join(' ')).not.toContain('s1');
        const file = first.args[first.args.indexOf('--env-file') + 1];
        expect((fs.statSync(file).mode & 0o777)).toBe(0o600);
        expect(fs.readFileSync(file, 'utf-8')).toBe('SECRET=s1\n');
        expect(first.args.slice(-2)).toEqual(['c1', '/bin/bash']);
        first.cleanup();
        expect(fs.existsSync(file)).toBe(false);

        fs.writeFileSync(st.env, 'SECRET=s2\nNEW=1\n1BAD=x\n');
        const second = buildExecArgs({ homeDir: home, dockerExecArgs }, 'c1', { command: ['env'] });
        expect(fs.readFileSync(second.args[second.args.indexOf('--env-file') + 1], 'utf-8')).toBe('SECRET=s2\nNEW=1\n');
        expect(second.invalid.map(i => i.line)).toEqual([3]);
        second.cleanup();
    });

    test('旧容器（无标签）与 withEnv:false 都不加 --env-file', () => {
        const legacy = buildExecArgs({ homeDir: home, dockerExecArgs: () => '\n' }, 'old', { command: ['ls'] });
        expect(legacy.args).toEqual(['exec', 'old', 'ls']);
        const st = state.createState({ homeDir: home, envLines: ['A=1'] });
        const noEnv = buildExecArgs({ homeDir: home, dockerExecArgs: () => st.id }, 'c', { withEnv: false, command: ['cat', '--', '/x'] });
        expect(noEnv.args).toEqual(['exec', 'c', 'cat', '--', '/x']);
    });

    test('envs 以 --env 传入且在容器名之前；extraEnv 进文件并覆盖用户 env', () => {
        const st = state.createState({ homeDir: home, envLines: ['A=1'] });
        const r = buildExecArgs({ homeDir: home, dockerExecArgs: () => st.id }, 'c', { envs: ['TERM=xterm'], extraEnv: ['A=first'], command: ['x'] });
        expect(r.args.slice(r.args.indexOf('--env'), r.args.indexOf('--env') + 2)).toEqual(['--env', 'TERM=xterm']);
        expect(fs.readFileSync(r.args[r.args.indexOf('--env-file') + 1], 'utf-8')).toBe('A=first\n');
        r.cleanup();
    });

    test('resolveContainerId: 运行时报错或标签非法时返回空', () => {
        expect(resolveContainerId(() => { throw new Error('x'); }, 'c')).toBe('');
        expect(resolveContainerId(() => 'not-an-id', 'c')).toBe('');
        expect(resolveContainerId(() => '0123456789abcdef\n', 'c')).toBe('0123456789abcdef');
    });
});

describe('exec 调用点收敛', () => {
    const root = path.join(__dirname, '..');
    // 与用户容器无关或必须绕开 env 的 exec（apt 源改写、插件自己的容器）
    const files = ['bin/manyoyo.js', 'lib/web/server.js'];
    test.each(files)('%s 里不再直接拼 exec 参数数组', file => {
        const text = fs.readFileSync(path.join(root, file), 'utf-8');
        expect(text).not.toMatch(/\[\s*'exec'/);
    });
});
