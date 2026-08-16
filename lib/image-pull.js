'use strict';

const { DEFAULT_IMAGE_NAME } = require('./default-image');

function ensureDefaultImage(options = {}) {
    const imageName = String(options.imageName || '').trim();
    const imageVersion = String(options.imageVersion || '').trim();
    const defaultImageName = options.defaultImageName || DEFAULT_IMAGE_NAME;
    if (!imageName || !imageVersion || imageName !== defaultImageName) {
        return false;
    }

    const image = `${imageName}:${imageVersion}`;
    const execute = typeof options.execute === 'function' ? options.execute : () => {};
    const log = typeof options.log === 'function' ? options.log : () => {};
    const commandName = String(options.commandName || 'manyoyo').trim() || 'manyoyo';
    try {
        execute(['image', 'inspect', image], { stdio: 'pipe' });
        return false;
    } catch (inspectError) {
        log(`📥 正在拉取默认镜像: ${image}`);
        try {
            execute(['pull', image], { stdio: 'inherit' });
            return true;
        } catch (pullError) {
            const error = new Error(`无法拉取默认镜像 ${image}。请检查网络或执行 ${commandName} build --iv ${imageVersion} 在本地构建镜像。`);
            error.cause = pullError;
            throw error;
        }
    }
}

module.exports = { ensureDefaultImage };
