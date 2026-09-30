'use strict';

const { spawn } = require('child_process');
const { describeError } = require('./error-hints');

const OUTPUT_TAIL_CHARS = 4096;

/**
 * 拉取镜像，输出实时回调（CLI 直接透传终端，Web 取最后一行当进度）。
 * 失败时 reject，err.output 是输出末尾，供分类提示。
 */
function pullImageProcess(options) {
    const { command, env, imageRef, onOutput } = options;
    const spawnFn = options.spawnFn || spawn;
    return new Promise((resolve, reject) => {
        let tail = '';
        const child = spawnFn(command, ['pull', imageRef], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        const collect = stream => chunk => {
            const text = chunk.toString('utf-8');
            tail = (tail + text).slice(-OUTPUT_TAIL_CHARS);
            if (onOutput) onOutput(text, stream);
        };
        child.stdout.on('data', collect('stdout'));
        child.stderr.on('data', collect('stderr'));
        child.on('error', error => {
            const err = new Error(error.message);
            err.output = `${tail}\n${error.message}`;
            reject(err);
        });
        child.on('close', code => {
            if (code === 0) {
                resolve();
                return;
            }
            const err = new Error(`${command} pull ${imageRef} 退出码 ${code}`);
            err.output = tail;
            reject(err);
        });
    });
}

function toFriendlyPullError(error, imageRef, command) {
    const text = `${error && error.output || ''}\n${error && error.message || ''}`;
    const info = describeError(text, { imageRef, command });
    const friendly = new Error(info
        ? `${info.reason}\n${info.action}`
        : `拉取镜像 ${imageRef} 失败: ${String(error && error.message || error).split('\n')[0]}`);
    friendly.code = info ? info.code : 'IMAGE_PULL_FAILED';
    friendly.cause = error;
    return friendly;
}

/**
 * 本地没有镜像就拉取；已有则什么都不做。
 * 失败抛出带“原因 + 下一步”的错误：运行时不可用 / 镜像不存在 / 网络问题。
 * @returns {Promise<{pulled: boolean}>}
 */
async function ensureImagePresent(options) {
    const { imageRef, command, isPresent, pull, onStart } = options;
    if (await isPresent()) {
        return { pulled: false };
    }
    if (onStart) onStart();
    try {
        await pull();
    } catch (error) {
        throw toFriendlyPullError(error, imageRef, command);
    }
    return { pulled: true };
}

module.exports = {
    pullImageProcess,
    toFriendlyPullError,
    ensureImagePresent
};
