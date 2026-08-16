'use strict';

async function connectExistingContainer(runtime, dependencies) {
    if (!(runtime.quiet.cnew || runtime.quiet.full)) {
        dependencies.log(runtime.containerName);
    }
    const driver = dependencies.getRuntimeDriver();
    if (dependencies.getContainerStatus(runtime.containerName) !== 'running') {
        driver.startContainer(runtime.containerName);
    }
    const defaultCommand = driver.getDefaultCommand(runtime.containerName);
    runtime.execCommand = runtime.execCommand
        ? dependencies.joinExecCommand(runtime.execCommandPrefix, runtime.execCommand, runtime.execCommandSuffix)
        : dependencies.joinExecCommand(runtime.execCommandPrefix, defaultCommand, runtime.execCommandSuffix);
    return defaultCommand;
}

async function createNewContainer(runtime, dependencies) {
    if (!(runtime.quiet.cnew || runtime.quiet.full)) {
        dependencies.logCreating(runtime.containerName);
    }
    runtime.execCommand = dependencies.joinExecCommand(
        runtime.execCommandPrefix,
        runtime.execCommand,
        runtime.execCommandSuffix
    );
    const defaultCommand = runtime.execCommand;
    if (runtime.showCommand) {
        dependencies.logCommandPreview(runtime);
        dependencies.exit(0);
        return defaultCommand;
    }
    try {
        dependencies.dockerExecArgs(dependencies.buildDockerRunArgs(runtime), { stdio: 'pipe' });
    } catch (e) {
        dependencies.showImagePullHint(e);
        throw e;
    }
    await dependencies.waitForContainerReady(runtime.containerName);
    dependencies.executeFirstCommand(runtime);
    return defaultCommand;
}

async function setupContainer(runtime, dependencies) {
    if (runtime.showCommand) {
        if (dependencies.containerExists(runtime.containerName)) {
            const defaultCommand = dependencies.getRuntimeDriver().getDefaultCommand(runtime.containerName);
            const execCommand = runtime.execCommand
                ? dependencies.joinExecCommand(runtime.execCommandPrefix, runtime.execCommand, runtime.execCommandSuffix)
                : dependencies.joinExecCommand(runtime.execCommandPrefix, defaultCommand, runtime.execCommandSuffix);
            dependencies.logExistingCommandPreview(runtime.containerName, execCommand);
            dependencies.exit(0);
            return defaultCommand;
        }
        runtime.execCommand = dependencies.joinExecCommand(runtime.execCommandPrefix, runtime.execCommand, runtime.execCommandSuffix);
        dependencies.logNewCommandPreview(runtime);
        dependencies.exit(0);
        return runtime.execCommand;
    }
    return dependencies.containerExists(runtime.containerName)
        ? dependencies.connectExistingContainer(runtime)
        : dependencies.createNewContainer(runtime);
}

