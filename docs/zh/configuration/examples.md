---
title: 配置示例 | MANYOYO
description: 几个可直接复制的 manyoyo.json 最小配置示例
---

# 配置示例

本页给出几个可直接复制的最小 `~/.manyoyo/manyoyo.json` 示例。约定：运行配置写在 `runs.<name>`，`envFile` 必须是绝对路径，`env` 用对象（map）写法。

## 1. 最小可用配置

```bash
mkdir -p ~/.manyoyo
cat > ~/.manyoyo/manyoyo.json << 'EOF2'
{
    "imageName": "ghcr.io/xcanwin/manyoyo",
    "imageVersion": "2.1.0-common",
    "runs": {
        "claude": {
            "envFile": ["/abs/path/anthropic.env"],
            "yolo": "c"
        }
    }
}
EOF2

manyoyo run -r claude
```

## 2. 多个 Agent

```json5
{
    "runs": {
        "claude": { "envFile": ["/abs/path/anthropic.env"], "yolo": "c" },
        "codex":  { "envFile": ["/abs/path/openai.env"],    "yolo": "cx" }
    }
}
```

## 3. 多环境（共用全局 env）

```json5
{
    "env": { "TZ": "Asia/Shanghai" },
    "runs": {
        "dev":  { "containerName": "my-dev",  "env": { "NODE_ENV": "development" }, "yolo": "c" },
        "prod": { "containerName": "my-prod", "env": { "NODE_ENV": "production" },  "yolo": "c", "quiet": ["tip", "cmd"] }
    }
}
```

`manyoyo run -r dev` / `manyoyo run -r prod`。

## 4. 叠加：全局 + 运行配置 + 命令行

```json5
{
    "env": { "TZ": "Asia/Shanghai" },
    "runs": {
        "claude": {
            "envFile": ["/abs/path/base.env", "/abs/path/secrets.env"],
            "env": { "DEBUG": "false" },
            "yolo": "c"
        }
    }
}
```

```bash
manyoyo run -r claude -e "LOG_LEVEL=debug"   # 最终 TZ、DEBUG、LOG_LEVEL 都生效
```

## 5. 容器模式

```json5
{
    "runs": {
        "dind": { "containerMode": "dind", "envFile": ["/abs/path/anthropic.env"] }
    }
}
```

`sock` 模式会让容器访问宿主机 Docker，风险最高，见[安全说明](../guide/security.md)与[容器模式](../reference/container-modes.md)。

## 验证

```bash
manyoyo config show -r claude      # 最终生效的配置
manyoyo config command -r claude   # 将执行的容器命令
```

## 下一步

- [配置概览](./README.md)
- [环境变量](./environment.md)
- [配置文件](./config-files.md)
