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
