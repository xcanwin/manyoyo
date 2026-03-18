---
title: CLI Reference | MANYOYO
description: MANYOYO CLI structure, option ownership, and common commands based on the latest --help output.
---

# CLI Reference

This page follows the current `manyoyo --help` and subcommand `--help` output. It focuses on command layout, option ownership, and high-frequency workflows.

## Top-level commands

| Command | Purpose |
| --- | --- |
| `manyoyo run` | Start or reconnect to a container and run commands inside it |
| `manyoyo build` | Build the sandbox image |
| `manyoyo rm <name>` | Remove a container |
| `manyoyo ps` | List containers |
| `manyoyo images` | List images |
| `manyoyo serve [listen]` | Start the web UI server, default `127.0.0.1:3000` |
| `manyoyo playwright` | Manage the Playwright plugin service |
| `manyoyo plugin` | Plugin namespace; common use is `plugin playwright ...` |
| `manyoyo config show` | Print the final resolved configuration |
| `manyoyo config command` | Print the generated container command |
| `manyoyo init [agents]` | Initialize local Agent configs into `~/.manyoyo` |
| `manyoyo update` | Update MANYOYO; skipped for local file installs |
| `manyoyo install <name>` | Install the `manyoyo` command as a docker-cli-plugin |
| `manyoyo prune` | Clean dangling and `<none>` images |

## Option ownership

### `run` / `config show` / `config command`

These commands share the same core runtime options:

| Option | Description |
| --- | --- |
| `-r, --run <name>` | Load `runs.<name>` from `~/.manyoyo/manyoyo.json` |
| `--hp, --host-path <path>` | Host working directory |
| `-n, --cont-name <name>` | Container name |
| `--cp, --cont-path <path>` | Container working directory |
| `-m, --cont-mode <mode>` | Container mode: `common`, `dind`, `sock` |
| `--in, --image-name <name>` | Image name |
| `--iv, --image-ver <version>` | Image version; must be `x.y.z-suffix`, for example `1.8.12-common` |
| `-e, --env <env>` | Append environment variables, repeatable |
| `--ef, --env-file <file>` | Append env files, absolute paths only |
| `-v, --volume <volume>` | Append bind mounts, repeatable |
| `-p, --port <port>` | Append port mappings, repeatable |
| `--sp` / `-s` / `--ss` / `-- <args...>` | Compose prefix, main command, and suffix args |
| `-x, --shell-full <command...>` | Pass the full command directly; mutually exclusive with `--sp/-s/--ss/--` |
| `-y, --yolo <cli>` | Start supported Agents in no-confirmation mode |
| `--first-shell*` / `--first-env*` | Run only when the container is created for the first time |
| `--rm-on-exit` | Remove the container after exit; `run` only |
| `-q, --quiet <item>` | Quiet selected output, repeatable |

### `serve`

`serve` reuses most `run` options and adds web auth options:

| Option | Description |
| --- | --- |
| `[listen]` | Listen address, supports `<port>` or `<host:port>` |
| `-U, --user <username>` | Login username, default `admin` |
| `-P, --pass <password>` | Login password; randomly generated at startup if omitted |
| `-d, --detach` | Start the web server in background and return immediately; if no password is set, prints the generated password for this run |

### `build`

| Option | Description |
| --- | --- |
| `-r, --run <name>` | Load run configuration |
| `--in, --image-name <name>` | Set image name |
| `--iv, --image-ver <version>` | Set image version |
| `--iba, --image-build-arg <arg>` | Pass Dockerfile build args, repeatable |
| `--yes` | Auto-confirm prompts |

### `playwright`

| Command | Purpose |
| --- | --- |
| `manyoyo playwright ls` | List available scenes |
| `manyoyo playwright up [scene]` | Start a scene, default `mcp-host-headless` |
| `manyoyo playwright down [scene]` | Stop a scene |
| `manyoyo playwright status [scene]` | Show status |
| `manyoyo playwright health [scene]` | Run health check |
| `manyoyo playwright logs [scene]` | Show logs |
| `manyoyo playwright mcp-add` | Print MCP integration commands |
| `manyoyo playwright cli-add` | Print host commands that install the playwright-cli skill |
| `manyoyo playwright ext-download` | Download built-in extensions locally |

Extra options for `playwright up`:

| Option | Description |
| --- | --- |
| `--ext-path <path>` | Append an extension directory containing `manifest.json` |
| `--ext-name <name>` | Append an extension under `~/.manyoyo/plugin/playwright/extensions/` |

## Common workflows

```bash
# Help
manyoyo --help
manyoyo run --help
manyoyo config show --help

# Initialize and start
manyoyo init all
manyoyo run -r claude
manyoyo run -r codex --ss "resume --last"

# Inspect config and generated command
manyoyo config show -r claude
manyoyo config command -r claude

# Custom commands
manyoyo run --rm-on-exit -x /bin/bash
manyoyo run -n demo --first-shell "npm ci" -s "npm test"

# Web server
manyoyo serve 127.0.0.1:3000
manyoyo serve 0.0.0.0:3000 -U admin -P strong-password

# Playwright
manyoyo playwright ls
manyoyo playwright up mcp-host-headless
manyoyo plugin playwright up mcp-host-headless
manyoyo playwright up cli-host-headless
manyoyo playwright mcp-add --host localhost
```

## Configuration and precedence

- Scalar options: command line > `runs.<name>` > global config > defaults
- Array options `envFile`, `volumes`, `imageBuildArgs`: appended in order global config -> `runs.<name>` -> command line
- `env`: merged by key with the same priority as scalar options
- `serve` auth options: command line > `runs.<name>` > global config > environment variables > defaults
- `--ef` and `--first-env-file` accept absolute paths only

## Security notes

- `sock` mode exposes the host Docker socket to the container and is the highest-risk mode
- `-y, --yolo` skips Agent confirmation and should stay in controlled environments
- For `serve 0.0.0.0:<port>`, set a strong password and restrict source IPs with firewall rules
