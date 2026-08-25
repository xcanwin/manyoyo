'use strict';

const { estimateContainerCapacity } = require('../lib/capacity');

describe('estimateContainerCapacity', () => {
    test('estimates additional containers from average writable-layer size of existing containers', () => {
        const report = estimateContainerCapacity({
            runtimeCommand: 'docker',
            imageName: 'localhost/xcanwin/manyoyo',
            imageVersion: '1.9.1-full',
            containerNames: ['a', 'b', 'c'],
            diskPath: '/Users/test/.manyoyo',
            runCommand: (command, args) => {
                if (args[0] === 'image') return '3221225472\n'; // 3GB
                if (args[0] === 'inspect') return '104857600\n209715200\n52428800\n'; // 100MB / 200MB / 50MB
                throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
            },
            statfs: () => ({ bavail: 2500000, bsize: 4096 }) // ~10GB 可用
        });

        expect(report.image.sizeBytes).toBe(3221225472);
        expect(report.container.sampledCount).toBe(3);
        expect(report.container.averageWritableBytes).toBe(Math.round((104857600 + 209715200 + 52428800) / 3));
        expect(report.disk.availableBytes).toBe(2500000 * 4096);
        expect(report.estimatedAdditionalContainers).toBe(
            Math.floor((2500000 * 4096) / report.container.averageWritableBytes)
        );
        expect(report.notes.length).toBeGreaterThan(0);
    });

    test('falls back to a conservative default when there is no existing container to sample', () => {
        const report = estimateContainerCapacity({
            runtimeCommand: 'podman',
            imageName: 'localhost/xcanwin/manyoyo',
            imageVersion: '1.9.1-full',
            containerNames: [],
            diskPath: '/Users/test/.manyoyo',
            runCommand: (command, args) => {
                if (args[0] === 'image') return '3221225472\n';
                throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
            },
            statfs: () => ({ bavail: 2500000, bsize: 4096 })
        });

        expect(report.container.sampledCount).toBe(0);
        expect(report.container.averageWritableBytes).toBeGreaterThan(0);
        expect(report.estimatedAdditionalContainers).toEqual(expect.any(Number));
        expect(report.notes.some(note => note.includes('保守'))).toBe(true);
    });

    test('degrades gracefully without throwing when runtime/disk commands fail', () => {
        const report = estimateContainerCapacity({
            runtimeCommand: 'docker',
            imageName: 'localhost/xcanwin/manyoyo',
            imageVersion: '1.9.1-full',
            containerNames: ['a'],
            diskPath: '/Users/test/.manyoyo',
            runCommand: () => { throw new Error('daemon not running'); },
            statfs: () => { throw new Error('statfs failed'); }
        });

        expect(report.image.sizeBytes).toBeNull();
        expect(report.disk.availableBytes).toBeNull();
        expect(report.estimatedAdditionalContainers).toBeNull();
        expect(report.notes.length).toBeGreaterThan(0);
    });
});
