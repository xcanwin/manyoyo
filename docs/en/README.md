---
layout: home
title: MANYOYO Docs | Open-source AI agent sandbox
description: "MANYOYO is an open-source AI agent sandbox: run AI agents safely (Claude Code, Codex, Gemini, OpenCode in YOLO mode) inside Docker/Podman containers. One command to install."

hero:
  name: MANYOYO
  text: AI Agent CLI Security Sandbox
  tagline: Let AI go wild in a container, without hurting your computer
  actions:
    - theme: brand
      text: Install now
      link: /en/guide/quick-start
    - theme: alt
      text: What is it
      link: /en/guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/xcanwin/manyoyo

features:
  - title: Isolation
    details: Docker/Podman container isolation; the agent only sees the work directory you give it.
    link: /en/guide/security
    linkText: Security notes
  - title: Multiple agents
    details: Claude Code, Codex, Gemini and OpenCode behind one entry point, switch any time.
    link: /en/reference/agents
    linkText: Supported agents
  - title: Web UI
    details: Chat, browse files and open a terminal in the browser, phones included.
    link: /en/guide/first-run
    linkText: First run
  - title: One-command install
    details: One command each to install, upgrade and uninstall; no need to install Node.js or containers first.
    link: /en/guide/daily
    linkText: Daily use
---

## Install with one command

```bash
curl -fsSL https://github.com/xcanwin/manyoyo/raw/main/scripts/install.sh | sh
```

When it finishes, follow the on-screen prompts to finish setup. macOS needs nothing installed first. Linux: if the container runtime is missing, the installer explains why and, with your consent, installs it with sudo. If you already have Node.js and Docker/Podman, `npm install -g @xcanwin/manyoyo` works too.

## What is it

MANYOYO lets Claude Code, Codex, Gemini and OpenCode run in YOLO / SOLO mode inside a container: the agent only sees the work directory you give it, and a broken container can be deleted and recreated any time. See the [Introduction](./guide/introduction.md).

## Popular use cases

- [Claude Code YOLO sandbox](./guide/quick-start.md) - one command to set up, no-confirmation mode in an isolated environment
- [Codex CLI container sandbox](./reference/agents.md) - run `codex` in an isolated container with session recovery
- [Container modes](./reference/container-modes.md) - compare `common` / `dind` / `sock`

> 中文文档请切换到 [简体中文](../README.md)。
