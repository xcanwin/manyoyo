---
title: 容器模式
description: "选择 common、dind、sock 三种容器模式，并了解各自的开启方式。"
---

# 容器模式

本页帮你决定容器里是否需要运行容器，并给出三种模式的开启方法。模式只有 `common`、`dind`、`sock`。

## 模式对比

| 模式 | 用途 | 隔离强度 | 需要的参数 |
|------|------|----------|------------|
| `common`（默认） | 日常开发，容器内不运行容器 | 最强 | 无 |
| `dind` | 容器内再运行容器（构建镜像、CI） | 较弱，容器带 `--privileged` | `-m dind` |
| `sock` | 容器内直接操作宿主机的容器运行时 | 最弱，等同拥有宿主机容器权限 | `-m sock` |

不确定就用 `common`；需要容器嵌套时优先 `dind`，不要用 `sock`。各模式的风险详见 [安全须知](../guide/security.md)。

开启方式有两种，效果相同：命令行 `-m, --cont-mode <mode>`，或在 `~/.manyoyo/manyoyo.json` 的 `runs.<name>` 里写 `containerMode`。

## common（默认）

适合不需要在容器里运行 Docker/Podman 的场景。不加任何参数就是 common。

```bash
manyoyo run -r claude
manyoyo run -r claude -m common   # 显式指定，效果相同
```

风险：最低，容器无法访问宿主机的容器运行时。

## dind

适合需要在容器里构建镜像、运行容器的场景。容器以 `--privileged` 启动，容器内的服务与宿主机隔离。`dockerd` 不会自动启动，需要在容器内手动执行 `nohup dockerd &`（使用 Podman 则无需启动守护进程）。

```bash
manyoyo run -r claude -m dind
```

```json5
{
    runs: {
        claude: { containerMode: "dind" }
    }
}
```

风险：`--privileged` 放宽了容器的内核权限，只在需要时使用。详细操作见 [Docker-in-Docker](../advanced/docker-in-docker.md)。

## sock

适合必须让容器直接管理宿主机上已有容器的少数场景。容器以 `--privileged` 启动，并挂载宿主机的 `/var/run/docker.sock`，同时设置 `DOCKER_HOST` 与 `CONTAINER_HOST`。

```bash
manyoyo run -r claude -m sock
```

风险：容器内的 Agent 可以删除、读取宿主机上的任何容器与镜像，并可借此访问宿主机文件，完成任务后立即删除容器。详见 [安全须知](../guide/security.md)。

## 下一步

- [安全须知](../guide/security.md)
- [Docker-in-Docker](../advanced/docker-in-docker.md)
- [命令行选项](cli-options.md)
