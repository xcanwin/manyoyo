'use strict';

const os = require('os');
const path = require('path');

// 配置里 containerName / hostPath / containerPath 的占位符，命令行与网页共用这一个展开函数：
//   {now}（也认 ${now}）→ 年月日-时分秒，如 20261024-230915
//   {quickChatPath}      → 快捷对话目录（serve.quickChat.path），没配置就是默认工作目录 ~/.manyoyo/work
const NOW_TOKEN = /\{now\}|\$\{now\}/g;
const QUICK_CHAT_PATH_TOKEN = /\{quickChatPath\}/g;

function formatNow(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function expandHome(value, homeDir = os.homedir()) {
    const text = String(value || '').trim();
    if (text === '~') return homeDir;
    if (text.startsWith('~/')) return path.join(homeDir, text.slice(2));
    return text;
}

/** 快捷对话目录的绝对路径（去掉末尾斜杠）；没配置返回 defaultDir */
function resolveQuickChatPath(config, { homeDir = os.homedir(), defaultDir = path.join(os.homedir(), '.manyoyo', 'work') } = {}) {
    const quickChat = config && config.serve && typeof config.serve === 'object' ? config.serve.quickChat : null;
    const raw = quickChat && typeof quickChat.path === 'string' ? quickChat.path.trim() : '';
    if (!raw) return defaultDir;
    const resolved = path.resolve(expandHome(raw, homeDir));
    return resolved;
}

/**
 * 展开占位符。返回 { value, templated }：templated 表示原文里确实有占位符
 * （调用方据此决定要不要替用户建目录：只有按模板生成的目录才自动建）。
 */
function expandTemplate(value, vars = {}) {
    if (typeof value !== 'string') return { value, templated: false };
    const now = vars.now === undefined ? formatNow() : vars.now;
    let templated = false;
    let result = value.replace(NOW_TOKEN, () => {
        templated = true;
        return now;
    });
    result = result.replace(QUICK_CHAT_PATH_TOKEN, () => {
        templated = true;
        return String(vars.quickChatPath || '').replace(/\/+$/, '');
    });
    return { value: result, templated };
}

module.exports = { formatNow, expandHome, resolveQuickChatPath, expandTemplate };
