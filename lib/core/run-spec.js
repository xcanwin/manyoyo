'use strict';

const VALID_CONTAINER_MODES = new Set(['common', 'dind', 'sock']);
const IMAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+-[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function assertObject(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${field} 必须是对象`);
    }
}

function assertString(value, field) {
    if (typeof value !== 'string') {
        throw new Error(`${field} 必须是字符串`);
    }
}

function assertArray(value, field) {
    if (!Array.isArray(value)) {
        throw new Error(`${field} 必须是数组`);
    }
}

function validateResolvedRunSpec(spec) {
    assertObject(spec, 'RunSpec');
    if (spec.configVersion !== 1) {
        throw new Error('RunSpec.configVersion 必须为 1');
    }
    assertObject(spec.image, 'image');
    assertString(spec.image.name, 'image.name');
    assertString(spec.image.version, 'image.version');
    if (!IMAGE_VERSION_PATTERN.test(spec.image.version)) {
        throw new Error('image.version 必须为 x.y.z-后缀');
    }

    assertObject(spec.container, 'container');
    ['name', 'mode', 'hostPath', 'containerPath'].forEach(field => assertString(spec.container[field], `container.${field}`));
    if (!VALID_CONTAINER_MODES.has(spec.container.mode)) {
        throw new Error('container.mode 必须是 common、dind 或 sock');
    }
    ['modeArgs', 'envFile', 'volumes', 'ports', 'extraArgs', 'imageBuildArgs']
        .forEach(field => assertArray(spec.container[field], `container.${field}`));
    assertObject(spec.container.env, 'container.env');

    assertObject(spec.process, 'process');
    ['prefix', 'shell', 'suffix'].forEach(field => assertString(spec.process[field], `process.${field}`));
    if (typeof spec.process.tty !== 'boolean') {
        throw new Error('process.tty 必须是布尔值');
    }
    assertObject(spec.provenance, 'provenance');
    return spec;
}

module.exports = {
    validateResolvedRunSpec
};
