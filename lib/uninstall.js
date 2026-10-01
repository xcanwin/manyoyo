'use strict';

// manyoyo uninstall：卸载离线包安装的 MANYOYO（方案 4.4）。
// 所有副作用（询问、执行命令、杀进程、日志）都从参数注入，便于用临时 HOME 测试。
// 只会碰 ~/.manyoyo 下的约定目录和 shell 配置里带标记的 manyoyo 块，绝不碰其它路径。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MACHINE_NAME = 'podman-machine-manyoyo';
const BLOCK_START = '# >>> manyoyo >>>';
const BLOCK_END = '# <<< manyoyo <<<';
const SHELL_FILES = ['.zprofile', '.zshrc', '.bash_profile', '.bashrc'];
// run/ 里只有 serve -d 的 pid 文件，属于程序状态
const PROGRAM_DIRS = ['bin', 'app', 'runtime', '.install', 'serve', 'run'];
const CONFIG_AND_HISTORY = ['manyoyo.json', 'web-history', 'logs', 'plugin'];
const MANYOYO_IMAGE_REPOS = ['ghcr.io/xcanwin/manyoyo', 'localhost/xcanwin/manyoyo'];

/**
 * 精确移除安装器写入的 PATH 块（含它前面那一个空行）。
 * 只认独占一行的起止标记；用户自己的内容、仅仅提到 manyoyo 的行都不会被动。
 */
function removeManagedBlock(text) {
    const lines = String(text).split('\n');
    const result = [];
    let index = 0;
    let removed = 0;
    while (index < lines.length) {
        if (lines[index] === BLOCK_START) {
            const end = lines.indexOf(BLOCK_END, index + 1);
            if (end !== -1) {
                if (result.length > 0 && result[result.length - 1] === '') result.pop();
                index = end + 1;
                removed += 1;
                continue;
            }
        }
        result.push(lines[index]);
        index += 1;
    }
    return { text: result.join('\n'), removed };
}

function defaultRun(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf-8', timeout: options.timeout || 60000, env: options.env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || '').trim() || `${command} 退出码 ${result.status}`);
    return result.stdout || '';
}

function defaultIsManyoyoServe(pid) {
    try {
        const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' }).stdout || '';
        return /manyoyo/.test(command) && /\bserve\b/.test(command);
    } catch (error) {
        return false;
    }
}

function defaultKill(pid) {
    try {
        process.kill(pid, 'SIGTERM');
        return true;
    } catch (error) {
        return false;
    }
}

function readPid(file) {
    try {
        const text = fs.readFileSync(file, 'utf-8');
        const json = text.trim().startsWith('{') ? JSON.parse(text).pid : Number(text.trim());
        return Number.isInteger(json) && json > 0 ? json : 0;
    } catch (error) {
        return 0;
    }
}

function removePath(target) {
    // symlink 只删链接本身，不会顺着删到目标
    fs.rmSync(target, { recursive: true, force: true });
}

const isYes = answer => /^y(es)?$/i.test(String(answer || '').trim());

