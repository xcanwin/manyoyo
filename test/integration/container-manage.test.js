'use strict';

// 真实容器：env 热更新、自启动、PID 1 行为、挂载权限。运行时不可用或镜像缺失时自动跳过。
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { imageVersion } = require('../../package.json');
const { selectContainerRuntime } = require('../../lib/container-runtime');
const { buildContainerRunArgs } = require('../../lib/container-run');
const { buildExecArgs } = require('../../lib/container-exec');
const state = require('../../lib/container-state');

const IMAGE_NAME = 'ghcr.io/xcanwin/manyoyo';
let runtime = null;
let skipReason = '';
try {
    runtime = selectContainerRuntime();
    const info = spawnSync(runtime.command, ['info'], { stdio: 'ignore', timeout: 15000, env: { ...process.env, ...runtime.env } });
    if (info.status !== 0) skipReason = `${runtime.command} info 失败`;
    else if (spawnSync(runtime.command, ['image', 'inspect', `${IMAGE_NAME}:${imageVersion}`], { stdio: 'ignore', env: { ...process.env, ...runtime.env } }).status !== 0) {
        skipReason = `本机没有镜像 ${IMAGE_NAME}:${imageVersion}`;
    }
} catch (e) {
    skipReason = e.message;
}
if (skipReason) console.warn(`[container-manage 集成测试已跳过] ${skipReason}`);
const maybe = skipReason ? describe.skip : describe;

function rt(args, options = {}) {
    return spawnSync(runtime.command, args, { encoding: 'utf-8', env: { ...process.env, ...runtime.env }, timeout: 60000, ...options });
}

function dockerExecArgs(args) {
    const r = rt(args);
    if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
    return r.stdout;
}

maybe('container-manage（真实容器）', () => {
    let home;
    let work;
    const names = [];

    beforeAll(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-int-home-'));
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-int-work-'));
    });
    afterAll(() => {
        names.forEach(name => rt(['rm', '-f', name]));
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(work, { recursive: true, force: true });
    });

    function create({ envLines = [], autostart = '', extraArgs = [] } = {}) {
        const name = `cm-int-${crypto.randomBytes(3).toString('hex')}`;
        names.push(name);
        const st = state.createState({ homeDir: home, envLines, autostart, meta: { name } });
        const args = buildContainerRunArgs({
            state: st, containerName: name, hostPath: work, containerPath: '/workspace',
            imageName: IMAGE_NAME, imageVersion, containerExtraArgs: extraArgs, defaultCommand: '/bin/bash'
        });
        dockerExecArgs(args);
        return { name, st };
    }

    function exec(name, command, options = {}) {
        const built = buildExecArgs({ homeDir: home, dockerExecArgs }, name, { command: ['/bin/bash', '-c', command], ...options });
        try {
            return { ...rt(built.args), invalid: built.invalid };
        } finally {
            built.cleanup();
        }
    }

    async function waitFor(fn, timeoutMs = 15000) {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            if (fn()) return true;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return false;
    }

    test('env：下一次 exec 生效；删除的 key 消失；inspect 里看不到值；容器内追加可见；非法行被跳过并报出', () => {
        const { name, st } = create({ envLines: ['CM_A=1', 'CM_B=old', 'CM_SECRET=topsecret-xyz'] });
        expect(exec(name, 'echo "$CM_A|$CM_B"').stdout.trim()).toBe('1|old');
        expect(rt(['inspect', name]).stdout).not.toContain('topsecret-xyz');

        state.writeEnv(home, st.id, 'CM_A=2\nCM_C=new\n');
        expect(exec(name, 'echo "$CM_A|${CM_B:-gone}|$CM_C"').stdout.trim()).toBe('2|gone|new');

        expect(exec(name, 'printf "CM_D=x\\n1BAD=y\\n" >> /run/manyoyo/env').status).toBe(0);
        const after = exec(name, 'echo "$CM_D"; env | grep -c "^1BAD=" || true');
        expect(after.stdout.split('\n')[0]).toBe('x');
        expect(after.stdout.split('\n')[1]).toBe('0');
        expect(after.invalid.map(i => i.text)).toEqual(['1BAD=y']);
    });

    test('自启动：新建、restart、stop+start 各执行一次；容器写不了只读的 sys', async () => {
        const { name, st } = create({ autostart: 'date +%s%N >> /run/manyoyo/ran.txt\n' });
        const ran = () => (fs.existsSync(path.join(st.box, 'ran.txt')) ? fs.readFileSync(path.join(st.box, 'ran.txt'), 'utf-8').trim().split('\n').length : 0);
        expect(await waitFor(() => ran() === 1)).toBe(true);
        rt(['restart', '-t', '1', name]);
        expect(await waitFor(() => ran() === 2)).toBe(true);
        rt(['stop', '-t', '1', name]);
        rt(['start', name]);
        expect(await waitFor(() => ran() === 3)).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 1500));
        expect(ran()).toBe(3);
        expect(exec(name, 'touch /run/manyoyo-sys/x').status).not.toBe(0);
    });

    test('PID 1：podman stop 不等满 10 秒；孤儿进程被回收不留僵尸', () => {
        const { name } = create();
        // 孤儿：子 shell 里起后台 sleep 后立即退出，sleep 被 PID 1 收养，结束后必须被回收
        exec(name, '(sleep 1 &) ; sleep 0.1');
        const started = Date.now();
        // 等 sleep 结束后检查僵尸
        spawnSync('sleep', ['2']);
        const zombies = exec(name, "ps -eo stat= | grep -c '^Z' || true").stdout.trim();
        expect(zombies).toBe('0');
        const t0 = Date.now();
        rt(['stop', name]);
        expect(Date.now() - t0).toBeLessThan(3000);
        expect(Date.now() - started).toBeGreaterThan(0);
    });
});
