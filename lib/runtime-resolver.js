'use strict';

const crypto = require('crypto');
const { resolveContainerMode } = require('./runtime/container-modes');
const { validateResolvedRunSpec } = require('./core/run-spec');

function toArray(value) {
    return Array.isArray(value) ? value : (value ? [value] : []);
}

function resolveValueSource(layers, fallback = 'default') {
    const layer = layers.find(item => Boolean(item.value));
    return layer ? layer.source : fallback;
}

function mergeArrayWithSources(layers) {
    const values = [];
    const sources = [];
    for (const layer of layers) {
        for (const value of toArray(layer.value)) {
            if (!value) continue;
            values.push(value);
            sources.push(layer.source);
        }
    }
    return { values, sources };
}

function mergeEnvWithSources(layers) {
    const values = {};
    const sources = {};
    for (const layer of layers) {
        for (const [key, value] of Object.entries(layer.value)) {
            values[key] = value;
            sources[key] = layer.source;
        }
    }
    return { values, sources };
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

    const provenance = {};

    let hostPath = pickConfigValue(cliOptions.hostPath, runConfig.hostPath, globalConfig.hostPath, defaults.hostPath) || defaults.hostPath;
    provenance.hostPath = resolveValueSource([
        { source: 'cli', value: cliOptions.hostPath },
        { source: 'run', value: runConfig.hostPath },
        { source: 'global', value: globalConfig.hostPath },
        { source: 'default', value: defaults.hostPath }
    ]);
    let containerName = defaults.containerName;
    const mergedContainerName = pickConfigValue(cliOptions.contName, runConfig.containerName, globalConfig.containerName);
    provenance.containerName = resolveValueSource([
        { source: 'cli', value: cliOptions.contName },
        { source: 'run', value: runConfig.containerName },
        { source: 'global', value: globalConfig.containerName },
        { source: 'default', value: defaults.containerName }
    ]);
    if (mergedContainerName) {
        containerName = mergedContainerName;
    }
    containerName = resolveContainerNameTemplate(containerName);

    let containerPath = defaults.containerPath;
    const mergedContainerPath = pickConfigValue(cliOptions.contPath, runConfig.containerPath, globalConfig.containerPath);
    provenance.containerPath = resolveValueSource([
        { source: 'cli', value: cliOptions.contPath },
        { source: 'run', value: runConfig.containerPath },
        { source: 'global', value: globalConfig.containerPath },
        { source: 'default', value: defaults.containerPath }
    ]);
    if (mergedContainerPath) {
        containerPath = mergedContainerPath;
    }

    const imageName = pickConfigValue(cliOptions.imageName, runConfig.imageName, globalConfig.imageName, defaults.imageName) || defaults.imageName;
    const imageVersion = pickConfigValue(cliOptions.imageVer, runConfig.imageVersion, globalConfig.imageVersion, defaults.imageVersion) || defaults.imageVersion;
    provenance.imageName = resolveValueSource([
        { source: 'cli', value: cliOptions.imageName },
        { source: 'run', value: runConfig.imageName },
        { source: 'global', value: globalConfig.imageName },
        { source: 'default', value: defaults.imageName }
    ]);
    provenance.imageVersion = resolveValueSource([
        { source: 'cli', value: cliOptions.imageVer },
        { source: 'run', value: runConfig.imageVersion },
        { source: 'global', value: globalConfig.imageVersion },
        { source: 'default', value: defaults.imageVersion }
    ]);

    let execPrefix = '';
    const mergedShellPrefix = pickConfigValue(cliOptions.shellPrefix, runConfig.shellPrefix, globalConfig.shellPrefix);
    provenance.exec = {
        prefix: resolveValueSource([
            { source: 'cli', value: cliOptions.shellPrefix },
            { source: 'run', value: runConfig.shellPrefix },
            { source: 'global', value: globalConfig.shellPrefix }
        ]),
        shell: resolveValueSource([
            { source: 'cli', value: cliOptions.shell },
            { source: 'run', value: runConfig.shell },
            { source: 'global', value: globalConfig.shell }
        ]),
        suffix: resolveValueSource([
            { source: 'cli', value: cliOptions.shellSuffix },
            { source: 'run', value: runConfig.shellSuffix },
            { source: 'global', value: globalConfig.shellSuffix }
        ])
    };
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
    provenance.first = {
        exec: {
            prefix: resolveValueSource([
                { source: 'cli', value: cliOptions.firstShellPrefix },
                { source: 'run', value: runFirstConfig.shellPrefix },
                { source: 'global', value: globalFirstConfig.shellPrefix }
            ]),
            shell: resolveValueSource([
                { source: 'cli', value: cliOptions.firstShell },
                { source: 'run', value: runFirstConfig.shell },
                { source: 'global', value: globalFirstConfig.shell }
            ]),
            suffix: resolveValueSource([
                { source: 'cli', value: cliOptions.firstShellSuffix },
                { source: 'run', value: runFirstConfig.shellSuffix },
                { source: 'global', value: globalFirstConfig.shellSuffix }
            ])
        }
    };
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

    const envFileMerged = mergeArrayWithSources([
        { source: 'global', value: globalConfig.envFile },
        { source: 'run', value: runConfig.envFile },
        { source: 'cli', value: cliOptions.envFile }
    ]);
    const envFile = envFileMerged.values;
    provenance.envFile = envFileMerged.sources;

    const envMerged = mergeEnvWithSources([
        { source: 'global', value: normalizeJsonEnvMap(globalConfig.env, '全局配置') },
        { source: 'run', value: normalizeJsonEnvMap(runConfig.env, '运行配置') },
        { source: 'cli', value: normalizeCliEnvMap(cliOptions.env) }
    ]);
    const env = envMerged.values;
    provenance.env = envMerged.sources;

    const firstEnvFileMerged = mergeArrayWithSources([
        { source: 'global', value: globalFirstConfig.envFile },
        { source: 'run', value: runFirstConfig.envFile },
        { source: 'cli', value: cliOptions.firstEnvFile }
    ]);
    const firstEnvFile = firstEnvFileMerged.values;
    provenance.first.envFile = firstEnvFileMerged.sources;

    const firstEnvMerged = mergeEnvWithSources([
        { source: 'global', value: normalizeJsonEnvMap(globalFirstConfig.env, '全局配置 first') },
        { source: 'run', value: normalizeJsonEnvMap(runFirstConfig.env, '运行配置 first') },
        { source: 'cli', value: normalizeCliEnvMap(cliOptions.firstEnv) }
    ]);
    const firstEnv = firstEnvMerged.values;
    provenance.first.env = firstEnvMerged.sources;

    const volumeMerged = mergeArrayWithSources([
        { source: 'global', value: globalConfig.volumes },
        { source: 'run', value: runConfig.volumes },
        { source: 'cli', value: cliOptions.volume }
    ]);
    let volumes = mergeArrayConfig(globalConfig.volumes, runConfig.volumes, cliOptions.volume)
        .map(volume => normalizeVolume(volume));
    provenance.volumes = volumeMerged.sources;
    const portMerged = mergeArrayWithSources([
        { source: 'global', value: globalConfig.ports },
        { source: 'run', value: runConfig.ports },
        { source: 'cli', value: cliOptions.port }
    ]);
    const ports = mergeArrayConfig(globalConfig.ports, runConfig.ports, cliOptions.port);
    provenance.ports = portMerged.sources;
    const imageBuildArgMerged = mergeArrayWithSources([
        { source: 'global', value: globalConfig.imageBuildArgs },
        { source: 'run', value: runConfig.imageBuildArgs },
        { source: 'cli', value: cliOptions.imageBuildArg }
    ]);
    const imageBuildArgs = mergeArrayConfig(globalConfig.imageBuildArgs, runConfig.imageBuildArgs, cliOptions.imageBuildArg);
    provenance.imageBuildArgs = imageBuildArgMerged.sources;

    const yolo = pickConfigValue(cliOptions.yolo, runConfig.yolo, globalConfig.yolo) || '';
    const containerMode = pickConfigValue(cliOptions.contMode, runConfig.containerMode, globalConfig.containerMode) || '';
    const quiet = pickConfigValue(cliOptions.quiet, runConfig.quiet, globalConfig.quiet) || [];
    provenance.yolo = resolveValueSource([
        { source: 'cli', value: cliOptions.yolo },
        { source: 'run', value: runConfig.yolo },
        { source: 'global', value: globalConfig.yolo }
    ]);
    provenance.containerMode = resolveValueSource([
        { source: 'cli', value: cliOptions.contMode },
        { source: 'run', value: runConfig.containerMode },
        { source: 'global', value: globalConfig.containerMode }
    ]);
    provenance.quiet = resolveValueSource([
        { source: 'cli', value: cliOptions.quiet },
        { source: 'run', value: runConfig.quiet },
        { source: 'global', value: globalConfig.quiet }
    ]);

    if (cliOptions.shellFull) {
        execShell = cliOptions.shellFull.join(' ');
        execPrefix = '';
        execSuffix = '';
        provenance.exec = { prefix: 'cli', shell: 'cli', suffix: 'cli' };
    }

    if (!cliOptions.shellFull) {
        const doubleDashIndex = argv.indexOf('--');
        if (doubleDashIndex !== -1 && doubleDashIndex < argv.length - 1) {
            execSuffix = normalizeCommandSuffix(argv.slice(doubleDashIndex + 1).join(' '));
            provenance.exec.suffix = 'cli';
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
    const serverTrustProxy = pickConfigValue(cliOptions.serverTrustProxy, runConfig.serverTrustProxy, globalConfig.serverTrustProxy) === true;
    provenance.serverTrustProxy = resolveValueSource([
        { source: 'cli', value: cliOptions.serverTrustProxy },
        { source: 'run', value: runConfig.serverTrustProxy },
        { source: 'global', value: globalConfig.serverTrustProxy }
    ]);
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
        provenance.volumes = provenance.volumes.concat((worktreeState.extraVolumes || []).map(() => 'derived:worktrees'));
    }

    const resolvedContainerMode = resolveContainerMode(containerMode || 'common');
    const runSpec = validateResolvedRunSpec({
        configVersion: 1,
        image: { name: imageName, version: imageVersion },
        container: {
            name: containerName,
            mode: resolvedContainerMode.mode,
            modeArgs: resolvedContainerMode.args,
            hostPath,
            containerPath,
            envFile,
            env,
            volumes,
            ports,
            extraArgs: [],
            imageBuildArgs
        },
        process: {
            prefix: execPrefix,
            shell: execShell,
            suffix: execSuffix,
            tty: true
        },
        provenance
    });

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
        serverTrustProxy,
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
        },
        provenance,
        runSpec
    };
}

module.exports = {
    resolveRuntimeConfig
};
