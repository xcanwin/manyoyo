---
title: Playwright Plugin | MANYOYO
description: "Manage the Playwright plugin service with manyoyo playwright: scenes, MCP wiring, playwright-cli, browser extensions and attaching to your real Chrome."
---

# Playwright Plugin

A plugin that lets agents drive a browser through MCP or playwright-cli. Common commands:

```bash
manyoyo playwright ls
manyoyo playwright up mcp-host-headless
manyoyo playwright up mcp-host-headless --ext-path /abs/path/extA --ext-name adguard
manyoyo playwright status mcp-host-headless
manyoyo playwright logs mcp-host-headless
manyoyo playwright mcp-add --host localhost
manyoyo playwright cli-add
manyoyo playwright up cli-host-headless
manyoyo playwright up dev-host-headed
manyoyo run -r codex
```

Starting `cli-host-headed` auto-creates `~/.manyoyo/.cache/ms-playwright`; if you want container-side `playwright-cli` to reuse the host cache, mount `~/.manyoyo/.cache/ms-playwright:/root/.cache/ms-playwright` in the config.

To let an agent control the host machine's running stable Chrome, run `manyoyo playwright up dev-host-headed`; it tries to open `chrome://inspect/#remote-debugging` in Chrome, reminds you to enable remote debugging, and prints usage commands for both container-side and host-side agents. Container-side automatic attach still requires configuring `cliSessionScene` and the related volume mounts first. This mode controls the real browser instance and may access existing login state and cookies, so use it only in a trusted local environment.

See [Configuration](../configuration/README.md) and the [Command Cheat Sheet](../reference/cli-options.md) for more.
