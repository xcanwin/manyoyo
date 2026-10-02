'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runUninstall, removeManagedBlock } = require('../lib/uninstall');

const BLOCK = [
    '# >>> manyoyo >>>',
    '# 由 MANYOYO 安装器添加；manyoyo uninstall 会移除这一段',
    'case ":$PATH:" in',
    '    *":$HOME/.manyoyo/bin:"*) ;;',
    '    *) export PATH="$HOME/.manyoyo/bin:$PATH" ;;',
    'esac',
    '# <<< manyoyo <<<'
].join('\n');

let root;
let home;
let m;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-uninstall-'));
    home = path.join(root, 'home');
    m = path.join(home, '.manyoyo');
    fs.mkdirSync(home, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedInstall({ privatePodman = true } = {}) {
    for (const dir of ['bin', 'app/9.9.9', 'serve/login-tokens', '.install', 'run/serve']) fs.mkdirSync(path.join(m, dir), { recursive: true });
    fs.writeFileSync(path.join(m, 'bin/manyoyo'), 'wrapper');
    fs.writeFileSync(path.join(m, 'app/9.9.9/.installed'), 'x');
    fs.writeFileSync(path.join(m, 'manyoyo.json'), '{ imageVersion: "1" }');
    fs.mkdirSync(path.join(m, 'web-history'), { recursive: true });
    fs.writeFileSync(path.join(m, 'web-history/a.json'), '{}');
    fs.mkdirSync(path.join(m, 'logs/run'), { recursive: true });
    fs.writeFileSync(path.join(m, 'logs/run/a.log'), 'log line');
    fs.mkdirSync(path.join(m, 'workpath'), { recursive: true });
    fs.writeFileSync(path.join(m, 'workpath/project.txt'), 'my work');
    if (privatePodman) {
        fs.mkdirSync(path.join(m, 'runtime/podman/bin'), { recursive: true });
        fs.writeFileSync(path.join(m, 'runtime/podman/bin/podman'), 'p');
        fs.mkdirSync(path.join(m, 'runtime/podman/data'), { recursive: true });
    }
    fs.writeFileSync(path.join(home, '.zprofile'), `export A=1\n\n${BLOCK}\n`);
    fs.writeFileSync(path.join(home, '.zshrc'), `alias ll='ls -l'\n\n${BLOCK}\n# user line after\n`);
}

function harness(answers = [], extra = {}) {
    const asked = [];
    const logs = [];
    const commands = [];
    const queue = [...answers];
    return {
        asked, logs, commands,
        options: {
            homeDir: home,
            ask: async question => { asked.push(question); return queue.length > 0 ? queue.shift() : ''; },
            log: line => logs.push(line),
            run: (command, args, opts) => { commands.push({ command, args, opts }); return extra.runOutput ? extra.runOutput(command, args) : ''; },
            isManyoyoServe: () => true,
            isImporter: () => true,
            kill: jest.fn(() => true),
            ...extra.options
        }
    };
}

describe('removeManagedBlock', () => {
    test('removes exactly the installer block and the blank line before it, nothing else', () => {
        const original = 'export A=1\nexport B=2\n';
        expect(removeManagedBlock(`${original}\n${BLOCK}\n`)).toEqual({ text: original, removed: 1 });
        expect(removeManagedBlock(`before\n\n${BLOCK}\nafter\n`).text).toBe('before\nafter\n');
        expect(removeManagedBlock(`${BLOCK}\n`).text).toBe('');
    });

    test('leaves lines that merely mention manyoyo, unmatched markers and other users\' blocks alone', () => {
        const text = '# my notes about manyoyo\nexport MANYOYO_X=1\n# >>> other >>>\nfoo\n# <<< other <<<\n# >>> manyoyo >>>\nno end marker\n';
        expect(removeManagedBlock(text)).toEqual({ text, removed: 0 });
    });

    test('removes every copy of the block', () => {
        expect(removeManagedBlock(`a\n\n${BLOCK}\nb\n\n${BLOCK}\n`)).toEqual({ text: 'a\nb\n', removed: 2 });
    });

    test('is an exact inverse of what the installer writes (round trip through the real installer function)', () => {
        const script = fs.readFileSync(path.join(__dirname, '../scripts/offline/install.sh'), 'utf8');
        const fn = script.slice(script.indexOf('add_path_block() {'), script.indexOf('setup_path() {'));
        for (const original of ['export A=1\n', 'export A=1', '', 'line1\n\nline2\n']) {
            const file = path.join(root, `rc-${Buffer.from(original).toString('hex') || 'empty'}`);
            fs.writeFileSync(file, original);
            const r = spawnSync('sh', ['-c', `${fn}\nadd_path_block "${file}"`], { encoding: 'utf-8' });
            expect(r.status).toBe(0);
            const installed = fs.readFileSync(file, 'utf8');
            expect(installed).toContain('# >>> manyoyo >>>');
            const restored = removeManagedBlock(installed).text;
            // 原文件没有结尾换行时，安装器会先补一个换行；其余必须逐字节还原
            expect(restored).toBe(original === '' || original.endsWith('\n') ? original : `${original}\n`);
        }
    });
});

describe('runUninstall', () => {
    test('asks for confirmation first and changes nothing when declined', async () => {
        seedInstall();
        const h = harness(['n']);
        const summary = await runUninstall(h.options);
        expect(summary.aborted).toBe(true);
        expect(h.asked).toHaveLength(1);
        expect(fs.existsSync(path.join(m, 'app/9.9.9'))).toBe(true);
        expect(fs.readFileSync(path.join(home, '.zprofile'), 'utf8')).toContain('# >>> manyoyo >>>');
        expect(h.commands).toEqual([]);
    });

    test('default answers remove the program but keep config, history, logs and workpath', async () => {
        seedInstall();
        const h = harness(['y', '', '']);
        const summary = await runUninstall(h.options);

        for (const dir of ['bin', 'app', 'runtime', '.install', 'serve']) expect(fs.existsSync(path.join(m, dir))).toBe(false);
        for (const keep of ['manyoyo.json', 'web-history/a.json', 'logs', 'workpath/project.txt']) expect(fs.existsSync(path.join(m, keep))).toBe(true);
        expect(summary.kept).toEqual(expect.arrayContaining(['~/.manyoyo/manyoyo.json', '~/.manyoyo/workpath']));
        expect(fs.readFileSync(path.join(home, '.zprofile'), 'utf8')).toBe('export A=1\n');
        expect(fs.readFileSync(path.join(home, '.zshrc'), 'utf8')).toBe("alias ll='ls -l'\n# user line after\n");
        // 第二个问题是 workpath，措辞要点明“默认保留”
        expect(h.asked[2]).toContain('workpath');
        expect(h.asked[2]).toContain('默认保留');
    });

    test('stops the private machine with the isolated Podman environment, and the matching processes', async () => {
        seedInstall();
        fs.writeFileSync(path.join(m, 'serve/app.json'), JSON.stringify({ host: '127.0.0.1', port: 1, pid: 4242 }));
        fs.writeFileSync(path.join(m, 'run/serve/127.0.0.1_3000.pid'), '4343\n');
        fs.mkdirSync(path.join(m, 'runtime/import'), { recursive: true });
        fs.writeFileSync(path.join(m, 'runtime/import/loading.json'), '{"pid": 4444}');
        const h = harness(['y', '', '']);
        await runUninstall(h.options);

        const stop = h.commands.find(c => c.args[0] === 'machine' && c.args[1] === 'stop');
        expect(stop.command).toBe(path.join(m, 'runtime/podman/bin/podman'));
        expect(stop.args[2]).toBe('podman-machine-manyoyo');
        expect(stop.opts.env.XDG_DATA_HOME).toBe(path.join(m, 'runtime/podman/data'));
        expect(stop.opts.env.CONTAINERS_CONF).toBe(path.join(m, 'runtime/podman/containers.conf'));
        expect(h.options.kill.mock.calls.map(c => c[0]).sort()).toEqual([4242, 4343, 4444]);
    });

    test('never kills a pid that is not a manyoyo serve process (pid reuse)', async () => {
        seedInstall({ privatePodman: false });
        fs.writeFileSync(path.join(m, 'serve/app.json'), JSON.stringify({ host: '127.0.0.1', port: 1, pid: 4242 }));
        const h = harness(['y', '', ''], { options: { isManyoyoServe: () => false } });
        await runUninstall(h.options);
        expect(h.options.kill).not.toHaveBeenCalled();
    });

    test('never kills a recorded import pid that is not the import script (pid reuse)', async () => {
        seedInstall();
        fs.mkdirSync(path.join(m, 'runtime/import'), { recursive: true });
        fs.writeFileSync(path.join(m, 'runtime/import/loading.json'), '{"pid": 4444}');
        const h = harness(['y', '', ''], { options: { isImporter: () => false } });
        await runUninstall(h.options);
        expect(h.options.kill).not.toHaveBeenCalled();
    });

    test('--yes still warns that private Podman contents go away', async () => {
        seedInstall();
        const h = harness([], { options: { yes: true } });
        await runUninstall(h.options);
        expect(h.logs.join('\n')).toContain('私有 Podman 里的容器与镜像会随虚拟机一起删除');
    });

    test('Linux install (no private Podman): bash/profile PATH blocks are removed, user lines stay, and only manyoyo containers/images in the external runtime are asked about', async () => {
        seedInstall({ privatePodman: false });
        fs.writeFileSync(path.join(home, '.profile'), `export KEEP=1\n\n${BLOCK}\n`);
        fs.writeFileSync(path.join(home, '.bashrc'), `alias g=git\n\n${BLOCK}\n`);
        const h = harness(['y', 'n', 'n', 'n'], {
            runOutput: (command, args) => (args[0] === 'ps' ? 'my-claude\n' : args[0] === 'images' ? 'ghcr.io/xcanwin/manyoyo:2.0.0-common\nalpine:latest\n' : ''),
            options: { selectExternalRuntime: () => ({ command: 'podman', env: {} }) }
        });
        await runUninstall(h.options);
        expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toBe('export KEEP=1\n');
        expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8')).toBe('alias g=git\n');
        expect(h.asked[1]).toContain('删除这些容器与镜像');
        // 回答了 n：既没删容器也没删镜像，更不会动运行时本身
        expect(h.commands.filter(c => ['rm', 'rmi', 'machine'].includes(c.args[0]))).toEqual([]);
    });

    test('a failing machine stop does not abort the uninstall', async () => {
        seedInstall();
        const h = harness(['y', '', ''], { options: { run: () => { throw new Error('machine not found\nmore'); } } });
        await runUninstall(h.options);
        expect(fs.existsSync(path.join(m, 'runtime'))).toBe(false);
        expect(h.logs.join('\n')).toContain('停止虚拟机时出错');
    });

    test('answering yes deletes config/history/logs, and workpath only on its own explicit yes', async () => {
        seedInstall();
        const first = harness(['y', 'y', 'n']);
        await runUninstall(first.options);
        for (const gone of ['manyoyo.json', 'web-history', 'logs']) expect(fs.existsSync(path.join(m, gone))).toBe(false);
        expect(fs.readFileSync(path.join(m, 'workpath/project.txt'), 'utf8')).toBe('my work');

        seedInstall();
        await runUninstall(harness(['y', 'n', 'yes']).options);
        expect(fs.existsSync(path.join(m, 'workpath'))).toBe(false);
        expect(fs.existsSync(path.join(m, 'manyoyo.json'))).toBe(true);
    });

    test('--yes confirms the uninstall itself without prompts and never deletes user data', async () => {
        seedInstall();
        const h = harness([], {});
        h.options.yes = true;
        const summary = await runUninstall(h.options);
        expect(h.asked).toEqual([]);
        expect(fs.existsSync(path.join(m, 'app'))).toBe(false);
        for (const keep of ['manyoyo.json', 'web-history', 'logs', 'workpath/project.txt']) expect(fs.existsSync(path.join(m, keep))).toBe(true);
        expect(summary.kept.length).toBeGreaterThan(0);
        expect(h.logs.join('\n')).toContain('没有删除任何用户数据');
    });

    test('answering yes to everything leaves no empty directories behind (not even run/serve)', async () => {
        seedInstall();
        fs.mkdirSync(path.join(m, 'logs/serve'), { recursive: true });
        await runUninstall(harness(['y', 'y', 'y']).options);
        expect(fs.existsSync(m)).toBe(false);
    });

    test('empty leftover sub-directories of kept data are pruned, files and symlinks are never touched', async () => {
        seedInstall({ privatePodman: false });
        fs.mkdirSync(path.join(m, 'logs/empty/deeper'), { recursive: true });
        const elsewhere = path.join(root, 'elsewhere');
        fs.mkdirSync(elsewhere);
        fs.symlinkSync(elsewhere, path.join(m, 'logs/link'));
        await runUninstall(harness(['y', 'n', 'n']).options);
        expect(fs.existsSync(path.join(m, 'logs/empty'))).toBe(false);
        expect(fs.readFileSync(path.join(m, 'logs/run/a.log'), 'utf8')).toBe('log line');
        expect(fs.lstatSync(path.join(m, 'logs/link')).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(elsewhere)).toBe(true);
        expect(fs.readFileSync(path.join(m, 'workpath/project.txt'), 'utf8')).toBe('my work');
    });

    test('with nothing kept the empty ~/.manyoyo directory is removed too', async () => {
        for (const dir of ['bin', 'app/1']) fs.mkdirSync(path.join(m, dir), { recursive: true });
        await runUninstall(harness(['y']).options);
        expect(fs.existsSync(m)).toBe(false);
    });

    test('reports and exits quietly when there is no installation', async () => {
        const h = harness();
        const summary = await runUninstall(h.options);
        expect(summary.aborted).toBe(true);
        expect(h.logs.join('\n')).toContain('无需卸载');
    });

    test('a symlinked workpath only loses the link, never the files it points to', async () => {
        seedInstall();
        fs.rmSync(path.join(m, 'workpath'), { recursive: true });
        const elsewhere = path.join(root, 'my-projects');
        fs.mkdirSync(elsewhere);
        fs.writeFileSync(path.join(elsewhere, 'precious.txt'), 'keep');
        fs.symlinkSync(elsewhere, path.join(m, 'workpath'));
        await runUninstall(harness(['y', 'n', 'y']).options);
        expect(fs.existsSync(path.join(m, 'workpath'))).toBe(false);
        expect(fs.readFileSync(path.join(elsewhere, 'precious.txt'), 'utf8')).toBe('keep');
    });

    describe('reused external runtime (no private Podman)', () => {
        const runOutput = (command, args) => {
            if (args[0] === 'ps') return 'my-claude-1\nmy-codex-2\n';
            if (args[0] === 'images') return 'ghcr.io/xcanwin/manyoyo:1.9.2-common\nlocalhost/xcanwin/manyoyo:1.0.0\nalpine:latest\nghcr.io/xcanwin/manyoyo-playwright:1\n';
            return '';
        };
        const external = { command: 'docker', env: {} };

        test('only manyoyo containers and images are listed, and removed only after an explicit yes', async () => {
            seedInstall({ privatePodman: false });
            const h = harness(['y', 'y', '', ''], { runOutput, options: { selectExternalRuntime: () => external } });
            const summary = await runUninstall(h.options);
            expect(h.commands.find(c => c.args[0] === 'ps').args).toEqual(['ps', '-a', '--filter', 'label=manyoyo.default_cmd', '--format', '{{.Names}}']);
            expect(h.commands.filter(c => c.args[0] === 'rm').map(c => c.args[2])).toEqual(['my-claude-1', 'my-codex-2']);
            expect(h.commands.filter(c => c.args[0] === 'rmi').map(c => c.args[1])).toEqual(['ghcr.io/xcanwin/manyoyo:1.9.2-common', 'localhost/xcanwin/manyoyo:1.0.0']);
            expect(summary.externalRemoved.images).not.toContain('alpine:latest');
            expect(summary.externalRemoved.images).not.toContain('ghcr.io/xcanwin/manyoyo-playwright:1');
            expect(h.commands.some(c => c.args.includes('machine'))).toBe(false); // 不动用户自己的运行时
        });

        test('declining (or --yes) leaves the external containers and images alone', async () => {
            seedInstall({ privatePodman: false });
            const declined = harness(['y', 'n', '', ''], { runOutput, options: { selectExternalRuntime: () => external } });
            await runUninstall(declined.options);
            expect(declined.commands.some(c => c.args[0] === 'rm' || c.args[0] === 'rmi')).toBe(false);

            seedInstall({ privatePodman: false });
            const auto = harness([], { runOutput, options: { selectExternalRuntime: () => external } });
            auto.options.yes = true;
            await runUninstall(auto.options);
            expect(auto.commands.some(c => c.args[0] === 'rm' || c.args[0] === 'rmi')).toBe(false);
        });

        test('with a private Podman the external runtime is not even queried', async () => {
            seedInstall({ privatePodman: true });
            const selectExternalRuntime = jest.fn(() => external);
            await runUninstall(harness(['y', '', ''], { options: { selectExternalRuntime } }).options);
            expect(selectExternalRuntime).not.toHaveBeenCalled();
        });
    });
});

describe('manyoyo uninstall (CLI wiring)', () => {
    test('is registered, documented in --help, and needs no container runtime', () => {
        const bin = path.join(__dirname, '../bin/manyoyo.js');
        const help = spawnSync('node', [bin, 'uninstall', '--help'], { encoding: 'utf-8' });
        expect(help.status).toBe(0);
        expect(help.stdout).toContain('--yes');
        expect(help.stdout).toContain('不会删');
    });

    test('--yes against an empty HOME exits 0 and touches nothing', () => {
        const bin = path.join(__dirname, '../bin/manyoyo.js');
        const result = spawnSync('node', [bin, 'uninstall', '--yes'], { encoding: 'utf-8', env: { ...process.env, HOME: home } });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('无需卸载');
    });
});
