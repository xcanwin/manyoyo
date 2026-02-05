---
layout: home
title: MANYOYO 文档 | AI 智能体 CLI 安全沙箱
description: MANYOYO 是用于 AI Agent CLI 的 Docker/Podman 安全沙箱，可安全运行 Claude Code、Gemini、Codex、OpenCode 的 YOLO/SOLO 模式。

hero:
  name: MANYOYO
  text: AI 智能体 CLI 安全沙箱
  tagline: 安全运行 Agent YOLO/SOLO 模式，保护宿主机
  actions:
    - theme: brand
      text: 2 分钟快速开始
      link: /zh/guide/quick-start
    - theme: alt
      text: 安装详解
      link: /zh/guide/installation
    - theme: alt
      text: GitHub
      link: https://github.com/xcanwin/manyoyo

features:
  - title: 多智能体支持
    details: claude code、gemini、codex、opencode 一套命令快速切换。
    link: /zh/reference/agents
    linkText: 查看详情
  - title: 安全隔离
    details: 基于 Docker/Podman 容器隔离，降低宿主机风险。
    link: /zh/reference/container-modes
    linkText: 查看详情
  - title: 配置系统
    details: 支持环境变量、配置文件、运行配置，灵活管理复杂场景。
    link: /zh/configuration/
    linkText: 查看详情
  - title: 故障排查
    details: 完整的问题索引、构建和运行时错误解决方案。
    link: /zh/troubleshooting/
    linkText: 查看详情
  - title: 为效率而生
    details: 支持会话恢复、环境文件导入、配置模板，减少重复操作和 token 开销。
    link: /zh/advanced/session-management
    linkText: 查看详情
  - title: 容器嵌套
    details: 支持 Docker-in-Docker 模式，安全运行容器化应用。
    link: /zh/advanced/docker-in-docker
    linkText: 查看详情
---

> 如果你更习惯英文文档，请切换到 [English](/en/)。

## 为什么是 MANYOYO

MANYOYO 不是通用容器工具，而是专门为 AI Agent CLI 设计的安全沙箱：

- 常见 Agent 与开发工具可预装，避免反复安装
- 可自由切换 Agent 和 `/bin/bash`，适合真实开发流程
- 支持配置文件和环境文件，适配团队协作

## 热门场景

- [Claude Code YOLO 安全沙箱](./guide/quick-start) - 2 分钟启动隔离环境，降低宿主机风险
- [Codex CLI 容器沙箱](./reference/agents) - 在隔离容器中运行 `codex`，支持会话恢复与命令调试
- [Docker/Podman 安全运行 Agent CLI](./reference/container-modes) - 对比 `none` / `dind` / `sock` 模式

## 在线文档部署方式

当前文档站使用 **VitePress + GitHub Actions + GitHub Pages**：

- 本地开发：`npm run docs:dev`
- 构建静态站：`npm run docs:build`
- 推送 `main` 分支后自动部署到 GitHub Pages
