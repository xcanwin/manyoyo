---
title: CLI Reference | MANYOYO
description: MANYOYO CLI option reference for container management, env injection, YOLO/SOLO modes, debugging, and cleanup commands.
---

# Command Reference

## Common Commands

| Scenario | Command |
| --- | --- |
| View help | `manyoyo -h` |
| View version | `manyoyo -v` |
| Initialize config from local Agent setup | `manyoyo init all` |
| List containers | `manyoyo ps` |
| List images | `manyoyo images` |
| Create container and start Claude Code | `manyoyo run -n test --ef /abs/path/.env -y c` |
| Enter shell | `manyoyo run -n test -x /bin/bash` |
| Execute custom command | `manyoyo run -n test -x echo "hello world"` |
| Remove container | `manyoyo rm test` |
| Clean dangling images | `manyoyo prune` |
| List Playwright plugin scenes | `manyoyo playwright ls` |
| Start Playwright plugin scenes | `manyoyo playwright up all` |
| Start via plugin namespace | `manyoyo plugin playwright up host-headless` |
| Print MCP add commands | `manyoyo playwright mcp-add --host localhost` |

## Quick Parameter Reference

| Parameter | Description |
| --- | --- |
| `run -n, --cont-name` | Container name |
| `run -y` | Quick enter Agent mode |
| `run -x` | Execute command in container |
| `run -e` | Pass environment variables directly |
| `run -p` | Pass port mappings directly (same as `--publish`) |
| `run --ef` | Read environment variable file (absolute path only) |
| `run -r` | Read `runs.<name>` from `~/.manyoyo/manyoyo.json` |
| `build` | Build sandbox image |
| `run/build --iv` | Specify image version tag (format: `x.y.z-suffix`, e.g. `1.8.0-common`) |
| `build --iba` | Pass image build arguments (e.g., `TOOL=common`) |
| `update` | Update MANYOYO; skip when detected as local file install (`npm install -g .`/`npm link`), otherwise run `npm update -g @xcanwin/manyoyo` |
| `init [agents]` | Initialize `~/.manyoyo` from local Agent configuration |
| `serve [port]` | Start web interaction server (default `127.0.0.1:3000`, supports `<port>` or `<host:port>`) |
| `playwright ls` | List enabled Playwright plugin scenes |
| `playwright up/down/status/health/logs [scene]` | Manage Playwright scenes (default scene is `host-headless`) |
| `playwright mcp-add [--host]` | Print MCP add commands for Claude/Codex |
| `plugin ls` | List current plugins with scene summary |
| `plugin playwright ...` | Invoke Playwright through the plugin namespace |
| `-u <username>` | Web login username |
| `-P <password>` | Web login password (auto-generated random password if omitted) |
| `-q` | Silent output (can be used multiple times) |

## Configuration File Rules

- `manyoyo run -r claude` will read `runs.claude` from `~/.manyoyo/manyoyo.json`
- `manyoyo run --ef /abs/path/my.env` only accepts absolute env-file paths
- Any command will prioritize loading the global configuration `~/.manyoyo/manyoyo.json`

## Web Authentication Notes

- `serve` accepts both `3000` and `0.0.0.0:3000`
- Web auth priority: command-line arguments > `runs.<name>` > global configuration > environment variables > defaults
- Environment variable keys: `MANYOYO_SERVER_USER`, `MANYOYO_SERVER_PASS`
- See [Web Server Auth and Security](../advanced/web-server-auth.md) for login flow and security baseline

For complete parameters, please refer to `README.md`.
