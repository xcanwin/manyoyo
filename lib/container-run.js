'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildMirrorEnvArgs } = require('./mirrors');

function sanitizeDefaultCommand(defaultCommand) {
    return String(defaultCommand || '').replace(/[\r\n]/g, ' ');
}

// 状态目录挂进容器的位置；PID 1 是 manyoyo 自带的 init（回收僵尸、响应 SIGTERM、跑自启动脚本）
const BOX_MOUNT = '/run/manyoyo';
const SYS_MOUNT = '/run/manyoyo-sys';
const GATE_MOUNT = '/run/manyoyo-gate';

// 用户已经自己指定网络（--network / --net）时不再加默认的 manyoyo bridge
function hasNetworkArg(args) {
    return (args || []).some(arg => /^--(network|net)(=|$)/.test(String(arg)));
}

function buildContainerRunArgs(options) {
    const st = options.state;
    if (!st || !st.id) throw new Error('缺少容器状态目录');
    const args = [
        'run', '-d',
        '--name', options.containerName,
        '--entrypoint', `${SYS_MOUNT}/init.sh`,
        // docker 默认带 NET_RAW（podman 默认不带）：有它的容器能发原始包 / 伪造 ARP，冒充别的容器的来源 IP，
        // 域名白名单的过滤代理就是按来源 IP 认容器的，所以统一去掉
        '--cap-drop', 'NET_RAW',
        ...(options.contModeArgs || []),
        ...(options.containerExtraArgs || []),
        ...(options.defaultNetwork && !hasNetworkArg([...(options.contModeArgs || []), ...(options.containerExtraArgs || [])])
            ? ['--network', options.defaultNetwork] : []),
        ...(options.containerEnvs || []),
        ...buildMirrorEnvArgs(options.mirrors, options.containerEnvs),
        ...(options.containerVolumes || []),
        ...(options.containerPorts || []),
        '--volume', `${st.box}:${BOX_MOUNT}`,
        '--volume', `${st.sys}:${SYS_MOUNT}:ro`,
        '--tmpfs', GATE_MOUNT,
        '--label', `manyoyo.id=${st.id}`,
        '--volume', `${options.hostPath}:${options.containerPath}`,
        '--workdir', options.containerPath,
        '--label', `manyoyo.default_cmd=${sanitizeDefaultCommand(options.defaultCommand)}`,
        `${options.imageName}:${options.imageVersion}`
    ];
    return args;
}

/**
 * 把命令行里的 `--env KEY=值` 挪进 0600 的临时 env 文件，改用 `--env-file` 传入，
 * 避免密钥出现在 ps / /proc 与错误信息里；exec 返回（或抛错）后立即删除文件。
 * 没有 KEY=值 形式的 env 时原样执行。
 */
function runWithEnvFile(args, dir, exec) {
    const rest = [];
    const lines = [];
    let envFileIndex = -1;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--env' && /^[^=]+=/.test(String(args[i + 1] ?? ''))) {
            if (envFileIndex < 0) envFileIndex = rest.length;
            lines.push(args[i + 1]);
            i += 1;
        } else {
            rest.push(args[i]);
        }
    }
    if (!lines.length) return exec(args);

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, `env-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    rest.splice(envFileIndex, 0, '--env-file', file);
    try {
        return exec(rest);
    } finally {
        fs.rmSync(file, { force: true });
    }
}

function quoteShellArg(value) {
    const text = String(value);
    if (text.includes(' ') || text.includes('"') || text.includes('=')) {
        return `"${text.replace(/"/g, '\\"')}"`;
    }
    return text;
}

function buildContainerRunCommand(dockerCmd, args) {
    return `${dockerCmd} ${args.map(quoteShellArg).join(' ')}`;
}

module.exports = {
    hasNetworkArg,
    BOX_MOUNT,
    SYS_MOUNT,
    GATE_MOUNT,
    buildContainerRunArgs,
    runWithEnvFile,
    buildContainerRunCommand
};
