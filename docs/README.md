---
layout: home
title: MANYOYO 文档 | 开源 AI Agent 沙箱（AI agent sandbox）
description: MANYOYO 是开源的 AI Agent 沙箱，让 Claude Code、Codex、Gemini、OpenCode 在 Docker/Podman 容器里安全运行 YOLO 模式（run AI agents safely）。一条命令安装。

hero:
  name: MANYOYO
  text: AI 智能体 CLI 安全沙箱
  tagline: 让 AI 在容器里随便折腾，伤不到你的电脑
  actions:
    - theme: brand
      text: 立即安装
      link: /guide/quick-start
    - theme: alt
      text: 它是什么
      link: /guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/xcanwin/manyoyo

features:
  - title: 隔离保护
    details: 基于 Docker/Podman 容器隔离，Agent 只能看到你给它的工作目录。
    link: /guide/security
    linkText: 安全须知
  - title: 多 Agent
    details: Claude Code、Codex、Gemini、OpenCode 一个入口，随时切换。
    link: /reference/agents
    linkText: 支持的 Agent
  - title: 网页界面
    details: 浏览器里对话、看文件、开终端，手机也能用。
    link: /guide/first-run
    linkText: 第一次使用
  - title: 一条命令安装
    details: 安装、升级、卸载各一条命令，不需要先装 Node.js 或容器。
    link: /guide/daily
    linkText: 日常使用
---

## 一条命令安装

```bash
curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | sh
```

装完按屏幕提示完成配置。macOS 不需要预装任何东西。Linux：缺少容器环境时，安装器会说明原因，征得你同意后用 sudo 自动安装。已有 Node.js 和 Docker/Podman 的用户，也可以 `npm install -g @xcanwin/manyoyo`。

## 它是什么

MANYOYO（慢悠悠）让 Claude Code、Codex、Gemini、OpenCode 在容器里放心跑 YOLO / SOLO 模式：Agent 只能看到你给它的工作目录，容器出问题随时删掉重来。详见[介绍](./guide/introduction.md)。

## 热门场景

- [Claude Code YOLO 安全沙箱](./guide/quick-start.md) - 一条命令装好，隔离环境里放心免确认
- [Codex CLI 容器沙箱](./reference/agents.md) - 在隔离容器中运行 `codex`，支持会话恢复与命令调试
- [容器模式](./reference/container-modes.md) - 对比 `common` / `dind` / `sock` 模式

> English? 请切换到 [English](./en/README.md)。
