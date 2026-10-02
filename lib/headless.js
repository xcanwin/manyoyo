'use strict';

// 有头 / 无头判定：安装器与无参 `manyoyo` 启动器共用这一份规则。
// 有头 = 本机有图形界面且不是 SSH 会话，可以直接打开浏览器；无头 = 走命令行配置与端口转发。

function isSet(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function parseEnvForce(value) {
    const text = String(value === undefined ? '' : value).trim().toLowerCase();
    if (['1', 'true', 'yes'].includes(text)) return true;
    if (['0', 'false', 'no'].includes(text)) return false;
    return null;
}

/**
 * @param {{env?: Object, platform?: string, force?: boolean|null}} [options]
 *   force：命令行 --headless(true) / --gui(false)，优先于环境变量 MANYOYO_HEADLESS，再优先于自动判定
 * @returns {{headless: boolean, reason: string}}
 */
function detectHeadless(options = {}) {
    const env = options.env || process.env;
    const platform = options.platform || process.platform;
    if (options.force === true) return { headless: true, reason: '命令行指定了 --headless' };
    if (options.force === false) return { headless: false, reason: '命令行指定了 --gui' };
    const forced = parseEnvForce(env.MANYOYO_HEADLESS);
    if (forced !== null) return { headless: forced, reason: `环境变量 MANYOYO_HEADLESS=${forced ? 1 : 0}` };
    if (isSet(env.SSH_CONNECTION) || isSet(env.SSH_TTY)) return { headless: true, reason: '当前是 SSH 会话' };
    if (platform === 'linux' && !isSet(env.DISPLAY) && !isSet(env.WAYLAND_DISPLAY)) {
        return { headless: true, reason: '没有检测到图形界面（DISPLAY / WAYLAND_DISPLAY 都为空）' };
    }
    return { headless: false, reason: '检测到图形界面' };
}

// 从 argv 取出 --headless / --gui；两者都出现或夹杂别的参数时返回 null，让调用方按普通子命令处理
function parseLauncherArgs(args) {
    let force = null;
    for (const arg of args) {
        if (arg === '--headless') {
            if (force === false) return null;
            force = true;
        } else if (arg === '--gui') {
            if (force === true) return null;
            force = false;
        } else {
            return null;
        }
    }
    return { force };
}

module.exports = { detectHeadless, parseLauncherArgs, parseEnvForce };
