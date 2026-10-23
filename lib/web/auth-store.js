'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeConfigFileSecure } = require('../secure-file');

// 网页登录会话：内存为准，落盘只为 serve 重启后不把人踢下线。
// 文件只存 sha256(token)（不存 token 明文）和一个“凭据指纹”HMAC(随机盐, 用户名\0密码)：
// 改了用户名或密码（含每次启动随机生成的密码变了）指纹就对不上，整份作废。
const FILE_VERSION = 1;
const DEFAULT_FLUSH_DELAY_MS = 1000;
// 滑动续期不是每个请求都写盘：新的到期时间比已落盘的晚到这个值才写
const REWRITE_SLACK_MS = 60 * 60 * 1000;

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function fingerprintOf(salt, user, pass) {
    return crypto.createHmac('sha256', Buffer.from(salt, 'hex')).update(`${user}\0${pass}`).digest('hex');
}

function authSessionsFilePath(homeDir, host, port) {
    const safeHost = String(host || 'host').replace(/[^A-Za-z0-9.-]/g, '_');
    return path.join(homeDir, '.manyoyo', 'serve', `auth-sessions-${safeHost}_${Number(port) || 0}.json`);
}

function safeEqualHex(a, b) {
    const x = Buffer.from(String(a), 'hex');
    const y = Buffer.from(String(b), 'hex');
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * @param {object} options
 * @param {string} [options.file] 落盘路径；不给就只在内存里
 * @param {string} options.user
 * @param {string} options.pass
 * @param {number} options.ttlMs
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.warn]
 */
function createAuthStore(options) {
    const now = options.now || Date.now;
    const warn = options.warn || (() => {});
    const file = options.file || '';
    const ttlMs = options.ttlMs;
    const flushDelayMs = options.flushDelayMs || DEFAULT_FLUSH_DELAY_MS;
    const sessions = new Map(); // sha256(token) → { username, expiresAt }
    const persisted = new Map(); // sha256(token) → 已落盘的 expiresAt
    let salt = crypto.randomBytes(16).toString('hex');
    let timer = null;
    let dirty = false;
    let warnedWrite = false;

    function serialize() {
        const out = {};
        for (const [key, session] of sessions) out[key] = { username: session.username, expiresAt: session.expiresAt };
        return `${JSON.stringify({ version: FILE_VERSION, salt, fingerprint: fingerprintOf(salt, options.user, options.pass), sessions: out })}\n`;
    }

    function flush() {
        if (timer) { clearTimeout(timer); timer = null; }
        dirty = false;
        if (!file) return;
        try {
            writeConfigFileSecure(file, serialize());
            persisted.clear();
            for (const [key, session] of sessions) persisted.set(key, session.expiresAt);
        } catch (e) {
            if (!warnedWrite) {
                warnedWrite = true;
                warn(`登录会话写盘失败（重启后需要重新登录）: ${e && e.message}`);
            }
        }
    }

    function scheduleFlush() {
        if (!file) return;
        dirty = true;
        if (timer) return;
        timer = setTimeout(flush, flushDelayMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    function load() {
        if (!file) return;
        let raw;
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
                warn(`登录会话文件不是 0600 的普通文件，已忽略: ${file}`);
                flush();
                return;
            }
            raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch (e) {
            if (e && e.code === 'ENOENT') return;
            warn(`登录会话文件读取失败，已忽略: ${e && e.message}`);
            flush();
            return;
        }
        const valid = raw && raw.version === FILE_VERSION && typeof raw.salt === 'string' && /^[0-9a-f]{32}$/.test(raw.salt)
            && typeof raw.fingerprint === 'string' && raw.sessions && typeof raw.sessions === 'object';
        if (!valid || !safeEqualHex(raw.fingerprint, fingerprintOf(raw.salt, options.user, options.pass))) {
            // 改过用户名或密码：整份作废，并马上覆盖（否则改回旧密码后旧会话会复活）
            flush();
            return;
        }
        salt = raw.salt;
        const current = now();
        for (const [key, session] of Object.entries(raw.sessions)) {
            if (/^[0-9a-f]{64}$/.test(key) && session && typeof session.username === 'string' && Number.isFinite(session.expiresAt) && session.expiresAt > current) {
                sessions.set(key, { username: session.username, expiresAt: session.expiresAt });
                persisted.set(key, session.expiresAt);
            }
        }
    }

    function prune() {
        const current = now();
        let removed = false;
        for (const [key, session] of sessions) {
            if (session.expiresAt <= current) {
                sessions.delete(key);
                removed = true;
            }
        }
        if (removed) scheduleFlush();
    }

    load();

    return {
        create(username) {
            prune();
            const token = crypto.randomBytes(24).toString('hex');
            sessions.set(hashToken(token), { username, expiresAt: now() + ttlMs });
            flush();
            return token;
        },
        // 命中则顺延到期时间（滑动过期）
        touch(token) {
            if (!token) return null;
            prune();
            const key = hashToken(token);
            const session = sessions.get(key);
            if (!session) return null;
            session.expiresAt = now() + ttlMs;
            if (file && session.expiresAt - (persisted.get(key) || 0) >= REWRITE_SLACK_MS) scheduleFlush();
            return { username: session.username };
        },
        remove(token) {
            if (!token) return;
            if (sessions.delete(hashToken(token))) flush();
        },
        close() {
            if (dirty) flush();
            else if (timer) { clearTimeout(timer); timer = null; }
        },
        // 仅测试用
        size() { return sessions.size; }
    };
}

module.exports = { createAuthStore, authSessionsFilePath };
