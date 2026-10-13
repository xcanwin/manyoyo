'use strict';

const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { wrapAgentCommand, buildRunKillCommand, buildLiveRunsCommand, terminateRun, isValidRunId, createRunId, pidFilePath } = require('../lib/web/agent-run-control');

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return false; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const runKill = (runId, signal) => spawnSync(...[buildRunKillCommand(runId, signal)[0], buildRunKillCommand(runId, signal).slice(1)], { encoding: 'utf8' });

const launch = (command, id, options = {}) => spawn('/bin/bash', ['-lc', wrapAgentCommand(command, id)], options);

describe('wrapAgentCommand', () => {
    test('writes its pid first and keeps the original command verbatim (still the single bash -lc argument)', () => {
        const id = createRunId();
        expect(wrapAgentCommand("claude -p 'it''s'", id)).toBe(`echo $$ > ${pidFilePath(id)}; claude -p 'it''s'; exit $?`);
        expect(() => wrapAgentCommand('x', 'bad id; rm -rf /')).toThrow(/runId/);
    });

    test('run with a local shell: the pid file holds the shell, exit code and stdout pass through', () => {
        const id = createRunId();
        const result = spawnSync('/bin/bash', ['-lc', wrapAgentCommand('echo hello; exit 7', id)], { encoding: 'utf8' });
        expect(result.status).toBe(7);
        expect(result.stdout).toContain('hello');
        expect(fs.readFileSync(pidFilePath(id), 'utf8').trim()).toMatch(/^\d+$/);
        fs.rmSync(pidFilePath(id));
    });
});

describe('RUN_KILL_SCRIPT 按不可信输入处理 PID 文件', () => {
    const children = [];
    afterEach(() => {
        children.splice(0).forEach(child => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* 已退出 */ } } });
    });

    function startWrapped(id, command = 'sleep 60') {
        const child = launch(command, id, { stdio: 'ignore', detached: true });
        children.push(child);
        return child;
    }
    async function pidOf(id) {
        for (let i = 0; i < 50; i += 1) {
            if (fs.existsSync(pidFilePath(id))) {
                const text = fs.readFileSync(pidFilePath(id), 'utf8').trim();
                if (text) return Number(text);
            }
            await sleep(40);
        }
        throw new Error('pid file not written');
    }

    test('a real run: INT reaches the whole process tree (a grandchild too), not only the shell', async () => {
        const id = createRunId();
        startWrapped(id, 'sleep 61; true');
        const pid = await pidOf(id);
        await sleep(300);
        const grandchild = spawnSync('pgrep', ['-f', '^sleep 61$'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(Number)[0];
        expect(alive(pid) && alive(grandchild)).toBe(true);
        expect(runKill(id, 'INT').status).toBe(0);
        await sleep(400);
        expect(alive(pid)).toBe(false);
        expect(alive(grandchild)).toBe(false);
        fs.rmSync(pidFilePath(id), { force: true });
    });

    test('the agent is the last simple command (bash would exec and lose the marker): the process is still recognized and killed', async () => {
        const id = createRunId();
        startWrapped(id, 'sleep 63');
        const pid = await pidOf(id);
        await sleep(300);
        expect(alive(pid)).toBe(true);
        // 没有 exit $? 时 bash 会把自己换成 sleep，命令行里不再有标记，runKill 会因 4 拒绝
        expect(runKill(id, 'INT').status).toBe(0);
        await sleep(400);
        expect(alive(pid)).toBe(false);
        fs.rmSync(pidFilePath(id), { force: true });
    });

    test('forged pid file (points at an innocent process whose command line has no run marker) is refused: nothing is killed', async () => {
        const innocent = spawn('sleep', ['60'], { stdio: 'ignore' });
        children.push(innocent);
        const id = createRunId();
        fs.writeFileSync(pidFilePath(id), `${innocent.pid}\n`);
        expect(runKill(id, 'KILL').status).toBe(4);
        await sleep(200);
        expect(alive(innocent.pid)).toBe(true);
        fs.rmSync(pidFilePath(id));
    });

    test('forged pid file pointing at the process of another run (its command line carries a different run id) is refused; non-numeric, 0/1 and symlink pid files are refused too', async () => {
        const otherId = createRunId();
        startWrapped(otherId);
        const otherPid = await pidOf(otherId);
        const id = createRunId();
        fs.writeFileSync(pidFilePath(id), `${otherPid}`);
        expect(runKill(id, 'KILL').status).toBe(4);
        expect(alive(otherPid)).toBe(true);
        for (const bad of ['abc', '12; reboot', '1', '0', '-1', '']) {
            fs.writeFileSync(pidFilePath(id), bad);
            expect(runKill(id, 'KILL').status).toBe(3);
        }
        fs.rmSync(pidFilePath(id));
        fs.symlinkSync(pidFilePath(otherId), pidFilePath(id));
        expect(runKill(id, 'KILL').status).toBe(0); // 符号链接：当作没有，什么也不杀
        expect(alive(otherPid)).toBe(true);
        fs.rmSync(pidFilePath(id));
        runKill(otherId, 'KILL');
        fs.rmSync(pidFilePath(otherId), { force: true });
    });

    test('ids and signals are whitelisted', () => {
        expect(isValidRunId('x')).toBe(false);
        expect(isValidRunId('a'.repeat(65))).toBe(false);
        expect(() => buildRunKillCommand(createRunId(), 'HUP')).toThrow(/信号/);
        expect(() => buildRunKillCommand('../../etc', 'INT')).toThrow(/runId/);
    });
});

