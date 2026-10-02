'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { renderInstallEnv } = require('../scripts/offline/install-env');

const SCRIPTS = path.join(__dirname, '../scripts/offline');
const IMAGE_SHA = 'b'.repeat(64);

// 隔离 PATH：系统命令的符号链接，但不含真实的 docker / podman（否则会被安装器当成“已有运行时”）
let safeBin;
beforeAll(() => {
    safeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-safebin-'));
    for (const dir of ['/usr/bin', '/bin']) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            if (/^(docker|podman)/.test(name) || fs.existsSync(path.join(safeBin, name))) continue;
            try { fs.symlinkSync(path.join(dir, name), path.join(safeBin, name)); } catch (error) { /* 同名已存在 */ }
        }
    }
});
afterAll(() => fs.rmSync(safeBin, { recursive: true, force: true }));

let root;
let home;
let fakeBin;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-installer-'));
    home = path.join(root, 'home');
    fakeBin = path.join(root, 'fakebin');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const script = (file, body) => fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

// 替身 podman：用状态目录模拟 machine / 镜像，并记录每次调用和关键环境变量
function writeFakePodman(file) {
    script(file, `
state="\${FAKE_STATE:?}"
echo "podman $* [CONTAINERS_CONF=$CONTAINERS_CONF XDG_DATA_HOME=$XDG_DATA_HOME]" >> "$state/calls.log"
case "$1 $2" in
  "machine init")
    [ -n "\${FAKE_FAIL_INIT:-}" ] && { [ -n "\${FAKE_PARTIAL:-}" ] && : > "$state/machine"; echo "init boom" >&2; exit 1; }
    : > "$state/machine" ;;
  "machine inspect") [ -n "\${FAKE_INSPECT_FAILS:-}" ] && exit 125; [ -f "$state/machine" ] || exit 125 ;;
  "machine start")
    [ -n "\${FAKE_FAIL_START:-}" ] && { echo "krunkit abort" >&2; exit 1; }
    : > "$state/running" ;;
  "machine rm") rm -f "$state/machine" "$state/running" ;;
  "machine list") [ -f "$state/machine" ] && echo "podman-machine-manyoyo*"; [ -n "\${FAKE_LIST_ONLY:-}" ] && echo "podman-machine-manyoyo*"; exit 0 ;;
  "load -i") echo "$3" >> "$state/loaded" ;;
esac
[ "$1" = info ] && { [ -f "$state/running" ] || exit 125; }
exit 0
`);
}

function writePayload(dir, { kind = 'full', arch = 'arm64', version = '9.9.9', manifestExtra = '', platform = 'macos' } = {}) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'install'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'app/node/bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'app/manyoyo/bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'app/manyoyo/lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    for (const name of ['install.sh', 'finish-import.sh']) fs.copyFileSync(path.join(SCRIPTS, name), path.join(dir, 'install', name));
    fs.copyFileSync(path.join(__dirname, '../lib/proxy-config.js'), path.join(dir, 'app/manyoyo/lib/proxy-config.js'));
    script(path.join(dir, 'app/node/bin/node'), `exec "${process.execPath}" "$@"`);
    fs.writeFileSync(path.join(dir, 'app/manyoyo/bin/manyoyo.js'),
        "require('fs').appendFileSync(process.env.FAKE_STATE + '/launched.log', `name=${process.env.MANYOYO_COMMAND_NAME} args=${process.argv.slice(2).join(' ')}\\n`);\n");
    fs.writeFileSync(path.join(dir, 'images/manyoyo-9.9.9-common-arm64.tar.gz'), 'image');
    const componentInfo = {
        image: { ref: 'ghcr.io/xcanwin/manyoyo:9.9.9-common', file: 'images/manyoyo-9.9.9-common-arm64.tar.gz', sha256: IMAGE_SHA },
        podman: { version: '6.1.3' },
        vmDisk: { file: 'vm/disk.raw.zst', sha256: 'c'.repeat(64) }
    };
    if (kind === 'full') {
        fs.mkdirSync(path.join(dir, 'runtime/podman/bin'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'runtime/podman/lib'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'runtime/podman/share'), { recursive: true });
        writeFakePodman(path.join(dir, 'runtime/podman/bin/podman'));
        fs.writeFileSync(path.join(dir, 'runtime/podman/lib/libkrun.dylib'), 'lib');
        fs.mkdirSync(path.join(dir, 'vm'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'vm/disk.raw.zst'), 'disk');
    }
    fs.writeFileSync(path.join(dir, 'install/env.sh'), renderInstallEnv({ version, imageVersion: `${version}-common`, arch, kind, componentInfo, platform }));
    fs.writeFileSync(path.join(dir, 'manifest.json'), `{"version":"${version}","kind":"${kind}"${manifestExtra}}\n`);
    return dir;
}

