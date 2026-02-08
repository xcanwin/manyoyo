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
- [Install Podman (Recommended)](./installation#install-podman-recommended)
- [Install Docker (Optional)](./installation#install-docker-optional)

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

If `--init-config` reports missing variables, edit only the related `.env`:

```bash
vim ~/.manyoyo/env/claude.env
vim ~/.manyoyo/env/codex.env
vim ~/.manyoyo/env/gemini.env
vim ~/.manyoyo/env/opencode.env
```

More issues: [Troubleshooting](../troubleshooting/)

## Next Steps

- [Basic Usage](./basic-usage)
- [Configuration](../configuration/)
- [CLI Reference](../reference/cli-options)
- [Troubleshooting](../troubleshooting/)
