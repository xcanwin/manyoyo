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
manyoyo -l
manyoyo --cont-list

# View using Docker/Podman commands
docker ps -a | grep myy
podman ps -a | grep myy
```

### Create Container

```bash
# Create and run container (auto-generate container name)
manyoyo -x echo "Hello MANYOYO"

# Specify container name
manyoyo -n myy-dev -x /bin/bash

# Use timestamp container name (default)
manyoyo -y c  # Auto-generates name like myy-0204-1430
```

### Delete Container

```bash
# Delete specified container
manyoyo -n myy-dev --crm
manyoyo -n myy-dev --cont-remove

# Auto-delete on exit (one-time mode)
manyoyo -n temp --rm-on-exit -x /bin/bash
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
manyoyo -x echo "Hello World"

# Execute multiple commands (using && to connect)
manyoyo -x 'echo "Start" && ls -la && echo "End"'

# Use full command (-x or --shell-full)
manyoyo --sf 'python3 --version'
```

### Interactive Shell

```bash
# Enter interactive bash
manyoyo -x /bin/bash

# Enter shell in existing container
manyoyo -n myy-dev -x /bin/bash

# Specify working directory
manyoyo --hp /path/to/project -x /bin/bash
```

### Command Composition

MANYOYO supports three ways to compose commands:

#### 1. Using --shell-full (Recommended)

```bash
# Full command
manyoyo -x 'claude --version'
```

#### 2. Using --shell-prefix, --shell, --

```bash
# Set environment variable + command + arguments
manyoyo --sp 'DEBUG=1' -s claude -- --version

# Equivalent to: DEBUG=1 claude --version
```

#### 3. Step-by-step Setup

```bash
# Set command only
manyoyo -s claude

# Add prefix
manyoyo --sp 'DEBUG=1' -s claude

# Add suffix arguments
manyoyo -s claude -- --help
```

## AI CLI Shortcuts

MANYOYO provides shortcuts to launch AI CLI tools in YOLO/SOLO mode (skip permission confirmation).

### Claude Code

```bash
# Using shortcuts
manyoyo -y c          # Recommended
manyoyo -y claude
manyoyo -y cc

# Equivalent to
manyoyo -x claude --dangerously-skip-permissions
```

### Gemini

```bash
# Using shortcuts
manyoyo -y gm         # Recommended
manyoyo -y gemini
manyoyo -y g

# Equivalent to
manyoyo -x gemini --skip-safety-check
```

### Codex

```bash
# Using shortcuts
manyoyo -y cx         # Recommended
manyoyo -y codex

# Equivalent to
manyoyo -x codex --skip-permissions
```

### OpenCode

```bash
# Using shortcuts
manyoyo -y oc         # Recommended
manyoyo -y opencode

# Equivalent to
manyoyo -x opencode --yolo
```

## Environment Variables and Configuration

### Using Environment Variables

```bash
# String form (-e parameter)
manyoyo -e "ANTHROPIC_BASE_URL=https://api.anthropic.com" \
        -e "ANTHROPIC_AUTH_TOKEN=sk-xxx" \
        -x claude

# Multiple environment variables
manyoyo -e "VAR1=value1" \
        -e "VAR2=value2" \
        -e "VAR3=value3" \
        -x /bin/bash
```

### Using Environment Files

```bash
# Load environment file
manyoyo --ef anthropic_claudecode -x claude

# Load multiple environment files
manyoyo --ef base --ef anthropic_secrets -x claude

# Use relative path
manyoyo --ef ./local.env -x claude
```

### Using Run Configuration

```bash
# Load run configuration
manyoyo -r claude

# Run configuration + override environment variables
manyoyo -r claude -e "DEBUG=true"

# Run configuration + additional environment file
manyoyo -r claude --ef additional
```

For detailed configuration, refer to [Configuration System](../configuration/).

## Directories and Mounts

### Working Directory

```bash
# Default mount current directory
manyoyo -y c  # Current directory mounted to same path in container

# Specify host working directory
manyoyo --hp /path/to/project -y c

# Specify container working directory
manyoyo --cp /workspace -y c

# Specify both
manyoyo --hp /Users/me/project --cp /workspace -y c
```

### Additional Mounts

```bash
# Mount single file
manyoyo -v "/Users/me/.ssh/config:/root/.ssh/config:ro" -y c

# Mount multiple directories
manyoyo -v "/data:/workspace/data" \
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
manyoyo -y c

# Create named session
manyoyo -n my-project --ef anthropic -y c
```

### Resume Session

Different AI CLI tools have different resume commands:

```bash
# Claude Code
manyoyo -n my-project -- -c

# Codex
manyoyo -n my-project -- resume --last

# Gemini
manyoyo -n my-project -- -r

# OpenCode
manyoyo -n my-project -- -c
```

### Interactive Session Prompt

After exiting a container session, the system will prompt you to choose an action:

```
Container exited, please choose an action:
  y - Keep container running in background (default)
  n - Remove container
  1 - Re-enter using initial command
  x - Execute new command
  i - Enter interactive shell