function install(payload, env = {}, args = []) {
    const state = path.join(root, 'state');
    fs.mkdirSync(state, { recursive: true });
    return spawnSync('sh', [path.join(payload, 'install/install.sh'), ...args], {
        encoding: 'utf-8',
        env: {
            PATH: `${fakeBin}:${safeBin}`,
            HOME: path.join(root, 'should-not-be-used'),
            MANYOYO_TEST_HOME: home,
            MANYOYO_TEST_UNAME_S: 'Darwin',
            MANYOYO_TEST_UNAME_M: 'arm64',
            MANYOYO_TEST_MACOS_VERSION: '26.6.2',
            MANYOYO_TEST_FREE_MB: '100000',
            MANYOYO_TEST_SHELL: '/bin/zsh',
            MANYOYO_TEST_SKIP_OPEN: '1',
            FAKE_STATE: state,
            ...env
        }
    });
}

const state = file => path.join(root, 'state', file);
const read = (file, fallback = '') => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback);
const calls = () => read(state('calls.log')).trim().split('\n').filter(Boolean);
const countCalls = prefix => calls().filter(line => line.startsWith(prefix)).length;
const blocks = file => (read(file).match(/^# >>> manyoyo >>>$/gm) || []).length;
async function waitFor(check, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (check()) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
}
const imported = () => fs.existsSync(path.join(home, `.manyoyo/.install/image-loaded-${IMAGE_SHA}`));

describe('offline installer (sh)', () => {
    test('first install of the full package: app, wrappers, private Podman, machine, background image import, PATH blocks', async () => {
        const payload = writePayload(path.join(root, 'payload'));
        const result = install(payload, { http_proxy: 'http://user:secret@127.0.0.1:7890' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('安装完成');
        expect(result.stdout).toContain('exec "$SHELL" -l'); // 当前终端立刻生效的办法

        const m = path.join(home, '.manyoyo');
        expect(fs.readFileSync(path.join(m, 'app/9.9.9/.installed'), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
        expect(fs.readlinkSync(path.join(m, 'app/current'))).toBe('9.9.9');
        expect(fs.existsSync(path.join(m, 'app/9.9.9/node/bin/node'))).toBe(true);
        for (const name of ['manyoyo', 'my']) expect(fs.statSync(path.join(m, 'bin', name)).mode & 0o111).not.toBe(0);

        // 包装脚本用私有 Node 启动，并用环境变量区分命令名
        const run = spawnSync(path.join(m, 'bin/my'), ['--hello'], { encoding: 'utf-8', env: { PATH: safeBin, FAKE_STATE: path.join(root, 'state') } });
        expect(run.status).toBe(0);
        expect(read(state('launched.log'))).toContain('name=my args=--hello');

        // 私有 Podman 与专属名字的 machine
        expect(fs.existsSync(path.join(m, 'runtime/podman/bin/podman'))).toBe(true);
        expect(fs.existsSync(path.join(m, 'runtime/podman/lib/libkrun.dylib'))).toBe(true);
        const initCall = calls().find(c => c.startsWith('podman machine init'));
        expect(initCall).toContain('--image');
        expect(initCall).toContain('podman-machine-manyoyo');
        expect(initCall).toContain(`CONTAINERS_CONF=${path.join(m, 'runtime/podman/containers.conf')}`);
        expect(initCall).toContain(`XDG_DATA_HOME=${path.join(m, 'runtime/podman/data')}`);
        expect(countCalls('podman machine start')).toBe(1);

        // 代理被抄进私有配置（600），日志里没有代理值
        const conf = fs.readFileSync(path.join(m, 'runtime/podman/containers.conf'), 'utf8');
        expect(conf).toContain('http_proxy=http://user:secret@127.0.0.1:7890');
        expect(conf).toContain('helper_binaries_dir');
        expect(fs.statSync(path.join(m, 'runtime/podman/containers.conf')).mode & 0o777).toBe(0o600);
        const logFile = path.join(m, 'logs/install', fs.readdirSync(path.join(m, 'logs/install')).find(f => f.startsWith('install-')));
        expect(fs.readFileSync(logFile, 'utf8')).not.toContain('secret');
        expect(result.stdout).not.toContain('secret');

        // 后台导入：load 被调用、归档与标记被清理
        expect(await waitFor(imported)).toBe(true);
        expect(read(state('loaded'))).toContain('manyoyo-9.9.9-common-arm64.tar.gz');
        expect(fs.existsSync(path.join(m, 'runtime/import/manyoyo-9.9.9-common-arm64.tar.gz'))).toBe(false);
        expect(fs.existsSync(path.join(m, 'runtime/import/loading.json'))).toBe(false);

        // 安装记录：manyoyo update 据此判断 Podman / 虚拟机磁盘有没有变化
        expect(JSON.parse(fs.readFileSync(path.join(m, '.install/installed.json'), 'utf8'))).toEqual({
            version: '9.9.9', kind: 'full', arch: 'arm64', imageVersion: '9.9.9-common', podmanVersion: '6.1.3', vmDiskSha256: 'c'.repeat(64)
        });

        // PATH 块：zsh 的 .zprofile 与 .zshrc 各一段
        expect(blocks(path.join(home, '.zprofile'))).toBe(1);
        expect(blocks(path.join(home, '.zshrc'))).toBe(1);
        expect(read(path.join(home, '.zprofile'))).toContain('export PATH="$HOME/.manyoyo/bin:$PATH"');
    });

    test('is idempotent: a second run skips every finished step and never duplicates the PATH block', async () => {
        const payload = writePayload(path.join(root, 'payload'));
        expect(install(payload).status).toBe(0);
        expect(await waitFor(imported)).toBe(true);
        const installedMarker = path.join(home, '.manyoyo/app/9.9.9/.installed');
        const before = fs.statSync(installedMarker).mtimeMs;

        const second = install(writePayload(path.join(root, 'payload2')));
        expect(second.status).toBe(0);
        expect(second.stdout).toContain('已安装，跳过');
        expect(countCalls('podman machine init')).toBe(1);
        expect(countCalls('podman machine start')).toBe(1);
        expect(read(state('loaded')).trim().split('\n')).toHaveLength(1);
        expect(fs.statSync(installedMarker).mtimeMs).toBe(before);
        expect(blocks(path.join(home, '.zprofile'))).toBe(1);
        expect(blocks(path.join(home, '.zshrc'))).toBe(1);
    });

    test('resumes after a failed machine start: friendly error, then the rerun does not recreate the machine', async () => {
        const payload = writePayload(path.join(root, 'payload'));
        const first = install(payload, { FAKE_FAIL_START: '1' });
        expect(first.status).toBe(1);
        expect(first.stdout).toContain('安装失败：启动虚拟机失败');
        expect(first.stdout).toContain('下一步');
        expect(first.stdout).toContain('日志：');
        expect(countCalls('podman machine init')).toBe(1);

        const second = install(writePayload(path.join(root, 'payload2')));
        expect(second.status).toBe(0);
        expect(countCalls('podman machine init')).toBe(1);
        expect(countCalls('podman machine start')).toBe(2);
        expect(await waitFor(imported)).toBe(true);
    });

    test('a failed machine init cleans up the half-created machine so the rerun starts clean', () => {
        const first = install(writePayload(path.join(root, 'payload')), { FAKE_FAIL_INIT: '1' });
        expect(first.status).toBe(1);
        expect(first.stdout).toContain('创建虚拟机失败');
        expect(countCalls('podman machine rm')).toBe(0); // init 失败后列表里没有这台虚拟机，不用也不能删
        expect(install(writePayload(path.join(root, 'payload2'))).status).toBe(0);
        expect(countCalls('podman machine init')).toBe(2);
    });

    test('an existing working Docker is reused: no private Podman, no VM, the image is loaded through docker', async () => {
        script(path.join(fakeBin, 'docker'), 'echo "docker $*" >> "$FAKE_STATE/calls.log"; exit 0');
        const result = install(writePayload(path.join(root, 'payload')));
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('复用');
        expect(fs.existsSync(path.join(home, '.manyoyo/runtime/podman'))).toBe(false);
        expect(countCalls('podman')).toBe(0);
        expect(await waitFor(imported)).toBe(true);
        expect(calls().some(c => c.startsWith('docker load -i') && c.includes('manyoyo-9.9.9-common-arm64.tar.gz'))).toBe(true);
    });

    test('reusing an existing runtime records no Podman / VM versions (nothing was installed)', () => {
        script(path.join(fakeBin, 'docker'), 'exit 0');
        expect(install(writePayload(path.join(root, 'payload'))).status).toBe(0);
        const record = JSON.parse(fs.readFileSync(path.join(home, '.manyoyo/.install/installed.json'), 'utf8'));
        expect(record).toEqual(expect.objectContaining({ podmanVersion: '', vmDiskSha256: '' }));
    });

    test('a machine that exists but cannot be inspected right now is never re-created or removed (it may hold the user\'s containers)', () => {
        fs.mkdirSync(path.join(root, 'state'), { recursive: true });
        fs.writeFileSync(path.join(root, 'state/machine'), '');
        const result = install(writePayload(path.join(root, 'payload')), { FAKE_INSPECT_FAILS: '1', FAKE_FAIL_INIT: '1' });
        expect(result.status).toBe(0);
        expect(countCalls('podman machine init')).toBe(0);
        expect(countCalls('podman machine rm')).toBe(0);
        expect(fs.existsSync(path.join(root, 'state/machine'))).toBe(true);
    });

    test('a failed init that left a half-created machine behind removes exactly that one', () => {
        const first = install(writePayload(path.join(root, 'payload')), { FAKE_FAIL_INIT: '1', FAKE_PARTIAL: '1' });
        expect(first.status).toBe(1);
        expect(calls().filter(c => c.startsWith('podman machine rm -f podman-machine-manyoyo'))).toHaveLength(1);
        expect(fs.existsSync(path.join(root, 'state/machine'))).toBe(false);
    });

    test('an existing Docker whose daemon is down does not count as a runtime', () => {
        script(path.join(fakeBin, 'docker'), 'exit 1');
        const result = install(writePayload(path.join(root, 'payload')));
        expect(result.status).toBe(0);
        expect(fs.existsSync(path.join(home, '.manyoyo/runtime/podman/bin/podman'))).toBe(true);
    });

    test('the lite package needs a running runtime and says what to do otherwise', () => {
        const payload = writePayload(path.join(root, 'payload'), { kind: 'lite' });
        const missing = install(payload);
        expect(missing.status).toBe(1);
        expect(missing.stdout).toContain('精简包需要已经在运行的 Docker 或 Podman');
        expect(fs.existsSync(path.join(home, '.manyoyo/app'))).toBe(false);

        script(path.join(fakeBin, 'podman'), 'echo "podman $*" >> "$FAKE_STATE/calls.log"; exit 0');
        expect(install(writePayload(path.join(root, 'payload2'), { kind: 'lite' })).status).toBe(0);
    });

    test.each([
        ['not macOS', { MANYOYO_TEST_UNAME_S: 'Linux' }, '只支持 macOS'],
        ['wrong architecture', { MANYOYO_TEST_UNAME_M: 'x86_64' }, 'arm64 版'],
        ['unknown architecture', { MANYOYO_TEST_UNAME_M: 'riscv64' }, '不认识的 CPU'],
        ['old macOS', { MANYOYO_TEST_MACOS_VERSION: '12.6' }, 'macOS 版本过低'],
        ['no disk space', { MANYOYO_TEST_FREE_MB: '500' }, '磁盘空间不足']
    ])('refuses to install on %s, explains why, and changes nothing', (_name, env, message) => {
        const result = install(writePayload(path.join(root, 'payload')), env);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(message);
        expect(result.stdout).toContain('下一步');
        expect(fs.existsSync(path.join(home, '.manyoyo/app'))).toBe(false);
        expect(fs.existsSync(path.join(home, '.zprofile'))).toBe(false);
    });

    test('bash with only ~/.profile: block goes into .profile and no .bash_profile is created (it would shadow .profile)', () => {
        fs.writeFileSync(path.join(home, '.profile'), 'export KEEP=1\n');
        install(writePayload(path.join(root, 'payload')), { MANYOYO_TEST_SHELL: '/bin/bash', MANYOYO_TEST_SKIP_MACHINE: '1' });
        expect(read(path.join(home, '.profile'))).toContain('# >>> manyoyo >>>');
        expect(read(path.join(home, '.profile'))).toContain('export KEEP=1');
        expect(fs.existsSync(path.join(home, '.bash_profile'))).toBe(false);
    });

    test('PATH block per shell: bash gets .bash_profile/.bashrc, unknown shells only get a hint, user content is kept', () => {
        fs.writeFileSync(path.join(home, '.bash_profile'), 'export FOO=1'); // 没有结尾换行
        const bash = install(writePayload(path.join(root, 'payload')), { MANYOYO_TEST_SHELL: '/bin/bash', MANYOYO_TEST_SKIP_MACHINE: '1' });
        expect(bash.status).toBe(0);
        const profile = read(path.join(home, '.bash_profile'));
        expect(profile.startsWith('export FOO=1\n\n# >>> manyoyo >>>\n')).toBe(true);
        expect(blocks(path.join(home, '.bashrc'))).toBe(1);
        expect(fs.existsSync(path.join(home, '.zprofile'))).toBe(false);

        const fishHome = path.join(root, 'fish-home');
        fs.mkdirSync(fishHome);
        const fish = spawnSync('sh', [path.join(writePayload(path.join(root, 'payload2')), 'install/install.sh')], {
            encoding: 'utf-8',
            env: { PATH: `${fakeBin}:${safeBin}`, MANYOYO_TEST_HOME: fishHome, MANYOYO_TEST_UNAME_S: 'Darwin', MANYOYO_TEST_UNAME_M: 'arm64', MANYOYO_TEST_MACOS_VERSION: '26.0', MANYOYO_TEST_FREE_MB: '100000', MANYOYO_TEST_SHELL: '/opt/homebrew/bin/fish', MANYOYO_TEST_SKIP_OPEN: '1', MANYOYO_TEST_SKIP_MACHINE: '1', FAKE_STATE: path.join(root, 'state') }
        });
        expect(fish.status).toBe(0);
        expect(fish.stdout).toContain('没有为 fish 自动写入 PATH');
        expect(fs.readdirSync(fishHome).filter(f => f.startsWith('.z') || f.startsWith('.bash'))).toEqual([]);
    });

    test('quarantine flags are cleared on the app and the private runtime', () => {
        script(path.join(fakeBin, 'xattr'), 'echo "xattr $*" >> "$FAKE_STATE/xattr.log"');
        expect(install(writePayload(path.join(root, 'payload')), { MANYOYO_TEST_SKIP_MACHINE: '1' }).status).toBe(0);
        const log = read(state('xattr.log'));
        expect(log).toContain(`-dr com.apple.quarantine ${path.join(home, '.manyoyo/app/9.9.9')}`);
        expect(log).toContain(`-dr com.apple.quarantine ${path.join(home, '.manyoyo/runtime/podman')}`);
    });

    test('reinstalling changed programs keeps the machine data and config of the private Podman', () => {
        expect(install(writePayload(path.join(root, 'payload')), { MANYOYO_TEST_SKIP_MACHINE: '1' }).status).toBe(0);
        const sentinel = path.join(home, '.manyoyo/runtime/podman/data/keep-me');
        fs.writeFileSync(sentinel, 'machine data');
        const second = install(writePayload(path.join(root, 'payload2'), { manifestExtra: ',"changed":true' }), { MANYOYO_TEST_SKIP_MACHINE: '1' });
        expect(second.status).toBe(0);
        expect(second.stdout).toContain('安装私有 Podman');
        expect(fs.readFileSync(sentinel, 'utf8')).toBe('machine data');
    });

    test('launches manyoyo at the end unless told not to', () => {
        const opened = install(writePayload(path.join(root, 'payload')), { MANYOYO_TEST_SKIP_OPEN: '', MANYOYO_TEST_SKIP_MACHINE: '1' });
        expect(opened.status).toBe(0);
        expect(read(state('launched.log'))).toContain('name=manyoyo');
        fs.rmSync(state('launched.log'));
        const quiet = install(writePayload(path.join(root, 'payload2')), { MANYOYO_TEST_SKIP_OPEN: '', MANYOYO_TEST_SKIP_MACHINE: '1' }, ['--no-open']);
        expect(quiet.status).toBe(0);
        expect(fs.existsSync(state('launched.log'))).toBe(false);
    });

    test('rejects unknown arguments', () => {
        const result = install(writePayload(path.join(root, 'payload')), {}, ['--bogus']);
        expect(result.status).toBe(2);
    });

    test('only macOS-bundled commands are used: no brew / git / python3 / curl / wget anywhere in the scripts', () => {
        for (const file of ['install.sh', 'finish-import.sh']) {
            const text = fs.readFileSync(path.join(SCRIPTS, file), 'utf8').replace(/^\s*#.*$/gm, '');
            expect(text).not.toMatch(/\b(brew|git|python3?|pip3?|curl|wget|npm|npx)\b/);
        }
    });

    test('no $VAR is directly followed by a non-ASCII character (macOS bash 3.2 as sh reads such bytes as part of the name and dies under set -u)', () => {
        for (const file of ['install.sh', 'finish-import.sh']) {
            const lines = fs.readFileSync(path.join(SCRIPTS, file), 'utf8').split('\n');
            const offenders = lines
                .map((line, index) => ({ line, number: index + 1 }))
                .filter(({ line }) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line));
            expect(offenders.map(o => `${file}:${o.number}: ${o.line.trim()}`)).toEqual([]);
        }
    });

    test('scripts are valid POSIX sh (sh -n, dash -n) and pass shellcheck when available', () => {
        for (const file of ['install.sh', 'finish-import.sh']) {
            expect(spawnSync('sh', ['-n', path.join(SCRIPTS, file)]).status).toBe(0);
            if (fs.existsSync('/usr/bin/dash')) expect(spawnSync('dash', ['-n', path.join(SCRIPTS, file)]).status).toBe(0);
            const shellcheck = spawnSync('shellcheck', ['--version']);
            if (!shellcheck.error) expect(spawnSync('shellcheck', ['-s', 'sh', '-x', '-e', 'SC1091', path.join(SCRIPTS, file)], { encoding: 'utf-8' }).status).toBe(0);
        }
    });
});

describe('install env generation', () => {
    test('rejects values that could smuggle shell syntax', () => {
        const base = { version: '1.0.0', imageVersion: '1.0.0-common', arch: 'arm64', kind: 'lite', componentInfo: { image: { ref: 'ghcr.io/x/y:1', file: 'images/a.tar.gz', sha256: 'a'.repeat(64) } } };
        expect(renderInstallEnv(base)).toContain("MANYOYO_KIND='lite'");
        expect(() => renderInstallEnv({ ...base, version: "1.0.0'; rm -rf ~; '" })).toThrow(/不允许的字符/);
        expect(() => renderInstallEnv({ ...base, componentInfo: { image: { ...base.componentInfo.image, ref: 'a b' } } })).toThrow(/不允许的字符/);
    });
});


describe('offline installer (sh): Linux package', () => {
    const linuxEnv = (extra = {}) => ({
        MANYOYO_TEST_UNAME_S: 'Linux',
        MANYOYO_TEST_UNAME_M: 'x86_64',
        MANYOYO_TEST_GLIBC: 'glibc 2.35',
        MANYOYO_TEST_SHELL: '/bin/bash',
        MANYOYO_TEST_SKIP_MACHINE: '',
        ...extra
    });
    const linuxPayload = (options = {}) => writePayload(path.join(root, 'payload'), { kind: 'lite', arch: 'x64', platform: 'linux', ...options });
    // 替身 docker / podman：info 的行为由 FAKE_INFO 决定（ok / denied / subuid / down）
    function writeFakeRuntime(name) {
        script(path.join(fakeBin, name), `
state="\${FAKE_STATE:?}"
echo "${name} $*" >> "$state/calls.log"
case "$1" in
  info)
    case "\${FAKE_INFO:-ok}" in
      ok) exit 0 ;;
      denied) echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1 ;;
      subuid) echo "ERRO[0000] cannot find UID/GID for user: no subuid ranges found" >&2; exit 1 ;;
      *) echo "Cannot connect to the daemon" >&2; exit 1 ;;
    esac ;;
  load) echo "$3" >> "$state/loaded" ;;
esac
exit 0
`);
    }

    test('without docker/podman: explains the apt command, never installs anything, and leaves ~/.manyoyo untouched except logs', () => {
        const result = install(linuxPayload(), linuxEnv());
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('没有检测到 docker 或 podman');
        expect(result.stdout).toContain('sudo apt update && sudo apt install -y podman');
        expect(result.stdout).toContain('重新运行本安装包即可续上');
        expect(fs.existsSync(path.join(home, '.manyoyo/app'))).toBe(false);
        expect(fs.existsSync(path.join(home, '.manyoyo/bin'))).toBe(false);
    });

    test('with a working docker: installs the app, loads the image with docker (no machine, no private Podman), writes PATH blocks for bash', async () => {
        writeFakeRuntime('docker');
        const result = install(linuxPayload(), linuxEnv());
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('linux / x64');
        expect(result.stdout).toContain('安装完成');
        const m = path.join(home, '.manyoyo');
        expect(fs.readlinkSync(path.join(m, 'app/current'))).toBe('9.9.9');
        expect(fs.existsSync(path.join(m, 'runtime/podman'))).toBe(false);
        expect(await waitFor(imported)).toBe(true);
        expect(calls().some(line => line.startsWith('docker load -i'))).toBe(true);
        expect(calls().some(line => line.includes('machine'))).toBe(false);
        expect(blocks(path.join(home, '.bashrc'))).toBe(1);
        const record = JSON.parse(read(path.join(m, '.install/installed.json')));
        expect(record).toEqual(expect.objectContaining({ kind: 'lite', arch: 'x64', podmanVersion: '' }));
    });

    test('docker installed but the user has no permission: explains the docker group fix', () => {
        writeFakeRuntime('docker');
        const result = install(linuxPayload(), linuxEnv({ FAKE_INFO: 'denied' }));
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('没有权限访问');
        expect(result.stdout).toContain('usermod -aG docker');
    });

    test('rootless podman without subuid/subgid: explains uidmap and subuids', () => {
        writeFakeRuntime('podman');
        const result = install(linuxPayload(), linuxEnv({ FAKE_INFO: 'subuid' }));
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('uidmap');
        expect(result.stdout).toContain('--add-subuids');
        expect(result.stdout).toContain('podman system migrate');
    });

    test('rejects an old glibc, the wrong OS and the wrong architecture with a next step', () => {
        writeFakeRuntime('docker');
        const old = install(linuxPayload(), linuxEnv({ MANYOYO_TEST_GLIBC: 'glibc 2.31' }));
        expect(old.status).toBe(1);
        expect(old.stdout).toContain('glibc 版本过低：2.31');
        expect(old.stdout).toContain('Ubuntu 22.04');
        expect(install(linuxPayload(), linuxEnv({ MANYOYO_TEST_GLIBC: 'glibc 2.36' })).status).toBe(0);

        const mac = install(linuxPayload(), linuxEnv({ MANYOYO_TEST_UNAME_S: 'Darwin' }));
        expect(mac.status).toBe(1);
        expect(mac.stdout).toContain('只支持 Linux');
        const arm = install(linuxPayload(), linuxEnv({ MANYOYO_TEST_UNAME_M: 'aarch64' }));
        expect(arm.status).toBe(1);
        expect(arm.stdout).toContain('请下载 arm64 对应的安装包');
    });

    test('--headless / --gui are passed through to the manyoyo launcher', () => {
        writeFakeRuntime('docker');
        const result = install(linuxPayload(), linuxEnv({ MANYOYO_TEST_SKIP_OPEN: '' }), ['--headless']);
        expect(result.status).toBe(0);
        expect(read(state('launched.log'))).toContain('args=--headless');
    });

    test('the macOS package still refuses to run on Linux', () => {
        const result = install(writePayload(path.join(root, 'payload')), { MANYOYO_TEST_UNAME_S: 'Linux' });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('只支持 macOS');
    });
});
