# MANYOYO

- 中文名：慢悠悠。
- 一款AI智能体安全增强工具，安全、高效、省token。
- 保障在Agent YOLO模式下宿主机的安全。
- 对大模型采用ReAct得到AI Agent，对AI Agent采用循环得到manyoyo。从而实现高效。
- 通过预装常见AI Agent及大量AI常用工具实现节省token。

# 功能

- 环境隔离，安全可靠
- 快捷开启常见Agent YOLO模式
- 快捷进入/bin/bash
- 安装Skills Marketplace后快捷恢复之前会话
- 自定义BASEURL、AUTH_TOKEN等任意变量
- 快捷导入配置文件
- 支持安全的容器嵌套容器docker-in-docker模式
- 支持危险的容器嵌套容器mount-docker-socket模式
- 自定义其他安全沙箱镜像

# 镜像编译

```
iv=1.0.0 && podman build -t localhost/xcanwin/manyoyo:$iv -f docker/manyoyo.Dockerfile . --no-cache
podman image prune -f
```

# 使用方法

```
./manyoyo.sh --install manyoyo
manyoyo -h
```

## 命令行介绍

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
