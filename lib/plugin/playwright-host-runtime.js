'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function createPlaywrightHostRuntimeManager(options = {}) {
    const plugin = options.plugin;
    const isCliScene = options.isCliScene || (() => false);
    const sleep = options.sleep || (async () => {});

    return {
        hostLaunchCommand(sceneName, cfgPath) {
            if (isCliScene(sceneName)) {
                return {
                    command: plugin.playwrightBinPath(sceneName),
                    args: ['launch-server', '--browser', plugin.defaultBrowserName(sceneName), '--config', String(cfgPath)]
                };
            }
            return {
                command: plugin.localBinPath('playwright-mcp'),
                args: ['--config', String(cfgPath)]
            };
        },
        spawnHostProcess(command, args, logFd) {
            return spawn(command, args, {
                detached: true,
                stdio: ['ignore', logFd, logFd]
            });
        },
        stopHostStarter(pid) {
            if (!Number.isInteger(pid) || pid <= 0) {
                return;
            }
            try {
                process.kill(-pid, 'SIGTERM');
                return;
            } catch {
                // no-op
            }
            try {
                process.kill(pid, 'SIGTERM');
            } catch {
                // no-op
            }
        },
        hostScenePids(sceneName) {
            const cfgPath = plugin.sceneConfigPath(sceneName);
            const pattern = isCliScene(sceneName)
                ? `playwright.*launch-server.*--config ${cfgPath}`
                : `playwright-mcp.*--config ${cfgPath}`;
            const cp = plugin.runCmd(['pgrep', '-f', pattern], { captureOutput: true, check: false });

            if (cp.returncode !== 0 || !cp.stdout.trim()) {
                return [];
            }

            const pids = [];
            for (const line of cp.stdout.split(/\r?\n/)) {
                const text = line.trim();
                if (/^\d+$/.test(text)) {
                    pids.push(Number(text));
                }
            }
            return pids;
        },
        async waitForHostPids(sceneName, fallbackPid) {
            for (let i = 0; i < 5; i += 1) {
                const pids = this.hostScenePids(sceneName);
                if (pids.length > 0) {
                    return pids;
                }
                // eslint-disable-next-line no-await-in-loop
                await sleep(100);
            }
            if (Number.isInteger(fallbackPid) && fallbackPid > 0) {
                return [fallbackPid];
            }
            return [];
        },
        async getHostSceneRuntimeInfo(sceneName) {
            const pidFile = plugin.scenePidFile(sceneName);
            const port = plugin.scenePort(sceneName);
            const managedPids = this.hostScenePids(sceneName);
            const portReachable = await plugin.portReady(port);
            return { pidFile, port, managedPids, portReachable };
        },
        signalPids(pids, signal = 'SIGTERM') {
            const values = Array.isArray(pids) ? pids : [];
            values.forEach(pid => {
                try {
                    process.kill(pid, signal);
                } catch {
                    // no-op
                }
            });
        },
        readPidFilePid(pidFile) {
            if (!fs.existsSync(pidFile)) {
                return 0;
            }
            const text = fs.readFileSync(pidFile, 'utf8').trim();
            return /^\d+$/.test(text) ? Number(text) : 0;
        },
        writeScenePidFile(pidFile, pid) {
            fs.mkdirSync(path.dirname(pidFile), { recursive: true });
            fs.writeFileSync(pidFile, `${pid}`, 'utf8');
        }
    };
}

module.exports = {
    createPlaywrightHostRuntimeManager
};
