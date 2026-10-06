'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const state = require('./container-state');

const ID_LABEL = 'manyoyo.id';

/**
 * 读容器的 manyoyo.id 标签；没有标签（旧容器）或容器不存在返回 ''。
 * @param {(args: string[], options?: object) => string} dockerExecArgs
 */
function resolveContainerId(dockerExecArgs, containerName) {
    try {
        const out = String(dockerExecArgs(
            ['inspect', '-f', `{{index .Config.Labels "${ID_LABEL}"}}`, containerName],
            { stdio: 'pipe' }
        ) || '').trim();
        return state.isValidId(out) ? out : '';
    } catch (e) {
        return '';
    }
}

// managed.env 在只读挂载的 sys/ 里（容器改不了）；box/env 是容器可写的，按不可信输入读取（见 container-state.js）
function readTextOrEmpty(file, untrusted = false) {
    if (untrusted) return state.readBoxText(file, state.MAX_ENV_BYTES).text;
    try {
        return fs.readFileSync(file, 'utf-8');
    } catch (e) {
        return '';
    }
}

/**
 * 合成一次 exec 的 env 行：managed → 用户 env（box/env）→ extra，后者覆盖前者，非法行一律丢弃。
 * podman 对非法行（1BAD=x、含空格的 key）会原样传进容器，所以必须由宿主机先过滤。
 * @returns {{lines: string[], invalid: object[]}}
 */
function composeEnvLines(managedText, boxText, extraLines = [], fileEntries = []) {
    const merged = new Map();
    const invalid = [];
    const take = (text, source) => {
        const parsed = state.parseEnvText(text);
        parsed.entries.forEach(entry => merged.set(entry.key, entry.value));
        parsed.invalid.forEach(item => invalid.push({ ...item, source }));
    };
    take(managedText, 'managed');
    // 环境变量文件（已解析、已校验的条目）排在 managed 之后、box/env 之前：表格里的变量优先于文件
    (fileEntries || []).forEach(entry => merged.set(entry.key, entry.value));
    take(boxText, 'box');
    // extra 是命令行 / 配置里已经成形的 KEY=VALUE（值是字面量，不再做去引号）
    (extraLines || []).forEach(line => {
        const i = String(line).indexOf('=');
        if (i > 0 && state.ENV_KEY_RE.test(line.slice(0, i))) merged.set(line.slice(0, i), line.slice(i + 1));
        else invalid.push({ line: 0, text: String(line), reason: '缺少 KEY=VALUE', source: 'extra' });
    });
    // 写给 docker / podman 的 --env-file：值是字面量（它们不处理引号），所以这里一律原样输出
    return { lines: [...merged].map(([key, value]) => `${key}=${value}`), invalid };
}

function writeTempEnvFile(homeDir, lines) {
    const dir = path.join(homeDir, '.manyoyo', 'tmp');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, `exec-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    return file;
}

/**
 * 所有进入用户容器的 `exec` 都经这里构造参数（Agent、终端、CLI 命令、first 预执行）。
 * 用户 env 与 manyoyo 注入的 env 放在宿主机文件里，每次 exec 现读，所以改了下一条命令就生效；
 * 值通过 0600 临时 env 文件传入，不出现在 ps 里；调用方必须在子进程启动后（或结束时）调 cleanup()。
 *
 * @param {{homeDir?: string, dockerExecArgs: Function}} ctx
 * @param {string} containerName
 * @param {object} options
 * @param {boolean} [options.interactive] -i
 * @param {boolean} [options.tty] -t
 * @param {string} [options.user]
 * @param {string[]} [options.envs] 非敏感的 KEY=VALUE（TERM 等），以 --env 传入
 * @param {string[]} [options.extraEnv] 敏感/用户 KEY=VALUE（first.env），进临时文件，优先级最高
 * @param {boolean} [options.withEnv=true] false 时不加载用户/managed env（读文件等与环境无关的 exec）
 * @param {string[]} options.command 容器内要运行的命令与参数
 * @returns {{args: string[], cleanup: () => void, invalid: object[], containerId: string}}
 */
function buildExecArgs(ctx, containerName, options = {}) {
    const homeDir = ctx.homeDir || os.homedir();
    const withEnv = options.withEnv !== false;
    const args = ['exec'];
    if (options.interactive) args.push('-i');
    if (options.tty) args.push('-t');
    if (options.user) args.push('--user', options.user);

    let containerId = '';
    let lines = [];
    let invalid = [];
    const extra = options.extraEnv || [];
    if (withEnv) {
        containerId = resolveContainerId(ctx.dockerExecArgs, containerName);
        if (containerId && state.stateExists(homeDir, containerId)) {
            const p = state.paths(homeDir, containerId);
            ({ lines, invalid } = composeEnvLines(readTextOrEmpty(p.managedEnv), readTextOrEmpty(p.env, true), extra, state.envFileEntries(homeDir, containerId)));
        } else {
            containerId = '';
            ({ lines, invalid } = composeEnvLines('', '', extra));
        }
    } else if (extra.length) {
        ({ lines, invalid } = composeEnvLines('', '', extra));
    }

    let envFile = '';
    if (lines.length) {
        envFile = writeTempEnvFile(homeDir, lines);
        args.push('--env-file', envFile);
    }
    (options.envs || []).forEach(entry => args.push('--env', entry));
    args.push(containerName, ...(options.command || []));

    let cleaned = false;
    const cleanup = () => {
        if (cleaned || !envFile) return;
        cleaned = true;
        try { fs.rmSync(envFile, { force: true }); } catch (e) { /* 尽力清理 */ }
    };
    return { args, cleanup, invalid, containerId };
}

module.exports = { ID_LABEL, resolveContainerId, composeEnvLines, buildExecArgs };
