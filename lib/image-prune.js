'use strict';

// 清理悬空镜像。绝不能用 `rmi -f`：Podman 的 `rmi --force` 会连带删除正在用该镜像的容器，
// 用户的旧容器（里面可能有没导出的工作成果）就这样没了。这里只做不带 -f 的清理，
// 被容器引用的镜像删不掉是预期行为，直接跳过。

function pruneDanglingImages({ dockerExecArgs, log = () => {}, colors = {} }) {
    const { YELLOW = '', GREEN = '', NC = '' } = colors;
    log(`\n${YELLOW}清理悬空镜像...${NC}`);
    // image prune 只清未被任何容器引用的悬空镜像
    try {
        dockerExecArgs(['image', 'prune', '-f'], { stdio: 'inherit' });
    } catch (error) {
        // daemon 不可用等：清理是尽力而为，不要把一次维护命令变成异常
        log(`${YELLOW}⚠️  image prune 失败，已跳过: ${String(error && error.message || error).split('\n')[0]}${NC}`);
        return;
    }

    try {
        const imagesOutput = dockerExecArgs(['images', '-a', '--format', '{{.ID}} {{.Repository}}']);
        const noneImages = [...new Set(String(imagesOutput)
            .split('\n')
            .filter(line => line.includes('<none>'))
            .map(line => line.split(' ')[0])
            .filter(id => id))];

        if (noneImages.length > 0) {
            log(`${YELLOW}尝试清理剩余的 <none> 镜像 (${noneImages.length} 个，仍被容器使用的会自动跳过)...${NC}`);
            for (const id of noneImages) {
                try {
                    dockerExecArgs(['rmi', id], { stdio: 'pipe' });
                } catch (error) {
                    // 被容器使用或被其它镜像依赖：保留
                }
            }
        }
    } catch (error) {
        // 列不出镜像就算了
    }

    log(`${GREEN}✅ 清理完成${NC}`);
}

module.exports = { pruneDanglingImages };
