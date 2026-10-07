---
title: Environment Variables | MANYOYO
description: Pass API URLs, tokens and other environment variables to the agent in the container with -e or env files
---

# Environment Variables

This page shows how to pass variables such as `BASE_URL` and `AUTH_TOKEN` to the agent CLI inside the container.

## Two ways to pass them

```bash
# 1. -e on the command line: fine for quick tests (stays in shell history)
manyoyo run -e "ANTHROPIC_BASE_URL=https://xxxx" -e "ANTHROPIC_AUTH_TOKEN=your-key" -x claude

# 2. Env file with --ef: recommended, keys stay out of shell history
manyoyo run --ef /abs/path/anthropic.env -x claude
```

`--ef` (and `envFile` in config) **accepts absolute paths only**. Env files are **read live** in a new container: they are re-read every time a command runs, so editing the file takes effect for the next command (running processes excepted); you can also add or remove them under "Environment variable files" on the web "Set container" tab. `-e` can be repeated.

## Env file format

```bash
# Lines starting with # and blank lines are ignored
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
API_TIMEOUT_MS=3000000      # export is optional
GREETING=hello world        # spaces in a value need no quotes
```

- Both `KEY=VALUE` and `export KEY=VALUE` work; values may use single quotes, double quotes, or none; spaces in a value need no quotes (`KEY=abc 123`), and a matching pair of quotes around the value is removed.
- The same syntax is used by the web "Environment variables" text view and `/run/manyoyo/env` inside the container, so there is only one to learn. It matches docker / podman `--env-file` (no variable expansion, no command execution) and also accepts the shell / dotenv `export` prefix and quoting.
- Trailing comments are not supported: `#` starts a comment only at the beginning of a line.
- Names must match `^[A-Za-z_][A-Za-z0-9_]*$`; values cannot contain newlines or shell special characters such as `;`, `&`, `|`, `` ` ``, `$`, `<`, `>`.

## Per-agent examples

```bash
mkdir -p ~/.manyoyo/env

# Claude Code
cat > ~/.manyoyo/env/claude.env << 'EOF'
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
export ANTHROPIC_MODEL="claude-sonnet-4-5"
EOF

# Codex
cat > ~/.manyoyo/env/codex.env << 'EOF'
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_API_KEY="sk-xxxxxxxx"
EOF

# Gemini
cat > ~/.manyoyo/env/gemini.env << 'EOF'
export GEMINI_API_KEY="your-api-key"
EOF
```

Use it with `manyoyo run --ef $HOME/.manyoyo/env/claude.env -x claude`, or put it in `runs.<name>.envFile` and run `manyoyo run -r <name>`. For OpenCode variables see the [agent reference](../reference/agents.md).

## Which value wins

Later sources override earlier ones, in this order:

1. Every layer's `envFile` (global, then `runs.<name>`, then `--ef`)
2. Global `env`
3. `runs.<name>.env`
4. Command-line `-e`

So `-e` wins over `runs.<name>.env`, and both win over env files.

## Tips

- Give files distinctive names (e.g. `claude-work.env`) and split non-secret settings from keys; keep only the key file out of version control.
- For secrets and access risks see [Security](../guide/security.md).
- `MANYOYO_SERVER_USER` / `MANYOYO_SERVER_PASS` are MANYOYO's own variables for `serve` authentication; they are not injected into the container. See [Web service](../guide/web.md).

## Variable not taking effect?

```bash
manyoyo config show -r claude                       # final merged config
manyoyo run -r claude -x env | grep ANTHROPIC       # values the container really got
```

Common causes: the path is not absolute, the file format is invalid, or several sources set the same name.

## Next

- [Configuration overview](./README.md): the four-layer priority
- [Config files](./config-files.md): using `envFile` in `runs`
- [Examples](./examples.md)