async function runUninstall(options = {}) {
    const homeDir = options.homeDir || os.homedir();
    const root = path.join(homeDir, '.manyoyo');
    const ask = options.ask || (async () => '');
    const log = options.log || (() => {});
    const run = options.run || defaultRun;
    const yes = Boolean(options.yes);
    const isManyoyoServe = options.isManyoyoServe || defaultIsManyoyoServe;
    const kill = options.kill || defaultKill;
    const selectExternalRuntime = options.selectExternalRuntime || (() => null);
    const summary = { aborted: false, stopped: [], removed: [], kept: [], shellFiles: [], externalRemoved: { containers: [], images: [] } };

    const privatePodmanRoot = path.join(root, 'runtime', 'podman');
    const hasPrivatePodman = fs.existsSync(path.join(privatePodmanRoot, 'bin', 'podman'));

    if (!fs.existsSync(root)) {
        log(`没有找到 ${root}，无需卸载。`);
        summary.aborted = true;
        return summary;
    }

    if (!yes) {
        log(`将停止 MANYOYO 的后台服务${hasPrivatePodman ? '与私有 Podman 虚拟机' : ''}，并删除：`);
        log(`  ${PROGRAM_DIRS.filter(dir => fs.existsSync(path.join(root, dir))).map(dir => `~/.manyoyo/${dir}`).join('、') || '（没有程序目录）'}`);
        log('  shell 配置里由安装器添加的 PATH 块');
        if (hasPrivatePodman) log('  注意：私有 Podman 里的容器与镜像会一并删除（工作目录里的文件不受影响）。');
        log('你的配置、会话历史、日志与工作目录会在后面逐项询问。');
        if (!isYes(await ask('❔ 确认卸载? [y/N]: '))) {
            log('已取消，什么都没有改动。');
            summary.aborted = true;
            return summary;
        }
    }

    // 1. 停止后台服务（pid 必须确实是 manyoyo serve，避免 pid 复用误杀）
    const pidFiles = [path.join(root, 'serve', 'app.json')];
    const runServeDir = path.join(root, 'run', 'serve');
    if (fs.existsSync(runServeDir)) {
        for (const name of fs.readdirSync(runServeDir)) if (name.endsWith('.pid')) pidFiles.push(path.join(runServeDir, name));
    }
    for (const file of pidFiles) {
        const pid = readPid(file);
        if (pid && pid !== process.pid && isManyoyoServe(pid) && kill(pid)) {
            summary.stopped.push(`serve(pid ${pid})`);
            log(`已停止后台服务 (pid ${pid})`);
        }
    }
    const importPid = readPid(path.join(root, 'runtime', 'import', 'loading.json'));
    if (importPid && importPid !== process.pid && kill(importPid)) {
        summary.stopped.push(`镜像导入(pid ${importPid})`);
        log(`已停止后台镜像导入 (pid ${importPid})`);
    }

    // 2. 停止私有 Podman machine（尽力而为；之后整个 runtime/ 会被删除）
    if (hasPrivatePodman) {
        try {
            run(path.join(privatePodmanRoot, 'bin', 'podman'), ['machine', 'stop', MACHINE_NAME], {
                env: {
                    ...process.env,
                    XDG_CONFIG_HOME: path.join(privatePodmanRoot, 'config'),
                    XDG_DATA_HOME: path.join(privatePodmanRoot, 'data'),
                    CONTAINERS_CONF: path.join(privatePodmanRoot, 'containers.conf')
                }
            });
            summary.stopped.push(`虚拟机 ${MACHINE_NAME}`);
            log(`已停止虚拟机 ${MACHINE_NAME}`);
        } catch (error) {
            log(`提示：停止虚拟机时出错（${String(error.message).split('\n')[0]}），继续卸载。`);
        }
    }

    // 3. 复用的外部 Docker/Podman：只处理 manyoyo 的容器与镜像，运行时本身不动
    if (!hasPrivatePodman) {
        const external = selectExternalRuntime();
        if (external) {
            const containers = String(safeRun(run, external.command, ['ps', '-a', '--filter', 'label=manyoyo.default_cmd', '--format', '{{.Names}}'], external)).split('\n').map(s => s.trim()).filter(Boolean);
            const images = String(safeRun(run, external.command, ['images', '--format', '{{.Repository}}:{{.Tag}}'], external)).split('\n').map(s => s.trim())
                .filter(ref => MANYOYO_IMAGE_REPOS.some(repo => ref.startsWith(`${repo}:`)));
            if (containers.length + images.length > 0) {
                log(`在你的 ${external.command} 里发现 ${containers.length} 个 manyoyo 容器、${images.length} 个 manyoyo 镜像。`);
                // --yes 只确认程序本身的卸载；容器里可能有未保存的工作，不在 --yes 范围内
                if (!yes && isYes(await ask('❔ 删除这些容器与镜像（不会动 Docker/Podman 本身）? [y/N]: '))) {
                    for (const name of containers) { safeRun(run, external.command, ['rm', '-f', name], external); summary.externalRemoved.containers.push(name); }
                    for (const ref of images) { safeRun(run, external.command, ['rmi', ref], external); summary.externalRemoved.images.push(ref); }
                    log('已删除 manyoyo 的容器与镜像。');
                } else {
                    summary.kept.push('外部运行时里的 manyoyo 容器与镜像');
                }
            }
        }
    }

    // 4. 删除程序目录
    for (const dir of PROGRAM_DIRS) {
        const target = path.join(root, dir);
        if (fs.existsSync(target) || isDanglingLink(target)) {
            removePath(target);
            summary.removed.push(`~/.manyoyo/${dir}`);
        }
    }

    // 5. 移除 shell 配置里的 PATH 块
    for (const name of SHELL_FILES) {
        const file = path.join(homeDir, name);
        if (!fs.existsSync(file)) continue;
        const { text, removed } = removeManagedBlock(fs.readFileSync(file, 'utf-8'));
        if (removed > 0) {
            fs.writeFileSync(file, text);
            summary.shellFiles.push(name);
        }
    }
    if (summary.shellFiles.length > 0) log(`已从 ${summary.shellFiles.join('、')} 移除 PATH 块（新开终端后生效）`);

    // 6. 用户数据：逐项询问，默认保留；--yes 不会删除任何用户数据
    const dataItems = CONFIG_AND_HISTORY.filter(name => fs.existsSync(path.join(root, name)));
    if (dataItems.length > 0) {
        if (!yes && isYes(await ask(`❔ 同时删除配置、会话历史与日志（${dataItems.join('、')}）? [y/N]: `))) {
            dataItems.forEach(name => { removePath(path.join(root, name)); summary.removed.push(`~/.manyoyo/${name}`); });
        } else {
            summary.kept.push(...dataItems.map(name => `~/.manyoyo/${name}`));
        }
    }
    const workpath = path.join(root, 'workpath');
    if (fs.existsSync(workpath)) {
        if (!yes && isYes(await ask('❔ 删除默认工作目录 ~/.manyoyo/workpath（里面是你的项目文件，默认保留）? [y/N]: '))) {
            removePath(workpath);
            summary.removed.push('~/.manyoyo/workpath');
        } else {
            summary.kept.push('~/.manyoyo/workpath');
        }
    }
    if (yes && summary.kept.length > 0) log('--yes 只确认程序本身的卸载，没有删除任何用户数据。');

    // 收掉遗留的空目录（如日志按天分的空子目录）；还有保留的数据就留着
    pruneEmptyDirs(root);
    try {
        if (fs.readdirSync(root).length === 0) fs.rmdirSync(root);
    } catch (error) {
        // 保留
    }
    if (summary.kept.length > 0) log(`已保留：${summary.kept.join('、')}`);
    log('卸载完成。');
    return summary;
}

// 只删空目录，不碰任何文件和符号链接
function pruneEmptyDirs(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const child = path.join(dir, entry.name);
        pruneEmptyDirs(child);
        try {
            if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
        } catch (error) {
            // 保留
        }
    }
}

function isDanglingLink(target) {
    try {
        return fs.lstatSync(target).isSymbolicLink();
    } catch (error) {
        return false;
    }
}

function safeRun(run, command, args, external) {
    try {
        return run(command, args, { env: external && external.env ? { ...process.env, ...external.env } : undefined });
    } catch (error) {
        return '';
    }
}

module.exports = {
    runUninstall,
    readPid,
    defaultIsManyoyoServe,
    defaultKill,
    removeManagedBlock,
    MACHINE_NAME,
    BLOCK_START,
    BLOCK_END
};
