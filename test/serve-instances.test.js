'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    listServeInstances, formatServeTable, findOutdatedInstances, restartCommand, maskSecretArgs, parseServeCommand, inspectScript
} = require('../lib/serve-instances');

let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-serves-')); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function pidFile(name, pid) {
    const dir = path.join(home, '.manyoyo', 'run', 'serve');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), `${pid}\n`);
}
function installAt(rel, version) {
    const bin = path.join(home, rel, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(home, rel, 'package.json'), JSON.stringify({ version }));
    fs.writeFileSync(path.join(bin, 'manyoyo.js'), '');
    return path.join(bin, 'manyoyo.js');
}

describe('masking and parsing', () => {
    test('passwords never survive: -P, --pass and --pass=', () => {
        expect(maskSecretArgs(['0.0.0.0:3000', '-U', 'admin', '-P', 'sekret'])).toEqual(['0.0.0.0:3000', '-U', 'admin', '-P', '******']);
        expect(maskSecretArgs(['--pass', 'x', '--pass=y', '-P'])).toEqual(['--pass', '******', '--pass=******', '-P']);
    });

    test('other credentials are masked too: glued -Psecret, -e KEY=value, --env=TOKEN=value (harmless env stays)', () => {
        expect(maskSecretArgs(['-Psecret123', '-e', 'ANTHROPIC_API_KEY=sk-abc', '--env=MY_TOKEN=t', '-e', 'DEBUG=1'])).toEqual(['-P', '******', '-e', 'ANTHROPIC_API_KEY=******', '--env=MY_TOKEN=******', '-e', 'DEBUG=1']);
    });

    test('parses the listen address, falls back to the default and ignores non-serve commands', () => {
        expect(parseServeCommand('node /a/bin/manyoyo.js serve 0.0.0.0:3000 -U admin')).toMatchObject({ script: '/a/bin/manyoyo.js', listen: '0.0.0.0:3000', args: ['0.0.0.0:3000', '-U', 'admin'] });
        expect(parseServeCommand('node /a/bin/manyoyo.js serve -U admin').listen).toBe(''); // 没写：由 pid 文件名决定
        expect(parseServeCommand('node /a/x.js run -n a')).toBeNull();
        expect(parseServeCommand('')).toBeNull();
    });

    test('infers version and source from where the script lives', () => {
        const npmScript = installAt('lib/node_modules/@xcanwin/manyoyo', '7.1.6');
        expect(inspectScript(npmScript)).toEqual({ version: '7.1.6', source: 'npm' });
        const offlineScript = installAt('.manyoyo/app/8.2.0/manyoyo', '8.2.0');
        expect(inspectScript(offlineScript)).toEqual({ version: '8.2.0', source: 'offline' });
        expect(inspectScript(path.join(home, 'nowhere', 'bin', 'manyoyo.js'))).toEqual({ version: '', source: 'unknown' });
    });
});

describe('listServeInstances', () => {
    test('lists only running instances, with version, source and a masked command', () => {
        const npmScript = installAt('lib/node_modules/@xcanwin/manyoyo', '7.1.6');
        pidFile('0.0.0.0_3000.pid', 111);
        pidFile('127.0.0.1_9999.pid', 222); // 已退出
        pidFile('bad.pid', 'x');
        const instances = listServeInstances({
            homeDir: home,
            isRunning: pid => pid === 111,
            readArgs: () => `node ${npmScript} serve 0.0.0.0:3000 -U admin -P sekret`
        });
        expect(instances).toHaveLength(1);
        expect(instances[0]).toMatchObject({ pid: 111, listen: '0.0.0.0:3000', version: '7.1.6', source: 'npm', command: 'my serve 0.0.0.0:3000 -U admin -P ******' });
        expect(JSON.stringify(instances)).not.toContain('sekret');
    });

    test('a stale pid file whose pid now belongs to an unrelated process is not listed', () => {
        pidFile('0.0.0.0_3000.pid', 77);
        const instances = listServeInstances({ homeDir: home, isRunning: () => true, readArgs: () => '/usr/sbin/sshd -D' });
        expect(instances).toEqual([]);
    });

    test('a launcher serve without an explicit listen still restarts with the real address; token-array command lines keep paths with spaces', () => {
        const script = installAt('with space/.manyoyo/app/8.2.0/manyoyo', '8.2.0');
        pidFile('127.0.0.1_3000.pid', 5);
        const [item] = listServeInstances({ homeDir: home, isRunning: () => true, readArgs: () => ['node', script, 'serve', '-d'] });
        expect(item).toMatchObject({ listen: '127.0.0.1:3000', version: '8.2.0', source: 'offline' });
        expect(restartCommand(item)).toBe('my serve 127.0.0.1:3000 -d --restart');
    });

    test('no pid directory means no instances; an unreadable command line is not trusted as a serve; the listen can come from the pid file name', () => {
        expect(listServeInstances({ homeDir: home })).toEqual([]);
        pidFile('127.0.0.1_3000.pid', 5);
        expect(listServeInstances({ homeDir: home, isRunning: () => true, readArgs: () => '' })).toEqual([]);
        pidFile('0.0.0.0_4000.pid', 6);
        const found = listServeInstances({ homeDir: home, isRunning: () => true, readArgs: () => 'node /a/bin/manyoyo.js serve -U admin' });
        expect(found.map(entry => entry.listen).sort()).toEqual(['0.0.0.0:4000', '127.0.0.1:3000']);
    });
});

describe('table, outdated detection and restart command', () => {
    const items = [
        { pid: 111, listen: '0.0.0.0:3000', version: '7.1.6', source: 'npm', args: ['0.0.0.0:3000', '-U', 'admin', '-P', '******'], command: 'my serve 0.0.0.0:3000 -U admin -P ******' },
        { pid: 222, listen: '127.0.0.1:35817', version: '8.2.0', source: 'offline', args: ['127.0.0.1:35817'], command: 'my serve 127.0.0.1:35817' }
    ];

    test('table has the four columns and an empty message', () => {
        const text = formatServeTable(items);
        expect(text.split('\n')[0]).toMatch(/^监听地址\s+PID\s+版本\s+启动命令$/);
        // 按显示宽度对齐：“监听地址”4 个汉字占 8 列，列宽取最长的 127.0.0.1:35817（15 列）+ 2 列间隔，所以 PID 数据在第 17 列，表头 PID 前是 4 个汉字 + 9 个空格
        const lines = text.split('\n');
        expect(lines[0].indexOf('PID')).toBe(13);
        expect(lines[1].indexOf('111')).toBe(17);
        expect(text).toContain('0.0.0.0:3000');
        expect(text).toContain('7.1.6');
        expect(text).toContain('my serve 0.0.0.0:3000 -U admin -P ******');
        expect(formatServeTable([])).toBe('没有正在运行的 serve。');
    });

    test('outdated = anything not on the current version (unknown counts)', () => {
        expect(findOutdatedInstances(items, '8.2.0').map(item => item.pid)).toEqual([111]);
        expect(findOutdatedInstances([{ ...items[1], version: '' }], '8.2.0')).toHaveLength(1);
    });

    test('restart command keeps the original arguments and adds -d --restart exactly once', () => {
        expect(restartCommand(items[0])).toBe('my serve 0.0.0.0:3000 -U admin -P ****** -d --restart');
        expect(restartCommand({ ...items[0], args: [...items[0].args, '-d'] })).toBe('my serve 0.0.0.0:3000 -U admin -P ****** -d --restart');
    });
});
