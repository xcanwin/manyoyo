'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'manyoyo.js');
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('manyoyo serve --stop 不带 listen：停掉本机所有 serve 实例', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-stopall-'));
    const env = { ...process.env, HOME: home };
    const children = [];
    try {
        for (let i = 0; i < 2; i++) {
            const port = await freePort();
            children.push(spawn(process.execPath, [BIN, 'serve', `127.0.0.1:${port}`, '-U', 'u', '-P', 'p'], { env, stdio: 'ignore' }));
        }
        const dir = path.join(home, '.manyoyo', 'run', 'serve');
        for (let i = 0; i < 80 && !(fs.existsSync(dir) && fs.readdirSync(dir).length === 2); i++) await sleep(250);
        expect(fs.readdirSync(dir)).toHaveLength(2);
        const res = spawnSync(process.execPath, [BIN, 'serve', '--stop'], { env, encoding: 'utf8' });
        expect(res.stdout).toContain('已停止 serve');
        await sleep(500);
        expect(children.some(c => alive(c.pid))).toBe(false);
        const again = spawnSync(process.execPath, [BIN, 'serve', '--stop'], { env, encoding: 'utf8' });
        expect(again.stdout).toContain('没有运行中的 serve 实例');
    } finally {
        children.forEach(c => { try { c.kill('SIGKILL'); } catch (e) { /* ignore */ } });
        fs.rmSync(home, { recursive: true, force: true });
    }
}, 60000);
