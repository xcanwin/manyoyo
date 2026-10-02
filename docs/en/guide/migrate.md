---
title: Migrate Existing Agent Configs | MANYOYO
description: Fastest path for users who already run Claude/Codex/Gemini/OpenCode on host and want immediate model access inside MANYOYO sandbox.
---

# Migrate Existing Agent Configs

This page is for users who already have npm / Docker or Podman set up and a working agent on the host (new to MANYOYO? start with [Install](./quick-start.md)). You already:
- can run `claude` / `codex` / `gemini` / `opencode` on host
- already have model access configured (env vars or local auth)

Goal: migrate that working setup into MANYOYO with minimal steps.

> The default image is the prebuilt `ghcr.io/xcanwin/manyoyo`, pulled automatically when missing locally, so you do not need `manyoyo build`; build only when you want a custom image.

## 1. Install manyoyo

```bash
npm install -g @xcanwin/manyoyo
manyoyo -v
```

## 2. Install Podman / Docker

Container runtime install/switch references:
- [Install Podman (Recommended)](../advanced/installation.md#install-podman-recommended)
- [Install Docker (Optional)](../advanced/installation.md#install-docker-optional)

## 3. Migrate existing configs now

```bash
manyoyo init all
```

## 4. Start agents directly

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
