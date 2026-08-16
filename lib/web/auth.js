'use strict';

const crypto = require('crypto');

const WEB_AUTH_COOKIE_NAME = 'manyoyo_web_auth';
const WEB_AUTH_TTL_SECONDS = 12 * 60 * 60;

function createAuthState() {
    return {
        authSessions: new Map(),
        loginFailures: new Map()
    };
}

function secureStringEqual(a, b) {
    const aBuffer = Buffer.from(String(a || ''), 'utf-8');
    const bBuffer = Buffer.from(String(b || ''), 'utf-8');
    if (aBuffer.length !== bBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function parseCookies(req) {
    const cookieHeader = req.headers.cookie || '';
    if (!cookieHeader) return {};

    const cookies = {};
    cookieHeader.split(';').forEach(part => {
        const index = part.indexOf('=');
        if (index <= 0) return;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (!key) return;
        try {
            cookies[key] = decodeURIComponent(value);
        } catch (error) {
            cookies[key] = value;
        }
    });
    return cookies;
}

function pruneExpiredWebAuthSessions(state) {
    const now = Date.now();
    for (const [sessionId, session] of state.authSessions.entries()) {
        if (!session || session.expiresAt <= now) {
            state.authSessions.delete(sessionId);
        }
    }
}

function createWebAuthSession(state, username) {
    pruneExpiredWebAuthSessions(state);
    const sessionId = crypto.randomBytes(24).toString('hex');
    state.authSessions.set(sessionId, {
        username,
        expiresAt: Date.now() + WEB_AUTH_TTL_SECONDS * 1000
    });
    return sessionId;
}

function getWebAuthSession(state, req) {
    pruneExpiredWebAuthSessions(state);
    const sessionId = parseCookies(req)[WEB_AUTH_COOKIE_NAME];
    if (!sessionId) return null;
    const session = state.authSessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        state.authSessions.delete(sessionId);
        return null;
    }
    session.expiresAt = Date.now() + WEB_AUTH_TTL_SECONDS * 1000;
    return { sessionId, username: session.username };
}

function clearWebAuthSession(state, req) {
    const sessionId = parseCookies(req)[WEB_AUTH_COOKIE_NAME];
    if (sessionId) {
        state.authSessions.delete(sessionId);
    }
}

function isSecureWebRequest(req, ctx) {
    if (req.socket && req.socket.encrypted) return true;
    if (!ctx.trustProxy) return false;
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return forwardedProto === 'https';
}

function getWebAuthCookie(sessionId, secure = false) {
    const securePart = secure ? '; Secure' : '';
    return `${WEB_AUTH_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict${securePart}; Max-Age=${WEB_AUTH_TTL_SECONDS}`;
}

function getWebAuthClearCookie(secure = false) {
    const securePart = secure ? '; Secure' : '';
    return `${WEB_AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict${securePart}; Max-Age=0`;
}

module.exports = {
    WEB_AUTH_COOKIE_NAME,
    createAuthState,
    secureStringEqual,
    parseCookies,
    createWebAuthSession,
    getWebAuthSession,
    clearWebAuthSession,
    isSecureWebRequest,
    getWebAuthCookie,
    getWebAuthClearCookie
};
