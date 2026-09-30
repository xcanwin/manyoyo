'use strict';

const { describeError, formatErrorHint } = require('../lib/error-hints');

describe('error hints', () => {
    test.each([
        ['Cannot connect to Podman. Please verify your connection', 'PODMAN_MACHINE_UNAVAILABLE', 'podman machine start'],
        ['unable to connect to Podman socket: failed to connect', 'PODMAN_MACHINE_UNAVAILABLE', 'podman machine start'],
        ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock', 'DOCKER_DAEMON_UNAVAILABLE', 'Docker Desktop'],
        ['Error: pull access denied for foo, repository does not exist', 'IMAGE_NOT_FOUND', 'manyoyo build'],
        ['manifest unknown: manifest unknown', 'IMAGE_NOT_FOUND', 'imageVersion'],
        ['dial tcp 1.2.3.4:443: i/o timeout', 'IMAGE_PULL_FAILED', '网络'],
        ['pinging container registry localhost: Get "https://localhost/v2/"', 'IMAGE_PULL_FAILED', 'manyoyo build'],
        ['Bind for 0.0.0.0:8080 failed: port is already allocated', 'PORT_IN_USE', '换一个端口'],
        ['listen EADDRINUSE: address already in use 127.0.0.1:3000', 'PORT_IN_USE', '换一个端口'],
        ['xcode-select: note: No developer tools were found', 'XCODE_CLT_MISSING', 'xcode-select --install']
    ])('maps %j to %s', (raw, code, actionPart) => {
        const info = describeError(raw);
        expect(info.code).toBe(code);
        expect(info.reason).toEqual(expect.any(String));
        expect(info.action).toContain(actionPart);
    });

    test('interpolates the runtime command, image and port', () => {
        expect(describeError('Cannot connect to Podman', { command: 'docker' }).reason)
            .toContain('当前 docker 命令正在连接 Podman machine');
        expect(describeError('no such host', { imageRef: 'img:1.0.0-common' }).reason).toContain('img:1.0.0-common');
        expect(describeError('port is already allocated', { port: 3000 }).reason).toContain('3000');
    });

    test('unknown errors map to null and an empty hint', () => {
        expect(describeError('something else')).toBeNull();
        expect(describeError(undefined)).toBeNull();
        expect(formatErrorHint('something else')).toBe('');
    });

    test('formatErrorHint renders reason then action', () => {
        expect(formatErrorHint('Cannot connect to Podman', { command: 'podman' }))
            .toBe('\n提示: 当前 podman 命令正在连接 Podman machine，但连接不可用。\n请先在宿主机执行: podman machine start');
    });
});
