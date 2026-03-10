const path = require('path');
const { buildManyoyoLogPath, normalizeLogScope } = require('../lib/log-path');

describe('manyoyo log path helpers', () => {
    test('should place scoped logs under ~/.manyoyo/logs/<scope>/', () => {
        const result = buildManyoyoLogPath('serve', new Date('2026-03-10T12:00:00+08:00'), '/tmp/home');

        expect(result).toEqual({
            rootDir: path.join('/tmp/home', '.manyoyo', 'logs'),
            dir: path.join('/tmp/home', '.manyoyo', 'logs', 'serve'),
            path: path.join('/tmp/home', '.manyoyo', 'logs', 'serve', 'serve-2026-03-10.log'),
            scope: 'serve',
            file: 'serve-2026-03-10.log'
        });
    });

    test('should normalize invalid scope characters', () => {
        expect(normalizeLogScope('serve auth/api')).toBe('serve-auth-api');
        expect(normalizeLogScope('')).toBe('general');
    });
});
