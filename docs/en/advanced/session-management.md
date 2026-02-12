# Session Management

This page introduces MANYOYO's session management mechanism, including session creation, resumption, persistence, and best practices.

## What is a Session

In MANYOYO, a **Session** refers to:
- A running container instance
- The working state of the AI agent inside the container
- The agent's conversation history and context

## Session Lifecycle

```
Create → Run → Pause/Exit → Resume → Delete
  ↓      ↓         ↓          ↓       ↓
Container AI Work Container   Continue  Cleanup
          Running  Preserved  Work
```

## Creating Sessions

### Auto-named Sessions

```bash
# Auto-generate container name (based on timestamp)
manyoyo -y c
# Generated name like: my-0204-1430

# View container name
manyoyo -l
```

**Naming Rule**: `my-{MMDD}-{HHMM}`
- Example: `my-0204-1430` means created on Feb 4 at 14:30

### Named Sessions

```bash
# Create named session (recommended)
manyoyo -n my-project -y c

# Advantages:
# - Easy to remember
# - Convenient for managing multiple projects
# - Configuration files can use fixed names
```

### Creating Sessions Using Configuration Files

```bash
# Method 1: Run configuration (recommended)
cat > ~/.manyoyo/run/project-a.json << 'EOF'
{
    "containerName": "my-project-a",
    "envFile": ["anthropic_claudecode"],
    "yolo": "c"
}
EOF

manyoyo -r project-a

# Method 2: Project configuration
cat > ./myproject/.manyoyo.json << 'EOF'
{
    "containerName": "my-myproject",
    "envFile": ["anthropic_claudecode"],
    "yolo": "c"
}
EOF

cd myproject
manyoyo -r ./.manyoyo.json
```

## Session Resumption

### Exit Prompt

When you exit a container session, the system will prompt:

```
Container exited, please select an action:
  y - Keep container running in background (default)
  n - Remove container
  1 - Re-enter using the initial command
  r - Resume initial command session (agent commands only)
  x - Execute a new command
  i - Enter interactive shell
```

### Option Descriptions

#### y - Keep Running (Recommended)

```bash
# After selecting 'y', container runs in background
# You can resume the session later

# Resume Claude Code session
manyoyo -n my-project -- -c

# Resume Codex session
manyoyo -n my-project -- resume --last

# Resume Gemini session
manyoyo -n my-project -- -r
```

**Use Cases**:
- Temporarily away, continue work later
- Need to preserve AI conversation history
- Testing not complete, need to continue

#### n - Remove Container

```bash
# After selecting 'n', container is removed
# All data and history are lost
```

**Use Cases**:
- One-time testing
- Don't need to preserve history
- Want to free resources

#### 1 - Re-enter

```bash
# After selecting '1', re-enter using the startup command
# For example, if started with 'manyoyo -y c'
# Then re-run 'claude --dangerously-skip-permissions'
```

**Use Cases**:
- AI accidentally exited
- Need to restart AI tool
- Clear current session but keep container

#### r - Resume Initial Command Session

```bash
# After selecting 'r', append the agent resume arg to the initial command
# Example:
#   Claude -> -r
#   Codex  -> resume
```

**Use Cases**:
- Initial command is an agent CLI
- Want a fast resume path without manual input

#### x - Execute New Command

```bash
# After selecting 'x', can execute any command
# Prompt to input command

# Example:
x
Enter command to execute: npm test
```

**Use Cases**:
- Need to run tests
- Check modifications made by AI
- Execute custom scripts

#### i - Enter Shell

```bash
# After selecting 'i', enter /bin/bash

# You can:
$ ls -la              # View files
$ git status          # Check code
$ npm test            # Run tests
$ claude --version    # Check tool version
```

**Use Cases**:
- Need to manually check
- Debug issues
- Run multiple commands

### Agent-specific Resume Commands

Different AI CLI tools have different resume methods:

#### Claude Code

