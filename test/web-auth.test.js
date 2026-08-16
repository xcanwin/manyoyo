'use strict';

const {
    createAuthState,
    createWebAuthSession,
    getWebAuthSession,
    getWebAuthCookie,
    isSecureWebRequest
} = require('../lib/web/auth');

describe('web auth domain', () => {
    test('uses a Secure cookie only for TLS or explicitly trusted proxy HTTPS', () => {
        expect(isSecureWebRequest({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }, { trustProxy: false })).toBe(false);
        expect(isSecureWebRequest({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }, { trustProxy: true })).toBe(true);
        expect(getWebAuthCookie('session', true)).toContain('; Secure');
        expect(getWebAuthCookie('session', false)).not.toContain('; Secure');
    });

    test('creates and resolves a sliding auth session from a cookie', () => {
        const state = createAuthState();
        const sessionId = createWebAuthSession(state, 'admin');
        const session = getWebAuthSession(state, {
            headers: { cookie: `manyoyo_web_auth=${sessionId}` }
        });

        expect(session).toEqual(expect.objectContaining({ sessionId, username: 'admin' }));
    });
});
