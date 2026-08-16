'use strict';

function registerCoreCommands(program, dependencies) {
    const {
        manyoyoName,
        imageVersionHelpExample,
        applyRunStyleOptions,
        appendArrayOption,
        enableShellSuffixPassThrough,
        validateShellSuffixPassThroughArgs,
        selectAction
    } = dependencies;

    const runCommand = program.command('run').description('启动（容器不存在时）或连接（容器已存在时）容器并执行命令');
    runCommand.addHelpText('after', `
Examples:
  ${manyoyoName} run -r codex
  ${manyoyoName} run --rm-on-exit -x /bin/bash -lc "node -v"
  ${manyoyoName} run -n demo --first-shell "npm ci" -s "npm test"

Notes:
  参数优先级与合并规则（标量覆盖、数组追加、env 按 key 合并）请用 ${manyoyoName} config show --help 或查看文档。
`);
    applyRunStyleOptions(runCommand);
    enableShellSuffixPassThrough(runCommand);
    runCommand.action((options, command) => {
        validateShellSuffixPassThroughArgs(command);
        selectAction('run', options);
    });

    const buildCommand = program.command('build').description('构建 manyoyo 沙箱镜像');
    buildCommand
        .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
        .option('--in, --image-name <name>', '指定镜像名称')
        .option('--iv, --image-ver <version>', `指定镜像版本 (格式: x.y.z-后缀，如 ${imageVersionHelpExample})`)
        .option('--update-agents', '仅更新已有镜像内 Agent CLI 到 latest (Claude/Codex/Gemini/OpenCode)')
        .option('--yes', '所有提示自动确认 (用于CI/脚本)');
    appendArrayOption(buildCommand, '--iba, --image-build-arg <arg>', '构建镜像时传参给dockerfile (可多次使用)');
    buildCommand.action(options => selectAction('build', options));

    const removeCommand = program.command('rm <name>').description('删除指定容器');
    removeCommand
        .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
        .action((name, options) => selectAction('rm', { ...options, contName: name }));

    program.command('ps')
        .description('列举容器')
        .action(() => selectAction('ps', { contList: true }));

    program.command('images')
        .description('列举镜像')
        .action(() => selectAction('images', { imageList: true }));

    const serveCommand = program.command('serve [listen]').description('启动网页交互服务 (默认 127.0.0.1:3000)');
    applyRunStyleOptions(serveCommand, { includeRmOnExit: false, includeWebAuthOptions: true });
    serveCommand.option('-d, --detach', '后台启动网页服务并立即返回');
    serveCommand.option('--stop', '停止后台网页服务；必须显式传入 listen');
    serveCommand.option('--restart', '重启后台网页服务；必须显式传入 listen');
    serveCommand.action((listen, options) => {
        selectAction('serve', {
            ...options,
            server: listen === undefined ? true : listen,
            serverUser: options.user,
            serverPass: options.pass,
            serverTrustProxy: options.trustProxy
        });
    });

    const initCommand = program.command('init [agents]').description('初始化 Agent 配置到 ~/.manyoyo');
    initCommand
        .option('--yes', '所有提示自动确认 (用于CI/脚本)')
        .action((agents, options) => selectAction('init', { ...options, initConfig: agents === undefined ? 'all' : agents }));

    program.command('doctor')
        .description('诊断容器运行时、镜像、配置、Agent、模式、插件和端口')
        .option('-r, --run <name>', '加载运行配置 (从 ~/.manyoyo/manyoyo.json 的 runs.<name> 读取)')
        .option('--port <port>', '检查指定监听端口')
        .option('--json', '以 JSON 输出稳定诊断结果')
        .action(options => selectAction('doctor', { ...options, doctor: true }));

    program.command('update')
        .description('更新 MANYOYO（若检测为本地 file 安装则跳过）')
        .action(() => selectAction('update', { update: true }));

    program.command('install <name>')
        .description(`安装 ${manyoyoName} 命令 (docker-cli-plugin)`)
        .action(name => selectAction('install', { install: name }));

    program.command('prune')
        .description('清理悬空镜像和 <none> 镜像')
        .action(() => selectAction('prune', { imageRemove: true }));
}

module.exports = { registerCoreCommands };
