# Basic Usage

This page keeps only the daily workflows and matches the current `--help` structure.

## Start with help

```bash
manyoyo --help
manyoyo run --help
manyoyo serve --help
manyoyo config show --help
manyoyo playwright --help
```

## Daily container operations

```bash
# List containers and images
manyoyo ps
manyoyo images

# Create or reconnect
manyoyo run -r claude
manyoyo run -n my-dev -x /bin/bash

# One-shot container
manyoyo run --rm-on-exit -x /bin/bash

# Remove container
manyoyo rm my-dev
```

## Command execution styles

Prefer `-x, --shell-full` when possible:

```bash
manyoyo run -x 'claude --version'
manyoyo run -x 'echo "Start" && ls -la && echo "End"'
```

Use `--sp` / `-s` / `--ss` or `--` only when you need a split command:

```bash
manyoyo run --sp 'DEBUG=1' -s claude -- --version
manyoyo run -s claude --ss '--help'
manyoyo run -r codex --ss 'resume --last'
```

Initialize only on first container creation:

```bash
manyoyo run -n demo --first-shell "npm ci" -s "npm test"
manyoyo run -n demo --first-env NODE_ENV=development -x /bin/bash
```

## Agent shortcut mode

`-y, --yolo` starts supported Agents in no-confirmation mode:

```bash
manyoyo run -y c
manyoyo run -y gm
manyoyo run -y cx
manyoyo run -y oc
```

Check `manyoyo run --help` for the current aliases. Keep this mode in controlled environments.

## Config and environment variables

```bash
# Pass env vars directly
manyoyo run -e "DEBUG=true" -e "HTTP_PROXY=http://127.0.0.1:7890" -x /bin/bash

# Load absolute-path env files
manyoyo run --ef /abs/path/anthropic_claudecode.env -x claude
manyoyo run --ef /abs/path/base.env --ef /abs/path/secret.env -x claude

# Load runs.<name>
manyoyo run -r claude
manyoyo run -r claude -e "DEBUG=true"
```

For debugging, start with:

```bash
manyoyo config show -r claude
manyoyo config command -r claude
```

## Session resume

Different Agents use different resume arguments, so pass them through as suffix args:

```bash
manyoyo run -n my-project -- -c
manyoyo run -n my-project -- resume --last
manyoyo run -n my-project -- -r
```

If you are unsure how the command is assembled, inspect it first:

```bash
manyoyo config command -r claude
```

## Web server

`serve` reuses most `run` options and adds web authentication:

```bash
manyoyo serve 127.0.0.1:3000
manyoyo serve 0.0.0.0:3000 -U admin -P strong-password
manyoyo config show --serve 127.0.0.1:3000
```

When listening on public interfaces, always set a strong password and restrict source IPs.

## Playwright plugin

Prefer the top-level `manyoyo playwright` command. `manyoyo plugin playwright` is mainly the namespace form.

```bash
manyoyo playwright ls
manyoyo playwright up mcp-host-headless
manyoyo playwright up mcp-host-headless --ext-path /abs/path/extA --ext-name adguard
manyoyo playwright status mcp-host-headless
manyoyo playwright logs mcp-host-headless
manyoyo playwright mcp-add --host localhost
manyoyo playwright up cli-host-headless
manyoyo run -r codex
```

For deeper details, see [Configuration](../configuration/README.md) and [CLI Reference](../reference/cli-options.md).
