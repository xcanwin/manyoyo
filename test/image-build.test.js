const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildImage } = require('../lib/image-build');

function parseImageVersionTag(tag) {
    const match = String(tag || '').match(/^(\d+\.\d+\.\d+)-([A-Za-z0-9][A-Za-z0-9_.-]*)$/);
    if (!match) return null;
    return { baseVersion: match[1], tool: match[2] };
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

describe('image-build with podman buildkit fallback', () => {
    afterEach(() => {
        while (tempRoots.length > 0) {
            const rootDir = tempRoots.pop();
            fs.rmSync(rootDir, { recursive: true, force: true });
        }
    });

    test('podman should prefer buildkit and pipe output to podman load', async () => {
        const options = createBaseOptions({
            dockerCmd: 'podman',
            imageBuildArgs: ['--build-arg', 'APT_MIRROR=https://mirror.example']
        });

        await buildImage(options);

        expect(options.runCmdPipeline).toHaveBeenCalledTimes(1);
        const [leftCmd, leftArgs, rightCmd, rightArgs] = options.runCmdPipeline.mock.calls[0];
        expect(leftCmd).toBe('podman');
        expect(rightCmd).toBe('podman');
        expect(rightArgs).toEqual(['load']);
        expect(leftArgs).toEqual(expect.arrayContaining([
            'run',
            '--entrypoint',
            'buildctl-daemonless.sh',
            'moby/buildkit:latest',
            '--frontend',
            'dockerfile.v0',
            '--opt',
            'build-arg:TOOL=common',
            '--opt',
            'build-arg:APT_MIRROR=https://mirror.example'
        ]));
        const usedPodmanBuild = options.runCmd.mock.calls.some(([cmd, args]) => (
            cmd === 'podman' && Array.isArray(args) && args[0] === 'build'
        ));
        expect(usedPodmanBuild).toBe(false);
    });

    test('podman should fallback to native podman build when buildkit fails', async () => {
        const options = createBaseOptions({
            dockerCmd: 'podman',
            runCmdPipeline: jest.fn(async () => { throw new Error('buildkit unavailable'); })
        });

        await buildImage(options);

        expect(options.runCmdPipeline).toHaveBeenCalledTimes(1);
        const buildCall = options.runCmd.mock.calls.find(([cmd, args]) => (
            cmd === 'podman' && Array.isArray(args) && args[0] === 'build'
        ));
        expect(buildCall).toBeTruthy();
    });

    test('docker should keep native docker build path', async () => {
        const options = createBaseOptions({
            dockerCmd: 'docker'
        });

        await buildImage(options);

        expect(options.runCmdPipeline).not.toHaveBeenCalled();
        const buildCall = options.runCmd.mock.calls.find(([cmd, args]) => (
            cmd === 'docker' && Array.isArray(args) && args[0] === 'build'
        ));
        expect(buildCall).toBeTruthy();
    });
});
