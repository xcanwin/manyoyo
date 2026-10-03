'use strict';

// 正在运行的 manyoyo serve 实例：靠 ~/.manyoyo/run/serve/<监听地址>.pid 记录（7.x 起就是这个格式，所以也能认出旧版实例）。
// `manyoyo serve --list` 与安装器装完后的“旧版 serve 还在运行”提示共用这里。
// 版本与来源从进程命令行里的脚本路径推断（脚本旁边的 package.json；npm 全局安装或 ~/.manyoyo/app/<版本>/）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_LISTEN = '127.0.0.1:3000';
const SECRET_FLAGS = new Set(['-P', '--pass']);
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL)/i;

// Linux 优先读 /proc/<pid>/cmdline（NUL 分隔，路径里有空格也不会被拆开）；否则退回 ps（macOS）
function defaultReadArgs(pid) {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
        const tokens = raw.split('\0').filter(Boolean);
        if (tokens.length > 0) return tokens;
    } catch (error) {
        // 没有 /proc：用 ps
    }
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf-8' });
    return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function defaultIsRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error && error.code === 'EPERM';
    }
}

/** 密码不出现在任何输出里：-P <值> / --pass <值> / --pass=<值> 都遮成 ****** */
function maskSecretArgs(tokens) {
    const result = [];
    const maskEnv = value => value.replace(/^([^=]+)=.*$/, (all, name) => (SECRET_ENV_NAME.test(name) ? `${name}=******` : all));
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if ((token === '-e' || token === '--env') && i + 1 < tokens.length) {
            result.push(token, maskEnv(tokens[i + 1]));
            i += 1;
        } else if (/^--env=/.test(token)) {
            result.push(`--env=${maskEnv(token.slice(6))}`);
        } else if (/^-P.+/.test(token)) {
            result.push('-P', '******'); // 粘连写法 -Psecret
        } else if (SECRET_FLAGS.has(token)) {
            result.push(token);
            if (i + 1 < tokens.length) {
                result.push('******');
                i += 1;
            }
        } else if (/^--pass=/.test(token)) {
            result.push('--pass=******');
        } else {
            result.push(token);
        }
    }
    return result;
}

function listenFromFileName(name) {
    const base = name.replace(/\.pid$/, '');
    const index = base.lastIndexOf('_');
    return index > 0 ? `${base.slice(0, index)}:${base.slice(index + 1)}` : DEFAULT_LISTEN;
}

function inspectScript(scriptPath, readFile = fs.readFileSync, realpath = fs.realpathSync) {
    let real = scriptPath;
    try {
        real = realpath(scriptPath);
    } catch (error) {
        // 路径已不存在：按原样判断
    }
    let version = '';
    try {
        version = String(JSON.parse(readFile(path.join(path.dirname(real), '..', 'package.json'), 'utf-8')).version || '');
    } catch (error) {
        // 读不到就是“版本未知”
    }
    const normalized = real.split(path.sep).join('/');
    let source = 'unknown';
    if (normalized.includes('/node_modules/@xcanwin/manyoyo/')) source = 'npm';
    else if (normalized.includes('/.manyoyo/app/')) source = 'offline';
    return { version, source };
}

/** 把 `node /…/manyoyo.js serve 0.0.0.0:3000 -U admin -P x` 拆成脚本与 serve 之后的参数 */
function parseServeCommand(commandLine) {
    const tokens = Array.isArray(commandLine) ? commandLine : String(commandLine || '').trim().split(/\s+/).filter(Boolean);
    const serveIndex = tokens.indexOf('serve');
    if (serveIndex < 1) return null;
    const script = tokens.slice(0, serveIndex).reverse().find(token => /manyoyo(\.js)?$|\/my$|\.js$/.test(token)) || tokens[serveIndex - 1];
    const args = tokens.slice(serveIndex + 1);
    // 监听地址形如 host:port 或 [ipv6]:port；不能取“第一个非选项参数”，否则 -U admin 的 admin 会被当成地址
    const listen = args.find(token => /^(\[[^\]]+\]|[A-Za-z0-9.-]+):\d+$/.test(token)) || '';
    return { script, args, listen };
}

function listServeInstances(options = {}) {
    const homeDir = options.homeDir || os.homedir();
    const readArgs = options.readArgs || defaultReadArgs;
    const isRunning = options.isRunning || defaultIsRunning;
    const dir = path.join(homeDir, '.manyoyo', 'run', 'serve');
    let names = [];
    try {
        names = fs.readdirSync(dir).filter(name => name.endsWith('.pid')).sort();
    } catch (error) {
        return [];
    }
    const instances = [];
    for (const name of names) {
        let pid = 0;
        try {
            const text = fs.readFileSync(path.join(dir, name), 'utf-8').trim();
            pid = /^\d+$/.test(text) ? Number(text) : 0;
        } catch (error) {
            pid = 0;
        }
        if (!pid || !isRunning(pid)) continue;
        const parsed = parseServeCommand(readArgs(pid));
        // 命令行不是 manyoyo serve：pid 文件残留且 pid 已被别的进程复用，不能算 serve 实例
        if (!parsed) continue;
        const info = inspectScript(parsed.script);
        const args = parsed.args;
        instances.push({
            pid,
            // 命令行里写了监听地址就用它；没写（用默认或配置）时 pid 文件名就是实际监听地址（host_port）
            listen: parsed.listen || listenFromFileName(name),
            version: info.version,
            source: info.source,
            args: maskSecretArgs(args),
            command: `my serve ${maskSecretArgs(args).join(' ')}`.trim()
        });
    }
    return instances;
}

function sourceLabel(source) {
    return { npm: '由全局 Node 的 npm 安装', offline: '安装包安装', unknown: '来源未知' }[source] || '来源未知';
}

/** 表格：监听地址 / PID / 版本 / 启动命令 */
function formatServeTable(instances) {
    if (instances.length === 0) return '没有正在运行的 serve。';
    const rows = instances.map(item => [item.listen, String(item.pid), item.version || '未知', item.command]);
    const header = ['监听地址', 'PID', '版本', '启动命令'];
    // 终端里中日韩字符占两列，按显示宽度对齐
    const width = text => [...text].reduce((sum, char) => sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60]/.test(char) ? 2 : 1), 0);
    const widths = header.map((_, column) => Math.max(...[header, ...rows].map(row => width(row[column]))));
    const pad = (text, size) => text + ' '.repeat(size - width(text) + 2);
    return [header, ...rows].map(row => row.map((cell, column) => (column === 3 ? cell : pad(cell, widths[column]))).join('').trimEnd()).join('\n');
}

/** 与当前版本不同的实例（旧版代码还在跑） */
function findOutdatedInstances(instances, currentVersion) {
    return instances.filter(item => item.version !== currentVersion);
}

/** 重启成新版的命令：沿用原参数（密码仍是 ******，需要换回原密码），加 -d --restart */
function restartCommand(instance) {
    const args = instance.args.filter(token => token !== '-d' && token !== '--detach' && token !== '--restart');
    // --restart 必须显式带监听地址：命令行里没写（用了默认或配置里的）就补上实际监听地址
    if (!args.includes(instance.listen)) args.unshift(instance.listen);
    return `my serve ${args.join(' ')} -d --restart`.replace(/\s+/g, ' ');
}

module.exports = { listServeInstances, formatServeTable, findOutdatedInstances, restartCommand, sourceLabel, maskSecretArgs, parseServeCommand, inspectScript };
