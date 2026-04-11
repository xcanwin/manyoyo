'use strict';

const { resolveRuntimeConfig } = require('../lib/runtime-resolver');
const { normalizeVolume, parseEnvEntry } = require('../lib/runtime-normalizers');

function pickConfigValue() {
    for (let i = 0; i < arguments.length; i += 1) {
        if (arguments[i]) {
            return arguments[i];
        }
    }
    return undefined;
}

function normalizeCommandSuffix(suffix) {
    if (typeof suffix !== 'string') {
        return '';
    }
    const trimmed = suffix.trim();
    return trimmed ? ` ${trimmed}` : '';
}

function normalizeJsonEnvMap(envConfig) {
    if (envConfig === undefined || envConfig === null) {
        return {};
    }
    const result = {};
    Object.entries(envConfig).forEach(([key, value]) => {
        const parsed = parseEnvEntry(`${key}=${value === null ? '' : String(value)}`);
        result[parsed.key] = parsed.value;
    });
    return result;
}

function normalizeCliEnvMap(envList) {
    const result = {};
    (envList || []).forEach(item => {
        const parsed = parseEnvEntry(item);
        result[parsed.key] = parsed.value;
    });
    return result;
}

function mergeArrayConfig(globalValue, runValue, cliValue) {
    return [...(globalValue || []), ...(runValue || []), ...(cliValue || [])];
}

function parseServerListen(rawServer) {
    if (rawServer === true || rawServer === undefined || rawServer === null || rawServer === '') {
        return { host: '127.0.0.1', port: 3000 };
    }
    const value = String(rawServer).trim();
    const idx = value.lastIndexOf(':');
    return {
        host: value.slice(0, idx),
        port: Number(value.slice(idx + 1))
    };
}

