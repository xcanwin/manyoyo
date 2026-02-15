const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { buildImage } = require('../lib/image-build');

function parseImageVersionTag(tag) {
    const match = String(tag || '').match(/^(\d+\.\d+\.\d+)-([A-Za-z0-9][A-Za-z0-9_.-]*)$/);
    if (!match) return null;
    return { baseVersion: match[1], tool: match[2] };
}

function createCommandError(message, stderr = '', stdout = '') {
    const err = new Error(message);
    err.stderr = stderr;
    err.stdout = stdout;
    return err;
}

function createTestRoot() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-image-build-'));
    const dockerDir = path.join(rootDir, 'docker');
    const cacheDir = path.join(dockerDir, 'cache');
    const nodeCacheDir = path.join(cacheDir, 'node');
    fs.mkdirSync(nodeCacheDir, { recursive: true });

    fs.writeFileSync(path.join(dockerDir, 'manyoyo.Dockerfile'), 'FROM scratch\n');
    fs.writeFileSync(path.join(nodeCacheDir, 'node-v24.0.0-linux-x64.tar.gz'), 'cache');
    fs.writeFileSync(path.join(cacheDir, '.timestamps.json'), JSON.stringify({
        'node/': new Date().toISOString()
    }));

    return rootDir;
}

const tempRoots = [];

function createBaseOptions(overrides = {}) {
    const rootDir = createTestRoot();
    tempRoots.push(rootDir);
    const runCmd = jest.fn(() => '');
    const runCmdPipeline = jest.fn(async () => {});
    const log = jest.fn();
    const error = jest.fn();
    const pruneDanglingImages = jest.fn();
    const askQuestion = jest.fn(async () => '');

    return {
        rootDir,
        runCmd,
        runCmdPipeline,
        log,
        error,
        pruneDanglingImages,
        askQuestion,
        imageName: 'localhost/xcanwin/manyoyo',
        imageVersionTag: '1.8.0-common',
        parseImageVersionTag,
        yesMode: true,
        loadConfig: () => ({}),
        exit: (code) => { throw new Error(`exit:${code}`); },
        ...overrides
    };
}

