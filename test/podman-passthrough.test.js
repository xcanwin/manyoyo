'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runPodmanCommand, buildShellFunction } = require('../lib/podman-passthrough');
const { getPrivatePodmanPaths } = require('../lib/container-runtime');

const BIN = path.join(__dirname, '../bin/manyoyo.js');
let home;

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-podman-')); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function installFakePodman() {
    const paths = getPrivatePodmanPaths(home);
    fs.mkdirSync(path.dirname(paths.bin), { recursive: true });
    // 把收到的参数（一行一个）和关键环境变量写出来，退出码取 FAKE_EXIT
    fs.writeFileSync(paths.bin, '#!/bin/sh\nfor a in "$@"; do printf "ARG<%s>\\n" "$a"; done\nprintf "XDG_DATA_HOME=%s\\nCONTAINERS_CONF=%s\\n" "$XDG_DATA_HOME" "$CONTAINERS_CONF"\nexit "${FAKE_EXIT:-0}"\n', { mode: 0o755 });
    return paths;
}

describe('podman passthrough', () => {
    test('without a private Podman it explains and fails', () => {
        const errors = [];
        const code = runPodmanCommand(['ps'], { homeDir: home, errLog: line => errors.push(line) });
        expect(code).toBe(1);
        expect(errors.join('\n')).toContain('没有找到');
    });

    test('--help prints usage even without a private Podman', () => {
        const logs = [];
        const code = runPodmanCommand(['--help'], { homeDir: home, log: line => logs.push(line) });
        expect(code).toBe(0);
        expect(logs.join('\n')).toContain('用法');
    });

    test('passes args verbatim (quotes, dashes, spaces) with the private env', () => {
        const paths = installFakePodman();
        const calls = [];
        const code = runPodmanCommand(['exec', '-it', 'c1', 'sh', '-c', `echo "a 'b'"`], {
            homeDir: home,
            spawnSync: (command, args, opts) => { calls.push({ command, args, opts }); return { status: 7 }; }
        });
        expect(code).toBe(7);
        expect(calls[0].command).toBe(paths.bin);
        expect(calls[0].args).toEqual(['exec', '-it', 'c1', 'sh', '-c', `echo "a 'b'"`]);
        expect(calls[0].opts.env).toEqual(expect.objectContaining({ XDG_CONFIG_HOME: paths.configHome, XDG_DATA_HOME: paths.dataHome, CONTAINERS_CONF: paths.containersConf }));
        expect(calls[0].opts.stdio).toBe('inherit');
    });

    test('env prints a function that is safe to eval and does not touch PATH or global XDG vars', () => {
        const paths = installFakePodman();
        const lines = [];
        expect(runPodmanCommand(['env', '--shell', 'bash'], { homeDir: home, log: line => lines.push(line) })).toBe(0);
        const code = lines.join('\n');
        expect(code).toMatch(/^podman\(\) \{ env XDG_CONFIG_HOME='.*' XDG_DATA_HOME='.*' CONTAINERS_CONF='.*' '.*\/podman' "\$@"; \}$/);
        expect(code).not.toMatch(/export |PATH=/);
        expect(buildShellFunction({ ...paths, bin: "/we ird/'p" }, 'sh')).toContain(`'/we ird/'\\''p'`);
        const fish = [];
        runPodmanCommand(['env', '--shell', 'fish'], { homeDir: home, log: line => fish.push(line) });
        expect(fish.join('\n')).toContain('function podman');
        expect(fish.join('\n')).toContain('$argv');
    });

    test('CLI: `manyoyo podman ...` reaches the private binary unparsed (options like -a / --format), and propagates exit code', () => {
        installFakePodman();
        const run = (args, extraEnv = {}) => spawnSync('node', [BIN, 'podman', ...args], { encoding: 'utf-8', env: { ...process.env, HOME: home, ...extraEnv } });
        const result = run(['ps', '-a', '--format', '{{.Names}}']);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ARG<ps>\nARG<-a>\nARG<--format>\nARG<{{.Names}}>');
        expect(result.stdout).toContain(`XDG_DATA_HOME=${path.join(home, '.manyoyo/runtime/podman/data')}`);
        expect(run(['--help']).stdout).toContain('eval');
        expect(run(['ps'], { FAKE_EXIT: '3' }).status).toBe(3);
    });
});
