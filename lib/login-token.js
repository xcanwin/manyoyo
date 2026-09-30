'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LOGIN_TOKEN_TTL_MS = 60 * 1000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function getLoginTokenDir(homeDir = os.homedir()) {
    return path.join(homeDir, '.manyoyo', 'serve', 'login-tokens');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function isLoopbackHost(host) {
    const text = String(host || '').trim().toLowerCase();
    return text === '127.0.0.1' || text === '::1' || text === '[::1]' || text === 'localhost';
}

// 删除过期（或无法读取）的令牌文件；目录不存在视为无事可做
function pruneLoginTokens(dir, options = {}) {
    const now = options.now || Date.now();
    const ttlMs = options.ttlMs || LOGIN_TOKEN_TTL_MS;
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch (e) {
        return;
    }
    for (const name of names) {
        const filePath = path.join(dir, name);
        try {
            if (now - fs.lstatSync(filePath).mtimeMs > ttlMs) {
                fs.unlinkSync(filePath);
            }
        } catch (e) {
            // 被并发消费/清理，忽略
        }
    }
}

/**
 * 启动器侧：生成一次性令牌，只把 sha256(令牌) 落盘成空文件。
 * 目录 0700、文件 0600；顺带清理过期文件。
 */
function issueLoginToken(dir, options = {}) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    pruneLoginTokens(dir, options);
    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dir, hashToken(token)), '', { mode: 0o600, flag: 'wx' });
    return token;
}

/**
 * serve 侧：令牌有效则消费（删除文件）并返回 true。
 * 格式不符、文件不存在、不是普通文件、已过期、被并发消费，都返回 false；过期文件会被顺手删掉。
 */
function consumeLoginToken(dir, token, options = {}) {
    if (!dir || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
        return false;
    }
    const now = options.now || Date.now();
    const ttlMs = options.ttlMs || LOGIN_TOKEN_TTL_MS;
    const filePath = path.join(dir, hashToken(token));
    let stat;
    try {
        stat = fs.lstatSync(filePath);
    } catch (e) {
        return false;
    }
    const fresh = stat.isFile() && now - stat.mtimeMs <= ttlMs;
    try {
        fs.unlinkSync(filePath);
    } catch (e) {
        return false;
    }
    return fresh;
}

module.exports = {
    LOGIN_TOKEN_TTL_MS,
    getLoginTokenDir,
    isLoopbackHost,
    pruneLoginTokens,
    issueLoginToken,
    consumeLoginToken
};
