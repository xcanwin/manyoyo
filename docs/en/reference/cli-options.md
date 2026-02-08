---
title: CLI Reference | MANYOYO
description: MANYOYO CLI option reference for container management, env injection, YOLO/SOLO modes, debugging, and cleanup commands.
---

# Command Reference

## Common Commands

| Scenario | Command |
| --- | --- |
| View help | `manyoyo -h` |
| View version | `manyoyo -V` |
| List containers | `manyoyo -l` |
| Create container and start Claude Code | `manyoyo -n test --ef .env -y c` |
| Enter shell | `manyoyo -n test -x /bin/bash` |
| Execute custom command | `manyoyo -n test -x echo "hello world"` |
| Remove container | `manyoyo -n test --crm` |
| Clean dangling images | `manyoyo --irm` |

## Quick Parameter Reference

| Parameter | Description |
| --- | --- |
| `-n, --name` | Container name |
| `-y` | Quick enter Agent mode |
| `-x` | Execute command in container |
| `-e` | Pass environment variables directly |
| `--ef` | Read environment variable file (`.env`) |
| `-r` | Read JSON5 configuration file |
| `--ib` | Build sandbox image |
| `--iv` | Specify image version |
| `--iba` | Pass image build arguments (e.g., `TOOL=common`) |
| `--server [port]` | Start web interaction server (default `3000`) |
| `--server-user <username>` | Web login username |
| `--server-pass <password>` | Web login password |
| `-q` | Silent output (can be used multiple times) |

## Configuration File Rules

- `manyoyo -r myconfig` will read `~/.manyoyo/run/myconfig.json`
- `manyoyo -r ./myconfig.json` will read configuration from current directory
- Any command will prioritize loading the global configuration `~/.manyoyo/manyoyo.json`

For complete parameters, please refer to `README.md`.
