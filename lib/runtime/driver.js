'use strict';

const { buildContainerRunArgs } = require('../container-run');
const { buildContainerExecArgs } = require('./container-exec');

function compileContainerRun(runtime) {
    return buildContainerRunArgs(runtime);
}

function compileContainerExec(containerName, command, options) {
    return buildContainerExecArgs(containerName, command, options);
}

function createRuntimeDriver(execute) {
    if (typeof execute !== 'function') {
        throw new TypeError('RuntimeDriver 需要 execute(args, options) 函数');
    }

    return {
        run: (args, options) => execute(args, options),
        containerExists(name) {
            const names = String(execute(['ps', '-a', '--format', '{{.Names}}']) || '');
            return names.split('\n').some(item => item.trim() === name);
        },
        getContainerStatus(name) {
            return String(execute(['inspect', '-f', '{{.State.Status}}', name]) || '').trim();
        },
        getDefaultCommand(name) {
            return String(execute(['inspect', '-f', '{{index .Config.Labels "manyoyo.default_cmd"}}', name]) || '').trim();
        },
        startContainer(name) {
            return execute(['start', name], { stdio: 'pipe' });
        },
        removeContainer(name) {
            return execute(['rm', '-f', name], { stdio: 'pipe' });
        }
    };
}

module.exports = { compileContainerRun, compileContainerExec, createRuntimeDriver };
