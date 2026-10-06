---
title: Configuration Files Details
description: "All fields of ~/.manyoyo/manyoyo.json, merge rules and minimal examples"
---

# Configuration Files Details

This page lists every field of `~/.manyoyo/manyoyo.json`. The file is JSON5 (comments allowed); the full template is `manyoyo.example.json` in the repository.

## File and Priority

There is one config file: `~/.manyoyo/manyoyo.json`. Top-level fields are the global config; `runs.<name>` is a run config loaded with `-r <name>`.

Priority: command line > `runs.<name>` > global config > defaults.

- Scalar fields: the highest-priority value wins.
- `env`: merged by key, later wins.
- `envFile`, `volumes`, `ports`, `imageBuildArgs`: appended in the order global -> `runs.<name>` -> command line.
- `serverUser` / `serverPass`: command line > `runs.<name>` > global config > environment variable > default.

```json5
{
    "imageName": "ghcr.io/xcanwin/manyoyo",
    "imageVersion": "2.2.0-full",
    "runs": {
        "claude": {
            "envFile": ["/abs/path/anthropic_claudecode.env"],
            "yolo": "c"
        }
    }
}
```

## Container and Image

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `containerName` | string | `my-{MMDD-HHmm}` | Container name; supports `{now}` (-> `MMDD-HHmm`) |
| `hostPath` | string | current directory | Host working directory mounted into the container |
| `containerPath` | string | same as `hostPath` | Working directory inside the container |
| `imageName` | string | `ghcr.io/xcanwin/manyoyo` | Image name (without version) |
| `imageVersion` | string | none | Format `x.y.z-suffix`, e.g. `2.2.0-common`, `2.2.0-full` |
| `containerMode` | string | `common` | `common` / `dind` / `sock`, see [Container Modes](../reference/container-modes.md) |
| `imageBuildArgs` | string array | none | Build args `KEY=VALUE`, appended, e.g. `TOOL=common` |

## Environment, Volumes and Ports

| Field | Type | Merge rule | Description |
| --- | --- | --- | --- |
| `envFile` | string array | append | Environment variable files, **absolute paths only**; read live in a new container on every command, so edits take effect for the next command |
| `env` | object | override by key | Environment variables set directly |
| `volumes` | string array | append | `host:container[:ro]`; host path may be absolute or start with `~` / `$HOME` |
| `ports` | string array | append | Passed through as `--publish`, e.g. `"8080:80"` |

```json5
{
    "env": { "TZ": "Asia/Shanghai" },
    "volumes": ["~/.ssh:/root/.ssh:ro"],
    "ports": ["127.0.0.1:8443:443"]
}
```

For mount and `sock` mode risks, see [Security](../guide/security.md).

## Commands

| Field | Type | Description |
| --- | --- | --- |
| `yolo` | string | `c` / `gm` / `cx` / `oc` (or `claude` / `gemini` / `codex` / `opencode`); skips permission prompts, see [Agents](../reference/agents.md) |
| `shellPrefix` | string | Command prefix, often temporary env vars |
| `shell` | string | Main command, e.g. `claude` |
| `shellSuffix` | string | Appended after `shell`, e.g. `resume --last`; overridable by `--ss` or `-- ...` (the latter wins) |
| `first` | object | Runs once **after a new container is created**, not when reusing one; has `shellPrefix` / `shell` / `shellSuffix` (override), `env` (merge by key), `envFile` (append) |
| `network` | object | Network policy written at creation: `preset` (`restricted` default / `allowlist` / `open`), `host` (host ports it may reach `[{ "ports": "11434" }]`), `egress` (`domains` allowlist, `rules` direct IP rules `[{ "cidr": "192.168.1.50", "ports": "8000" }]`), `peers`; omitted = restricted by default |
| `autostart` | string | bash script run by the in-container init on every container start; written when a container is created, then edited on the web "Container" tab, see [Manage containers](../guide/container-manage.md) |
| `autostartOnServe` | boolean | Start this container when `serve` starts |
| `agentPromptCommand` | string | Prompt command template for web AGENT mode, must contain `{prompt}`; inferred from `shell` / `yolo` when empty |
| `quiet` | string array | Suppress output: `tip` / `cmd` / `full` |

```json5
{
    "first": { "shell": "echo setup-once", "env": { "BOOTSTRAP": "1" } },
    "shell": "codex",
    "shellSuffix": "resume --last"
}
```

## Global-Only Fields

These fields only take effect in the global config, not in `runs.<name>`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `containerRuntime` | string | `auto` | `auto` / `docker` / `podman`; `auto` prefers the private Podman, then a docker / podman whose daemon works. `manyoyo doctor` shows the selected runtime |
| `updateCheck` | boolean | `true` | `serve` checks for a new version at most once a day; the request carries no local info, `false` sends nothing |
| `mirrors` | object | official sources | In-container package sources `apt` / `npm` / `pip` (`http(s)://` URLs, empty = official), applied when a container is created; for `apt` give only the mirror host, e.g. `https://mirrors.aliyun.com`. Same-name variables in `env` win |

## Web Service

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `serverUser` | string | `admin` | Login username, env var `MANYOYO_SERVER_USER` |
| `serverPass` | string | random | Login password, env var `MANYOYO_SERVER_PASS` |
| `serve.title` | string | shown dynamically by session Agent name | Once set (even to an empty string) it is fixed; `runs.<name>.serve` beats global |
| `serve.quickChat` | object | none | Web "Quick Chat": `path` is the work root, `run` is the `runs.<name>` to use |

For auth and public listening, see [Web Service](../guide/web.md) and [Security](../guide/security.md).

## Plugins

`plugins.playwright` configures `manyoyo playwright`; `runs.<name>.plugins.playwright` overrides the global one. Fields are described in [Playwright Plugin](../advanced/playwright.md); defaults are in `manyoyo.example.json`.

## Debugging

```bash
manyoyo config show             # merged global config
manyoyo config show -r claude   # merged result of one run config
manyoyo config command -r claude  # command that will run
```

If a setting has no effect, confirm the file is valid JSON5 and check the final value with `config show`; if an `envFile` is not loaded, confirm it is an absolute path.

## Next

- [Configuration System Overview](./README.md)
- [Environment Variables Details](./environment.md)
- [Configuration Examples](./examples.md)
