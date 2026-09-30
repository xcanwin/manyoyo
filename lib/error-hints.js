'use strict';

// 原始运行时/系统错误 -> “原因 + 下一步”。新增映射只改这里。
const RULES = [
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
        code: 'IMAGE_PULL_FAILED',
        pattern: /localhost\/v2|pinging container registry|connection refused|dial tcp .*:443|pull access denied|manifest unknown|failed to resolve reference|TLS handshake timeout|no such host/i,
        describe: ({ imageRef }) => ({
            reason: `本地未找到镜像${imageRef ? ` ${imageRef}` : ''}，并且从镜像仓库拉取失败。`,
            action: '检查网络后重试；或更新 ~/.manyoyo/manyoyo.json 的 imageVersion；或先执行 manyoyo build --iv <x.y.z-后缀> 构建镜像。'
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
        pattern: /xcode-select|Xcode command line tools|invalid active developer path/i,
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
        if (rule.pattern.test(raw)) {
            return { code: rule.code, ...rule.describe(ctx) };
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
