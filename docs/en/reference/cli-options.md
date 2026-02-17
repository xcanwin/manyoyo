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
| Initialize config from local Agent setup | `manyoyo --init-config all` |
| List containers | `manyoyo -l` |
| Create container and start Claude Code | `manyoyo -n test --ef /abs/path/.env -y c` |
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
| `-p` | Pass port mappings directly (same as `--publish`) |
| `--ef` | Read environment variable file (absolute path only) |
| `-r` | Read `runs.<name>` from `~/.manyoyo/manyoyo.json` |
| `--ib` | Build sandbox image |
| `--iv` | Specify image version tag (format: `x.y.z-suffix`, e.g. `1.8.0-common`) |
| `--iba` | Pass image build arguments (e.g., `TOOL=common`) |
| `--update` | Update MANYOYO; skip when detected as local file install (`npm install -g .`/`npm link`), otherwise run `npm update -g @xcanwin/manyoyo` |
| `--init-config [agents]` | Initialize `~/.manyoyo` from local Agent configuration |
| `--server [port]` | Start web interaction server (default `127.0.0.1:3000`, supports `<port>` or `<host:port>`) |
| `--server-user <username>` | Web login username |
| `--server-pass <password>` | Web login password (auto-generated random password if omitted) |
| `-q` | Silent output (can be used multiple times) |

## Configuration File Rules

- `manyoyo -r claude` will read `runs.claude` from `~/.manyoyo/manyoyo.json`
- `manyoyo --ef /abs/path/my.env` only accepts absolute env-file paths
- Any command will prioritize loading the global configuration `~/.manyoyo/manyoyo.json`

## Web Authentication Notes

- `--server` accepts both `3000` and `0.0.0.0:3000`
- Web auth priority: command-line arguments > `runs.<name>` > global configuration > environment variables > defaults
- Environment variable keys: `MANYOYO_SERVER_USER`, `MANYOYO_SERVER_PASS`
- See [Web Server Auth and Security](../advanced/web-server-auth.md) for login flow and security baseline

For complete parameters, please refer to `README.md`.
