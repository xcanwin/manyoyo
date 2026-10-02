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
| `manyoyo install <name>` | Install the `manyoyo` command as a docker-cli-plugin |
| `manyoyo prune` | Clean dangling and `<none>` images |
| `manyoyo doctor` | Diagnose container runtime, image, config, agent, mode, plugin and port state |
| `manyoyo update [--rollback]` | Update MANYOYO. Offline-package installs download only `-app.tar.gz` (tens of MB), verify its SHA256, put it in `~/.manyoyo/app/<version>/` and atomically switch `current`, keeping the previous version; `--rollback` switches back. npm installs keep using `npm update -g`; local file installs are skipped. If the new version bundles a different Podman / VM disk, you are only told to download the new full package |
| `manyoyo setup` | Command line wizard for headless machines (SSH, no graphical session): pick an agent, enter key / Base URL / model, choose the work directory (default `~/.manyoyo/work`), set the login password (8+ chars), optionally apt / npm / pip mirrors; keys and passwords are not echoed. Needs an interactive terminal and exits with an explanation when stdin is not one; after saving it restarts the background service and prints the port-forwarding hint |
| `manyoyo --headless` / `manyoyo --gui` | Force switches for the no-argument launcher (or set `MANYOYO_HEADLESS=1/0`; the flag wins). Detected automatically by default: an SSH session, or Linux without `DISPLAY` / `WAYLAND_DISPLAY`, counts as headless. Headless mode opens no browser and prints the `ssh -L` forwarding and stop commands; the installer accepts both flags too |
| `manyoyo podman <args...>` | Run a command with MANYOYO's private Podman; args go to podman verbatim (quotes, `-a` etc. are not parsed by manyoyo). `eval "$(manyoyo podman env)"` defines a `podman` function in the current terminal so you can type `podman ps -a` directly; it only lives in that terminal, does not touch PATH or your own Podman; use `--shell fish` for fish. Private Podman exists only after a full offline-package install |
| `manyoyo uninstall` | Uninstall the offline-package install of MANYOYO: stop the background service and the private Podman machine, delete `~/.manyoyo/{bin,app,runtime}` and the PATH block in your shell config; config, session history, logs and `work/` (and the 7.x legacy `workpath/`) are asked about one by one (kept by default). `--yes` only confirms removing the program itself and never deletes user data; when you reuse your own Docker/Podman it only asks whether to delete manyoyo's containers and images, never the runtime itself |
| `manyoyo` (no arguments) | Start (or reuse) the web service in the background on a random `127.0.0.1` port and open the browser, already logged in; the instance is recorded in `~/.manyoyo/serve/app.json`. Login uses a one-time token (valid for 60 seconds, deleted on use, stored in `~/.manyoyo/serve/login-tokens/`, enabled only for loopback listening); running `manyoyo` again issues a fresh token. Without a browser opener, the one-time login URL is printed to the terminal. `-h/--help` still shows help |

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
| `--iv, --image-ver <version>` | Image version; must be `x.y.z-suffix`, for example `2.1.0-common` |
| `-e, --env <env>` | Append environment variables, repeatable |
| `--ef, --env-file <file>` | Append env files, absolute paths only |
| `-v, --volume <volume>` | Append bind mounts, repeatable |
| `-p, --port <port>` | Append port mappings, repeatable |
| `--worktrees` / `--wt` | Enable Git worktree support and auto-mount the project-level `worktrees/<project>/` root |
| `--worktrees-root <path>` / `--wtr <path>` | Set the project-level Git worktrees root, absolute paths only; implicitly enables `--worktrees` |
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
| `--stop` | Stop a background web server; `[listen]` is required and targets that instance exactly |
| `--restart` | Restart a background web server; `[listen]` is required, and it stops the matched instance before starting with current arguments |

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
| `manyoyo playwright ls` | List available scenes |
| `manyoyo playwright up [scene]` | Start a scene, default `mcp-host-headless` |
| `manyoyo playwright down [scene]` | Stop a scene |
| `manyoyo playwright status [scene]` | Show status |
| `manyoyo playwright health [scene]` | Run health check |
| `manyoyo playwright logs [scene]` | Show logs |
| `manyoyo playwright mcp-add` | Print MCP integration commands; the first line marks them as container-side commands |
| `manyoyo playwright cli-add` | Print host commands that install the playwright-cli skill; the first line marks them as host-side commands |
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

# Diagnose the runtime environment
manyoyo doctor
manyoyo doctor --json
manyoyo doctor --fix

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
manyoyo playwright up dev-host-headed
manyoyo playwright mcp-add --host localhost
```

## Configuration and precedence

- Scalar options: command line > `runs.<name>` > global config > defaults
- Array options `envFile`, `volumes`, `imageBuildArgs`: appended in order global config -> `runs.<name>` -> command line
- `env`: merged by key with the same priority as scalar options
- `serve` auth options: command line > `runs.<name>` > global config > environment variables > defaults
- `--ef` and `--first-env-file` accept absolute paths only
- `--worktrees` infers the project-level worktrees root as `<main-repo-parent>/worktrees/<main-repo-dir-name>` by default; when started from a linked worktree, MANYOYO also mounts the main repo root and that project-level worktrees root
- `--worktrees-root` means the project-level worktrees root, for example `/Users/name/github/worktrees/manyoyo`; it is not the main repo directory and not a single branch worktree directory

## Security notes

- `sock` mode exposes the host Docker socket to the container and is the highest-risk mode
- `-y, --yolo` skips Agent confirmation and should stay in controlled environments
- For `serve 0.0.0.0:<port>`, set a strong password and restrict source IPs with firewall rules