```bash
# Resume last session
manyoyo -n my-session -- -c
manyoyo -n my-session -- --continue

# View available sessions
manyoyo -n my-session -x "claude --list-sessions"
```

#### Codex

```bash
# Resume last session
manyoyo -n my-session -- resume --last

# Resume specific session
manyoyo -n my-session -- resume <session-id>

# List all sessions
manyoyo -n my-session -- list
```

#### Gemini

```bash
# Resume session
manyoyo -n my-session -- -r
manyoyo -n my-session -- --resume

# Clear session history
manyoyo -n my-session -- --clear
```

#### OpenCode

```bash
# Resume session
manyoyo -n my-session -- -c
manyoyo -n my-session -- --continue
```

## Session Persistence

### Container Persistence

Container state is managed by Docker/Podman:

```bash
# View all sessions (including stopped)
manyoyo -l
docker ps -a | grep my

# Container status
docker ps -a --format "table {{.Names}}\t{{.Status}}"
```

### Data Persistence

#### 1. Working Directory Mount

```bash
# Mount current directory by default
manyoyo -y c  # Current directory auto-mounted

# Specify working directory
manyoyo --hp /path/to/project -y c

# Code modifications are saved on host
```

#### 2. Additional Data Mount

```bash
# Mount data directory
manyoyo -v "/data:/workspace/data" -y c

# Mount configuration files
manyoyo -v "~/.gitconfig:/root/.gitconfig:ro" -y c
```

#### 3. Use Volumes (Recommended)

```bash
# Create persistent volume
docker volume create myproject-data

# Mount volume
manyoyo -v "myproject-data:/workspace/data" -y c

# Data persists after container removal
```

### AI Conversation History Persistence

Different AI tools store history in different locations:

#### Claude Code

```bash
# History stored inside container
# Location: ~/.claude/sessions/

# Mount session directory (optional)
manyoyo -v "~/.claude:/root/.claude" -y c
```

#### Codex

```bash
# History stored inside container
# Location: ~/.codex/sessions/

# Mount session directory
manyoyo -v "~/.codex:/root/.codex" -y c
```

## Multi-session Management

### Parallel Sessions

```bash
# Project A
manyoyo -n project-a --hp ~/projects/a -y c

# Project B
manyoyo -n project-b --hp ~/projects/b -y c

# Project C
manyoyo -n project-c --hp ~/projects/c -y c

# View all sessions
manyoyo -l
```

### Session Switching

```bash
# Work in project A
manyoyo -n project-a -- -c

# Switch to project B
manyoyo -n project-b -- -c

# Switch to project C
manyoyo -n project-c -- -c
```

### Session Isolation

Each session is completely independent:
- Independent file system
- Independent environment variables
- Independent AI conversation history
- Independent process space

## Session Cleanup

### Manual Cleanup

```bash
# Remove single session
manyoyo -n my-session --crm
manyoyo -n my-session --cont-remove

# Or use Docker command
docker rm -f my-session
```

### Automatic Cleanup

```bash
# One-time session (auto-remove after exit)
manyoyo -n temp --rm-on-exit -y c

# Use cases:
# - Temporary testing
# - Quick verification
# - Don't need to preserve history
```

### Batch Cleanup

```bash
# Clean up all stopped MANYOYO containers
docker ps -a | grep my | grep Exited | awk '{print $1}' | xargs docker rm

# Clean up all MANYOYO containers (dangerous!)
docker ps -a | grep my | awk '{print $1}' | xargs docker rm -f
```

## Session Monitoring

### View Session Status

```bash
# List all MANYOYO sessions
manyoyo -l

# Detailed status
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Resource usage
docker stats $(docker ps -q --filter "name=my")
```

### View Session Logs

```bash
# View container logs
docker logs my-session

# Real-time logs
docker logs -f my-session

# Last 100 lines
docker logs --tail 100 my-session
```

### Enter Running Session

```bash
# Enter shell to check
manyoyo -n my-session -x /bin/bash

# View processes
$ ps aux

# View files
$ ls -la

# View environment variables
$ env | grep ANTHROPIC
```

