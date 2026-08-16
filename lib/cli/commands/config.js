'use strict';

function registerConfigCommands(command, dependencies) {
    const {
        applyRunStyleOptions,
        enableShellSuffixPassThrough,
        validateShellSuffixPassThroughArgs,
        selectAction
    } = dependencies;
    const configCommand = command.command('config').description('查看解析后的配置或命令');
    const configShowCommand = configCommand.command('show').description('显示最终生效配置并退出');
    applyRunStyleOptions(configShowCommand, { includeRmOnExit: false, includeServePreview: true });
    configShowCommand.option('--explain', '显示每个最终配置值的来源');
    enableShellSuffixPassThrough(configShowCommand);
    configShowCommand.action((options, commanderCommand) => {
        validateShellSuffixPassThroughArgs(commanderCommand);
        const finalOptions = { ...options, showConfig: true };
        if (options.serve !== undefined) {
            finalOptions.server = options.serve;
            finalOptions.serverUser = options.user;
            finalOptions.serverPass = options.pass;
            finalOptions.serverTrustProxy = options.trustProxy;
        }
        selectAction('config-show', finalOptions);
    });

    const configRunCommand = configCommand.command('command').description('显示将执行的 docker run 命令并退出');
    applyRunStyleOptions(configRunCommand, { includeRmOnExit: false });
    enableShellSuffixPassThrough(configRunCommand);
    configRunCommand.action((options, commanderCommand) => {
        validateShellSuffixPassThroughArgs(commanderCommand);
        selectAction('config-command', options);
    });
}

module.exports = { registerConfigCommands };
