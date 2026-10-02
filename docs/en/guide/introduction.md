---
title: Introduction | MANYOYO
description: What MANYOYO is and what it does, letting Claude Code, Codex, Gemini and OpenCode run in YOLO mode inside a container so the AI can go wild without hurting your computer.
---

# Introduction

**MANYOYO** lets Claude Code / Codex / Gemini / OpenCode run in YOLO mode inside a container: the AI can go wild without being able to hurt your computer.

## Why you need it

AI agent CLIs read and write your code, run shell commands and install dependencies. The no-confirmation (YOLO / SOLO) modes are the most productive, but running them directly on your machine leaves the risk boundary unclear. MANYOYO puts them in a container sandbox: the agent only sees the work directory you give it, and a broken container can be deleted and recreated at any time.

## What it does

- **Multiple agents**: `claude`, `codex`, `gemini` and `opencode` behind one entry point, switch any time.
- **Container isolation**: built on Docker / Podman to reduce what the host exposes.
- **Web UI**: chat, browse files and open a terminal in the browser, phones included.
- **One configuration**: run profiles, environment variables, mounts and image options live in `~/.manyoyo/manyoyo.json`.
- **One command** to install, upgrade and uninstall.

| Aspect | Bare agent CLI | MANYOYO |
| --- | --- | --- |
| Host exposure | High | Lower |
| Run boundary | Scattered | Centralized in container and config |
| Reproducibility | Weak | Strong (image + config) |
| High-risk mode notes | Left to each tool | Explicit YOLO / SOLO / sock warnings |

## Security boundary

MANYOYO reduces risk but is not "absolutely safe"; see [Security Notes](./security.md).

## Next Steps

- [Install](./quick-start.md)
- [First Run](./first-run.md)