async function handlePostExit(runtime, defaultCommand, dependencies) {
    if (runtime.rmOnExit) {
        dependencies.removeContainer(runtime.containerName);
        return false;
    }
    dependencies.showHelloTip(runtime.containerName, defaultCommand, runtime.execCommand);
    const resumeCommand = dependencies.buildAgentResumeCommand(defaultCommand);
    const hasResumeAction = Boolean(resumeCommand);
    const menuResume = hasResumeAction ? ', r=恢复首次命令会话' : '';
    const quietResume = hasResumeAction ? ' r' : '';
    const prompt = runtime.quiet.askkeep || runtime.quiet.full
        ? `保留容器吗? [y n 1${quietResume} x i] `
        : `❔ 会话已结束。是否保留此后台容器 ${runtime.containerName}? [ y=默认保留, n=删除, 1=首次命令进入${menuResume}, x=执行命令, i=交互式SHELL ]: `;
    const firstChar = (await dependencies.askQuestion(prompt)).trim().toLowerCase()[0];
    if (firstChar === 'n') {
        dependencies.removeContainer(runtime.containerName);
        return false;
    }
    if (firstChar === '1') {
        dependencies.log('first');
        runtime.execCommandPrefix = '';
        runtime.execCommandSuffix = '';
        runtime.execCommand = defaultCommand;
        return true;
    }
    if (firstChar === 'r' && hasResumeAction) {
        dependencies.log('resume');
        runtime.execCommandPrefix = '';
        runtime.execCommandSuffix = '';
        runtime.execCommand = resumeCommand;
        return true;
    }
    if (firstChar === 'x') {
        const command = await dependencies.askQuestion('❔ 输入要执行的命令: ');
        dependencies.log('command');
        runtime.execCommandPrefix = '';
        runtime.execCommandSuffix = '';
        runtime.execCommand = command;
        return true;
    }
    if (firstChar === 'i') {
        dependencies.log('shell');
        runtime.execCommandPrefix = '';
        runtime.execCommandSuffix = '';
        runtime.execCommand = '/bin/bash';
        return true;
    }
    dependencies.log('keep', runtime.containerName);
    return false;
}

function executeInContainer(runtime, defaultCommand, dependencies) {
    if (!dependencies.containerExists(runtime.containerName)) {
        throw new Error(`未找到容器: ${runtime.containerName}`);
    }

    if (dependencies.getContainerStatus(runtime.containerName) !== 'running') {
        dependencies.getRuntimeDriver().startContainer(runtime.containerName);
    }

    dependencies.showHelloTip(runtime.containerName, defaultCommand, runtime.execCommand);
    if (!(runtime.quiet.cmd || runtime.quiet.full)) {
        dependencies.logCommand(runtime.execCommand);
    }

    const result = dependencies.spawnSync(
        dependencies.dockerCmd,
        dependencies.compileContainerExec(runtime.containerName, runtime.execCommand, {
            stdinIsTTY: dependencies.stdinIsTTY,
            stdoutIsTTY: dependencies.stdoutIsTTY
        }),
        { stdio: 'inherit' }
    );
    dependencies.assertProcessSucceeded(result, '容器命令执行失败');
}

async function waitForContainerReady(containerName, dependencies) {
    let retryDelay = dependencies.initialDelay;
    for (let count = 0; count < dependencies.maxRetries; count++) {
        try {
            const status = dependencies.getContainerStatus(containerName);
            if (status === 'running') return true;
            if (status === 'exited') {
                dependencies.onExited(containerName);
                return false;
            }
        } catch (e) {
            // Keep the original retry behavior when inspect is briefly unavailable.
        }
        await dependencies.sleep(retryDelay);
        retryDelay = Math.min(retryDelay * 2, dependencies.maxDelay);
    }
    dependencies.onTimeout(containerName);
    return false;
}

function executeFirstCommand(runtime, dependencies) {
    if (!runtime.firstExecCommand || !String(runtime.firstExecCommand).trim()) return;
    const firstCommand = dependencies.joinExecCommand(
        runtime.firstExecCommandPrefix,
        runtime.firstExecCommand,
        runtime.firstExecCommandSuffix
    );
    if (!(runtime.quiet.cmd || runtime.quiet.full)) {
        dependencies.logCommand(firstCommand);
    }
    const result = dependencies.spawnSync(
        dependencies.dockerCmd,
        dependencies.compileContainerExec(runtime.containerName, firstCommand, {
            stdinIsTTY: dependencies.stdinIsTTY,
            stdoutIsTTY: dependencies.stdoutIsTTY,
            extraArgs: runtime.firstContainerEnvs || []
        }),
        { stdio: 'inherit' }
    );
    dependencies.assertProcessSucceeded(result, '首次预执行命令失败');
}

module.exports = {
    connectExistingContainer,
    createNewContainer,
    setupContainer,
    executeFirstCommand,
    executeInContainer,
    handlePostExit,
    waitForContainerReady
};
