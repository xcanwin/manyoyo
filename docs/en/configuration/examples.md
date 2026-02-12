# Configuration Examples

This page provides ready-to-use MANYOYO configuration examples for current versions.

> Unified rules: store run profiles under `runs.<name>` in `~/.manyoyo/manyoyo.json`;
> `envFile` must use absolute paths; use map style for `env`.

## Quick Start Example

### Minimal Working Configuration

```bash
mkdir -p ~/.manyoyo/

cat > ~/.manyoyo/manyoyo.json << 'EOF2'
{
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.8.0-common",
    "runs": {
        "claude": {
            "envFile": ["/abs/path/anthropic_claudecode.env"],
            "yolo": "c"
        }
    }
}
EOF2
```

Usage:
```bash
manyoyo -r claude
```

## Agent Configuration Examples

### Claude Code (Custom Base URL)

**Env file** (`/abs/path/anthropic_custom.env`):
```bash
export ANTHROPIC_BASE_URL="https://custom-api.example.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
export ANTHROPIC_MODEL="claude-opus-4-5"
export CLAUDE_CODE_SUBAGENT_MODEL="claude-haiku-4-5"
```

**`runs.claude-custom`**:
```json5
{
    "containerName": "my-claude-custom",
    "envFile": ["/abs/path/anthropic_custom.env"],
    "yolo": "c",
    "quiet": ["tip"]
}
```

### Codex (API Key)

**Env file** (`/abs/path/openai_api.env`):
```bash
export OPENAI_API_KEY="sk-xxxxxxxx"
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_MODEL="gpt-4-turbo"
```

**`runs.codex-api`**:
```json5
{
    "envFile": ["/abs/path/openai_api.env"],
    "yolo": "cx"
}
```

## Container Mode Examples

### Docker-in-Docker (safer)

**`runs.dind`**:
```json5
{
    "containerName": "my-dind",
    "containerMode": "dind",
    "envFile": ["/abs/path/anthropic_claudecode.env"],
    "volumes": [
        "~/.docker:/root/.docker:ro"
    ]
}
```

### Socket Mount (high risk)

**`runs.sock`**:
```json5
{
    "containerName": "my-sock",
    "containerMode": "sock",
    "envFile": ["/abs/path/anthropic_claudecode.env"]
}
```

## Multi-Environment Example

**`~/.manyoyo/manyoyo.json`**:
```json5
{
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.8.0-common",
    "env": {
        "TZ": "Asia/Shanghai"
    },
    "runs": {
        "dev": {
            "containerName": "my-dev",
            "envFile": ["/abs/path/anthropic_dev.env"],
            "env": {
                "NODE_ENV": "development",
                "DEBUG": "*"
            },
            "yolo": "c"
        },
        "test": {
            "containerName": "my-test",
            "envFile": ["/abs/path/anthropic_test.env"],
            "env": {
                "NODE_ENV": "test",
                "CI": "true"
            },
            "yolo": "c"
        },
        "prod": {
            "containerName": "my-prod",
            "envFile": ["/abs/path/anthropic_prod.env"],
            "env": {
                "NODE_ENV": "production"
            },
            "yolo": "c",
            "quiet": ["tip", "cmd"]
        }
    }
}
```

Usage:
```bash
manyoyo -r dev
manyoyo -r test
manyoyo -r prod
```

## Combined Configuration Examples

### Layering Multiple Env Files

**`runs.claude-full`**:
```json5
{
    "envFile": [
        "/abs/path/base.env",
        "/abs/path/anthropic_base.env",
        "/abs/path/anthropic_secrets.env"
    ],
    "yolo": "c"
}
```

### Global + Run + CLI

**Global `env`**:
```json5
{
    "env": {
        "TZ": "Asia/Shanghai"
    }
}
```

**`runs.claude`**:
```json5
{
    "envFile": ["/abs/path/anthropic_claudecode.env"],
    "env": {
        "DEBUG": "false"
    },
    "yolo": "c"
}
```

**CLI override**:
```bash
manyoyo -r claude -e "LOG_LEVEL=debug"
```

## Team Template Example

**Team template** (`config.example.json`):
```json5
{
    "imageName": "localhost/team/manyoyo",
    "imageVersion": "1.8.0-common",
    "env": {
        "PROJECT_NAME": "team-project",
        "NODE_ENV": "development"
    },
    "envFile": [
        "/abs/path/anthropic_team.env"
    ],
    "runs": {
        "team": {
            "yolo": "c"
        }
    }
}
```

Usage:
```bash
cp config.example.json ~/.manyoyo/manyoyo.json
cp anthropic_team.example.env /abs/path/anthropic_team.env
manyoyo -r team
```

## Debugging Examples

```bash
manyoyo -r claude --show-config
manyoyo -r claude --show-command
manyoyo -r claude -x env | grep ANTHROPIC
```

## Related Docs

- [Configuration Overview](./README.md)
- [Environment Variables](./environment.md)
- [Configuration Files](./config-files.md)
