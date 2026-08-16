'use strict';

async function startConfiguredWebServer(runtime, dependencies) {
    const serverHandle = await dependencies.startWebServer({
        serverHost: runtime.serverHost,
        serverPort: runtime.serverPort,
        authUser: runtime.serverAuthUser,
        authPass: runtime.serverAuthPass,
        authPassAuto: runtime.serverAuthPassAuto,
        trustProxy: runtime.serverTrustProxy,
        dockerCmd: dependencies.dockerCmd,
        hostPath: runtime.hostPath,
        containerPath: runtime.containerPath,
        imageName: runtime.imageName,
        imageVersion: runtime.imageVersion,
        execCommandPrefix: runtime.execCommandPrefix,
        execCommand: runtime.execCommand,
        execCommandSuffix: runtime.execCommandSuffix,
        contModeArgs: runtime.contModeArgs,
        containerExtraArgs: runtime.containerExtraArgs,
        containerEnvs: runtime.containerEnvs,
        containerVolumes: runtime.containerVolumes,
        containerPorts: runtime.containerPorts,
        validateHostPath: dependencies.validateHostPath,
        formatDate: dependencies.formatDate,
        isValidContainerName: dependencies.isValidContainerName,
        containerExists: dependencies.containerExists,
        getContainerStatus: dependencies.getContainerStatus,
        waitForContainerReady: dependencies.waitForContainerReady,
        dockerExecArgs: dependencies.dockerExecArgs,
        showImagePullHint: dependencies.showImagePullHint,
        removeContainer: dependencies.removeContainer,
        webHistoryDir: dependencies.webHistoryDir,
        colors: dependencies.colors,
        logger: runtime.logger
    });
    dependencies.writeServePidFile(runtime, serverHandle);
    return serverHandle;
}

module.exports = { startConfiguredWebServer };
