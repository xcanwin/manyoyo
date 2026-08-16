'use strict';

const {
    connectExistingContainer,
    createNewContainer,
    setupContainer,
    executeFirstCommand,
    executeInContainer,
    handlePostExit,
    waitForContainerReady
} = require('../lib/cli/container-lifecycle');

describe('CLI container lifecycle', () => {
    test('starts a stopped container and preserves default-command suffix merging', async () => {
        const runtime = { containerName: 'demo', quiet: {}, execCommand: '', execCommandPrefix: 'env A=1', execCommandSuffix: '--resume' };
        const driver = { startContainer: jest.fn(), getDefaultCommand: jest.fn(() => 'codex exec') };
        const command = await connectExistingContainer(runtime, {
            getContainerStatus: () => 'exited',
            getRuntimeDriver: () => driver,
            joinExecCommand: (...parts) => parts.filter(Boolean).join(' '),
            log: jest.fn()
        });

        expect(command).toBe('codex exec');
        expect(driver.startContainer).toHaveBeenCalledWith('demo');
        expect(runtime.execCommand).toBe('env A=1 codex exec --resume');
    });

    test('starts before exec, preserves non-TTY flags, and forwards command failures', () => {
        const runtime = { containerName: 'demo', execCommand: 'codex exec', quiet: {} };
        const driver = { startContainer: jest.fn() };
        const spawnSync = jest.fn(() => ({ status: 7 }));
        const assertProcessSucceeded = jest.fn(() => {
            throw new Error('容器命令执行失败');
        });

        expect(() => executeInContainer(runtime, 'codex', {
            containerExists: () => true,
            getContainerStatus: () => 'exited',
            getRuntimeDriver: () => driver,
            showHelloTip: jest.fn(),
            logCommand: jest.fn(),
            spawnSync,
            dockerCmd: 'docker',
            compileContainerExec: jest.fn(() => ['exec', 'demo', '/bin/bash']),
            stdinIsTTY: false,
            stdoutIsTTY: false,
            assertProcessSucceeded
        })).toThrow('容器命令执行失败');

        expect(driver.startContainer).toHaveBeenCalledWith('demo');
        expect(spawnSync).toHaveBeenCalledWith('docker', ['exec', 'demo', '/bin/bash'], { stdio: 'inherit' });
        expect(assertProcessSucceeded).toHaveBeenCalledWith({ status: 7 }, '容器命令执行失败');
    });

    test('retries transient inspect failures with bounded backoff until the container is running', async () => {
        const getContainerStatus = jest.fn()
            .mockImplementationOnce(() => { throw new Error('daemon busy'); })
            .mockReturnValueOnce('created')
            .mockReturnValueOnce('running');
        const sleep = jest.fn(async () => {});

        await waitForContainerReady('demo', {
            getContainerStatus,
            sleep,
            maxRetries: 3,
            initialDelay: 10,
            maxDelay: 15,
            onExited: jest.fn(),
            onTimeout: jest.fn()
        });

        expect(sleep.mock.calls).toEqual([[10], [15]]);
    });

    test('executes the first command once with its dedicated environment arguments', () => {
        const spawnSync = jest.fn(() => ({ status: 0 }));
        const runtime = {
            containerName: 'demo',
            firstExecCommand: 'setup',
            firstExecCommandPrefix: 'env A=1 ',
            firstExecCommandSuffix: ' --yes',
            firstContainerEnvs: ['-e', 'BOOT=1'],
            quiet: {}
        };

        executeFirstCommand(runtime, {
            joinExecCommand: (...parts) => parts.join(''),
            logCommand: jest.fn(),
            spawnSync,
            dockerCmd: 'docker',
            compileContainerExec: jest.fn(() => ['exec', 'demo', '/bin/bash']),
            stdinIsTTY: false,
            stdoutIsTTY: false,
            assertProcessSucceeded: jest.fn()
        });

        expect(spawnSync).toHaveBeenCalledWith('docker', ['exec', 'demo', '/bin/bash'], { stdio: 'inherit' });
    });

    test('creates, waits, then runs the one-time command in order', async () => {
        const runtime = {
            containerName: 'demo',
            execCommand: 'codex',
            execCommandPrefix: '',
            execCommandSuffix: '',
            quiet: {}
        };
        const order = [];
        const command = await createNewContainer(runtime, {
            joinExecCommand: (...parts) => parts.join(''),
            logCreating: jest.fn(),
            buildDockerRunArgs: jest.fn(() => ['run', 'demo']),
            dockerExecArgs: jest.fn(() => order.push('run')),
            showImagePullHint: jest.fn(),
            waitForContainerReady: jest.fn(async () => order.push('ready')),
            executeFirstCommand: jest.fn(() => order.push('first'))
        });

        expect(command).toBe('codex');
        expect(order).toEqual(['run', 'ready', 'first']);
    });

    test('delegates an existing container to the connection flow', async () => {
        const runtime = { containerName: 'demo', showCommand: false };
        const connectExistingContainer = jest.fn(async () => 'codex');

        await expect(setupContainer(runtime, {
            containerExists: () => true,
            createNewContainer: jest.fn(),
            connectExistingContainer
        })).resolves.toBe('codex');

        expect(connectExistingContainer).toHaveBeenCalledWith(runtime);
    });

    test('switches to a native resume command only when the adapter supports it', async () => {
        const runtime = { containerName: 'demo', execCommand: 'codex', quiet: {} };
        const askQuestion = jest.fn(async () => 'r');

        await expect(handlePostExit(runtime, 'codex exec', {
            removeContainer: jest.fn(),
            showHelloTip: jest.fn(),
            buildAgentResumeCommand: () => 'codex resume',
            askQuestion,
            log: jest.fn()
        })).resolves.toBe(true);

        expect(runtime.execCommand).toBe('codex resume');
        expect(askQuestion).toHaveBeenCalledTimes(1);
    });
});
