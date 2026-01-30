[中文](../README.md) | **<[English](README_EN.md)>**

---

# MANYOYO (Man-Yo-Yo)

**MANYOYO** is an AI agent security sandbox that is safe, efficient, and token-saving. Designed specifically for Agent YOLO mode to protect the host machine.

Pre-installed with common agents and tools to further save tokens. Freely switch between agents and `/bin/bash` in a loop for enhanced efficiency.

**MANYOYO** provides an isolated Docker/Podman container environment for running AI agent CLIs safely.

## Key Features

- **Multi-Agent Support**: Supports claude code, gemini, codex, opencode
- **Security Isolation**: Protects host machine, supports safe nested containers (Docker-in-Docker)
- **Quick Launch**: Quickly enable common Agent YOLO / SOLO mode (e.g., claude --dangerously-skip-permissions)
- **Convenient Operations**: Quick access to `/bin/bash`
- **Session Recovery**: Install Skills Marketplace to quickly resume sessions
- **Flexible Customization**: Support custom `BASEURL`, `AUTH_TOKEN`, and other variables
- **Configuration Management**: Quick import of configuration files
- **Advanced Mode**: Supports dangerous nested containers (mount-docker-socket), custom sandbox images

# Usage

## 1. Install manyoyo

### Global Installation (Recommended)

```bash
npm install -g @xcanwin/manyoyo
```

### Local Development

```bash
npm install -g .
```

## 2. Install podman

2.1 Install [podman](https://podman.io/docs/installation)

2.2 Pull base image

```bash
podman pull ubuntu:24.04
```

## 3. Build Image

Only one of the following commands needs to be executed:

```bash
# Build using manyoyo (Recommended, auto-cache enabled)
manyoyo --ib                                     # Build full version by default (Recommended)
manyoyo --ib --iba TOOL=common                   # Build common version (python,nodejs,claude)
manyoyo --ib --iba TOOL=go,codex,java,gemini     # Build custom combination
manyoyo --ib --iba GIT_SSL_NO_VERIFY=true        # Build the full version and skip Git SSL verification
manyoyo --ib --in myimage --iv 2.0.0             # Customize the image name and version to produce myimage:2.0.0-full
# How it works:
# - First build: Auto-downloads Node.js, JDT LSP, gopls etc. to docker/cache/
# - Rebuild within 2 days: Uses local cache, ~5x faster
# - After cache expires: Auto-downloads latest versions

# Or build manually (Not recommended)
iv=1.0.0 && podman build -t localhost/xcanwin/manyoyo:$iv-full -f docker/manyoyo.Dockerfile . --build-arg TOOL=full --no-cache
```

## 4. Usage

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
manyoyo -n test --crm

# Clean dangling images and <none> images
manyoyo --irm

# Execute custom command with quiet output
manyoyo -q full -x echo "hello world"
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
- `x` - Execute a new command
- `i` - Enter interactive shell

### Container Modes

#### Docker-in-Docker Development

```bash
# Docker-in-Docker (safe nested containers)
# Create a container with Docker-in-Docker support
manyoyo -n docker-dev -m dind -x /bin/bash

podman ps -a             # Now you can use podman commands inside the container

nohup dockerd &          # Inside the container, start dockerd
docker ps -a             # Now you can use docker commands inside the container
```

#### Mount Docker socket Development

```bash
# Mount Docker socket (dangerous!!! containers can access and execute everything on the host)
# Create a container mounting /var/run/docker.sock
manyoyo -n socket-dev -m sock -x /bin/bash

podman ps -a             # Now you can use podman commands inside the container

docker ps -a             # Now you can use docker commands inside the container
```

### Command-Line Options

| Option | Aliases | Description |
|--------|---------|-------------|
| `--hp PATH` | `--host-path` | Set host working directory (default: current path) |
| `-n NAME` | `--cn`, `--cont-name` | Set container name |
| `--cp PATH` | `--cont-path` | Set container working directory |
| `-l` | `--cl`, `--cont-list` | List all manyoyo containers |
| `--crm` | `--cont-remove` | Remove container |
| `-m MODE` | `--cm`, `--cont-mode` | Set container mode (common, dind, sock) |
| `--in NAME` | `--image-name` | Specify image name |
| `--iv VERSION` | `--image-ver` | Specify image version |
| `--ib` | `--image-build` | Build image |
| `--iba` | `--image-build-arg` | Pass arguments to a Dockerfile during image build |
| `--irm` | `--image-remove` | Clean dangling images and `<none>` images |
| `-e STRING` | `--env` | Set environment variable |
| `--ef FILE` | `--env-file` | Load environment variables from file |
| `-v STRING` | `--volume` | Bind mount volume |
| `--sp CMD` | `--shell-prefix` | Temporary environment variable (prefix for -s) |
| `-s CMD` | `--shell` | Specify command to execute |
| `--` | `--ss`, `--shell-suffix` | Command arguments (suffix for -s) |
| `-x CMD` | `--sf`, `--shell-full` | Full command (replaces --sp, -s, and --) |
| `-y CLI` | `--yolo` | Run AI agent without confirmation |
| `--install NAME` | | Install manyoyo command |
| `-q LIST` | `--quiet` | Quiet output |
| `-V` | `--version` | Show version |
| `-h` | `--help` | Show help |

## Additional Information

### Default Configuration

- **Container Name**: `myy-{MMDD-HHMM}` (auto-generated based on current time)
- **Host Path**: Current working directory
- **Container Path**: Same as host path
- **Image**: `localhost/xcanwin/manyoyo:xxx`

### Requirements

- Node.js >= 22.0.0
- Podman or Docker

### Uninstall

```bash
npm uninstall -g @xcanwin/manyoyo
```

## License

MIT
