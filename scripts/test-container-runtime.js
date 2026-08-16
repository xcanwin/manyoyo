#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const { resolveContainerMode } = require('../lib/runtime/container-modes');

function buildModeSmokeArgs(runtime, mode, image) {
    const modeArgs = resolveContainerMode(mode).args;
    const command = mode === 'sock'
        ? 'test -S /var/run/docker.sock && test "$DOCKER_HOST" = "unix:///var/run/docker.sock" && test "$CONTAINER_HOST" = "unix:///var/run/docker.sock"'
        : 'node --version';
    return ['run', '--rm', ...modeArgs, image, '/bin/bash', '-lc', command];
}

function runModeSmoke(runtime, mode, image) {
    if (mode === 'sock' && !fs.existsSync('/var/run/docker.sock')) {
        throw new Error('sock 模式验收需要宿主 Docker socket');
    }
    const result = spawnSync(runtime, buildModeSmokeArgs(runtime, mode, image), { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${runtime} ${mode} smoke test failed with exit code ${result.status}`);
    }
}

function main() {
    const runtime = process.env.MANYOYO_TEST_RUNTIME || 'docker';
    const image = process.env.MANYOYO_TEST_IMAGE || 'manyoyo-runtime-e2e:local';
    ['common', 'dind', 'sock'].forEach(mode => runModeSmoke(runtime, mode, image));
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message || error);
        process.exitCode = 1;
    }
}

module.exports = { buildModeSmokeArgs, runModeSmoke };
