'use strict';

const { EventEmitter } = require('events');
const { ensureImagePresent, pullImageProcess, toFriendlyPullError } = require('../lib/image-pull');

function fakeSpawn({ stdout = '', stderr = '', code = 0, error = null }) {
    return jest.fn(() => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
            if (error) {
                child.emit('error', error);
                return;
            }
            if (stdout) child.stdout.emit('data', Buffer.from(stdout));
            if (stderr) child.stderr.emit('data', Buffer.from(stderr));
            child.emit('close', code);
        });
        return child;
    });
}

describe('ensureImagePresent', () => {
    const REF = 'ghcr.io/xcanwin/manyoyo:1.0.0-common';

    test('does nothing when the image already exists', async () => {
        const pull = jest.fn();
        const onStart = jest.fn();
        const result = await ensureImagePresent({ imageRef: REF, command: 'docker', isPresent: async () => true, pull, onStart });
        expect(result).toEqual({ pulled: false });
        expect(pull).not.toHaveBeenCalled();
        expect(onStart).not.toHaveBeenCalled();
    });

    test('pulls when the image is missing', async () => {
        const pull = jest.fn(async () => {});
        const onStart = jest.fn();
        const result = await ensureImagePresent({ imageRef: REF, command: 'docker', isPresent: () => false, pull, onStart });
        expect(result).toEqual({ pulled: true });
        expect(onStart).toHaveBeenCalledTimes(1);
        expect(pull).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['network', 'dial tcp 140.82.1.1:443: i/o timeout', 'IMAGE_PULL_FAILED', '检查网络'],
        ['image not found', 'Error: manifest unknown', 'IMAGE_NOT_FOUND', 'imageVersion'],
        ['runtime unavailable', 'Cannot connect to the Docker daemon at unix:///x', 'DOCKER_DAEMON_UNAVAILABLE', 'Docker Desktop']
    ])('pull failure (%s) becomes a friendly error with reason and next step', async (_name, output, code, hint) => {
        const pull = async () => {
            const err = new Error('docker pull exited 1');
            err.output = output;
            throw err;
        };
        await expect(ensureImagePresent({ imageRef: REF, command: 'docker', isPresent: () => false, pull }))
            .rejects.toMatchObject({ code, message: expect.stringContaining(hint) });
    });

    test('an unrecognised failure still names the image', async () => {
        const pull = async () => { throw new Error('weird'); };
        await expect(ensureImagePresent({ imageRef: REF, command: 'docker', isPresent: () => false, pull }))
            .rejects.toMatchObject({ code: 'IMAGE_PULL_FAILED', message: expect.stringContaining(REF) });
        expect(toFriendlyPullError(new Error('x'), REF, 'docker').cause).toBeInstanceOf(Error);
    });
});

describe('pullImageProcess', () => {
    test('streams output and resolves on exit code 0', async () => {
        const chunks = [];
        const spawnFn = fakeSpawn({ stdout: 'layer 1\n', stderr: 'layer 2\n' });
        await pullImageProcess({ command: '/p/podman', env: { A: '1' }, imageRef: 'img:1', spawnFn, onOutput: (t, s) => chunks.push([s, t]) });
        expect(spawnFn).toHaveBeenCalledWith('/p/podman', ['pull', 'img:1'], expect.objectContaining({ env: { A: '1' } }));
        expect(chunks).toEqual([['stdout', 'layer 1\n'], ['stderr', 'layer 2\n']]);
    });

    test('rejects with the output tail on a non-zero exit', async () => {
        const spawnFn = fakeSpawn({ stderr: 'manifest unknown', code: 1 });
        await expect(pullImageProcess({ command: 'docker', imageRef: 'img:1', spawnFn })).rejects.toMatchObject({ output: 'manifest unknown' });
    });

    test('rejects when the command cannot be spawned', async () => {
        const spawnFn = fakeSpawn({ error: new Error('spawn docker ENOENT') });
        await expect(pullImageProcess({ command: 'docker', imageRef: 'img:1', spawnFn })).rejects.toThrow(/ENOENT/);
    });
});

describe('describeImageProblem：给网页弹窗的结构化信息', () => {
    const { describeImageProblem } = require('../lib/image-pull');
    const REF = 'ghcr.io/xcanwin/manyoyo:2.3.1-common';
    test('按运行时给出对应的拉取命令：系统 docker / 系统 podman / 自带的私有 podman', () => {
        expect(describeImageProblem(REF, 'docker')).toMatchObject({ runtime: 'docker', runtimeLabel: '系统的 Docker', pullCommand: `docker pull ${REF}`, buildCommand: 'my build --iv 2.3.1-common' });
        expect(describeImageProblem(REF, '/usr/bin/podman')).toMatchObject({ runtime: 'podman', pullCommand: `podman pull ${REF}` });
        expect(describeImageProblem(REF, '/home/u/.manyoyo/runtime/podman/bin/podman')).toMatchObject({ runtime: 'private-podman', runtimeLabel: 'MANYOYO 自带的 Podman', pullCommand: `my podman pull ${REF}` });
    });
    test('镜像不存在 / 拉不到才带 imageProblem；未授权等不带；没有合规版本号时构建命令用占位', () => {
        const missing = toFriendlyPullError(Object.assign(new Error('x'), { output: 'manifest unknown' }), REF, 'docker');
        expect(missing.code).toBe('IMAGE_NOT_FOUND');
        expect(missing.imageProblem).toMatchObject({ code: 'IMAGE_NOT_FOUND', pullCommand: `docker pull ${REF}` });
        const network = toFriendlyPullError(Object.assign(new Error('x'), { output: 'dial tcp 1.2.3.4:443 i/o timeout' }), REF, 'podman');
        expect(network.imageProblem.code).toBe('IMAGE_PULL_FAILED');
        const denied = toFriendlyPullError(Object.assign(new Error('x'), { output: 'unauthorized: authentication required' }), REF, 'docker');
        expect(denied.imageProblem).toBeUndefined();
        expect(describeImageProblem('foo/bar:latest', 'docker').buildCommand).toBe('my build --iv <x.y.z-后缀>');
    });
});
