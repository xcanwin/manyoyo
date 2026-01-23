# MANYOYO（慢悠悠）

**MANYOYO** 是一款 AI 智能体安全增强工具，安全、高效、省 token，专为 Agent YOLO 模式设计，保障宿主机安全。

预装常见 Agent 与工具，进一步节省 token。循环自由切换 Agent 和 /bin/bash，进一步提效。

## 功能亮点

- **多Agent**：支持 claude code, gemini, codex, opencode
- **安全隔离**：保护宿主机，支持安全容器嵌套（Docker-in-Docker）
- **高效启动**：快捷开启常见 Agent YOLO / SOLO 模式（例如 claude --dangerously-skip-permissions）
- **便捷操作**：快速进入 `/bin/bash`
- **会话恢复**：安装 Skills Marketplace 可快速恢复会话
- **自定义灵活**：支持自定义 `BASEURL`、`AUTH_TOKEN` 等变量
- **配置管理**：快捷导入配置文件
- **高级模式**：支持危险容器嵌套（mount-docker-socket）、自定义沙箱镜像

# 使用方法

1. 安装 [podman](https://podman.io/docs/installation)
2. 编译镜像

```
podman pull ubuntu:24.04
iv=1.1.0 && podman build -t localhost/xcanwin/manyoyo:$iv -f docker/manyoyo.Dockerfile . --no-cache
podman image prune -f
```

3. 执行命令

```
./manyoyo.sh --install manyoyo
manyoyo -h
```

## 命令行说明

```
Usage:
  manyoyo [OPTIONS]
  manyoyo [--hp HOST_PATH] [-n CONTAINER_NAME] [--cp CONTAINER_PATH] [--ef ENV_FILE] [--sp COMMAND] [-s COMMAND] [-- COMMAND]

Options:
  -l|--ls|--list                 列举容器
  --hp|--host-path PATH          设置宿主机工作目录 (默认当前路径)
  -n|--cn|--cont-name NAME       设置容器名称
  --cp|--cont-path PATH          设置容器工作目录
  --in|--image-name NAME         指定镜像名称
  --iv|--image-ver VERSION       指定镜像版本
  -e|--env STRING                设置环境变量
  --ef|--env-file ENV_FILE       设置环境变量通过文件
  -v|--volume STRING             绑定挂载卷
  --rm|--remove-cont             删除-n容器
  --sp|--shell-prefix COMMAND    临时环境变量 (作为-s前缀)
  -s|--shell COMMAND             指定命令执行
  --|--shell-suffix COMMAND      指定命令参数, --后面全部直传 (作为-s后缀)
  -x|--shell-full COMMAND        指定完整命令执行, -x后面全部直传 (代替--sp和-s和--命令)
  -y|--yolo CLI                  使AGENT无需确认 (代替-s命令)
                                 例如 claude / c, gemini / gm, codex / cx, opencode / oc
  -m|--cm|--cont-mode STRING     设置容器嵌套容器模式
                                 例如 common, dind, mdsock
  --install NAME                 安装manyoyo命令
                                 例如 manyoyo, myy, docker-cli-plugin
  -h|--help                      显示帮助

Example:
  ./manyoyo.sh --install manyoyo              安装manyoyo命令
  manyoyo -n test --ef ./xxx.env -y c         设置环境变量并运行无需确认的AGENT
  manyoyo -n test -- -c                       恢复之前会话
  manyoyo -x echo 123                         指定命令执行
  manyoyo -n test --ef ./xxx.env -x claude    设置环境变量并运行
  manyoyo -n test -x claude -c                恢复之前会话
```
