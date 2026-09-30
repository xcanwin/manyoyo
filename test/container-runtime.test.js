'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    selectContainerRuntime,
    getPrivatePodmanPaths,
    resolveForcedRuntime,
    mergeRuntimeEnv
} = require('../lib/container-runtime');

function makeHome(withPrivatePodman) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-runtime-'));
    if (withPrivatePodman) {
        const paths = getPrivatePodmanPaths(home);
        fs.mkdirSync(path.dirname(paths.bin), { recursive: true });
        fs.writeFileSync(paths.bin, '#!/bin/sh\n', { mode: 0o755 });
    }
    return home;
}

// available: { 'docker --version': true, 'docker info': false, ... }
function fakeRun(available, calls = []) {
    return (command, args, options = {}) => {
        calls.push({ command, args, options });
        const key = `${path.basename(command)} ${args[0]}`;
        if (!available[key]) throw new Error(`${key} failed`);
        return 'ok';
    };
}

describe('container runtime selection', () => {
    let homes = [];
    const newHome = withPrivate => {
        const home = makeHome(withPrivate);
        homes.push(home);
        return home;
    };
    afterEach(() => {
        homes.forEach(h => fs.rmSync(h, { recursive: true, force: true }));
        homes = [];
    });

    test('configured runtime wins over everything without probing', () => {
        const home = newHome(true);
        const calls = [];
        const result = selectContainerRuntime({ configured: 'docker', homeDir: home, run: fakeRun({}, calls) });
        expect(result).toEqual({ command: 'docker', env: {}, source: 'config' });
        expect(calls).toHaveLength(0);
    });

    test('auto and empty configured values fall through to detection', () => {
        const home = newHome(false);
        const run = fakeRun({ 'docker info': true });
        expect(selectContainerRuntime({ configured: 'auto', homeDir: home, run }).source).toBe('docker-daemon');
        expect(selectContainerRuntime({ configured: '', homeDir: home, run }).source).toBe('docker-daemon');
    });

    test('invalid configured value throws a friendly error', () => {
        expect(() => selectContainerRuntime({ configured: 'lxc', homeDir: newHome(false), run: fakeRun({}) }))
            .toThrow(/containerRuntime/);
    });

    test('private podman beats system docker and gets an isolated env plus containers.conf', () => {
        const home = newHome(true);
        const paths = getPrivatePodmanPaths(home);
        const result = selectContainerRuntime({ homeDir: home, run: fakeRun({ 'docker info': true }) });

        expect(result.command).toBe(paths.bin);
        expect(result.source).toBe('private-podman');
        expect(result.env).toEqual({
            XDG_CONFIG_HOME: paths.configHome,
            XDG_DATA_HOME: paths.dataHome,
            CONTAINERS_CONF: paths.containersConf
        });
        const conf = fs.readFileSync(paths.containersConf, 'utf8');
        expect(conf).toContain('[engine]');
        expect(conf).toContain(`helper_binaries_dir = [${JSON.stringify(path.dirname(paths.bin))}]`);
    });

    test('existing containers.conf is not overwritten', () => {
        const home = newHome(true);
        const paths = getPrivatePodmanPaths(home);
        fs.writeFileSync(paths.containersConf, '# mine\n');
        selectContainerRuntime({ homeDir: home, run: fakeRun({}) });
        expect(fs.readFileSync(paths.containersConf, 'utf8')).toBe('# mine\n');
    });

    test('prefers docker whose daemon responds over podman', () => {
        const result = selectContainerRuntime({
            homeDir: newHome(false),
            run: fakeRun({ 'docker --version': true, 'docker info': true, 'podman info': true })
        });
        expect(result).toEqual({ command: 'docker', env: {}, source: 'docker-daemon' });
    });

    test('skips docker with a dead daemon and picks podman whose daemon responds', () => {
        const result = selectContainerRuntime({
            homeDir: newHome(false),
            run: fakeRun({ 'docker --version': true, 'docker info': false, 'podman --version': true, 'podman info': true })
        });
        expect(result).toEqual({ command: 'podman', env: {}, source: 'podman-daemon' });
    });

    test('falls back to the first runtime that only answers --version', () => {
        const result = selectContainerRuntime({
            homeDir: newHome(false),
            run: fakeRun({ 'docker --version': true, 'podman --version': true })
        });
        expect(result).toEqual({ command: 'docker', env: {}, source: 'version-only' });

        const podmanOnly = selectContainerRuntime({
            homeDir: newHome(false),
            run: fakeRun({ 'podman --version': true })
        });
        expect(podmanOnly.command).toBe('podman');
    });

    test('info probes use a timeout so a hung Docker Desktop cannot block', () => {
        const calls = [];
        selectContainerRuntime({ homeDir: newHome(false), run: fakeRun({ 'docker info': true }, calls) });
        const infoCall = calls.find(c => c.args[0] === 'info');
        expect(infoCall.options.timeout).toBe(3000);
    });

    test('throws a friendly error when nothing is installed', () => {
        expect(() => selectContainerRuntime({ homeDir: newHome(false), run: fakeRun({}) }))
            .toThrow(/docker\/podman not found/);
    });

    test('resolveForcedRuntime never spawns and returns null when nothing is forced', () => {
        expect(resolveForcedRuntime({ homeDir: newHome(false) })).toBeNull();
        expect(resolveForcedRuntime({ configured: 'podman', homeDir: newHome(false) }))
            .toEqual({ command: 'podman', env: {}, source: 'config' });
        expect(resolveForcedRuntime({ homeDir: newHome(true) }).source).toBe('private-podman');
    });

    test('mergeRuntimeEnv layers extras over a base env without mutating process.env', () => {
        const before = { ...process.env };
        expect(mergeRuntimeEnv({})).toBeUndefined();
        const merged = mergeRuntimeEnv({ CONTAINERS_CONF: '/x' }, { PATH: '/bin' });
        expect(merged).toEqual({ PATH: '/bin', CONTAINERS_CONF: '/x' });
        expect(process.env).toEqual(before);
    });
});
