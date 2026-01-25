# MANYOYO（慢悠悠）

**MANYOYO** 是一款 AI 智能体提效安全沙箱，安全、高效、省 token，专为 Agent YOLO 模式设计，保障宿主机安全。

预装常见 Agent 与工具，进一步节省 token。循环自由切换 Agent 和 /bin/bash，进一步提效。

MANYOYO provides an isolated Docker/Podman container environment for running AI agent CLIs safely.

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

## 1. 安装 podman

- 安装 [podman](https://podman.io/docs/installation)

## 2. 编译镜像

```
podman pull ubuntu:24.04
iv=1.4.0-all && podman build -t localhost/xcanwin/manyoyo:$iv -f docker/manyoyo.Dockerfile . --build-arg EXT=all --no-cache
podman image prune -f
```

## 3. 安装 manyoyo（选一种）

### Global Installation (Recommended)

```bash
cd ./manyoyo/
npm install -g .
```

### Local Development

```bash
npm install
npm link
```

### Direct Symlink Installation

```bash
node manyoyo.js --install manyoyo
```

## 4. 使用方法

### Basic Commands

```bash
# Show help
manyoyo -h

# Show version
manyoyo -V

# List all containers
manyoyo -l

# Create new container with environment file
manyoyo -n test --ef .env -y c

# Resume existing session
manyoyo -n test -- -c

# Execute command in interactive shell
manyoyo -n test -x /bin/bash

# Execute custom command
manyoyo -n test -x echo "hello world"

# Remove container
manyoyo -n test --rm
```

### Environment Variables

#### String Format

```bash
# Direct
manyoyo -e "VAR=value" -x env

# Multiple
manyoyo -e "A=1" -e "B=2" -x env
```

#### File Format

```bash
# From file
manyoyo --ef .env -x env
```

Environment files (`.env`) support the following formats:

```bash
# With export statement
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
# export CLAUDE_CODE_OAUTH_TOKEN="sk-xxxxxxxx"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
export API_TIMEOUT_MS=3000000
export ANTHROPIC_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-5"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5"
export CLAUDE_CODE_SUBAGENT_MODEL="claude-sonnet-4-5"

# Simple key=value
API_KEY=your-api-key-here

# Quoted values (quotes will be stripped)
MESSAGE="Hello World"
PATH='/usr/local/bin'
```

### AI CLI Shortcuts (skip permissions)

```bash
# Claude Code
manyoyo -y c          # or: claude, cc

# Gemini
manyoyo -y gm         # or: gemini, g

# Codex
manyoyo -y cx         # or: codex

# OpenCode
manyoyo -y oc         # or: opencode
```

### Interactive Session Management

After exiting a container session, you'll be prompted with options:

- `y` - Keep container running in background (default)
- `n` - Delete the container
- `1` - Re-enter with the original command
- `s` - Execute a new command
- `i` - Enter interactive shell

### Container Modes

#### Docker-in-Docker Development

```bash
# Docker-in-Docker (safe nested containers)
# Create a container with Docker-in-Docker support
manyoyo -n docker-dev -m dind -x /bin/bash

# Inside the container, start dockerd
nohup dockerd &

# Now you can use docker commands inside the container
docker run hello-world
```

#### Mount Docker socket Development

```bash
# Mount Docker socket (dangerous - container can access host)
manyoyo -n socket-dev -m mdsock -x docker ps
```

### Command-Line Options

| Option | Aliases | Description |
|--------|---------|-------------|
| `-l` | `--ls`, `--list` | List all manyoyo containers |
| `--hp PATH` | `--host-path` | Set host working directory (default: current path) |
| `-n NAME` | `--cn`, `--cont-name` | Set container name |
| `--cp PATH` | `--cont-path` | Set container working directory |
| `--in NAME` | `--image-name` | Specify image name |
| `--iv VERSION` | `--image-ver` | Specify image version |
| `-e STRING` | `--env` | Set environment variable |
| `--ef FILE` | `--env-file` | Load environment variables from file |
| `-v STRING` | `--volume` | Bind mount volume |
| `--rm` | `--rmc`, `--remove-cont` | Remove container |
| `--sp CMD` | `--shell-prefix` | Temporary environment variable (prefix for -s) |
| `-s CMD` | `--shell` | Specify command to execute |
| `--` | `--ss`, `--shell-suffix` | Command arguments (suffix for -s) |
| `-x CMD` | `--sf`, `--shell-full` | Full command (replaces --sp, -s, and --) |
| `-y CLI` | `--yolo` | Run AI agent without confirmation |
| `-m MODE` | `--cm`, `--cont-mode` | Set container mode (common, dind, mdsock) |
| `--install NAME` | | Install manyoyo command |
| `-V` | `--version` | Show version |
| `-h` | `--help` | Show help |

## 其他说明

### Default Configuration

- **Container Name**: `myy-{MMDD-HHMM}` (auto-generated based on current time)
- **Host Path**: Current working directory
- **Container Path**: Same as host path
- **Image**: `localhost/xcanwin/manyoyo:xxx`

### Requirements

- Node.js >= 14.0.0
- Docker or Podman

## License

MIT
