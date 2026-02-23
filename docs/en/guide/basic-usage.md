# Basic Usage

This page introduces basic usage of MANYOYO, including common commands, container management, and daily operations.

## Help and Version Information

### View Help

```bash
# Display help information
manyoyo -h
manyoyo --help

# Display brief help
manyoyo
```

### View Version

```bash
# Display MANYOYO version
manyoyo -V
manyoyo --version
```

## Container Management

### List Containers

```bash
# List all MANYOYO containers
manyoyo ls

# View using Docker/Podman commands
docker ps -a | grep my
podman ps -a | grep my
```

### Create Container

```bash
# Create and run container (auto-generate container name)
manyoyo run -x echo "Hello MANYOYO"

# Specify container name
manyoyo run -n my-dev -x /bin/bash

# Use timestamp container name (default)
manyoyo run -y c  # Auto-generates name like my-0204-1430
```

### Delete Container

```bash
# Delete specified container
manyoyo rm my-dev
manyoyo rm my-dev

# Auto-delete on exit (one-time mode)
manyoyo run -n temp --rm-on-exit -x /bin/bash
```

### Container Status

```bash
# View running containers
docker ps  # or podman ps

# View all containers (including stopped)
docker ps -a

# View container details
docker inspect <container-name>
docker logs <container-name>
```

## Running Commands

### Basic Command Execution

```bash
# Execute single command
manyoyo run -x echo "Hello World"

# Execute multiple commands (using && to connect)
manyoyo run -x 'echo "Start" && ls -la && echo "End"'

# Use full command (-x or --shell-full)
manyoyo run --shell-full 'python3 --version'
```

### Interactive Shell

```bash
# Enter interactive bash
manyoyo run -x /bin/bash

# Enter shell in existing container
manyoyo run -n my-dev -x /bin/bash

# Specify working directory
manyoyo run --hp /path/to/project -x /bin/bash
```

### Command Composition

MANYOYO supports three ways to compose commands:

#### 1. Using --shell-full (Recommended)

```bash
# Full command
manyoyo run -x 'claude --version'
```

#### 2. Using --shell-prefix, --shell, --

```bash
# Set environment variable + command + arguments
manyoyo run --sp 'DEBUG=1' -s claude -- --version

# Equivalent to: DEBUG=1 claude --version
```

#### 3. Step-by-step Setup

```bash
# Set command only
manyoyo run -s claude

# Add prefix
manyoyo run --sp 'DEBUG=1' -s claude

# Add suffix arguments
manyoyo run -s claude -- --help
```

## AI CLI Shortcuts

MANYOYO provides shortcuts to launch AI CLI tools in YOLO/SOLO mode (skip permission confirmation).

### Claude Code

```bash
# Using shortcuts
manyoyo run -y c          # Recommended
manyoyo run -y claude
manyoyo run -y cc

# Equivalent to
manyoyo run -x claude --dangerously-skip-permissions
```

### Gemini

```bash
# Using shortcuts
manyoyo run -y gm         # Recommended
manyoyo run -y gemini
manyoyo run -y g

# Equivalent to
manyoyo run -x gemini --yolo
```

### Codex

```bash
# Using shortcuts
manyoyo run -y cx         # Recommended
manyoyo run -y codex

# Equivalent to
manyoyo run -x codex --dangerously-bypass-approvals-and-sandbox
```

### OpenCode

```bash
# Using shortcuts
manyoyo run -y oc         # Recommended
manyoyo run -y opencode

# Equivalent to
manyoyo run -x "OPENCODE_PERMISSION='{\"*\":\"allow\"}' opencode"
```

## Environment Variables and Configuration

### Using Environment Variables

```bash
# String form (-e parameter)
manyoyo run -e "ANTHROPIC_BASE_URL=https://api.anthropic.com" \
        -e "ANTHROPIC_AUTH_TOKEN=sk-xxx" \
        -x claude

# Multiple environment variables
manyoyo run -e "VAR1=value1" \
        -e "VAR2=value2" \
        -e "VAR3=value3" \
        -x /bin/bash
```

