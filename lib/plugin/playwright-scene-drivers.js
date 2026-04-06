'use strict';

const fs = require('fs');
const path = require('path');

function createPlaywrightSceneDrivers(options = {}) {
    const plugin = options.plugin;
    const sceneDefs = options.sceneDefs || {};
    const isCliScene = options.isCliScene || (() => false);
    const asStringArray = options.asStringArray || ((value, fallback) => fallback);
    const tailText = options.tailText || (() => '');
    const sleep = options.sleep || (async () => {});

    return {
        container: {
            up: async (sceneName, actionOptions = {}) => {
                const runtime = plugin.ensureContainerRuntimeAvailable('up', sceneName);
                if (!runtime) {
                    return 1;
                }

                try {
                    plugin.ensureContainerScenePrerequisites(sceneName);
                } catch (error) {
                    return error.returncode || 1;
                }

                const incomingExtensionPaths = asStringArray(actionOptions.extensionPaths, []);
                const hostInitScriptPath = plugin.sceneInitScriptPath(sceneName);
                const containerInitScriptPath = path.posix.join('/app/config', path.basename(hostInitScriptPath));
                let configOptions = {
                    ...actionOptions,
                    extensionPaths: incomingExtensionPaths,
                    initScript: [containerInitScriptPath]
                };
                const composeFiles = [plugin.containerComposePath(sceneName)];
                const volumeMounts = [`${hostInitScriptPath}:${containerInitScriptPath}:ro`];

                if (incomingExtensionPaths.length > 0) {
                    const mapped = plugin.buildContainerExtensionMounts(incomingExtensionPaths);
                    volumeMounts.push(...mapped.volumeMounts);
                    configOptions = {
                        ...actionOptions,
                        extensionPaths: mapped.containerPaths,
                        initScript: [containerInitScriptPath]
                    };
                }
                const cfgPath = plugin.ensureSceneConfig(sceneName, configOptions);
                const overridePath = plugin.ensureContainerComposeOverride(sceneName, volumeMounts);
                if (overridePath) {
                    composeFiles.push(overridePath);
                }

                const env = plugin.containerEnv(sceneName, cfgPath, { requireVncPassword: true });

                try {
                    const args = plugin.buildContainerComposeCommand(sceneName, composeFiles, ['up', '-d']);
                    plugin.runCmd(args, { env, check: true });
                } catch (error) {
                    return error.returncode || 1;
                }

                const port = plugin.scenePort(sceneName);
                if (await plugin.waitForPort(port)) {
                    plugin.writeStdout(`[up] ${sceneName} ready on 127.0.0.1:${port}`);
                    return 0;
                }

                plugin.writeStderr(`[up] ${sceneName} did not become ready on 127.0.0.1:${port}`);
                return 1;
            },
            down: (sceneName) => {
                if (!plugin.ensureContainerRuntimeAvailable('down', sceneName)) {
                    return 1;
                }

                plugin.ensureContainerComposeOverride(sceneName, []);
                const cfgPath = plugin.sceneConfigPath(sceneName);
                const env = plugin.containerEnv(sceneName, cfgPath);

                try {
                    plugin.runCmd(plugin.buildContainerComposeCommand(sceneName, [], ['down']), { env, check: true });
                } catch (error) {
                    return error.returncode || 1;
                }

                plugin.writeStdout(`[down] ${sceneName}`);
                return 0;
            },
            status: (sceneName) => {
                const runtime = plugin.ensureContainerRuntimeAvailable('status', sceneName);
                if (!runtime) {
                    return 1;
                }

                const def = sceneDefs[sceneName];
                const cp = plugin.runCmd([
                    runtime,
                    'ps',
                    '--filter',
                    `name=${def.containerName}`,
                    '--format',
                    '{{.Names}}'
                ], { captureOutput: true, check: false });

                const names = new Set(
                    cp.stdout
                        .split(/\r?\n/)
                        .map(line => line.trim())
                        .filter(Boolean)
                );

                if (names.has(def.containerName)) {
                    plugin.writeStdout(`[status] ${sceneName} running`);
                } else {
                    plugin.writeStdout(`[status] ${sceneName} stopped`);
                }
                return 0;
            },
            logs: (sceneName) => {
                const runtime = plugin.ensureContainerRuntimeAvailable('logs', sceneName);
                if (!runtime) {
                    return 1;
                }

                const def = sceneDefs[sceneName];
                const cp = plugin.runCmd([
                    runtime,
                    'logs',
                    '--tail',
                    '80',
                    def.containerName
                ], { captureOutput: true, check: false });

                const output = cp.stdout || cp.stderr;
                if (output.trim()) {
                    plugin.writeStdout(output.trimEnd());
                } else {
                    plugin.writeStdout(`[logs] ${sceneName} no logs`);
                }

                return cp.returncode === 0 ? 0 : 1;
            }
        },
        host: {
            up: async (sceneName, actionOptions = {}) => {
                try {
                    plugin.ensureCliHostHeadedCacheDir(sceneName);
                    plugin.ensureHostScenePrerequisites(sceneName);
                } catch (error) {
                    plugin.writeStderr(`[up] ${sceneName} failed: ${error.message || String(error)}`);
                    return error.returncode || 1;
                }

                fs.mkdirSync(plugin.config.runDir, { recursive: true });
                const cfgPath = plugin.ensureSceneConfig(sceneName, actionOptions);
                const pidFile = plugin.scenePidFile(sceneName);
                const logFile = plugin.sceneLogFile(sceneName);
                plugin.clearHostSceneRuntimeState(sceneName);

                let { port, managedPids, portReachable } = await plugin.getHostSceneRuntimeInfo(sceneName);
                if (managedPids.length > 0 && portReachable) {
                    plugin.writeStdout(`[up] ${sceneName} already running (pid(s) ${managedPids.join(' ')})`);
                    return 0;
                }

                if (portReachable) {
                    plugin.writeStderr(`[up] ${sceneName} failed: port ${port} is already in use by another process.`);
                    plugin.writeStderr('Stop the conflicting process first, then retry.');
                    return 1;
                }

                fs.rmSync(pidFile, { force: true });
                const logFd = fs.openSync(logFile, 'a');
                let launchCommand = null;
                try {
                    launchCommand = plugin.hostLaunchCommand(sceneName, cfgPath);
                } catch (error) {
                    fs.closeSync(logFd);
                    plugin.writeStderr(`[up] ${sceneName} failed: ${error.message || String(error)}`);
                    return 1;
                }

                const starter = plugin.spawnHostProcess(launchCommand.command, launchCommand.args, logFd);
                fs.closeSync(logFd);
                if (typeof starter.unref === 'function') {
                    starter.unref();
                }

                if (await plugin.waitForPort(port)) {
                    if (isCliScene(sceneName)) {
                        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
                        plugin.writeSceneEndpoint(sceneName, {
                            port,
                            wsPath: String(cfg.wsPath || '')
                        });
                    }
                    managedPids = await plugin.waitForHostPids(sceneName, starter.pid);
                    if (managedPids.length > 0) {
                        plugin.writeScenePidFile(pidFile, managedPids[0]);
                        plugin.writeStdout(`[up] ${sceneName} ready on 127.0.0.1:${port} (pid(s) ${managedPids.join(' ')})`);
                        plugin.remindCliSessionScene(sceneName);
                        return 0;
                    }
                }

                plugin.writeStderr(`[up] ${sceneName} failed to start. tail ${logFile}:`);
                const tail = tailText(logFile, 30);
                if (tail) {
                    plugin.writeStderr(tail);
                }

                if (starter.exitCode === null && !starter.killed) {
                    plugin.stopHostStarter(starter.pid);
                }

                return 1;
            },
            down: async (sceneName) => {
                const { pidFile, port, managedPids } = await plugin.getHostSceneRuntimeInfo(sceneName);
                plugin.clearHostSceneRuntimeState(sceneName);
                plugin.signalPids(managedPids);

                if (managedPids.length > 0) {
                    await sleep(300);
                }

                const pidFromFile = plugin.readPidFilePid(pidFile);
                if (pidFromFile > 0) {
                    plugin.signalPids([pidFromFile]);
                    fs.rmSync(pidFile, { force: true });
                }

                if (await plugin.portReady(port)) {
                    plugin.writeStderr(`[down] ${sceneName} warning: port ${port} is still in use (possibly unmanaged process)`);
                    return 1;
                }

                plugin.writeStdout(`[down] ${sceneName}`);
                return 0;
            },
            status: async (sceneName) => {
                const { pidFile, port, managedPids, portReachable } = await plugin.getHostSceneRuntimeInfo(sceneName);

                if (managedPids.length > 0 && portReachable) {
                    plugin.writeStdout(`[status] ${sceneName} running (pid(s) ${managedPids.join(' ')})`);
                    if (plugin.readPidFilePid(pidFile) <= 0) {
                        plugin.writeScenePidFile(pidFile, managedPids[0]);
                    }
                    return 0;
                }

                if (managedPids.length > 0 && !portReachable) {
                    plugin.writeStdout(`[status] ${sceneName} degraded (pid(s) ${managedPids.join(' ')}, port ${port} not reachable)`);
                    return 0;
                }

                fs.rmSync(pidFile, { force: true });
                if (portReachable) {
                    plugin.writeStdout(`[status] ${sceneName} conflict (port ${port} in use by unmanaged process)`);
                } else {
                    plugin.writeStdout(`[status] ${sceneName} stopped`);
                }
                return 0;
            },
            logs: (sceneName) => {
                const logFile = plugin.sceneLogFile(sceneName);
                if (!fs.existsSync(logFile)) {
                    plugin.writeStdout(`[logs] ${sceneName} no log file: ${logFile}`);
                    return 0;
                }

                const tail = tailText(logFile, 80);
                if (tail) {
                    plugin.writeStdout(tail);
                }
                return 0;
            }
        }
    };
}

module.exports = {
    createPlaywrightSceneDrivers
};
