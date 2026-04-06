'use strict';

const os = require('os');
const path = require('path');

function createWebServerContextHelpers(options = {}) {
    const createInitialWebRuntimeState = options.createInitialWebRuntimeState || (base => base);
    const getDefaultWebConfigPath = options.getDefaultWebConfigPath || (() => '');

    return {
        createWebServerContext(rawOptions = {}) {
            const fallbackLogger = {
                info: () => {},
                warn: () => {},
                error: () => {}
            };
            const ctx = {
                serverHost: rawOptions.serverHost || '127.0.0.1',
                serverPort: rawOptions.serverPort,
                authUser: rawOptions.authUser,
                authPass: rawOptions.authPass,
                authPassAuto: rawOptions.authPassAuto,
                dockerCmd: rawOptions.dockerCmd,
                hostPath: rawOptions.hostPath,
                containerPath: rawOptions.containerPath,
                imageName: rawOptions.imageName,
                imageVersion: rawOptions.imageVersion,
                execCommandPrefix: rawOptions.execCommandPrefix,
                execCommand: rawOptions.execCommand,
                execCommandSuffix: rawOptions.execCommandSuffix,
                contModeArgs: rawOptions.contModeArgs,
                containerExtraArgs: rawOptions.containerExtraArgs,
                containerEnvs: rawOptions.containerEnvs,
                containerVolumes: rawOptions.containerVolumes,
                containerPorts: rawOptions.containerPorts,
                validateHostPath: rawOptions.validateHostPath,
                formatDate: rawOptions.formatDate,
                isValidContainerName: rawOptions.isValidContainerName,
                containerExists: rawOptions.containerExists,
                getContainerStatus: rawOptions.getContainerStatus,
                waitForContainerReady: rawOptions.waitForContainerReady,
                dockerExecArgs: rawOptions.dockerExecArgs,
                showImagePullHint: rawOptions.showImagePullHint,
                removeContainer: rawOptions.removeContainer,
                logger: rawOptions.logger && typeof rawOptions.logger.info === 'function' ? rawOptions.logger : fallbackLogger,
                colors: rawOptions.colors || {
                    GREEN: '',
                    CYAN: '',
                    YELLOW: '',
                    NC: ''
                }
            };

            if (!ctx.authUser || !ctx.authPass) {
                throw new Error('Web 认证配置缺失，请设置 serve -U / serve -P');
            }

            return ctx;
        },
        createWebServerState(rawOptions = {}) {
            return createInitialWebRuntimeState({
                webHistoryDir: rawOptions.webHistoryDir || path.join(os.homedir(), '.manyoyo', 'web-history'),
                webConfigPath: rawOptions.webConfigPath || getDefaultWebConfigPath()
            });
        }
    };
}

module.exports = {
    createWebServerContextHelpers
};
