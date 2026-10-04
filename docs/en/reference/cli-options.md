---
title: Command Cheat Sheet | MANYOYO
description: Every MANYOYO command grouped as in --help, one line and one example each, plus a quick option reference.
---

# Command Cheat Sheet

This page lists every command by the groups in `manyoyo --help`, one line and one example each. For all options of a command: `manyoyo <command> --help`.

## Open the web UI

Run `manyoyo` with no arguments to start the web service and open the web UI (the setup wizard starts on first use). Without a graphical session (SSH etc.) it prints port-forwarding hints instead; force the choice with `--headless` / `--gui`. See [Daily Use](../guide/daily.md).

```bash
manyoyo
```

## Daily

| Command | Description | Example |
| --- | --- | --- |
| `update` | Upgrade to the latest version; `--rollback` returns to the previous one | `manyoyo update` |
| `uninstall` | Uninstall MANYOYO (config and data are kept by default); `--yes` only confirms removing the program itself | `manyoyo uninstall` |
| `setup` | Command line setup wizard (for machines without a graphical session) | `manyoyo setup` |
| `doctor` | Diagnose container runtime, image, config and ports; `--json` prints JSON, `--fix` repairs what it can | `manyoyo doctor` |

## Run from the command line

| Command | Description | Example |
| --- | --- | --- |
| `run` | Start a container and run a command (reconnect if it already exists) | `manyoyo run -y c` |
| `init [agents]` | Import existing local Agent configs into `~/.manyoyo` | `manyoyo init all` |
| `config show` | Print the final resolved configuration | `manyoyo config show -r claude` |
| `config command` | Print the container command that would run | `manyoyo config command -r claude` |

## Containers and images

| Command | Description | Example |
| --- | --- | --- |
| `ps` | List containers | `manyoyo ps` |
| `images` | List images | `manyoyo images` |
| `rm <name>` | Remove a container | `manyoyo rm my-0101-1200` |
| `build` | Build the sandbox image | `manyoyo build --iv 2.1.1-common` |
| `prune` | Remove dangling images | `manyoyo prune` |
| `podman <args...>` | Run a command with the private Podman (args pass through verbatim; only after a full offline-package install) | `manyoyo podman ps -a` |

## Web service and plugins

| Command | Description | Example |
| --- | --- | --- |
| `serve [listen]` | Start the web service, default `127.0.0.1:3000` | `manyoyo serve 127.0.0.1:3000 -d` |
| `playwright` | Manage the Playwright plugin service | `manyoyo playwright up headed` |

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
| `--iv, --image-ver <version>` | Image version; must be `x.y.z-suffix`, for example `2.1.1-common` |
| `-e, --env <env>` | Append environment variables, repeatable |
| `--ef, --env-file <file>` | Append env files, absolute paths only |
| `-v, --volume <volume>` | Append bind mounts, repeatable |
| `-p, --port <port>` | Append port mappings, repeatable |
| `--worktrees` / `--wt` | Enable Git worktree support and auto-mount the project-level `worktrees/<project>/` root |
| `--worktrees-root <path>` / `--wtr <path>` | Set the project-level Git worktrees root, absolute paths only; implicitly enables `--worktrees` |
| `--sp` / `-s` / `--ss` / `-- <args...>` | Compose prefix, main command, and suffix args |
| `-x, --shell-full <command...>` | Pass the full command directly; mutually exclusive with `--sp/-s/--ss/--` |
| `-y, --yolo <cli>` | Start an Agent in no-confirmation mode: `c`=Claude, `cx`=Codex, `gm`=Gemini, `oc`=OpenCode |
| `--first-shell*` / `--first-env*` | Run only when the container is created for the first time |
| `--rm-on-exit` | Remove the container after exit; `run` only |
| `-q, --quiet <item>` | Hide selected output, repeatable: `cnew` create/connect notice, `crm` delete notice, `tip` first-command tips, `cmd` command to run, `askkeep` shorter keep-container prompt, `full` all of them |

### `serve`

`serve` reuses most `run` options and adds web auth options:

| Option | Description |
| --- | --- |
| `[listen]` | Listen address, supports `<port>` or `<host:port>` |
| `-U, --user <username>` | Login username, default `admin` |
| `-P, --pass <password>` | Login password; randomly generated at startup if omitted |
| `-d, --detach` | Start the web server in background and return immediately; if no password is set, prints the generated password for this run |
| `--stop` | Stop a background web server; `[listen]` is required and targets that instance exactly |
| `--restart` | Restart a background web server; `[listen]` is required, and it stops the matched instance before starting with current arguments |
| `--list` | List running web services (listen address, PID, version, start command; the password shows as `******`); cannot be combined with other serve options |

### `build`

| Option | Description |
| --- | --- |
| `-r, --run <name>` | Load run configuration |
| `--in, --image-name <name>` | Set image name |
| `--iv, --image-ver <version>` | Set image version |
| `--iba, --image-build-arg <arg>` | Pass Dockerfile build args, repeatable |
| `--update-agents` | Update Agent CLIs in an existing image to latest (Claude/Codex/Gemini/OpenCode), without rebuilding the Dockerfile |
| `--yes` | Auto-confirm prompts |

### `doctor`

| Option | Description |
| --- | --- |
| `-r, --run <name>` | Load run configuration before diagnosing |
| `--port <port>` | Also check whether the given listening port is available |
| `--json` | Print a stable JSON report (`ok` + `checks[]`, including the selected `runtimeCommand` / `runtimeSource`) for scripting |
| `--fix` | Repair what can be repaired: start the Podman machine / Docker Desktop on macOS, pull a missing image, create a default config; for an occupied port it only suggests a free one. Checks that did not pass carry `fix: {attempted, fixed, message}` |

### `playwright`

| Command | Purpose |
| --- | --- |
| `manyoyo playwright` | List modes and show the current mode with a real probe (same as `status`) |
| `manyoyo playwright up <headed\|chrome\|vnc>` | Switch browser mode; without arguments lists all modes and exits non-zero |
| `manyoyo playwright down` | Stop the current mode and return to the default |
| `manyoyo playwright status` | Current mode + real probe; non-zero exit when unusable |
| `manyoyo playwright logs` | Show browser service logs |
| `manyoyo playwright mcp-add` | Print the in-container MCP (stdio) registration commands |
| `manyoyo playwright ext-download` | Download built-in extensions locally |

Extra options for `playwright up` (headed and vnc only):

| Option | Description |
| --- | --- |
| `--ext-path <path>` | Append an extension directory containing `manifest.json` |
| `--ext-name <name>` | Append an extension under `~/.manyoyo/plugin/playwright/extensions/` |

## Configuration and precedence

For precedence and merge rules see [Configuration basics](../configuration/README.md); `--ef` and `--first-env-file` accept absolute paths only.

- `--worktrees` infers the project-level worktrees root as `<main-repo-parent>/worktrees/<main-repo-dir-name>`; when started from a linked worktree, MANYOYO also mounts the main repo root and that root
- `--worktrees-root` is the project-level worktrees root (e.g. `/Users/name/github/worktrees/manyoyo`), not the main repo directory and not a single branch directory
- For the risks of `sock` mode, `-y/--yolo` and exposing `serve` on the network, see [Security](../guide/security.md)

## Next

- [Daily use](../guide/daily.md)
- [Configuration basics](../configuration/README.md)
