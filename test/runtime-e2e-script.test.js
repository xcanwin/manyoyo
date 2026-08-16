'use strict';

const fs = require('fs');
const path = require('path');
const { buildModeSmokeArgs } = require('../scripts/test-container-runtime');

describe('runtime E2E smoke command construction', () => {
    test('preserves common/dind/sock mode arguments when testing a built image', () => {
        expect(buildModeSmokeArgs('docker', 'common', 'manyoyo:test')).toEqual([
            'run', '--rm', 'manyoyo:test', '/bin/bash', '-lc', 'node --version'
        ]);
        expect(buildModeSmokeArgs('docker', 'dind', 'manyoyo:test')).toEqual(expect.arrayContaining([
            'run', '--rm', '--privileged', 'manyoyo:test'
        ]));
        expect(buildModeSmokeArgs('docker', 'sock', 'manyoyo:test')).toEqual(expect.arrayContaining([
            '--privileged', '--volume', '/var/run/docker.sock:/var/run/docker.sock',
            '--env', 'DOCKER_HOST=unix:///var/run/docker.sock',
            '--env', 'CONTAINER_HOST=unix:///var/run/docker.sock', 'manyoyo:test'
        ]));
    });

    test('release CI builds and exercises the image with Docker', () => {
        const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/npm-publish.yml'), 'utf8');
        expect(workflow).toContain('runtime-e2e:');
        expect(workflow).toContain('docker build');
        expect(workflow).toContain('npm run test:runtime-e2e');
    });
});
