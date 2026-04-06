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

module.exports = {
    parseEnvEntry,
    expandHomeAliasPath,
    normalizeVolume
};
