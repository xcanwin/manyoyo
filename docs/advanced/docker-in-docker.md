---
title: "容器内运行容器 | MANYOYO"
description: "让 AI 智能体在 MANYOYO 沙箱里构建镜像、运行容器：dind 与 sock 两种模式的最小步骤与常见问题。"
---

# 容器内运行容器（dind / sock）

让 AI 智能体在沙箱里构建镜像、运行容器：`dind` 在容器内用独立运行时，`sock` 直接操作宿主机 Docker。两种模式都会给容器加 `--privileged`，风险见 [安全说明](../guide/security.md)；模式对比见 [容器模式](../reference/container-modes.md)。

## dind：容器内独立运行时（推荐）

```bash
manyoyo run -m dind -x /bin/bash
```

进入后可直接使用 Podman：

```bash
podman ps -a
podman run hello-world
podman build -t myimage .
```

需要 Docker 时，先手动启动 `dockerd`：

```bash
nohup dockerd > /var/log/dockerd.log 2>&1 &
sleep 10
docker ps -a
```

嵌套容器的镜像和容器都在外层容器内，删除外层容器即全部清除；重要数据请挂载到外层容器。

### 写入运行配置

```json5
// ~/.manyoyo/manyoyo.json
{
    "runs": {
        "dind": {
            "containerName": "my-dind",
            "containerMode": "dind",
            "envFile": ["/abs/path/anthropic_claudecode.env"],
            "yolo": "c"
        }
    }
}
```

```bash
manyoyo run -r dind
```

### 示例：让智能体改 Dockerfile 并验证

```bash
manyoyo run -r dind
# 让智能体编写 Dockerfile、构建并运行：
podman build -t myapp:test .
podman run --rm myapp:test npm test
```

退出后用 `manyoyo run -n my-dind -x /bin/bash` 回到同一容器查看 `podman ps -a`、`podman images`。

## sock：挂载宿主机 Docker socket

```bash
manyoyo run -m sock -x /bin/bash
docker ps
```

`sock` 会挂载 `/var/run/docker.sock` 并设置 `DOCKER_HOST`、`CONTAINER_HOST`。容器内看到的是宿主机的容器和镜像，操作会直接作用在宿主机上，只在完全信任的任务里使用。

## 常见问题

**`dockerd` 启动失败**：查看 `/var/log/dockerd.log`，或 `dockerd --debug` 前台运行；删除残留的 `/var/run/docker.sock` 后重试。

**Podman 权限不足**：执行 `podman info` 检查存储与命名空间；必要时 `podman system reset`（会清空嵌套容器和镜像）。

**镜像拉取失败**：先确认容器内网络；需要代理时用 `env` 传入 `HTTP_PROXY` / `HTTPS_PROXY`，或在 `/etc/containers/registries.conf` 配置镜像源。

**空间不足**：`podman system df` 查看占用，`podman system prune -a --volumes` 清理。

## 注意事项

- 嵌套容器比直接运行有性能开销，且独立镜像库会增加磁盘占用。
- 外层容器的资源限制同样限制嵌套容器。
- 嵌套容器的端口需要先映射到外层容器，才能从宿主机访问。
- 不建议用于生产环境，生产构建请使用专用运行时或 Kaniko 等无 daemon 工具。

## 下一步

- [容器模式](../reference/container-modes.md)
- [安全说明](../guide/security.md)
- [运行时故障](../troubleshooting/runtime-errors.md)
