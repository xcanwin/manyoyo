const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');
const { startWebServer } = require('../lib/web/server');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(err => (err ? reject(err) : resolve(port)));
        });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Web terminal resize', () => {
    let tempHost;
    let handle;
    let logFile;
    let ws;

    async function setup() {
        tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-web-term-'));
        logFile = path.join(tempHost, 'exec.log');
        const fake = path.join(tempHost, 'fake-docker.js');
        fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('manyoyo-resize')) {
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args.slice(args.indexOf('manyoyo-resize'))) + '\\n');
  const failFile = ${JSON.stringify(logFile + '.fail')};
  if (fs.existsSync(failFile)) {
    const left = Number(fs.readFileSync(failFile, 'utf-8'));
    if (left > 0) { fs.writeFileSync(failFile, String(left - 1)); process.exit(3); }
  }
  process.exit(0);
}
if (args[0] === 'exec') { fs.appendFileSync(${JSON.stringify(logFile)}, 'BOOT ' + JSON.stringify(args) + '\\n'); setInterval(() => {}, 1000); }
else { process.exit(0); }
`, { mode: 0o755 });
        const port = await getFreePort();
        handle = await startWebServer({
            serverHost: '127.0.0.1', serverPort: port, authUser: 'webadmin', authPass: 'topsecret', authPassAuto: false,
            dockerCmd: fake,
            networkManager: { ensureBridgeNetwork: async () => {}, resolveRefs: async p => p, apply: async () => ({}), ensureReady: async () => ({}) },
            hostPath: tempHost, homeDir: tempHost, containerPath: '/workspace', imageName: 'x/y', imageVersion: '1.0.0-common',
            execCommandPrefix: '', execCommand: '', execCommandSuffix: '', contModeArgs: [], containerEnvs: [], containerVolumes: [],
            validateHostPath: () => {}, formatDate: () => '0101-0000',
            isValidContainerName: v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v),
            containerExists: () => true, getContainerStatus: () => 'running', waitForContainerReady: async () => {},
            dockerExecArgs: () => '', showImagePullHint: () => {}, removeContainer: () => {},
            webHistoryDir: path.join(tempHost, 'web-history'), webConfigPath: path.join(tempHost, 'manyoyo.json'),
            colors: { GREEN: '', CYAN: '', YELLOW: '', NC: '' }
        });
        const base = `http://127.0.0.1:${handle.port || port}`;
        const login = await fetch(`${base}/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'webadmin', password: 'topsecret' })
        });
        const cookie = login.headers.get('set-cookie').split(';')[0];
        ws = new WebSocket(`ws://127.0.0.1:${handle.port || port}/api/sessions/demo/terminal/ws?cols=100&rows=30`, { headers: { Cookie: cookie } });
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        await sleep(100);
    }

    const resizeCalls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '')
        .split('\n').filter(line => line.startsWith('[')).map(line => JSON.parse(line));

    afterEach(async () => {
        if (ws) ws.terminate();
        if (handle) await handle.close();
        fs.rmSync(tempHost, { recursive: true, force: true });
        ws = null;
        handle = null;
    });

    test('合法 resize 会在容器里执行一次固定脚本，参数是终端 id、列、行', async () => {
        await setup();
        ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 24 }));
        await sleep(400);
        const calls = resizeCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('manyoyo-resize');
        expect(calls[0][1]).toMatch(/^[0-9a-f]{16}$/);
        expect(calls[0].slice(2)).toEqual(['90', '24']);
        const boot = fs.readFileSync(logFile, 'utf-8').split('\n').find(line => line.startsWith('BOOT '));
        expect(boot).toContain(`MANYOYO_TERM_ID=`);
    });

    test('exec 失败（tty 文件还没写好）时会自动重试，不会一直停在旧尺寸', async () => {
        await setup();
        fs.writeFileSync(`${logFile}.fail`, '2');
        ws.send(JSON.stringify({ type: 'resize', cols: 88, rows: 30 }));
        await sleep(1500);
        const calls = resizeCalls();
        expect(calls).toHaveLength(3);
        expect(calls.every(call => call[2] === '88' && call[3] === '30')).toBe(true);
    });

    test('窄屏的小尺寸（小于建连下限）也会同步', async () => {
        await setup();
        ws.send(JSON.stringify({ type: 'resize', cols: 35, rows: 20 }));
        await sleep(400);
        expect(resizeCalls().map(call => call.slice(2))).toEqual([['35', '20']]);
    });

    test.each([
        [{ cols: '90', rows: 24 }],
        [{ cols: 90.5, rows: 24 }],
        [{ cols: 9, rows: 24 }],
        [{ cols: 90, rows: 3 }],
        [{ cols: 501, rows: 24 }],
        [{ cols: 90, rows: 201 }],
        [{ cols: -3, rows: 24 }],
        [{ cols: null, rows: undefined }],
        [{ cols: '90; rm -rf /', rows: 24 }]
    ])('非法或超范围的 resize %j 被忽略', async size => {
        await setup();
        ws.send(JSON.stringify({ type: 'resize', ...size }));
        await sleep(300);
        expect(resizeCalls()).toHaveLength(0);
    });

    test('连续大量 resize 被节流并合并，最终尺寸是最后一个，相同尺寸不重复执行', async () => {
        await setup();
        for (let cols = 60; cols < 100; cols++) {
            ws.send(JSON.stringify({ type: 'resize', cols, rows: 24 }));
        }
        await sleep(900);
        const calls = resizeCalls();
        expect(calls.length).toBeLessThan(10);
        expect(calls[calls.length - 1].slice(2)).toEqual(['99', '24']);
        ws.send(JSON.stringify({ type: 'resize', cols: 99, rows: 24 }));
        await sleep(300);
        expect(resizeCalls()).toHaveLength(calls.length);
    });
});