```

**Option Descriptions**:

- **y (default)**: Keep container running, can resume later
- **n**: Remove container, free resources
- **1**: Re-enter using the command that started the container
- **x**: Execute new custom command
- **i**: Enter /bin/bash interactive shell

**Example**:
```bash
# Start container
manyoyo -n dev -y c

# After working for a while, exit
# System prompts for action

# Choose 'y' - Keep running
# Resume session later
manyoyo -n dev -- -c

# Or choose 'i' - Enter shell to inspect
manyoyo -n dev -x /bin/bash
```

## Silent Mode

Silent mode reduces output information, suitable for scripts and CI/CD.

### Silent Options

```bash
# Silent prompt messages
manyoyo -q tip -x echo "Hello"

# Silent command display
manyoyo -q cmd -x echo "Hello"

# Silent all output
manyoyo -q full -x echo "Hello"

# Combine multiple silent options
manyoyo -q tip -q cmd -x echo "Hello"
```

### Auto-confirmation

```bash
# Skip all interactive confirmations (for scripts)
manyoyo --yes --ib --iv 1.7.0

# Combined usage
manyoyo --yes -q full -x echo "Automated"
```

## Image Management

### Specify Image

```bash
# Use default image name, specify version
manyoyo --iv 1.7.0-full -y c

# Use custom image
manyoyo --in myuser/sandbox --iv 1.0.0 -y c

# Full image identifier
manyoyo --in localhost/xcanwin/manyoyo --iv 1.7.0-full -y c
```

### Build Image

```bash
# Build default image
manyoyo --ib --iv 1.7.0

# Build custom image
manyoyo --ib --in mysandbox --iv 1.0.0

# Build minimal version
manyoyo --ib --iba TOOL=common

# Build specific tools
manyoyo --ib --iba TOOL=python,nodejs,claude
```

### Clean Images

```bash
# Clean dangling images and <none> images
manyoyo --irm
manyoyo --image-remove

# Clean using Docker/Podman
docker system prune -a  # or podman system prune -a
docker image prune      # Only clean dangling images
```

## Debugging and Diagnostics

### View Configuration

```bash
# Display final effective configuration
manyoyo --show-config

# Display merged result of specific configuration
manyoyo -r claude --show-config

# Display command to be executed
manyoyo --show-command -r claude
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
manyoyo -n debug -x /bin/bash

# Check internal container state
manyoyo -n debug -x 'env | sort'
manyoyo -n debug -x 'ls -la'
manyoyo -n debug -x 'which claude'

# Test network
manyoyo -n debug -x 'ping -c 3 api.anthropic.com'
manyoyo -n debug -x 'curl -I https://api.anthropic.com'
```

## Practical Tips

### Quick Testing

```bash
# Test if container is working
manyoyo -x echo "Container works"

# Test environment variables
manyoyo -e "TEST=123" -x 'echo $TEST'

# Test mounts
manyoyo -v "/tmp/test:/test" -x 'ls -la /test'
```

### One-time Container

```bash
# Auto-delete after running
manyoyo --rm-on-exit -x 'echo "Temporary"'

# For temporary testing
manyoyo -n temp --rm-on-exit -x /bin/bash
```

### Quick Tool Switching

```bash
# Start Claude Code
manyoyo -r claude

# After exit, switch to Codex
manyoyo -r codex

# Switch to interactive shell
manyoyo -n current-container -x /bin/bash
```

### Batch Operations

```bash
# Run commands in multiple projects
for proj in project1 project2 project3; do
    cd $proj
    manyoyo -n myy-$proj -y c
    cd ..
done

# Clean all test containers
docker ps -a | grep myy-test | awk '{print $1}' | xargs docker rm
```

## Common Workflows

### Development Workflow

```bash
# 1. Start development container
manyoyo -n dev-project --ef anthropic -y c

# 2. Work... (AI-assisted programming)

# 3. After exit, keep running (choose 'y')

# 4. Resume when needed
manyoyo -n dev-project -- -c

# 5. Enter shell to inspect
manyoyo -n dev-project -x /bin/bash

# 6. Remove container when done
manyoyo -n dev-project --crm
```

### Multi-project Workflow

```bash
# Project A
manyoyo -n project-a --hp ~/projects/a --ef claude -y c

# Project B
manyoyo -n project-b --hp ~/projects/b --ef claude -y c

# Switch back to Project A
manyoyo -n project-a -- -c

# List all project containers
manyoyo -l
```

### CI/CD Workflow

```bash
# Automation script example
#!/bin/bash

# Set non-interactive mode
manyoyo --yes -q full \
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

- [Configuration System](../configuration/) - Learn how to use configuration files to simplify operations
- [Command Reference](../reference/cli-options) - View all command-line options
- [Container Modes](../reference/container-modes) - Learn about different container nesting modes
- [Troubleshooting](../troubleshooting/) - Solve common problems