## Best Practices

### 1. Naming Conventions

```bash
# Name by project
my-webapp
my-api
my-mobile

# Name by function
my-dev
my-test
my-debug

# Name by time (automatic)
my-0204-1430
```

### 2. Configuration File Management

```bash
# Create configuration for each project
~/.manyoyo/run/
├── webapp.json
├── api.json
├── mobile.json
└── debug.json

# Quick start
manyoyo -r webapp
manyoyo -r api
manyoyo -r mobile
```

### 3. Data Backup

```bash
# Export container configuration
docker inspect my-session > my-session.json

# Backup mounted data
tar -czf backup.tar.gz ~/projects/myproject

# Backup AI history (optional)
docker cp my-session:/root/.claude ./claude-backup
```

### 4. Regular Cleanup

```bash
# Weekly cleanup script
cat > ~/cleanup-manyoyo.sh << 'EOF'
#!/bin/bash
# Clean up stopped containers older than 7 days
docker ps -a --filter "name=my" --filter "status=exited" \
    --format "{{.ID}} {{.CreatedAt}}" | \
    awk '{if ($2 < systime() - 604800) print $1}' | \
    xargs -r docker rm

# Clean up dangling images
docker image prune -f
EOF

chmod +x ~/cleanup-manyoyo.sh
```

### 5. Session Templates

```bash
# Create session template
cat > ~/.manyoyo/run/template.json << 'EOF'
{
    "containerName": "my-template",
    "envFile": ["base", "secrets"],
    "volumes": [
        "~/.ssh:/root/.ssh:ro",
        "~/.gitconfig:/root/.gitconfig:ro"
    ],
    "env": [
        "TZ=Asia/Shanghai"
    ]
}
EOF

# Create new session based on template
cp ~/.manyoyo/run/template.json ~/.manyoyo/run/newproject.json
# Modify containerName and specific configuration
```

## Advanced Tips

### Session Snapshots

```bash
# Commit container as image (save current state)
docker commit my-session my-session:snapshot-$(date +%Y%m%d)

# Create new session from snapshot
docker run -it my-session:snapshot-20240204
```

### Session Export/Import

```bash
# Export session
docker export my-session > my-session.tar

# Import to another machine
cat my-session.tar | docker import - my-session:imported
```

### Session Sharing

```bash
# Multi-person collaboration (same container)
# Person A creates session
manyoyo -n shared-session -y c

# Person B enters same session
manyoyo -n shared-session -x /bin/bash

# Note: Not recommended for multiple people to use AI simultaneously
```

## Troubleshooting

### Session Cannot Resume

**Problem**: Container does not exist prompt

**Solution**:
```bash
# Check if container exists
manyoyo -l
docker ps -a | grep my-session

# If not exists, create new session
manyoyo -n my-session -y c
```

### AI History Lost

**Problem**: After resuming session, AI doesn't remember previous conversations

**Solution**:
```bash
# Check if container is newly created
docker ps -a --format "{{.Names}}\t{{.CreatedAt}}"

# Mount session directory (when creating next time)
manyoyo -v "~/.claude:/root/.claude" -n my-session -y c
```

### Container Cannot Start

**Problem**: Session fails to start

**Solution**:
```bash
# View container logs
docker logs my-session

# Remove and recreate
manyoyo -n my-session --crm
manyoyo -n my-session -y c
```

## Integration with Skills Marketplace

If Skills Marketplace is installed, you can get more powerful session management features:

```bash
# List all sessions (including cloud)
claude --list-sessions

# Resume cloud session
claude --resume-session <session-id>

# Sync sessions to cloud
claude --sync-sessions
```

## Related Documentation

- [Basic Usage](../guide/basic-usage.md) - Learn basic commands
- [AI Agents](../reference/agents.md) - Learn about each agent's session management
- [Configuration Examples](../configuration/examples.md) - View configuration examples
- [Container Modes](../reference/container-modes.md) - Learn about container management
