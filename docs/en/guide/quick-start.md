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
manyoyo -v
```

## 2. Install Podman / Docker

Container runtime install/switch references:
- [Install Podman (Recommended)](./installation.md#install-podman-recommended)
- [Install Docker (Optional)](./installation.md#install-docker-optional)

## 3. Build sandbox image

Released builds use `ghcr.io/xcanwin/manyoyo:1.9.1-common` by default and the first `run` pulls it automatically. Use the local build command below only when the registry is unavailable or you need a custom image:

```bash
manyoyo build --iv 1.9.1-common
```

## 4. Optional: migrate existing configs now

```bash
manyoyo init all
```

When `~/.manyoyo/manyoyo.json` does not exist, the first `manyoyo run` (including `-r <agent>`) performs the equivalent non-interactive initialization before continuing. Existing configuration is never overwritten.

## 5. Start agents directly

```bash
manyoyo run -r claude
manyoyo run -r codex
manyoyo run -r gemini
manyoyo run -r opencode
```

If you want to verify the help output and config path first, run:

```bash
manyoyo --help
manyoyo run --help
manyoyo config show -r claude
```

## Troubleshooting

If `init` reports missing variables, edit the related `runs.<agent>.env` in `~/.manyoyo/manyoyo.json`:

```bash
vim ~/.manyoyo/manyoyo.json

# Example: inspect runs.claude.env
node -e "console.log(require('json5').parse(require('fs').readFileSync(process.env.HOME+'/.manyoyo/manyoyo.json','utf8')).runs?.claude?.env)"
```

More issues: [Troubleshooting](../troubleshooting/README.md)

## Next Steps

- [Basic Usage](./basic-usage.md)
- [Configuration](../configuration/README.md)
- [CLI Reference](../reference/cli-options.md)
- [Troubleshooting](../troubleshooting/README.md)