describe('buildLiveRunsCommand：列出容器里还活着的运行（serve 重启后据此决定是否自动发送排队）', () => {
    const children = [];
    afterEach(() => {
        children.splice(0).forEach(child => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* 已退出 */ } } });
    });
    const liveRuns = () => { const [cmd, ...args] = buildLiveRunsCommand(); return spawnSync(cmd, args, { encoding: 'utf8' }).stdout.split('\n').filter(Boolean); };

    test('还在跑的运行会列出；已经退出的、伪造（指向没有标记的进程）的、非法 PID 的不列', async () => {
        const id = createRunId();
        const child = spawn('/bin/bash', ['-lc', wrapAgentCommand('sleep 64; true', id)], { stdio: 'ignore', detached: true });
        children.push(child);
        for (let i = 0; i < 50 && !fs.existsSync(pidFilePath(id)); i += 1) await sleep(40);
        await sleep(200);
        const innocent = spawn('sleep', ['60'], { stdio: 'ignore' });
        children.push(innocent);
        const forged = createRunId();
        fs.writeFileSync(pidFilePath(forged), String(innocent.pid));
        const bad = createRunId();
        fs.writeFileSync(pidFilePath(bad), '12; reboot');
        const dead = createRunId();
        fs.writeFileSync(pidFilePath(dead), '999999');
        const listed = liveRuns();
        expect(listed).toContain(id);
        expect(listed).not.toContain(forged);
        expect(listed).not.toContain(bad);
        expect(listed).not.toContain(dead);
        process.kill(-child.pid, 'SIGKILL');
        await sleep(300);
        expect(liveRuns()).not.toContain(id);
        [id, forged, bad, dead].forEach(x => fs.rmSync(pidFilePath(x), { force: true }));
    });
});

describe('terminateRun 逐级升级', () => {
    function fakeRun() {
        let close;
        const closed = new Promise(resolve => { close = resolve; });
        return { runState: { runId: createRunId(), closed, process: { kill: jest.fn() } }, close };
    }

    test('the process exits after INT: only INT is sent and the client is not killed', async () => {
        const { runState, close } = fakeRun();
        const sent = [];
        await terminateRun({ runState, graceMs: 50, killInContainer: async (id, signal) => { sent.push(signal); close(); } });
        expect(sent).toEqual(['INT']);
        expect(runState.process.kill).not.toHaveBeenCalled();
    });

    test('a process that ignores INT and TERM gets KILL, and then the client is collected', async () => {
        const { runState } = fakeRun();
        const sent = [];
        const result = await terminateRun({ runState, graceMs: 20, killInContainer: async (id, signal) => { sent.push(signal); } });
        expect(sent).toEqual(['INT', 'TERM', 'KILL']);
        expect(runState.process.kill).toHaveBeenCalledWith('SIGKILL');
        expect(result).toBe('client-killed');
    });

    test('an invalid run id never reaches the container; only the client is collected', async () => {
        const { runState } = fakeRun();
        runState.runId = 'x; rm -rf /';
        const killInContainer = jest.fn();
        await terminateRun({ runState, graceMs: 20, killInContainer });
        expect(killInContainer).not.toHaveBeenCalled();
        expect(runState.process.kill).toHaveBeenCalled();
    });
});
