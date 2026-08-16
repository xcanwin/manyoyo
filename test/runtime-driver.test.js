'use strict';

const {
    compileContainerRun,
    compileContainerExec,
    createRuntimeDriver
} = require('../lib/runtime/driver');

test('runtime driver compiles run and exec arguments from shared contracts', () => {
    expect(compileContainerRun({
        containerName: 'demo', hostPath: '/host', containerPath: '/work',
        imageName: 'image', imageVersion: '1.0.0-common', defaultCommand: ''
    })).toEqual(expect.arrayContaining(['run', '-d', '--name', 'demo', 'image:1.0.0-common']));
    expect(compileContainerExec('demo', 'echo ok', { stdinIsTTY: false, stdoutIsTTY: false }))
        .toEqual(['exec', 'demo', '/bin/bash', '-c', 'echo ok']);
});

test('runtime driver provides lifecycle operations through an injected executor', () => {
    const execute = jest.fn((args) => {
        if (args[0] === 'ps') return 'demo\nother\n';
        if (args[0] === 'inspect' && args[3] === 'demo' && args[2] === '{{.State.Status}}') return 'running\n';
        if (args[0] === 'inspect') return 'codex exec\n';
        return '';
    });
    const driver = createRuntimeDriver(execute);

    expect(driver.containerExists('demo')).toBe(true);
    expect(driver.containerExists('missing')).toBe(false);
    expect(driver.getContainerStatus('demo')).toBe('running');
    expect(driver.getDefaultCommand('demo')).toBe('codex exec');
    driver.startContainer('demo');
    driver.removeContainer('demo');

    expect(execute).toHaveBeenCalledWith(['start', 'demo'], { stdio: 'pipe' });
    expect(execute).toHaveBeenCalledWith(['rm', '-f', 'demo'], { stdio: 'pipe' });
});
