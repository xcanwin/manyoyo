---
title: Configuration Examples | MANYOYO
description: A few minimal manyoyo.json examples you can copy as-is
---

# Configuration Examples

This page gives a few minimal `~/.manyoyo/manyoyo.json` examples you can copy. Conventions: run profiles live under `runs.<name>`, `envFile` must be an absolute path, and `env` uses the object (map) form.

## 1. Minimal working config

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

## 2. Several agents

```json5
{
    "runs": {
        "claude": { "envFile": ["/abs/path/anthropic.env"], "yolo": "c" },
        "codex":  { "envFile": ["/abs/path/openai.env"],    "yolo": "cx" }
    }
}
```

## 3. Several environments (shared global env)

```json5
{
    "env": { "TZ": "Asia/Shanghai" },
    "runs": {
        "dev":  { "containerName": "my-dev",  "env": { "NODE_ENV": "development" }, "yolo": "c" },
        "prod": { "containerName": "my-prod", "env": { "NODE_ENV": "production" },  "yolo": "c", "quiet": ["tip", "cmd"] }
    }
}
```

Run `manyoyo run -r dev` or `manyoyo run -r prod`.

## 4. Stacking: global + run profile + command line

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
manyoyo run -r claude -e "LOG_LEVEL=debug"   # TZ, DEBUG and LOG_LEVEL all apply
```

## 5. Container mode

```json5
{
    "runs": {
        "dind": { "containerMode": "dind", "envFile": ["/abs/path/anthropic.env"] }
    }
}
```

`sock` mode gives the container access to the host Docker and is the riskiest; see [Security](../guide/security.md) and [Container modes](../reference/container-modes.md).

## Verify

```bash
manyoyo config show -r claude      # final effective config
manyoyo config command -r claude   # container command that will run
```

## Next

- [Configuration overview](./README.md)
- [Environment variables](./environment.md)
- [Config files](./config-files.md)
