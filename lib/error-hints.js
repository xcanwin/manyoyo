'use strict';

const { describeMissing } = require('./rootless-network');

// 原始运行时/系统错误 -> “原因 + 下一步”。新增映射只改这里。
const RULES = [
    {
        code: 'ROOTLESS_NETWORK_MISSING',
        pattern: /could not find (slirp4netns|pasta)/i,
        describe: (ctx, match) => describeMissing(match[1].toLowerCase(), ctx)
    },
    {
        code: 'PODMAN_MACHINE_UNAVAILABLE',
        pattern: /Cannot connect to Podman|unable to connect to Podman socket|podman machine start|podman system connection/i,
        describe: ({ command }) => ({
            reason: `当前 ${command} 命令正在连接 Podman machine，但连接不可用。`,
            action: '请先在宿主机执行: podman machine start'
        })
    },
    {
        code: 'DOCKER_DAEMON_UNAVAILABLE',
        pattern: /Cannot connect to the Docker daemon|docker daemon is not running|Is the docker daemon running/i,
        describe: ({ command }) => ({
            reason: `当前 ${command} 命令无法连接容器运行时。`,
            action: '请先启动 Docker Desktop / Docker daemon，或确认 Podman machine 已启动。'
        })
    },
    {
        code: 'IMAGE_PULL_RATE_LIMITED',
        pattern: /toomanyrequests|too many requests|rate limit/i,
        describe: ({ imageRef }) => ({
            reason: `拉取镜像${imageRef ? ` ${imageRef}` : ''}被镜像仓库限流（请求过于频繁）。`,
            action: '稍等几分钟后重试；若在公共网络/代理出口下反复出现，换一个网络，或用离线安装包里自带的镜像。'
        })
    },
    {
        code: 'IMAGE_UNAUTHORIZED',
        pattern: /\bunauthorized\b|authentication required|permission_denied|denied: installation not allowed/i,
        describe: ({ imageRef }) => ({
            reason: `镜像仓库拒绝了对${imageRef ? ` ${imageRef} ` : ' 镜像'}的匿名访问（未授权）。`,
            action: '确认镜像名与版本无误；若是私有仓库，先执行 docker login / podman login；公开镜像仍报此错时，可能是过期的登录凭据，执行 logout 后重试。'
        })
    },
    {
        code: 'IMAGE_NOT_FOUND',
        pattern: /manifest unknown|repository does not exist|pull access denied|requested access to the resource is denied|name unknown|not found: manifest/i,
        describe: ({ imageRef }) => ({
            reason: `镜像${imageRef ? ` ${imageRef}` : ''}不存在（仓库里没有这个版本，或没有访问权限）。`,
            action: '检查 ~/.manyoyo/manyoyo.json 的 imageName / imageVersion；或先执行 manyoyo build --iv <x.y.z-后缀> 本地构建。'
        })
    },
    {
        code: 'IMAGE_PULL_FAILED',
        pattern: /localhost\/v2|pinging container registry|connection refused|dial tcp .*:443|TLS handshake timeout|no such host|i\/o timeout/i,
        describe: ({ imageRef }) => ({
            reason: `拉取镜像${imageRef ? ` ${imageRef}` : ''}失败，无法连接镜像仓库。`,
            action: '检查网络或代理后重试（国内网络可能需要代理或镜像加速）；也可以先执行 manyoyo build 本地构建。'
        })
    },
    {
        code: 'PORT_IN_USE',
        pattern: /port is already allocated|address already in use|EADDRINUSE/i,
        describe: ({ port }) => ({
            reason: `端口${port ? ` ${port}` : ''}已被占用。`,
            action: '换一个端口，或关闭占用该端口的程序后重试。'
        })
    },
    {
        code: 'XCODE_CLT_MISSING',
        // 只认真正的 CLT 缺失输出，不能因为输出里提到 xcode-select 就误判
        pattern: /xcode-select: (error|note)|invalid active developer path|xcrun: error|command line tools are (not installed|required)/i,
        describe: () => ({
            reason: '该功能需要 Xcode 命令行工具。',
            action: '请在终端执行: xcode-select --install，安装完成后重试。'
        })
    }
];

/**
 * @param {string} text 命令失败的原始输出
 * @param {{command?: string, imageRef?: string, port?: number|string}} [context]
 * @returns {{code: string, reason: string, action: string}|null}
 */
function describeError(text, context = {}) {
    const raw = String(text || '');
    const ctx = { command: 'docker', imageRef: '', port: '', ...context };
    for (const rule of RULES) {
        const match = rule.pattern.exec(raw);
        if (match) {
            return { code: rule.code, ...rule.describe(ctx, match) };
        }
    }
    return null;
}

function formatErrorHint(text, context = {}) {
    const info = describeError(text, context);
    return info ? `\n提示: ${info.reason}\n${info.action}` : '';
}

module.exports = {
    describeError,
    formatErrorHint
};
