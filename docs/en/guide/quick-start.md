---
title: Quick Start | MANYOYO
description: Fastest path for users who already run Claude/Codex/Gemini/OpenCode on host and want immediate model access inside MANYOYO sandbox.
---

# Quick Start

This page is for users who already:
- can run `claude` / `codex` / `gemini` / `opencode` on host
- already have model access configured (env vars or local auth)

Goal: migrate that working setup into MANYOYO with minimal steps.

## 1. Install manyoyo

```bash
npm install -g @xcanwin/manyoyo
manyoyo -V
```

## 2. Install Podman / Docker

Container runtime install/switch references:
- [Install Podman (Recommended)](./installation.md#install-podman-recommended)
- [Install Docker (Optional)](./installation.md#install-docker-optional)

## 3. Build sandbox image

```bash
manyoyo --ib --iv 1.7.0
```

## 4. Migrate existing configs now

```bash
manyoyo --init-config all
```

## 5. Start agents directly

```bash
manyoyo -r claude
manyoyo -r codex
manyoyo -r gemini
manyoyo -r opencode
```

## Troubleshooting

If `--init-config` reports missing variables, edit the related `runs.<agent>.env` in `~/.manyoyo/manyoyo.json`:

```bash
vim ~/.manyoyo/manyoyo.json

# Example: inspect runs.claude.env
cat ~/.manyoyo/manyoyo.json | jq '.runs.claude.env'
```

More issues: [Troubleshooting](../troubleshooting/README.md)

## Next Steps

- [Basic Usage](./basic-usage.md)
- [Configuration](../configuration/README.md)
- [CLI Reference](../reference/cli-options.md)
- [Troubleshooting](../troubleshooting/README.md)
