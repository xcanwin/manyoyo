'use strict';

const { createServeProcessManager } = require('../lib/cli/serve-process');

describe('serve process manager', () => {
    test('normalizes detached argv and IPv6 pid file names', () => {
        const manager = createServeProcessManager({
            fs: {},
            path: require('path'),
            os: { homedir: () => '/tmp/home' },
            processRef: {},
            globalRef: {},
            spawn: jest.fn(),
            sleep: jest.fn(),
            buildLogPath: jest.fn(),
            log: jest.fn(),
            colors: {}
        });

        expect(manager.buildDetachedServeArgv(['serve', '-d', '[::1]:3000', '--restart'])).toEqual(['serve', '[::1]:3000']);
        expect(manager.buildServePidFile('::1', 3000)).toEqual({
            dir: '/tmp/home/.manyoyo/run/serve',
            listen: '[::1]:3000',
            path: '/tmp/home/.manyoyo/run/serve/_1_3000.pid'
        });
    });

    test('passes explicit credentials to detached child without changing other environment values', () => {
        const manager = createServeProcessManager({
            fs: {},
            path: require('path'),
            os: { homedir: () => '/tmp/home' },
            processRef: { env: { KEEP: 'yes' } },
            globalRef: {},
            spawn: jest.fn(),
            sleep: jest.fn(),
            buildLogPath: jest.fn(),
            log: jest.fn(),
            colors: {}
        });

        expect(manager.buildDetachedServeEnv({ serverAuthUser: 'admin', serverAuthPass: 'secret' })).toEqual({
            KEEP: 'yes',
            MANYOYO_SERVER_USER: 'admin',
            MANYOYO_SERVER_PASS: 'secret'
        });
    });
});
