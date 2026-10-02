'use strict';

const { spawnSync } = require('child_process');
const { getPrivatePodmanPaths } = require('./container-runtime');

function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function privateEnv(paths) {
    return {
        XDG_CONFIG_HOME: paths.configHome,
        XDG_DATA_HOME: paths.dataHome,
        CONTAINERS_CONF: paths.containersConf
    };
}

/**
 * 输出可以 eval 的 shell 代码：只在当前终端定义一个 podman 函数（带上私有 Podman 的绝对路径与环境变量），
 * 不改全局 PATH / XDG_*，不影响用户自己的其它工具。
 */
function buildShellFunction(paths, shell = 'sh') {
    const env = privateEnv(paths);
    if (shell === 'fish') {
        const assigns = Object.entries(env).map(([key, value]) => `${key}=${shQuote(value)}`).join(' ');
        return `function podman\n    env ${assigns} ${shQuote(paths.bin)} $argv\nend\n`;
    }
    const assigns = Object.entries(env).map(([key, value]) => `${key}=${shQuote(value)}`).join(' ');
    return `podman() { env ${assigns} ${shQuote(paths.bin)} "$@"; }\n`;
}

function usageText(commandName) {
    return [
        `用法:`,
        `  ${commandName} podman <podman 参数...>     用 ${commandName} 的私有 Podman 执行一次，参数原样传给 podman`,
        `  eval "$(${commandName} podman env)"        在当前终端定义 podman 函数，之后直接输入 podman ps -a`,
        `  ${commandName} podman env --shell fish     fish 终端使用这个形式`,
        `说明: 函数只在当前终端有效，关闭终端即失效；不修改 PATH，也不影响你自己安装的 Podman。`
    ].join('\n');
}

/**
 * @returns {number} 退出码
 */
function runPodmanCommand(args, options = {}) {
    const log = options.log || (line => console.log(line));
    const errLog = options.errLog || (line => console.error(line));
    const commandName = options.commandName || 'manyoyo';
    const paths = getPrivatePodmanPaths(options.homeDir);
    const exists = options.exists || (file => require('fs').existsSync(file));
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        log(usageText(commandName));
        return 0;
    }
    if (!exists(paths.bin)) {
        errLog(`没有找到 ${commandName} 的私有 Podman（${paths.bin}）。当前没有使用私有 Podman：离线完整包安装后才有；使用你自己的 docker / podman 时直接用它们即可。`);
        return 1;
    }
    if (args[0] === 'env') {
        const rest = args.slice(1);
        let shell = '';
        for (let i = 0; i < rest.length; i += 1) {
            if (rest[i] === '--shell') { shell = rest[i + 1] || ''; i += 1; }
            else { errLog(`未知参数: ${rest[i]}`); return 2; }
        }
        if (!shell) shell = require('path').basename(String(options.shell || process.env.SHELL || 'sh'));
        log(buildShellFunction(paths, shell === 'fish' ? 'fish' : 'sh').trimEnd());
        return 0;
    }
    const run = options.spawnSync || spawnSync;
    const result = run(paths.bin, args, { stdio: 'inherit', env: { ...process.env, ...privateEnv(paths) } });
    if (result.error) {
        errLog(`无法执行私有 Podman: ${result.error.message}`);
        return 1;
    }
    if (result.signal) return 1;
    return result.status === null || result.status === undefined ? 1 : result.status;
}

module.exports = { runPodmanCommand, buildShellFunction, usageText };
