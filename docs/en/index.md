---
layout: home
title: MANYOYO Docs | AI Agent CLI Security Sandbox
description: MANYOYO is a Docker/Podman security sandbox for AI Agent CLI tools. Safely run Claude Code, Gemini, Codex, and OpenCode in YOLO/SOLO workflows.

hero:
  name: MANYOYO
  text: AI Agent CLI Security Sandbox
  tagline: Safely run Agent YOLO/SOLO mode, protect your host machine
  actions:
    - theme: brand
      text: 2-Minute Quick Start
      link: /en/guide/quick-start
    - theme: alt
      text: Installation Guide
      link: /en/guide/installation
    - theme: alt
      text: GitHub
      link: https://github.com/xcanwin/manyoyo

features:
  - title: Multi-Agent Support
    details: Claude Code, Gemini, Codex, OpenCode - switch between agents with one command.
    link: /en/reference/agents
    linkText: Learn more
  - title: Security Isolation
    details: Docker/Podman container isolation to reduce host machine risks.
    link: /en/reference/container-modes
    linkText: Learn more
  - title: Configuration System
    details: Support environment variables, config files, and run configs for flexible scenario management.
    link: /en/configuration/
    linkText: Learn more
  - title: Troubleshooting
    details: Complete issue index with build and runtime error solutions.
    link: /en/troubleshooting/
    linkText: Learn more
  - title: Built for Efficiency
    details: Session recovery, environment file import, config templates to reduce repetition and token costs.
    link: /en/advanced/session-management
    linkText: Learn more
  - title: Container Nesting
    details: Docker-in-Docker mode support for safely running containerized applications.
    link: /en/advanced/docker-in-docker
    linkText: Learn more
---

> If you prefer Chinese documentation, please switch to [简体中文](/zh/).

## Why MANYOYO

MANYOYO is not a general container tool, but a security sandbox specifically designed for AI Agent CLIs:

- Pre-installed common Agents and development tools, avoiding repeated installations
- Freely switch between Agent and `/bin/bash`, suitable for real development workflows
- Support configuration files and environment files for team collaboration

## Popular Use Cases

- [Claude Code YOLO sandbox](./guide/quick-start) - launch an isolated environment in 2 minutes
- [Codex CLI container sandbox](./reference/agents) - run `codex` in an isolated container with session recovery
- [Docker/Podman secure runtime for Agent CLI](./reference/container-modes) - compare `none` / `dind` / `sock` modes

## Documentation Deployment

This documentation site uses **VitePress + GitHub Actions + GitHub Pages**:

- Local development: `npm run docs:dev`
- Build static site: `npm run docs:build`
- Automatically deploy to GitHub Pages after pushing to `main` branch
