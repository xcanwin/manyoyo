**<[中文](README.md)>** | [English](docs/README_EN.md)

---

# MANYOYO（慢悠悠）

**MANYOYO** 是一款 AI 智能体提效安全沙箱，安全、高效、省 token，专为 Agent YOLO 模式设计，保障宿主机安全。

预装常见 Agent 与工具，进一步节省 token。循环自由切换 Agent 和 `/bin/bash`，进一步提效。

**MANYOYO** 提供隔离的 Docker/Podman 容器环境，用于安全运行 AI 智能体命令行工具。

## 功能亮点

- **多智能体支持**：支持 claude code, gemini, codex, opencode
- **安全隔离**：保护宿主机，支持安全容器嵌套（Docker-in-Docker）
- **快速启动**：快捷开启常见 Agent YOLO / SOLO 模式（例如 claude --dangerously-skip-permissions）
- **便捷操作**：快速进入 `/bin/bash`
- **会话恢复**：安装 Skills Marketplace 可快速恢复会话
- **灵活自定义**：支持自定义 `BASEURL`、`AUTH_TOKEN` 等变量
- **配置管理**：快捷导入配置文件
- **高级模式**：支持危险容器嵌套（mount-docker-socket）、自定义沙箱镜像

# 使用方法

## 1. 安装 manyoyo

### 全局安装（推荐）

```bash
npm install -g @xcanwin/manyoyo
```

### 本地开发

```bash
npm install -g .
```

## 2. 安装 podman

