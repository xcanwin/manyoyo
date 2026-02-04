---
layout: home

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
  - title: 安全隔离
    details: 基于 Docker/Podman 容器隔离，降低宿主机风险。
  - title: 配置系统
    details: 支持环境变量、配置文件、运行配置，灵活管理复杂场景。
  - title: 故障排查
    details: 完整的问题索引、构建和运行时错误解决方案。
  - title: 为效率而生
    details: 支持会话恢复、环境文件导入、配置模板，减少重复操作和 token 开销。
  - title: 容器嵌套
    details: 支持 Docker-in-Docker 模式，安全运行容器化应用。
---

> 如果你更习惯英文文档，请切换到 [English](/en/)。

## 为什么是 MANYOYO

MANYOYO 不是通用容器工具，而是专门为 AI Agent CLI 设计的安全沙箱：

- 常见 Agent 与开发工具可预装，避免反复安装
- 可自由切换 Agent 和 `/bin/bash`，适合真实开发流程
- 支持配置文件和环境文件，适配团队协作

## 在线文档部署方式

当前文档站使用 **VitePress + GitHub Actions + GitHub Pages**：

- 本地开发：`npm run docs:dev`
- 构建静态站：`npm run docs:build`
- 推送 `main` 分支后自动部署到 GitHub Pages
