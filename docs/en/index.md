---
layout: home

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
  - title: Security Isolation
    details: Docker/Podman container isolation to reduce host machine risks.
  - title: Configuration System
    details: Support environment variables, config files, and run configs for flexible scenario management.
  - title: Troubleshooting
    details: Complete issue index with build and runtime error solutions.
  - title: Built for Efficiency
    details: Session recovery, environment file import, config templates to reduce repetition and token costs.
  - title: Container Nesting
    details: Docker-in-Docker mode support for safely running containerized applications.
---

> If you prefer Chinese documentation, please switch to [简体中文](/zh/).

## Why MANYOYO

MANYOYO is not a general container tool, but a security sandbox specifically designed for AI Agent CLIs:

- Pre-installed common Agents and development tools, avoiding repeated installations
- Freely switch between Agent and `/bin/bash`, suitable for real development workflows
- Support configuration files and environment files for team collaboration

## Documentation Deployment

This documentation site uses **VitePress + GitHub Actions + GitHub Pages**:

- Local development: `npm run docs:dev`
- Build static site: `npm run docs:build`
- Automatically deploy to GitHub Pages after pushing to `main` branch
