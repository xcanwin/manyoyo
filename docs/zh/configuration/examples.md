# 配置示例

本页面提供当前版本可直接使用的 MANYOYO 配置示例。

> 统一规则：运行配置写在 `~/.manyoyo/manyoyo.json` 的 `runs.<name>`；
> `envFile` 必须是绝对路径；`env` 推荐对象（map）写法。

## 快速开始示例

### 最小可用配置

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

使用：
```bash
manyoyo -r claude
```

## Agent 配置示例

### Claude Code（自定义 Base URL）

**环境文件**（`/abs/path/anthropic_custom.env`）：
```bash
export ANTHROPIC_BASE_URL="https://custom-api.example.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
export ANTHROPIC_MODEL="claude-opus-4-5"
export CLAUDE_CODE_SUBAGENT_MODEL="claude-haiku-4-5"
```

**`runs.claude-custom`**：
```json5
{
    "containerName": "my-claude-custom",
    "envFile": ["/abs/path/anthropic_custom.env"],
    "yolo": "c",
    "quiet": ["tip"]
}
```

### Codex（API Key）

**环境文件**（`/abs/path/openai_api.env`）：
```bash
export OPENAI_API_KEY="sk-xxxxxxxx"
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_MODEL="gpt-4-turbo"
```

**`runs.codex-api`**：
```json5
{
    "envFile": ["/abs/path/openai_api.env"],
    "yolo": "cx"
}
```

## 容器模式示例

### Docker-in-Docker（较安全）

**`runs.dind`**：
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

### Socket 挂载（高风险）

**`runs.sock`**：
```json5
{
    "containerName": "my-sock",
    "containerMode": "sock",
    "envFile": ["/abs/path/anthropic_claudecode.env"]
}
```

## 多环境示例

**`~/.manyoyo/manyoyo.json`**：
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

使用：
```bash
manyoyo -r dev
manyoyo -r test
manyoyo -r prod
```

## 组合配置示例

### 多个环境文件叠加

**`runs.claude-full`**：
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

### 全局 + 运行 + 命令行

**全局 `env`**：
```json5
{
    "env": {
        "TZ": "Asia/Shanghai"
    }
}
```

**`runs.claude`**：
```json5
{
    "envFile": ["/abs/path/anthropic_claudecode.env"],
    "env": {
        "DEBUG": "false"
    },
    "yolo": "c"
}
```

**命令行覆盖**：
```bash
manyoyo -r claude -e "LOG_LEVEL=debug"
```

## 团队模板示例

**团队模板**（`config.example.json`）：
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

使用：
```bash
cp config.example.json ~/.manyoyo/manyoyo.json
cp anthropic_team.example.env /abs/path/anthropic_team.env
manyoyo -r team
```

## 调试示例

```bash
manyoyo -r claude --show-config
manyoyo -r claude --show-command
manyoyo -r claude -x env | grep ANTHROPIC
```

## 相关文档

- [配置系统概览](./README.md)
- [环境变量详解](./environment.md)
- [配置文件详解](./config-files.md)
