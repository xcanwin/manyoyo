'use strict';

const CONTAINER_MODE_ALIASES = {
    common: 'common',
    'docker-in-docker': 'dind',
    dind: 'dind',
    d: 'dind',
    'mount-docker-socket': 'sock',
    sock: 'sock',
    s: 'sock'
};

const CONTAINER_MODE_ARGS = {
    common: [],
    dind: ['--privileged'],
    sock: [
        '--privileged',
        '--volume', '/var/run/docker.sock:/var/run/docker.sock',
        '--env', 'DOCKER_HOST=unix:///var/run/docker.sock',
        '--env', 'CONTAINER_HOST=unix:///var/run/docker.sock'
    ]
};

function resolveContainerMode(mode) {
    const normalizedMode = CONTAINER_MODE_ALIASES[String(mode || '').trim().toLowerCase()];
    if (!normalizedMode) {
        throw new Error(`未知 containerMode: ${mode}`);
    }
    return {
        mode: normalizedMode,
        args: CONTAINER_MODE_ARGS[normalizedMode].slice()
    };
}

module.exports = {
    resolveContainerMode
};
