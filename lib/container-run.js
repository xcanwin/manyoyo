'use strict';

function sanitizeDefaultCommand(defaultCommand) {
    return String(defaultCommand || '').replace(/[\r\n]/g, ' ');
}

function buildContainerRunArgs(options) {
    const args = [
        'run', '-d',
        '--name', options.containerName,
        '--entrypoint', '',
        ...(options.contModeArgs || []),
        ...(options.containerEnvs || []),
        ...(options.containerVolumes || []),
        ...(options.containerPorts || []),
        '--volume', `${options.hostPath}:${options.containerPath}`,
        '--workdir', options.containerPath,
        '--label', `manyoyo.default_cmd=${sanitizeDefaultCommand(options.defaultCommand)}`,
        `${options.imageName}:${options.imageVersion}`,
        'tail', '-f', '/dev/null'
    ];
    return args;
}

function quoteShellArg(value) {
    const text = String(value);
    if (text.includes(' ') || text.includes('"') || text.includes('=')) {
        return `"${text.replace(/"/g, '\\"')}"`;
    }
    return text;
}

function buildContainerRunCommand(dockerCmd, args) {
    return `${dockerCmd} ${args.map(quoteShellArg).join(' ')}`;
}

module.exports = {
    buildContainerRunArgs,
    buildContainerRunCommand
};