### Using Environment Files

```bash
# Load environment file
manyoyo run --ef /abs/path/anthropic_claudecode.env -x claude

# Load multiple environment files
manyoyo run --ef /abs/path/base.env --ef /abs/path/anthropic_secrets.env -x claude
```

### Using Run Configuration

```bash
# Load run configuration
manyoyo run -r claude

# Run configuration + override environment variables
manyoyo run -r claude -e "DEBUG=true"

# Run configuration + additional environment file
manyoyo run -r claude --ef /abs/path/additional.env
```

For detailed configuration, refer to [Configuration System](../configuration/README.md).

## Directories and Mounts

### Working Directory

```bash
# Default mount current directory
manyoyo run -y c  # Current directory mounted to same path in container

# Specify host working directory
manyoyo run --hp /path/to/project -y c

# Specify container working directory
manyoyo run --cp /workspace -y c

# Specify both
manyoyo run --hp /Users/me/project --cp /workspace -y c
```

### Additional Mounts

```bash
# Mount single file
manyoyo run -v "/Users/me/.ssh/config:/root/.ssh/config:ro" -y c

# Mount multiple directories
manyoyo run -v "/data:/workspace/data" \
        -v "/cache:/workspace/cache" \
        -y c

# Mount options
# :ro - Read-only
# :rw - Read-write (default)
# :z  - SELinux private label
# :Z  - SELinux shared label
```

## Session Management

### Create Session

```bash
# Create new session (auto-generate name)
manyoyo run -y c

# Create named session
manyoyo run -n my-project --ef /abs/path/anthropic.env -y c
```

### Resume Session

Different AI CLI tools have different resume commands:

```bash
# Claude Code
manyoyo run -n my-project -- -c

# Codex
manyoyo run -n my-project -- resume --last

# Gemini
manyoyo run -n my-project -- -r

# OpenCode
manyoyo run -n my-project -- -c
```

### Interactive Session Prompt

After exiting a container session, the system will prompt you to choose an action:

```
Container exited, please choose an action:
  y - Keep container running in background (default)
  n - Remove container
  1 - Re-enter using initial command
  r - Resume initial command session (agent commands only)
  x - Execute new command
  i - Enter interactive shell
```

**Option Descriptions**:

- **y (default)**: Keep container running, can resume later
- **n**: Remove container, free resources
- **1**: Re-enter using the command that started the container
- **r**: Resume initial command session (auto-append agent resume arg)
- **x**: Execute new custom command
- **i**: Enter /bin/bash interactive shell

**Example**:
```bash
# Start container
manyoyo run -n dev -y c

# After working for a while, exit
# System prompts for action

# Choose 'y' - Keep running
# Resume session later
manyoyo run -n dev -- -c

# Or choose 'i' - Enter shell to inspect
manyoyo run -n dev -x /bin/bash
```

## Silent Mode

Silent mode reduces output information, suitable for scripts and CI/CD.

### Silent Options

```bash
# Silent prompt messages
manyoyo run -q tip -x echo "Hello"

# Silent command display
manyoyo run -q cmd -x echo "Hello"

# Silent all output
manyoyo run -q full -x echo "Hello"

# Combine multiple silent options
manyoyo run -q tip -q cmd -x echo "Hello"
```

### Auto-confirmation

```bash
# Skip all interactive confirmations (for scripts)
manyoyo build --yes --iv 1.8.0-common

# Combined usage
manyoyo run -q full -x echo "Automated"
```

## Image Management

### Specify Image

```bash
# Use default image name, specify version
manyoyo run --iv 1.8.0-full -y c

# Use custom image
manyoyo run --in myuser/sandbox --iv 1.0.0-common -y c

# Full image identifier
manyoyo run --in localhost/xcanwin/manyoyo --iv 1.8.0-full -y c
```

### Build Image

