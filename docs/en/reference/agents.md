---
title: AI Agents
description: Launch shortcuts, required environment variables and session resume for the four built-in agents
---

# AI Agents

This page shows how to start YOLO mode for Claude Code, Gemini, Codex and OpenCode with one command, and what each one needs configured. YOLO mode skips permission prompts, so use it only inside a container; see [Security](../guide/security.md).

## Quick Reference

| Agent | Shortcut (`-y`) | Command actually run | Resume (after `--`) |
|-------|-----------------|----------------------|---------------------|
| Claude Code | `c` / `cc` / `claude` | `IS_SANDBOX=1 claude --dangerously-skip-permissions` | `-r` (pick) or `-c` (most recent) |
| Gemini | `gm` / `g` / `gemini` | `gemini --yolo` | `-r` |
| Codex | `cx` / `codex` | `codex --dangerously-bypass-approvals-and-sandbox` | `resume` (`resume --last` for the most recent) |
| OpenCode | `oc` / `opencode` | `OPENCODE_PERMISSION='{"*":"allow"}' opencode` | `-c` |

Common usage:

```bash
manyoyo run -y c                    # New container and start (Claude Code as example)
manyoyo run -n my-session -y c      # Named container
manyoyo run -n my-session -- -c     # Back to an existing container, pass the resume argument to the agent
```

## Recommended: Save as a Run Profile

Add one entry per agent under `runs.<name>` in `~/.manyoyo/manyoyo.json`, then just run `manyoyo run -r <name>`. `envFile` must be an absolute path and `env` is an object. Keep keys in env files, not in the config.

```json5
{
    "runs": {
        "claude":   { "yolo": "c",  "envFile": ["/abs/path/anthropic_claudecode.env"] },
        "gemini":   { "yolo": "gm", "envFile": ["/abs/path/gemini.env"] },
        "codex":    { "yolo": "cx", "envFile": ["/abs/path/openai_codex.env"] },
        "opencode": { "yolo": "oc", "envFile": ["/abs/path/opencode.env"] }
    }
}
```

`manyoyo init all` generates these entries in one go.

## Claude Code

```bash
manyoyo run -r claude
manyoyo run -n <container> -- -c      # Continue the most recent session
```

Environment variables (`anthropic_claudecode.env`):

```bash
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
export ANTHROPIC_MODEL="claude-sonnet-4-5"    # optional
```

## Gemini

```bash
manyoyo run -r gemini
manyoyo run -n <container> -- -r
```

Environment variables (`gemini.env`):

```bash
export GEMINI_API_KEY="your-api-key"
export GEMINI_MODEL="gemini-2.0-flash-exp"    # optional
```

## Codex

```bash
manyoyo run -r codex
manyoyo run -n <container> -- resume --last
manyoyo run -n <container> -- resume <session-id>
```

To use account login instead of a key, mount the host login file into the container (in `runs.codex`):

```json5
"volumes": ["/Users/<you>/.codex/auth.json:/root/.codex/auth.json"]
```

Environment variables (`openai_codex.env`):

```bash
export OPENAI_BASE_URL=https://chatgpt.com/backend-api/codex
```

## OpenCode

```bash
manyoyo run -r opencode
manyoyo run -n <container> -- -c
```

Environment variables (`opencode.env`):

```bash
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

## Common Pitfalls

- **Agent says not logged in or authentication failed**: run `manyoyo config show -r <name>` to confirm `envFile` took effect, then `manyoyo run -r <name> -x 'env | grep -E "ANTHROPIC|OPENAI|GEMINI"'` to see whether the variables reached the container. After editing an env file, recreate the container with `manyoyo rm <container>`.
- **Resume shows nothing**: sessions live in the container and cannot be resumed after `manyoyo rm`; also check you used the resume argument for that agent from the table above.
- **Want another agent in the same container**: `manyoyo run -n <container> -x /bin/bash`, then run the full command from the table; simpler is one container per agent (for example `-n proj-claude`, `-n proj-codex`).
- **Command not found**: `manyoyo run -x which claude` (or gemini / codex / opencode) to confirm the image has the agent; switch to `2.1.0-full` if needed.

## Next Steps

- [Basic Usage](../guide/basic-usage.md)
- [Environment Variables](../configuration/environment.md)
- [Runtime Issues](../troubleshooting/runtime-errors.md#ai-cli-tool-errors)
