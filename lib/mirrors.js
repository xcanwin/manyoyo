'use strict';

const { normalizeMirrors } = require('./runtime-normalizers');

function hasEnvKey(envArgs, key) {
    const list = Array.isArray(envArgs) ? envArgs : [];
    for (let i = 0; i < list.length; i += 1) {
        if (list[i] !== '--env' && list[i] !== '-e') continue;
        const text = String(list[i + 1] || '');
        const idx = text.indexOf('=');
        if ((idx > 0 ? text.slice(0, idx) : text) === key) return true;
    }
    return false;
}

/**
 * npm / pip 源通过容器环境变量生效（镜像本身不变）。用户在 env 里自己设了同名变量时以用户为准。
 * @param {{apt?: string, npm?: string, pip?: string}} mirrors 已归一化的 mirrors
 * @param {string[]} existingEnvArgs 已有的 --env 参数
 * @returns {string[]} 追加的 --env 参数
 */
function buildMirrorEnvArgs(mirrors, existingEnvArgs = []) {
    const source = mirrors && typeof mirrors === 'object' ? mirrors : {};
    const pairs = [];
    if (source.npm) pairs.push(['NPM_CONFIG_REGISTRY', source.npm]);
    if (source.pip) {
        pairs.push(['PIP_INDEX_URL', source.pip]);
        if (/^http:\/\//i.test(source.pip)) {
            pairs.push(['PIP_TRUSTED_HOST', new URL(source.pip).hostname]);
        }
    }
    const args = [];
    for (const [key, value] of pairs) {
        if (!hasEnvKey(existingEnvArgs, key)) args.push('--env', `${key}=${value}`);
    }
    return args;
}

// 固定脚本：镜像地址只从环境变量读取，不拼接进脚本。
// 第一次执行时备份原文件（.manyoyo-orig，apt 不读这个后缀），之后每次都从备份还原再替换，所以重复执行、换源都幂等。
// 只替换主机部分，保留 /ubuntu、/ubuntu-ports 路径（amd64 与 arm64 通用）。
const APT_MIRROR_SCRIPT = [
    '[ -n "$MANYOYO_APT_MIRROR" ] || exit 0',
    'for f in /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list; do',
    '  [ -f "$f" ] || continue',
    '  [ -f "$f.manyoyo-orig" ] || cp -p "$f" "$f.manyoyo-orig" || exit 1',
    '  cp -p "$f.manyoyo-orig" "$f" || exit 1',
    '  sed -i -E "s|https?://[^/ ]*\\.ubuntu\\.com|${MANYOYO_APT_MIRROR%/}|g" "$f" || exit 1',
    'done'
].join('\n');

function buildAptMirrorExecArgs(containerName, aptMirror) {
    return ['exec', '--user', 'root', '--env', `MANYOYO_APT_MIRROR=${aptMirror}`, containerName, '/bin/sh', '-c', APT_MIRROR_SCRIPT];
}

/**
 * 容器创建后让 apt 源生效；失败只警告，不阻断创建。
 */
function applyAptMirror({ dockerExecArgs, containerName, mirrors, warn = () => {} }) {
    const apt = mirrors && typeof mirrors.apt === 'string' ? mirrors.apt : '';
    if (!apt) return false;
    try {
        dockerExecArgs(buildAptMirrorExecArgs(containerName, apt), { stdio: 'pipe' });
        return true;
    } catch (error) {
        warn(`apt 软件源配置失败（不影响使用，容器内仍是默认源）: ${String(error && error.message || error).split('\n')[0]}`);
        return false;
    }
}

module.exports = { normalizeMirrors, buildMirrorEnvArgs, buildAptMirrorExecArgs, applyAptMirror, APT_MIRROR_SCRIPT };