```bash
# Build default image
manyoyo build --iv 1.8.0-common

# Build custom image
manyoyo build --in mysandbox --iv 1.0.0-common

# Build minimal version
manyoyo build --iba TOOL=common

# Build specific tools
manyoyo build --iba TOOL=python,nodejs,claude
```

### Clean Images

```bash
# Clean dangling images and <none> images
manyoyo prune

# Clean using Docker/Podman
docker system prune -a  # or podman system prune -a
docker image prune      # Only clean dangling images
```

## Debugging and Diagnostics

### View Configuration

```bash
# Display final effective configuration
manyoyo config show

# Display merged result of specific configuration
manyoyo config show -r claude

# Display command to be executed
manyoyo config command -r claude
```

### View Logs

```bash
# View container logs
docker logs <container-name>

# View logs in real-time
docker logs -f <container-name>

# View last N lines of logs
docker logs --tail 100 <container-name>
```

### Debug Container

```bash
# Enter container for debugging
manyoyo run -n debug -x /bin/bash

# Check internal container state
manyoyo run -n debug -x 'env | sort'
manyoyo run -n debug -x 'ls -la'
manyoyo run -n debug -x 'which claude'

# Test network
manyoyo run -n debug -x 'ping -c 3 api.anthropic.com'
manyoyo run -n debug -x 'curl -I https://api.anthropic.com'
```

## Practical Tips

### Quick Testing

```bash
# Test if container is working
manyoyo run -x echo "Container works"

# Test environment variables
manyoyo run -e "TEST=123" -x 'echo $TEST'

# Test mounts
manyoyo run -v "/tmp/test:/test" -x 'ls -la /test'
```

### One-time Container

```bash
# Auto-delete after running
manyoyo run --rm-on-exit -x 'echo "Temporary"'

# For temporary testing
manyoyo run -n temp --rm-on-exit -x /bin/bash
```

### Quick Tool Switching

```bash
# Start Claude Code
manyoyo run -r claude

# After exit, switch to Codex
manyoyo run -r codex

# Switch to interactive shell
manyoyo run -n current-container -x /bin/bash
```

### Batch Operations

```bash
# Run commands in multiple projects
for proj in project1 project2 project3; do
    cd $proj
    manyoyo run -n my-$proj -y c
    cd ..
done

# Clean all test containers
docker ps -a | grep my-test | awk '{print $1}' | xargs docker rm
```

## Common Workflows

### Development Workflow

```bash
# 1. Start development container
manyoyo run -n dev-project --ef /abs/path/anthropic.env -y c

# 2. Work... (AI-assisted programming)

# 3. After exit, keep running (choose 'y')

# 4. Resume when needed
manyoyo run -n dev-project -- -c

# 5. Enter shell to inspect
manyoyo run -n dev-project -x /bin/bash

# 6. Remove container when done
manyoyo rm dev-project
```

### Multi-project Workflow

```bash
# Project A
manyoyo run -n project-a --hp ~/projects/a --ef /abs/path/claude.env -y c

# Project B
manyoyo run -n project-b --hp ~/projects/b --ef /abs/path/claude.env -y c

# Switch back to Project A
manyoyo run -n project-a -- -c

# List all project containers
manyoyo ls
```

### CI/CD Workflow

```bash
# Automation script example
#!/bin/bash

# Set non-interactive mode
manyoyo run -q full \
    -n ci-build \
    --rm-on-exit \
    -x 'npm install && npm test && npm run build'

# Check exit code
if [ $? -eq 0 ]; then
    echo "Build success"
else
    echo "Build failed"
    exit 1
fi
```

## Next Steps

- [Configuration System](../configuration/README.md) - Learn how to use configuration files to simplify operations
- [Command Reference](../reference/cli-options.md) - View all command-line options
- [Container Modes](../reference/container-modes.md) - Learn about different container nesting modes
- [Troubleshooting](../troubleshooting/README.md) - Solve common problems
