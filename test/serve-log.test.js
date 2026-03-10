const {
    sanitizeProcessArgv,
    getServeProcessSnapshot,
    formatServeLogValue
} = require('../lib/serve-log');

describe('serve log sanitization', () => {
    test('should mask password values in argv snapshots', () => {
        const snapshot = getServeProcessSnapshot({
            pid: 123,
            ppid: 45,
            cwd: () => '/tmp/demo',
            argv: ['node', 'bin/manyoyo.js', 'serve', '0.0.0.0:3000', '-U', 'admin', '-P', '123qweasdzxc']
        });

        expect(snapshot.argv).toEqual([
            'node',
            'bin/manyoyo.js',
            'serve',
            '0.0.0.0:3000',
            '-U',
            'admin',
            '-P',
            '****'
        ]);
    });

    test('should mask inline --pass syntax in argv and formatted logs', () => {
        expect(sanitizeProcessArgv(['my', 'serve', '--pass=secret123'])).toEqual(['my', 'serve', '--pass=****']);
        const snapshot = getServeProcessSnapshot({
            pid: 1,
            ppid: 0,
            cwd: () => '/tmp/demo',
            argv: ['my', 'serve', '--pass=secret123']
        });
        const formatted = formatServeLogValue({ process: snapshot });
        expect(formatted).toContain('--pass=****');
        expect(formatted).not.toContain('secret123');
    });
});
