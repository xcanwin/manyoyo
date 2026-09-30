'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
    getLoginTokenDir,
    isLoopbackHost,
    issueLoginToken,
    consumeLoginToken,
    pruneLoginTokens
} = require('../lib/login-token');

describe('login token', () => {
    let home;
    let dir;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'manyoyo-token-'));
        dir = getLoginTokenDir(home);
    });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

    test('issues a 64-hex token and stores only its sha256 as a 0600 file in a 0700 dir', () => {
        const token = issueLoginToken(dir);
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        const name = crypto.createHash('sha256').update(token).digest('hex');
        const file = path.join(dir, name);
        expect(fs.readFileSync(file, 'utf8')).toBe('');
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        expect(fs.readdirSync(dir)).toEqual([name]);
    });

    test('a token works once', () => {
        const token = issueLoginToken(dir);
        expect(consumeLoginToken(dir, token)).toBe(true);
        expect(consumeLoginToken(dir, token)).toBe(false);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('an expired token fails and its file is removed', () => {
        const token = issueLoginToken(dir);
        expect(consumeLoginToken(dir, token, { now: Date.now() + 61 * 1000 })).toBe(false);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('forged, malformed and traversal tokens fail', () => {
        issueLoginToken(dir);
        expect(consumeLoginToken(dir, 'a'.repeat(64))).toBe(false);
        expect(consumeLoginToken(dir, '../../etc/passwd')).toBe(false);
        expect(consumeLoginToken(dir, '')).toBe(false);
        expect(consumeLoginToken(dir, undefined)).toBe(false);
        expect(consumeLoginToken(undefined, 'a'.repeat(64))).toBe(false);
        expect(fs.readdirSync(dir)).toHaveLength(1);
    });

    test('a symlink posing as a token file is not accepted', () => {
        const token = 'b'.repeat(64);
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(home, 'target');
        fs.writeFileSync(target, '');
        fs.symlinkSync(target, path.join(dir, crypto.createHash('sha256').update(token).digest('hex')));
        expect(consumeLoginToken(dir, token)).toBe(false);
    });

    test('issuing prunes stale files but keeps fresh ones', () => {
        const old = issueLoginToken(dir);
        const oldFile = path.join(dir, crypto.createHash('sha256').update(old).digest('hex'));
        const past = new Date(Date.now() - 120 * 1000);
        fs.utimesSync(oldFile, past, past);
        const fresh = issueLoginToken(dir);
        expect(fs.existsSync(oldFile)).toBe(false);
        expect(consumeLoginToken(dir, fresh)).toBe(true);
        expect(() => pruneLoginTokens(path.join(home, 'missing'))).not.toThrow();
    });

    test('only loopback hosts qualify', () => {
        ['127.0.0.1', '::1', '[::1]', 'localhost'].forEach(h => expect(isLoopbackHost(h)).toBe(true));
        ['0.0.0.0', '192.168.1.2', '', undefined].forEach(h => expect(isLoopbackHost(h)).toBe(false));
    });
});