2.1 安装 [podman](https://podman.io/docs/installation)
2.2 拉取基础镜像

```bash
podman pull ubuntu:24.04
```

## 3. 编译镜像

以下命令只需执行一条：

```bash
# 使用 manyoyo 构建镜像（推荐，自动使用缓存加速）
manyoyo --ib                                     # 默认构建 full 版本（推荐）
manyoyo --ib --iba TOOL=common                   # 构建常见组件版本（python,nodejs,claude）
manyoyo --ib --iba TOOL=go,codex,java,gemini     # 构建自定义组件版本
manyoyo --ib --iba GIT_SSL_NO_VERIFY=true        # 构建 full 版本且跳过git的ssl验证
manyoyo --ib --in myimage --iv 2.0.0             # 自定义镜像名称和版本，得到 myimage:2.0.0-full
# 工作原理：
# - 首次构建：自动下载 Node.js、JDT LSP、gopls 等到 docker/cache/
# - 2天内再次构建：直接使用本地缓存，速度提升约 5 倍
# - 缓存过期后：自动重新下载最新版本

# 或手动构建（不推荐）
iv=1.0.0 && podman build -t localhost/xcanwin/manyoyo:$iv-full -f docker/manyoyo.Dockerfile . --build-arg TOOL=full --no-cache
```

## 4. 使用方法

### 基础命令

```bash
# 显示帮助
manyoyo -h

# 显示版本
manyoyo -V

# 列出所有容器
manyoyo -l

# 创建新容器并使用环境文件
manyoyo -n test --ef .env -y c

# 恢复现有会话
manyoyo -n test -- -c

# 在交互式 shell 中执行命令
manyoyo -n test -x /bin/bash

# 执行自定义命令
manyoyo -n test -x echo "hello world"

# 删除容器
manyoyo -n test --crm

# 清理悬空镜像和 <none> 镜像
manyoyo --irm
```

### 环境变量

#### 字符串格式

```bash
# 直接传递
manyoyo -e "VAR=value" -x env

# 多个变量
manyoyo -e "A=1" -e "B=2" -x env
```

#### 文件格式

```bash
# 从文件加载
manyoyo --ef .env -x env
```

环境文件（`.env`）支持以下格式：

```bash
# 使用 export 语句
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
# export CLAUDE_CODE_OAUTH_TOKEN="sk-xxxxxxxx"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
export API_TIMEOUT_MS=3000000
export ANTHROPIC_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-5"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5"
export CLAUDE_CODE_SUBAGENT_MODEL="claude-sonnet-4-5"

# 简单的键值对
API_KEY=your-api-key-here

# 带引号的值（引号会被移除）
MESSAGE="Hello World"
PATH='/usr/local/bin'
```

### AI CLI 快捷方式（跳过权限确认）

```bash
# Claude Code
manyoyo -y c          # 或: claude, cc

# Gemini
manyoyo -y gm         # 或: gemini, g

# Codex
manyoyo -y cx         # 或: codex

# OpenCode
manyoyo -y oc         # 或: opencode
```

### 交互式会话管理

退出容器会话后，系统将提示您选择操作：

- `y` - 保持容器在后台运行（默认）
- `n` - 删除容器
- `1` - 使用首次命令重新进入
- `x` - 执行新命令
- `i` - 进入交互式 shell

### 容器模式

#### Docker-in-Docker 开发

```bash
# Docker-in-Docker（安全的嵌套容器）
# 创建支持 Docker-in-Docker 的容器
manyoyo -n docker-dev -m dind -x /bin/bash

podman ps -a             # 现在可以在容器内使用 podman 命令

nohup dockerd &          # 在容器内启动 dockerd
docker ps -a             # 现在可以在容器内使用 docker 命令
```

#### 挂载 Docker Socket 开发

```bash
# 挂载 Docker Socket（危险的！！！容器可以访问和执行宿主机的一切）
# 创建挂载 /var/run/docker.sock 的容器
manyoyo -n socket-dev -m sock -x /bin/bash

podman ps -a             # 现在可以在容器内使用 podman 命令

docker ps -a             # 现在可以在容器内使用 docker 命令
```

### 命令行选项

| 选项 | 别名 | 描述 |
|------|------|------|
| `--hp PATH` | `--host-path` | 设置宿主机工作目录（默认：当前路径） |
| `-n NAME` | `--cn`, `--cont-name` | 设置容器名称 |
| `--cp PATH` | `--cont-path` | 设置容器工作目录 |
| `-l` | `--cl`, `--cont-list` | 列出所有 manyoyo 容器 |
| `--crm` | `--cont-remove` | 删除容器 |
| `-m MODE` | `--cm`, `--cont-mode` | 设置容器模式（common, dind, sock） |
| `--in NAME` | `--image-name` | 指定镜像名称 |
| `--iv VERSION` | `--image-ver` | 指定镜像版本 |
| `--ib` | `--image-build` | 构建镜像 |
| `--iba XXX=YYY` | `--image-build-arg` | 构建镜像时传参给dockerfile |
| `--irm` | `--image-remove` | 清理悬空镜像和 `<none>` 镜像 |
| `-e STRING` | `--env` | 设置环境变量 |
| `--ef FILE` | `--env-file` | 从文件加载环境变量 |
| `-v STRING` | `--volume` | 绑定挂载卷 |
| `--sp CMD` | `--shell-prefix` | 临时环境变量（作为 -s 的前缀） |
| `-s CMD` | `--shell` | 指定要执行的命令 |
| `--` | `--ss`, `--shell-suffix` | 命令参数（作为 -s 的后缀） |
| `-x CMD` | `--sf`, `--shell-full` | 完整命令（替代 --sp, -s 和 --） |
| `-y CLI` | `--yolo` | 无需确认运行 AI 智能体 |
| `--install NAME` | | 安装 manyoyo 命令 |
| `-V` | `--version` | 显示版本 |
| `-h` | `--help` | 显示帮助 |

## 其他说明

### 默认配置

- **容器名称**：`myy-{月日-时分}`（基于当前时间自动生成）
- **宿主机路径**：当前工作目录
- **容器路径**：与宿主机路径相同
- **镜像**：`localhost/xcanwin/manyoyo:xxx`

### 系统要求

- Node.js >= 22.0.0
- Podman 或 Docker

### 卸载

```bash
npm uninstall -g @xcanwin/manyoyo
```

## 许可证

MIT