describe('terminal resize script', () => {
    // 脚本里的校验逻辑用真实 shell 验证：tty 文件被伪造时必须拒绝
    const scriptSource = fs.readFileSync(path.join(__dirname, '../lib/web/server.js'), 'utf-8');
    const match = scriptSource.match(/const TERMINAL_RESIZE_SCRIPT = \[([\s\S]*?)\]\.join\('\\n'\);/);
    const script = match ? eval(`[${match[1]}].join('\\n')`) : '';
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-resize-script-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    function runScript(id, fileContent, prepare) {
        // 把 /tmp/manyoyo-term-<id>.tty 换成临时目录里的路径，stty 换成只打印参数的替身
        const ttyFile = path.join(dir, `manyoyo-term-${id}.tty`);
        if (prepare) prepare(ttyFile);
        else if (fileContent !== null) fs.writeFileSync(ttyFile, fileContent);
        const patched = script.replace('/tmp/manyoyo-term-', `${dir}/manyoyo-term-`).replace('exec stty -F "$t"', 'echo STTY "$t"');
        try {
            const out = execFileSync('/bin/bash', ['-c', patched, 'x', id, '90', '24'], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
            return { code: 0, out };
        } catch (error) {
            return { code: error.status, out: '' };
        }
    }

    test('脚本能从源码里取到', () => {
        expect(script).toContain('stty -F');
    });

    test('合法的 /dev/pts/N 才会执行', () => {
        expect(runScript('aaaa', '/dev/pts/7\n').out).toContain('STTY /dev/pts/7');
    });

    test.each([
        ['/etc/passwd\n'],
        ['/dev/pts/7; rm -rf /\n'],
        ['/dev/pts/../../etc/shadow\n'],
        ['/dev/pts/\n'],
        ['not a tty\n'],
        ['']
    ])('被伪造的 tty 内容 %j 被拒绝', content => {
        const result = runScript('bbbb', content);
        expect(result.code).not.toBe(0);
        expect(result.out).not.toContain('STTY');
    });

    test('符号链接和不存在的文件被拒绝', () => {
        const target = path.join(dir, 'real.txt');
        fs.writeFileSync(target, '/dev/pts/7\n');
        const link = runScript('cccc', null, ttyFile => fs.symlinkSync(target, ttyFile));
        expect(link.code).not.toBe(0);
        expect(runScript('dddd', null).code).not.toBe(0);
    });

    test('FIFO 不会卡住脚本（-f 判断为非普通文件）', () => {
        const result = runScript('eeee', null, ttyFile => execFileSync('mkfifo', [ttyFile]));
        expect(result.code).not.toBe(0);
    });

    test('列行里夹带非数字被拒绝', () => {
        const ttyFile = path.join(dir, 'manyoyo-term-ffff.tty');
        fs.writeFileSync(ttyFile, '/dev/pts/7\n');
        const patched = script.replace('/tmp/manyoyo-term-', `${dir}/manyoyo-term-`).replace('exec stty -F "$t"', 'echo STTY "$t"');
        let code = 0;
        try {
            execFileSync('/bin/bash', ['-c', patched, 'x', 'ffff', '90;ls', '24'], { stdio: 'ignore', timeout: 5000 });
        } catch (error) { code = error.status; }
        expect(code).not.toBe(0);
    });
});
