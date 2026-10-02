---
title: Configuration Basics | MANYOYO
description: One config file, four priority layers and a minimal example, so you can understand MANYOYO configuration in minutes
---

# Configuration Basics

This page explains where MANYOYO configuration lives and which value wins when sources conflict. You can use MANYOYO without any config; read this when you want to pin an agent, environment variables or mounts.

## One file

There is a single global config: `~/.manyoyo/manyoyo.json`, read automatically by every `manyoyo` command when it exists. The format is JSON5, which allows comments, trailing commas and unquoted keys:

```json5
{
    // global defaults
    imageVersion: "2.1.0-common",
    runs: {
        // named run profile: manyoyo run -r claude
        claude: {
            envFile: ["/abs/path/anthropic.env"],
            yolo: "c",
        },
    },
}
```

- `manyoyo run -r <name>` reads `runs.<name>`; it takes a name, not a file path.
- `envFile` and `--ef` accept absolute paths only.
- `containerName` supports a `{now}` template (expands to `MMDD-HHmm`).
- All fields are listed in [Config files](./config-files.md).

## Four-layer priority

**Command line > `runs.<name>` > global config > defaults**

Different parameter types merge differently:

| Type | Parameters | Behavior |
| --- | --- | --- |
| Scalar | `containerName`, `hostPath`, `containerPath`, `imageName`, `imageVersion`, `containerMode`, `yolo`, `shellPrefix`, `shell`, `serverUser`, `serverPass` | Only the highest-priority value is used |
| Map | `env` | Merged by key; for the same key the higher priority wins |
| Array | `envFile`, `volumes`, `ports`, `imageBuildArgs` | Appended in order global, then `runs.<name>`, then command line; all apply |
| First-run | `first.shellPrefix/shell/shellSuffix`, `first.env`, `first.envFile` | Run once when a container is newly created; each field follows the rule above |

`serverUser` / `serverPass` can also fall back to the environment variables `MANYOYO_SERVER_USER` / `MANYOYO_SERVER_PASS` (lower than global config, higher than defaults); see [Web service](../guide/web.md).

## Minimal example

```bash
# global: imageVersion 2.1.0-common; runs.demo: imageVersion 2.1.0-full, env VAR2
# command line: -e VAR3=value3
manyoyo run -r demo -e "VAR3=value3"
# image is 2.1.0-full (runs overrides global); VAR2, VAR3 and the global env all apply
```

## See the final result

```bash
manyoyo config show -r demo      # merged final config
manyoyo config command -r demo   # container command that will run
```

## Next

- [Environment variables](./environment.md): pass API URLs and tokens
- [Config files](./config-files.md): all fields
- [Examples](./examples.md)