describe('image-build with unified build and buildkit fallback', () => {
    afterEach(() => {
        while (tempRoots.length > 0) {
            const rootDir = tempRoots.pop();
            fs.rmSync(rootDir, { recursive: true, force: true });
        }
    });

    test('podman should prefer native build when it succeeds', async () => {
        const options = createBaseOptions({
            dockerCmd: 'podman'
        });

        await buildImage(options);

        expect(options.runCmdPipeline).not.toHaveBeenCalled();
        const buildCall = options.runCmd.mock.calls.find(([cmd, args]) => (
            cmd === 'podman' && Array.isArray(args) && args[0] === 'build'
        ));
        expect(buildCall).toBeTruthy();
        expect(options.pruneDanglingImages).toHaveBeenCalledTimes(1);
    });

    test('podman should fallback to buildkit when native build hits capability error', async () => {
        const options = createBaseOptions({
            dockerCmd: 'podman',
            imageBuildArgs: ['--build-arg', 'APT_MIRROR=https://mirror.example'],
            runCmd: jest.fn(() => {
                throw createCommandError('unknown flag: --load');
            })
        });

        await buildImage(options);

        expect(options.runCmd).toHaveBeenCalledTimes(1);
        expect(options.runCmdPipeline).toHaveBeenCalledTimes(1);
        const [leftCmd, leftArgs, rightCmd, rightArgs] = options.runCmdPipeline.mock.calls[0];
        expect(leftCmd).toBe('podman');
        expect(rightCmd).toBe('podman');
        expect(rightArgs).toEqual(['load']);
        expect(leftArgs).toEqual(expect.arrayContaining([
            'run',
            '--entrypoint',
            'buildctl-daemonless.sh',
            'docker.io/moby/buildkit:latest',
            '--frontend',
            'dockerfile.v0',
            '--opt',
            'build-arg:HTTP_PROXY=$HTTP_PROXY',
            '--opt',
            'build-arg:TOOL=common',
            '--opt',
            'build-arg:APT_MIRROR=https://mirror.example'
        ]));
        expect(options.pruneDanglingImages).toHaveBeenCalledTimes(1);
    });

    test('podman should not fallback when native build fails with non-capability error', async () => {
        const options = createBaseOptions({
            dockerCmd: 'podman',
            runCmd: jest.fn(() => {
                throw createCommandError(
                    'failed to solve: Dockerfile parse error',
                    'Build error: Dockerfile parse error line 12'
                );
            })
        });

        await expect(buildImage(options)).rejects.toThrow('exit:1');
        expect(options.runCmdPipeline).not.toHaveBeenCalled();
        expect(options.error).toHaveBeenCalled();
    });

    test('podman should fallback to buildkit on unknown CASE instruction from legacy builder', async () => {
        const options = createBaseOptions({
            dockerCmd: 'podman',
            runCmd: jest.fn(() => {
                throw createCommandError(
                    'Error: building at STEP "CASE "',
                    'Build error: Unknown instruction: "CASE"'
                );
            })
        });

        await buildImage(options);

        expect(options.runCmd).toHaveBeenCalledTimes(1);
        expect(options.runCmdPipeline).toHaveBeenCalledTimes(1);
        const [leftCmd, , rightCmd, rightArgs] = options.runCmdPipeline.mock.calls[0];
        expect(leftCmd).toBe('podman');
        expect(rightCmd).toBe('podman');
        expect(rightArgs).toEqual(['load']);
    });

    test('docker should prefer native build when it succeeds', async () => {
        const options = createBaseOptions({
            dockerCmd: 'docker'
        });

        await buildImage(options);

        expect(options.runCmdPipeline).not.toHaveBeenCalled();
        const buildCall = options.runCmd.mock.calls.find(([cmd, args]) => (
            cmd === 'docker' && Array.isArray(args) && args[0] === 'build'
        ));
        expect(buildCall).toBeTruthy();
        expect(options.pruneDanglingImages).toHaveBeenCalledTimes(1);
    });

    test('docker should fallback to buildkit when native build hits capability error', async () => {
        const options = createBaseOptions({
            dockerCmd: 'docker',
            runCmd: jest.fn(() => {
                throw createCommandError('unknown option --load');
            })
        });

        await buildImage(options);

        expect(options.runCmd).toHaveBeenCalledTimes(1);
        expect(options.runCmdPipeline).toHaveBeenCalledTimes(1);
        const [leftCmd, leftArgs, rightCmd, rightArgs] = options.runCmdPipeline.mock.calls[0];
        expect(leftCmd).toBe('docker');
        expect(rightCmd).toBe('docker');
        expect(rightArgs).toEqual(['load']);
        expect(leftArgs).toEqual(expect.arrayContaining([
            'run',
            '--entrypoint',
            'buildctl-daemonless.sh',
            'docker.io/moby/buildkit:latest',
            '--frontend',
            'dockerfile.v0',
            '--opt',
            'build-arg:TOOL=common'
        ]));
        expect(options.pruneDanglingImages).toHaveBeenCalledTimes(1);
    });

    test('docker should not fallback when native build fails with non-capability error', async () => {
        const options = createBaseOptions({
            dockerCmd: 'docker',
            runCmd: jest.fn(() => {
                throw createCommandError(
                    'failed to solve: syntax error',
                    'Dockerfile:23 syntax error'
                );
            })
        });

        await expect(buildImage(options)).rejects.toThrow('exit:1');
        expect(options.runCmdPipeline).not.toHaveBeenCalled();
        expect(options.error).toHaveBeenCalled();
    });

    test('should fallback when direct build fails without stderr/stdout diagnostics', async () => {
        const options = createBaseOptions({
            dockerCmd: 'podman',
            runCmd: jest.fn(() => {
                throw createCommandError('Command failed: podman build ...');
            })
        });

        await buildImage(options);
        expect(options.runCmd).toHaveBeenCalledTimes(1);
        expect(options.runCmdPipeline).toHaveBeenCalledTimes(1);
    });

    test('should fail when buildkit fallback also fails', async () => {
        const options = createBaseOptions({
            dockerCmd: 'docker',
            runCmd: jest.fn(() => {
                throw createCommandError('unknown flag: --load');
            }),
            runCmdPipeline: jest.fn(async () => {
                throw new Error('buildkit unavailable');
            })
        });

        await expect(buildImage(options)).rejects.toThrow('exit:1');
        expect(options.runCmd).toHaveBeenCalledTimes(1);
        expect(options.runCmdPipeline).toHaveBeenCalledTimes(1);
        expect(options.error).toHaveBeenCalled();
    });

    test('should honor cacheTTL=0 from config without falling back to default', async () => {
        const cacheHash = crypto.createHash('sha256').update('cache').digest('hex');
        const options = createBaseOptions({
            loadConfig: () => ({ cacheTTL: 0 }),
            runCmd: jest.fn((cmd, args) => {
                if (cmd === 'curl') {
                    if (Array.isArray(args) && args.some(arg => String(arg).includes('SHASUMS256.txt'))) {
                        return `${cacheHash} node-v24.0.0-linux-x64.tar.gz\n`;
                    }
                    return '';
                }
                return '';
            })
        });

        fs.writeFileSync(
            path.join(options.rootDir, 'docker', 'cache', '.timestamps.json'),
            JSON.stringify({ 'node/': '2000-01-01T00:00:00.000Z' })
        );

        await buildImage(options);
        const curlCalls = options.runCmd.mock.calls.filter(([cmd]) => cmd === 'curl');
        expect(curlCalls.length).toBeGreaterThan(0);
    });
});