describe('runtime resolver', () => {
    test('should merge config layers for config snapshot', () => {
        const resolved = resolveRuntimeConfig({
            cliOptions: {
                contName: 'cli-name',
                env: ['CLI_A=3'],
                volume: ['~/cli:/workspace/cli'],
                port: ['3000:30'],
                imageBuildArg: ['CLI=1'],
                shell: 'cli-shell'
            },
            globalConfig: {
                hostPath: '/global/host',
                env: { GLOBAL_A: '1' },
                volumes: ['~/global:/workspace/global'],
                ports: ['1000:10'],
                imageBuildArgs: ['GLOBAL=1']
            },
            runConfig: {
                env: { RUN_A: '2' },
                volumes: ['/run:/workspace/run'],
                ports: ['2000:20'],
                imageBuildArgs: ['RUN=1'],
                shell: 'run-shell'
            },
            globalFirstConfig: {},
            runFirstConfig: {},
            defaults: {
                hostPath: '/default/host',
                containerName: 'default-name',
                containerPath: '/default/container',
                imageName: 'localhost/xcanwin/manyoyo',
                imageVersion: '1.9.0-common'
            },
            envVars: {},
            argv: ['node', 'bin/manyoyo.js', 'config', 'show'],
            isServerMode: false,
            isServerStopMode: false,
            pickConfigValue,
            resolveContainerNameTemplate: value => value,
            normalizeCommandSuffix,
            normalizeJsonEnvMap,
            normalizeCliEnvMap,
            mergeArrayConfig,
            normalizeVolume: value => normalizeVolume(value, '/tmp/home'),
            parseServerListen
        });

        expect(resolved.containerName).toBe('cli-name');
        expect(resolved.hostPath).toBe('/global/host');
        expect(resolved.exec.shell).toBe('cli-shell');
        expect(resolved.env).toEqual({
            GLOBAL_A: '1',
            RUN_A: '2',
            CLI_A: '3'
        });
        expect(resolved.volumes).toEqual([
            '/tmp/home/global:/workspace/global',
            '/run:/workspace/run',
            '/tmp/home/cli:/workspace/cli'
        ]);
        expect(resolved.ports).toEqual(['1000:10', '2000:20', '3000:30']);
        expect(resolved.imageBuildArgs).toEqual(['GLOBAL=1', 'RUN=1', 'CLI=1']);
    });

    test('should prefer double-dash suffix over shell-suffix option', () => {
        const resolved = resolveRuntimeConfig({
            cliOptions: {
                shell: 'codex',
                shellSuffix: '-c'
            },
            globalConfig: {},
            runConfig: {},
            globalFirstConfig: {},
            runFirstConfig: {},
            defaults: {
                hostPath: '/host',
                containerName: 'default-name',
                containerPath: '/container',
                imageName: 'localhost/xcanwin/manyoyo',
                imageVersion: '1.9.0-common'
            },
            envVars: {},
            argv: ['node', 'bin/manyoyo.js', 'config', 'show', '--', 'resume', '--last'],
            isServerMode: false,
            isServerStopMode: false,
            pickConfigValue,
            resolveContainerNameTemplate: value => value,
            normalizeCommandSuffix,
            normalizeJsonEnvMap,
            normalizeCliEnvMap,
            mergeArrayConfig,
            normalizeVolume,
            parseServerListen
        });

        expect(resolved.exec.shell).toBe('codex');
        expect(resolved.exec.suffix).toBe(' resume --last');
    });

    test('should auto-generate server credentials in serve mode', () => {
        const resolved = resolveRuntimeConfig({
            cliOptions: {
                server: true
            },
            globalConfig: {},
            runConfig: {},
            globalFirstConfig: {},
            runFirstConfig: {},
            defaults: {
                hostPath: '/host',
                containerName: 'default-name',
                containerPath: '/container',
                imageName: 'localhost/xcanwin/manyoyo',
                imageVersion: '1.9.0-common'
            },
            envVars: {},
            argv: ['node', 'bin/manyoyo.js', 'config', 'show', '--serve'],
            isServerMode: true,
            isServerStopMode: false,
            pickConfigValue,
            resolveContainerNameTemplate: value => value,
            normalizeCommandSuffix,
            normalizeJsonEnvMap,
            normalizeCliEnvMap,
            mergeArrayConfig,
            normalizeVolume,
            parseServerListen
        });

        expect(resolved.server).toBe(true);
        expect(resolved.serverHost).toBe('127.0.0.1');
        expect(resolved.serverPort).toBe(3000);
        expect(resolved.serverUser).toBe('admin');
        expect(typeof resolved.serverPass).toBe('string');
        expect(resolved.serverPass.length).toBeGreaterThan(0);
        expect(resolved.serverPassAuto).toBe(true);
    });

    test('should append worktree mounts and expose worktree metadata', () => {
        const resolved = resolveRuntimeConfig({
            cliOptions: {
                worktrees: true
            },
            globalConfig: {
                volumes: ['/global:/workspace/global']
            },
            runConfig: {
                volumes: ['/run:/workspace/run']
            },
            globalFirstConfig: {},
            runFirstConfig: {},
            defaults: {
                hostPath: '/repo',
                containerName: 'default-name',
                containerPath: '/repo',
                imageName: 'localhost/xcanwin/manyoyo',
                imageVersion: '1.9.0-common'
            },
            envVars: {},
            argv: ['node', 'bin/manyoyo.js', 'config', 'show', '--worktrees'],
            isServerMode: false,
            isServerStopMode: false,
            pickConfigValue,
            resolveContainerNameTemplate: value => value,
            normalizeCommandSuffix,
            normalizeJsonEnvMap,
            normalizeCliEnvMap,
            mergeArrayConfig,
            normalizeVolume,
            parseServerListen,
            resolveWorktreeSupport: jest.fn(() => ({
                enabled: true,
                worktreesRoot: '/parent/worktrees/repo',
                worktreeRepoRoot: '/repo',
                worktreeMainRepoRoot: '/repo',
                extraVolumes: ['/parent/worktrees/repo:/parent/worktrees/repo']
            }))
        });

        expect(resolved.worktrees).toBe(true);
        expect(resolved.worktreesRoot).toBe('/parent/worktrees/repo');
        expect(resolved.worktreeRepoRoot).toBe('/repo');
        expect(resolved.worktreeMainRepoRoot).toBe('/repo');
        expect(resolved.volumes).toEqual([
            '/global:/workspace/global',
            '/run:/workspace/run',
            '/parent/worktrees/repo:/parent/worktrees/repo'
        ]);
    });
});
