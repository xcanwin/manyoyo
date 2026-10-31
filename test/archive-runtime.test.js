'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCliRuntime } = require('../lib/archive/runtime');

function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return false; }
}

describe('lib/archive/runtime（全部异步 + 超时）', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-rt-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    function fakeRuntime(script) {
        const fake = path.join(dir, 'fake-rt');
        fs.writeFileSync(fake, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
        return fake;
    }

    test('运行时子进程继承本进程环境；额外变量叠加其上（env 为 {} 或只有几个变量时不能丢 PATH / HOME）', async () => {
        const fake = fakeRuntime('printf "A /%s|%s|%s\\n" "$HOME" "${EXTRA_X:-}" "$PATH"');
        for (const extra of [{}, undefined, { EXTRA_X: 'x' }]) {
            const lines = [];
            await createCliRuntime({ command: fake, env: extra }).diff('c', { onEntry: (kind, p) => lines.push(p) });
            const [home, x, pathValue] = lines[0].slice(1).split('|');
            expect(home).toBe(process.env.HOME);
            expect(pathValue).toBe(process.env.PATH);
            expect(x).toBe(extra && extra.EXTRA_X ? 'x' : '');
        }
    });

    test('inspect 超时：子进程被强杀、抛 ETIMEDOUT，等待期间事件循环不被占住', async () => {
        const pidFile = path.join(dir, 'pid');
        const fake = fakeRuntime(`echo $$ > ${pidFile}\nexec sleep 30`);
        const runtime = createCliRuntime({ command: fake, shortTimeoutMs: 300 });
        let ticks = 0;
        const timer = setInterval(() => { ticks += 1; }, 20);
        const started = Date.now();
        await expect(runtime.inspect('c')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
        clearInterval(timer);
        expect(Date.now() - started).toBeLessThan(3000);
        expect(ticks).toBeGreaterThan(5);
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(pidAlive(pid)).toBe(false);
    });

    test('pause / unpause / canRead 同样有超时', async () => {
        const fake = fakeRuntime('exec sleep 30');
        const runtime = createCliRuntime({ command: fake, shortTimeoutMs: 200 });
        await expect(runtime.pause('c')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
        await expect(runtime.unpause('c')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
        await expect(runtime.canRead('c')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    });

    test('inspect：容器不存在返回 null；存在时给出状态与挂载点', async () => {
        const json = JSON.stringify({ Config: { Image: 'img:1', Labels: { 'manyoyo.id': 'abc' } }, State: { Running: true, Paused: false }, Mounts: [{ Destination: '/work' }] });
        const ok = createCliRuntime({ command: fakeRuntime(`echo '${json}'`) });
        expect(await ok.inspect('c')).toMatchObject({ id: 'abc', image: 'img:1', status: 'running', mounts: ['/work'] });
        const missing = createCliRuntime({ command: fakeRuntime('echo "no such" >&2; exit 1') });
        expect(await missing.inspect('c')).toBeNull();
    });

    test('diff：逐行回调、不设固定超时；signal 取消时强杀子进程', async () => {
        const pidFile = path.join(dir, 'pid');
        const fake = fakeRuntime(`echo $$ > ${pidFile}\necho "A /a"\necho "C /b"\necho "D /c"\nexec sleep 30`);
        const runtime = createCliRuntime({ command: fake, shortTimeoutMs: 100 });
        const seen = [];
        const controller = new AbortController();
        const promise = runtime.diff('c', { onEntry: (kind, p) => { seen.push(`${kind} ${p}`); }, signal: controller.signal });
        await new Promise(resolve => setTimeout(resolve, 500)); // 超过 shortTimeoutMs 也不能被当成超时
        expect(seen).toEqual(['A /a', 'C /b', 'D /c']);
        controller.abort();
        await expect(promise).rejects.toMatchObject({ name: 'RuntimeAbortError' });
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(pidAlive(pid)).toBe(false);
    });

    test('diff：命令失败时带上 stderr', async () => {
        const runtime = createCliRuntime({ command: fakeRuntime('echo boom >&2; exit 3') });
        await expect(runtime.diff('c', {})).rejects.toThrow(/boom/);
    });
});
