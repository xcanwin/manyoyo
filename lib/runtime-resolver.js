'use strict';

const crypto = require('crypto');

function toArray(value) {
    return Array.isArray(value) ? value : (value ? [value] : []);
}

function resolveRuntimeConfig(options = {}) {
    const params = options;
    const cliOptions = params.cliOptions || {};
    const globalConfig = params.globalConfig || {};
    const runConfig = params.runConfig || {};
    const globalFirstConfig = params.globalFirstConfig || {};
    const runFirstConfig = params.runFirstConfig || {};
    const defaults = params.defaults || {};
    const envVars = params.envVars || process.env;
    const pickConfigValue = params.pickConfigValue;
    const resolveContainerNameTemplate = params.resolveContainerNameTemplate;
    const normalizeCommandSuffix = params.normalizeCommandSuffix;
    const normalizeJsonEnvMap = params.normalizeJsonEnvMap;
    const normalizeCliEnvMap = params.normalizeCliEnvMap;
    const mergeArrayConfig = params.mergeArrayConfig;
    const normalizeVolume = params.normalizeVolume;
    const parseServerListen = params.parseServerListen;
    const resolveWorktreeSupport = params.resolveWorktreeSupport;
    const argv = Array.isArray(params.argv) ? params.argv : [];
    const isServerMode = params.isServerMode === true;
    const isServerStopMode = params.isServerStopMode === true;

    let hostPath = pickConfigValue(cliOptions.hostPath, runConfig.hostPath, globalConfig.hostPath, defaults.hostPath) || defaults.hostPath;
    let containerName = defaults.containerName;
    const mergedContainerName = pickConfigValue(cliOptions.contName, runConfig.containerName, globalConfig.containerName);
    if (mergedContainerName) {
        containerName = mergedContainerName;
    }
    containerName = resolveContainerNameTemplate(containerName);

    let containerPath = defaults.containerPath;
    const mergedContainerPath = pickConfigValue(cliOptions.contPath, runConfig.containerPath, globalConfig.containerPath);
    if (mergedContainerPath) {
        containerPath = mergedContainerPath;
    }

    const imageName = pickConfigValue(cliOptions.imageName, runConfig.imageName, globalConfig.imageName, defaults.imageName) || defaults.imageName;
    const imageVersion = pickConfigValue(cliOptions.imageVer, runConfig.imageVersion, globalConfig.imageVersion, defaults.imageVersion) || defaults.imageVersion;

    let execPrefix = '';
    const mergedShellPrefix = pickConfigValue(cliOptions.shellPrefix, runConfig.shellPrefix, globalConfig.shellPrefix);
    if (mergedShellPrefix) {
        execPrefix = `${mergedShellPrefix} `;
    }

    let execShell = '';
    const mergedShell = pickConfigValue(cliOptions.shell, runConfig.shell, globalConfig.shell);
    if (mergedShell) {
        execShell = mergedShell;
    }

    let execSuffix = '';
    const mergedShellSuffix = pickConfigValue(cliOptions.shellSuffix, runConfig.shellSuffix, globalConfig.shellSuffix);
    if (mergedShellSuffix) {
        execSuffix = normalizeCommandSuffix(mergedShellSuffix);
    }

    let firstExecPrefix = '';
    const mergedFirstShellPrefix = pickConfigValue(cliOptions.firstShellPrefix, runFirstConfig.shellPrefix, globalFirstConfig.shellPrefix);
    if (mergedFirstShellPrefix) {
        firstExecPrefix = `${mergedFirstShellPrefix} `;
    }

    let firstExecShell = '';
    const mergedFirstShell = pickConfigValue(cliOptions.firstShell, runFirstConfig.shell, globalFirstConfig.shell);
    if (mergedFirstShell) {
        firstExecShell = mergedFirstShell;
    }

    let firstExecSuffix = '';
    const mergedFirstShellSuffix = pickConfigValue(cliOptions.firstShellSuffix, runFirstConfig.shellSuffix, globalFirstConfig.shellSuffix);
    if (mergedFirstShellSuffix) {
        firstExecSuffix = normalizeCommandSuffix(mergedFirstShellSuffix);
    }

    const envFile = [
        ...toArray(globalConfig.envFile),
        ...toArray(runConfig.envFile),
        ...(cliOptions.envFile || [])
    ].filter(Boolean);

    const env = {
        ...normalizeJsonEnvMap(globalConfig.env, '全局配置'),
        ...normalizeJsonEnvMap(runConfig.env, '运行配置'),
        ...normalizeCliEnvMap(cliOptions.env)
    };

    const firstEnvFile = [
        ...toArray(globalFirstConfig.envFile),
        ...toArray(runFirstConfig.envFile),
        ...(cliOptions.firstEnvFile || [])
    ].filter(Boolean);

    const firstEnv = {
        ...normalizeJsonEnvMap(globalFirstConfig.env, '全局配置 first'),
        ...normalizeJsonEnvMap(runFirstConfig.env, '运行配置 first'),
        ...normalizeCliEnvMap(cliOptions.firstEnv)
    };

    let volumes = mergeArrayConfig(globalConfig.volumes, runConfig.volumes, cliOptions.volume)
        .map(volume => normalizeVolume(volume));
    const ports = mergeArrayConfig(globalConfig.ports, runConfig.ports, cliOptions.port);
    const imageBuildArgs = mergeArrayConfig(globalConfig.imageBuildArgs, runConfig.imageBuildArgs, cliOptions.imageBuildArg);

    const yolo = pickConfigValue(cliOptions.yolo, runConfig.yolo, globalConfig.yolo) || '';
    const containerMode = pickConfigValue(cliOptions.contMode, runConfig.containerMode, globalConfig.containerMode) || '';
    const quiet = pickConfigValue(cliOptions.quiet, runConfig.quiet, globalConfig.quiet) || [];

    if (cliOptions.shellFull) {
        execShell = cliOptions.shellFull.join(' ');
        execPrefix = '';
        execSuffix = '';
    }

    if (!cliOptions.shellFull) {
        const doubleDashIndex = argv.indexOf('--');
        if (doubleDashIndex !== -1 && doubleDashIndex < argv.length - 1) {
            execSuffix = normalizeCommandSuffix(argv.slice(doubleDashIndex + 1).join(' '));
        }
    }

    let serverHost = null;
    let serverPort = null;
    if (isServerMode) {
        const listen = parseServerListen(cliOptions.server);
        serverHost = listen.host;
        serverPort = listen.port;
    }

    let serverUser = pickConfigValue(cliOptions.serverUser, runConfig.serverUser, globalConfig.serverUser, envVars.MANYOYO_SERVER_USER) || '';
    let serverPass = pickConfigValue(cliOptions.serverPass, runConfig.serverPass, globalConfig.serverPass, envVars.MANYOYO_SERVER_PASS) || '';
    let serverPassAuto = false;
    if (isServerMode && !isServerStopMode) {
        if (!serverUser) {
            serverUser = 'admin';
        }
        if (!serverPass) {
            serverPass = crypto.randomBytes(12).toString('hex');
            serverPassAuto = true;
        }
    }

    if (!hostPath) {
        hostPath = defaults.hostPath;
    }

    let worktreeState = {
        enabled: false,
        worktreesRoot: null,
        worktreeRepoRoot: null,
        worktreeMainRepoRoot: null,
        extraVolumes: []
    };

    if (typeof resolveWorktreeSupport === 'function') {
        worktreeState = resolveWorktreeSupport({
            enabled: Boolean(cliOptions.worktrees || cliOptions.worktreesRoot),
            hostPath,
            containerPath,
            worktreesRoot: cliOptions.worktreesRoot,
            volumes
        });
        volumes = volumes.concat(worktreeState.extraVolumes || []);
    }

    return {
        hostPath,
        containerName,
        containerPath,
        imageName,
        imageVersion,
        envFile,
        env,
        firstEnvFile,
        firstEnv,
        volumes,
        ports,
        imageBuildArgs,
        worktrees: Boolean(worktreeState.enabled),
        worktreesRoot: worktreeState.worktreesRoot,
        worktreeRepoRoot: worktreeState.worktreeRepoRoot,
        worktreeMainRepoRoot: worktreeState.worktreeMainRepoRoot,
        containerMode,
        yolo,
        quiet,
        server: isServerMode,
        serverHost,
        serverPort,
        serverUser,
        serverPass,
        serverPassAuto,
        exec: {
            prefix: execPrefix,
            shell: execShell,
            suffix: execSuffix
        },
        first: {
            envFile: firstEnvFile,
            env: firstEnv,
            exec: {
                prefix: firstExecPrefix,
                shell: firstExecShell,
                suffix: firstExecSuffix
            }
        }
    };
}

module.exports = {
    resolveRuntimeConfig
};
