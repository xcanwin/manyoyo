'use strict';

function buildContainerExecArgs(containerName, command, options = {}) {
    const ttyArgs = [];
    if (options.stdinIsTTY && options.stdoutIsTTY) {
        ttyArgs.push('-it');
    } else if (options.stdinIsTTY) {
        ttyArgs.push('-i');
    } else if (options.stdoutIsTTY) {
        ttyArgs.push('-t');
    }

    const args = ['exec', ...ttyArgs, ...(options.extraArgs || []), containerName, '/bin/bash'];
    if (command) {
        args.push('-c', command);
    }
    return args;
}

function assertProcessSucceeded(result, action) {
    if (result.error) {
        throw result.error;
    }
    if (result.signal) {
        throw new Error(`${action}被信号终止，信号: ${result.signal}`);
    }
    if (typeof result.status === 'number' && result.status !== 0) {
        throw new Error(`${action}，退出码: ${result.status}`);
    }
}

module.exports = {
    buildContainerExecArgs,
    assertProcessSucceeded
};
