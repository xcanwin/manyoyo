# Configuration Examples

This page provides practical MANYOYO configuration examples covering common usage scenarios.

## Quick Start Examples

### Minimal Global Configuration

```bash
mkdir -p ~/.manyoyo/

cat > ~/.manyoyo/manyoyo.json << 'EOF'
{
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.7.0-full"
}
EOF
```

Usage:
```bash
manyoyo -y c  # Automatically uses image from global configuration
```

## Claude Code Configuration Examples

### Basic Configuration

Baseline template (env vars, run config, common commands) is maintained in one place:  
[AI Agents / Claude Code](../reference/agents.md#claude-code).

### Advanced Configuration (Custom Base URL)

**Environment File** (`~/.manyoyo/env/anthropic_custom.env`):
```bash
# Use custom API endpoint
export ANTHROPIC_BASE_URL="https://custom-api.example.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"

# Custom timeout
export API_TIMEOUT_MS=5000000

# Use specific model
export ANTHROPIC_MODEL="claude-opus-4-5"
export CLAUDE_CODE_SUBAGENT_MODEL="claude-haiku-4-5"

# Enable debugging
export DEBUG="anthropic:*"
```

**Run Configuration** (`~/.manyoyo/run/claude-custom.json`):
```json5
{
    "containerName": "my-claude-custom",
    "envFile": [
        "anthropic_custom"
    ],
    "yolo": "c",
    "quiet": ["tip"]  // Don't display tips
}
```

### OAuth Authentication Configuration

```bash
# Environment file
cat > ~/.manyoyo/env/anthropic_oauth.env << 'EOF'
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export CLAUDE_CODE_OAUTH_TOKEN="your-oauth-token"
export API_TIMEOUT_MS=3000000
EOF
```

## Codex Configuration Examples

### Basic Configuration

Baseline template (env vars, run config, resume commands) is maintained in one place:  
[AI Agents / Codex](../reference/agents.md#codex).

### API Key Authentication Configuration

```bash
# Environment file
cat > ~/.manyoyo/env/openai_api.env << 'EOF'
export OPENAI_API_KEY="sk-xxxxxxxx"
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_MODEL="gpt-4-turbo"
EOF
```

**Run Configuration**:
```json5
{
    "envFile": [
        "openai_api"
    ],
    "yolo": "cx"
}
```

## Gemini Configuration Examples

### Basic Configuration

Baseline template (env vars, run config, resume commands) is maintained in one place:  
[AI Agents / Gemini](../reference/agents.md#gemini).

## OpenCode Configuration Examples

### Basic Configuration

Baseline template (env vars, run config, shortcuts) is maintained in one place:  
[AI Agents / OpenCode](../reference/agents.md#opencode).

## Docker-in-Docker Configuration Examples

### Secure Nested Containers

**Run Configuration** (`~/.manyoyo/run/dind.json`):
```json5
{
    "containerName": "my-dind",
    "containerMode": "dind",
    "envFile": [
        "anthropic_claudecode"
    ],
    "volumes": [
        "~/.docker:/root/.docker:ro"  // Mount Docker config (read-only)
    ]
}
```

**Usage**:
```bash
# Start Docker-in-Docker container
manyoyo -r dind -x /bin/bash

# Use Podman inside container
podman ps -a

# Start dockerd and use Docker inside container
nohup dockerd &
docker ps -a
```

### Mount Socket (Dangerous)

**Run Configuration** (`~/.manyoyo/run/sock.json`):
```json5
{
    "containerName": "my-sock",
    "containerMode": "sock",  // Dangerous: can access everything on host
    "envFile": [
        "anthropic_claudecode"
    ]
}
```

**Warning**: This mode allows the container full access to the host's Docker, posing extremely high security risks!

## Multi-Environment Configuration Examples

### Development, Test, Production Environments

**Global Configuration** (`~/.manyoyo/manyoyo.json`):
```json5
{
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.7.0-full",
    "env": [
        "TZ=Asia/Shanghai"
    ]
}
```

**Development Environment** (`~/.manyoyo/run/dev.json`):
```json5
{
    "containerName": "my-dev",
    "envFile": [
        "anthropic_dev"
    ],
    "env": [
        "NODE_ENV=development",
        "DEBUG=*"
    ],
    "yolo": "c"
}
```

**Test Environment** (`~/.manyoyo/run/test.json`):
```json5
{
    "containerName": "my-test",
    "envFile": [
        "anthropic_test"
    ],
    "env": [
        "NODE_ENV=test",
        "CI=true"
    ],
    "yolo": "c"
}
```

**Production Environment** (`~/.manyoyo/run/prod.json`):
```json5
{
    "containerName": "my-prod",
    "envFile": [
        "anthropic_prod"
    ],
    "env": [
        "NODE_ENV=production"
    ],
    "yolo": "c",
    "quiet": ["tip", "cmd"]  // Silent output in production
}
```

**Usage**:
```bash
manyoyo -r dev   # Development environment
manyoyo -r test  # Test environment
manyoyo -r prod  # Production environment
```

## Project-Specific Configuration Examples

### Web Project Configuration

**Project Configuration** (`./myproject/.manyoyo.json`):
```json5
{
    "containerName": "my-webapp",
    "envFile": [
        "anthropic_claudecode"
    ],
    "env": [
        "PROJECT_NAME=webapp",
        "NODE_ENV=development"
    ],
    "volumes": [
        "./node_modules:/workspace/node_modules",
        "./dist:/workspace/dist"
    ],
    "yolo": "c"
}
```

**Usage**:
```bash
cd myproject
manyoyo -r ./.manyoyo.json
```

### Data Science Project Configuration

**Project Configuration** (`./ml-project/.manyoyo.json`):
```json5
{
    "containerName": "my-ml",
    "envFile": [
        "anthropic_claudecode"
    ],
    "env": [
        "JUPYTER_ENABLE_LAB=yes",
        "PYTHONPATH=/workspace"
    ],
    "volumes": [
        "./data:/workspace/data:ro",     // Data directory (read-only)
        "./models:/workspace/models",    // Model directory
        "./notebooks:/workspace/notebooks"
    ],
    "yolo": "c"
}
```

## Combined Configuration Examples

### Multiple Environment Files Combined

**Base Environment** (`~/.manyoyo/env/base.env`):
```bash
# Common configuration
export TZ=Asia/Shanghai
export LANG=en_US.UTF-8
```

**API Configuration** (`~/.manyoyo/env/anthropic_base.env`):
```bash
# API base configuration
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export API_TIMEOUT_MS=3000000
export ANTHROPIC_MODEL="claude-sonnet-4-5"
```

**Secret Configuration** (`~/.manyoyo/env/anthropic_secrets.env`):
```bash
# Sensitive information (do not commit to version control)
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
```

**Run Configuration** (`~/.manyoyo/run/claude-full.json`):
```json5
{
    "envFile": [
        "base",              // Common configuration
        "anthropic_base",    // API configuration
        "anthropic_secrets"  // Secrets (loaded last, overrides earlier variables with same name)
    ],
    "yolo": "c"
}
```

### Global + Run + Command Line Combined

**Global Configuration** (`~/.manyoyo/manyoyo.json`):
```json5
{
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.7.0-full",
    "env": [
        "TZ=Asia/Shanghai"  // Global environment variable
    ]
}
```

**Run Configuration** (`~/.manyoyo/run/claude.json`):
```json5
{
    "envFile": [
        "anthropic_claudecode"
    ],
    "env": [
        "DEBUG=false"  // Run config environment variable (merged with global)
    ],
    "yolo": "c"
}
```

**Command Line**:
```bash
# Command line environment variable (merged with global and run config)
manyoyo -r claude -e "LOG_LEVEL=debug"

# Final environment variables:
# - TZ=Asia/Shanghai (from global)
# - DEBUG=false (from run config)
# - LOG_LEVEL=debug (from command line)
# - ANTHROPIC_* (from anthropic_claudecode.env)
```

## Custom Image Configuration Examples

### Using Custom Image

**Global Configuration**:
```json5
{
    "imageName": "localhost/myuser/custom-manyoyo",
    "imageVersion": "2.0.0-full"
}
```

**Build Custom Image**:
```bash
manyoyo --ib --in myuser/custom-manyoyo --iv 2.0.0-full --iba TOOL=full
```

### Minimized Image Configuration

**Global Configuration**:
```json5
{
    "imageVersion": "1.7.0-common"  // Use minimal version image
}
```

**Build Minimal Image**:
```bash
manyoyo --ib --iv 1.7.0-common --iba TOOL=common
```

## Team Collaboration Configuration Examples

### Configuration Template

**Team Shared Configuration Template** (`config.example.json`):
```json5
{
    // Team unified image
    "imageName": "localhost/team/manyoyo",
    "imageVersion": "1.7.0-full",

    // Project environment variables
    "env": [
        "PROJECT_NAME=team-project",
        "NODE_ENV=development"
    ],

    // Environment file (need to copy example file and configure)
    "envFile": [
        "anthropic_team"  // Refer to anthropic_team.example.env
    ]
}
```

**Usage**:
```bash
# First time use for team members
cp config.example.json ~/.manyoyo/run/team.json
cp anthropic_team.example.env ~/.manyoyo/env/anthropic_team.env

# Edit configuration (fill in your own API Key)
vim ~/.manyoyo/env/anthropic_team.env

# Use team configuration
manyoyo -r team
```

## Debugging Configuration Examples

### View Final Configuration

```bash
# View configuration merge results
manyoyo -r claude --show-config

# View command to be executed
manyoyo -r claude --show-command

# View environment variables
manyoyo -r claude -x env | grep ANTHROPIC
```

### Enable Verbose Logging

**Run Configuration**:
```json5
{
    "envFile": [
        "anthropic_claudecode"
    ],
    "env": [
        "DEBUG=*",           // Enable all debug logs
        "LOG_LEVEL=debug"
    ],
    "yolo": "c"
}
```

## Best Practices Summary

### 1. File Organization

```bash
~/.manyoyo/
├── manyoyo.json                                   # Global configuration
├── env/                                            # Environment variables directory
│   ├── base.env                                   # Common environment variables
│   ├── anthropic_[claudecode]_claudecode.env      # Claude configuration
│   ├── anthropic_secrets.env                      # Secrets (do not commit)
│   ├── openai_[gpt]_codex.env                    # Codex configuration
│   └── gemini.env                                 # Gemini configuration
└── run/                                            # Run configuration directory
    ├── claude.json                                # Claude run configuration
    ├── codex.json                                 # Codex run configuration
    ├── gemini.json                                # Gemini run configuration
    ├── dev.json                                   # Development environment config
    ├── test.json                                  # Test environment config
    └── prod.json                                  # Production environment config
```

### 2. Naming Conventions

- Environment files: `<provider>_[<tool>]_<purpose>.env`
- Run configurations: `<tool>.json` or `<env>_<tool>.json`
- Use descriptive names for easy understanding and maintenance

### 3. Security Practices

- Store sensitive information separately in `*_secrets.env`
- Do not commit files containing keys to version control
- Use `.gitignore` to exclude sensitive files
- Provide example configuration files (`.example` suffix)

### 4. Configuration Layering

```
Global Configuration (~/.manyoyo/manyoyo.json)
  ↓ Common settings (image, timezone, etc.)
Run Configuration (~/.manyoyo/run/*.json)
  ↓ Tool/environment-specific settings
Command Line Arguments
  ↓ Temporary overrides and debugging
```

## Related Documentation

- [Configuration System Overview](./README.md) - Understand configuration principles
- [Environment Variables Details](./environment.md) - Deep dive into environment variables
- [Configuration Files Details](./config-files.md) - Learn all configuration options
