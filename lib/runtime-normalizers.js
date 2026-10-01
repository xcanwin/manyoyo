'use strict';

const os = require('os');
const path = require('path');

function parseEnvEntry(entryText) {
    const text = String(entryText || '');
    const idx = text.indexOf('=');
    if (idx <= 0) {
        throw new Error(`env 格式应为 KEY=VALUE: ${text}`);
    }

    const key = text.slice(0, idx);
    const value = text.slice(idx + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`env key 非法: ${key}`);
    }
    if (/[\r\n\0]/.test(value) || /[;&|`$<>]/.test(value)) {
        throw new Error(`env value 含非法字符: ${key}`);
    }

    return { key, value };
}

function expandHomeAliasPath(filePath, homeDir = os.homedir()) {
    const text = String(filePath || '').trim();
    if (!text) {
        return text;
    }
    if (text === '~') {
        return homeDir;
    }
    if (text.startsWith('~/')) {
        return path.join(homeDir, text.slice(2));
    }
    if (text === '$HOME') {
        return homeDir;
    }
    if (text.startsWith('$HOME/')) {
        return path.join(homeDir, text.slice('$HOME/'.length));
    }
    return text;
}

function normalizeVolume(volume, homeDir = os.homedir()) {
    const text = String(volume || '').trim();
    if (!text.startsWith('~') && !text.startsWith('$HOME')) {
        return text;
    }

    const separatorIndex = text.indexOf(':');
    if (separatorIndex === -1) {
        return expandHomeAliasPath(text, homeDir);
    }

    const hostPath = text.slice(0, separatorIndex);
    const rest = text.slice(separatorIndex);
    return `${expandHomeAliasPath(hostPath, homeDir)}${rest}`;
}

const MIRROR_KEYS = ['apt', 'npm', 'pip'];
const MIRROR_URL_MAX_LENGTH = 256;

/**
 * 归一化全局配置 mirrors：{ apt, npm, pip }，空/缺省 = 官方默认（返回空字符串）。
 * 只接受 http/https URL；这些值会进入容器环境变量或 apt 配置，所以严格拒绝空白和 shell 元字符。
 */
function normalizeMirrors(value) {
    const result = { apt: '', npm: '', pip: '' };
    if (value === undefined || value === null) {
        return result;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('mirrors 必须是对象，例如 { "npm": "https://registry.npmmirror.com/" }');
    }
    for (const key of Object.keys(value)) {
        if (!MIRROR_KEYS.includes(key)) {
            throw new Error(`mirrors 不支持的键: ${key}（只支持 ${MIRROR_KEYS.join(' / ')}）`);
        }
        const raw = value[key];
        if (raw === undefined || raw === null) {
            continue;
        }
        if (typeof raw !== 'string') {
            throw new Error(`mirrors.${key} 必须是字符串`);
        }
        const text = raw.trim();
        if (!text) {
            continue;
        }
        if (!/^https?:\/\//i.test(text)) {
            throw new Error(`mirrors.${key} 必须以 http:// 或 https:// 开头: ${text.slice(0, 40)}`);
        }
        if (text.length > MIRROR_URL_MAX_LENGTH) {
            throw new Error(`mirrors.${key} 过长（最多 ${MIRROR_URL_MAX_LENGTH} 个字符）`);
        }
        if (/[\s\0;&|`$<>'"\\]/.test(text)) {
            throw new Error(`mirrors.${key} 含非法字符（不允许空白、引号、反斜杠和 ; & | \` $ < >）`);
        }
        try {
            new URL(text);
        } catch (e) {
            throw new Error(`mirrors.${key} 不是有效的 URL`);
        }
        result[key] = text;
    }
    return result;
}

module.exports = {
    normalizeMirrors,
    parseEnvEntry,
    expandHomeAliasPath,
    normalizeVolume
};
