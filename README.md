<p align="center">
  <img src="./assets/manyoyo-logo-09-cyberpunk-terminal.svg" alt="MANYOYO logo" width="560" />
</p>

# <p align="center"><a href="https://github.com/xcanwin/manyoyo">MANYOYO（慢悠悠）</a></p>
<p align="center">一款AI智能体安全沙箱，保障PC安全，可以随心所欲运行YOLO/SOLO模式。</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@xcanwin/manyoyo"><img alt="npm" src="https://img.shields.io/npm/v/@xcanwin/manyoyo?style=flat-square" /></a>
  <a href="https://github.com/xcanwin/manyoyo/actions/workflows/npm-publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/xcanwin/manyoyo/npm-publish.yml?style=flat-square" /></a>
  <a href="https://github.com/xcanwin/manyoyo/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

<p align="center">
  <a href="README.md"><b>中文</b></a> |
  <a href="https://xcanwin.github.io/manyoyo/en/">English</a>
</p>
<p align="center">
  📚 在线文档：<a href="https://xcanwin.github.io/manyoyo/">https://xcanwin.github.io/manyoyo/</a>
</p>

---

## 项目简介

**MANYOYO** 是一款 AI 智能体提效安全沙箱，安全、高效、省 token，专为 Agent YOLO 模式设计，保障宿主机安全。

预装常见 Agent 与工具，进一步节省 token。循环自由切换 Agent 和 `/bin/bash`，进一步提效。

**MANYOYO** 提供隔离的 Docker/Podman 容器环境，用于安全运行 AI 智能体命令行工具。

## 功能亮点

- **多智能体支持**：支持 claude code, gemini, codex, opencode
- **安全隔离**：保护宿主机，支持安全容器嵌套（Docker-in-Docker）
- **快速启动**：快捷开启常见 Agent YOLO / SOLO 模式（例如 claude --dangerously-skip-permissions）
- **便捷操作**：快速进入 `/bin/bash`
- **会话恢复**：安装 Skills Marketplace 可快速恢复会话
- **灵活自定义**：支持配置各 CLI 的 `*_BASE_URL` / `*_AUTH_TOKEN` / `*_API_KEY` 等变量
- **配置管理**：快捷导入配置文件
- **高级模式**：支持危险容器嵌套（mount-docker-socket）、自定义沙箱镜像

---

## 快速开始

```bash
npm install -g @xcanwin/manyoyo    # 安装
podman pull ubuntu:24.04           # 仅 Podman 需要
manyoyo --ib --iv 1.7.0            # 构建镜像
manyoyo -y c                       # 运行 Claude Code YOLO 模式
```

注意：YOLO/SOLO 会跳过权限确认，请确保在可控环境中使用。

---

## 安全提示

- **YOLO/SOLO 模式**：跳过权限确认，存在误删或执行危险命令风险。详见：[AI 智能体](https://xcanwin.github.io/manyoyo/zh/reference/agents)
- **sock 容器模式**：挂载宿主机 Docker socket，容器可完全控制宿主机容器。详见：[容器模式](https://xcanwin.github.io/manyoyo/zh/reference/container-modes)

## 安装

### 全局安装（推荐）

```bash
npm install -g @xcanwin/manyoyo
```

### 系统要求

- Node.js >= 22.0.0
- Podman（推荐） 或 Docker

详细安装指南请参考：[安装详解](https://xcanwin.github.io/manyoyo/zh/guide/installation)

## 构建镜像

```bash
# 构建完整版本（推荐）
manyoyo --ib --iv 1.7.0

# 构建精简版本
manyoyo --ib --iba TOOL=common

# 构建自定义版本
manyoyo --ib --iba TOOL=go,codex,java,gemini
```

- 首次构建会自动下载依赖到 `docker/cache/`，2天内再次构建会使用缓存，速度提升约 **5 倍**

## 常用命令

```bash
# 启动常见智能体
manyoyo -y c          # Claude Code（或 claude / cc）
manyoyo -y gm         # Gemini（或 gemini / g）
manyoyo -y cx         # Codex（或 codex）
manyoyo -y oc         # OpenCode（或 opencode）

# 容器管理
manyoyo -l
manyoyo -n myy-dev -x /bin/bash
manyoyo -n myy-dev --crm

# 调试配置与命令拼装
manyoyo --show-config
manyoyo --show-command
```

## 配置

配置优先级：命令行参数 > 运行配置 > 全局配置 > 默认值  
详细说明请参考：
- [配置系统概览](https://xcanwin.github.io/manyoyo/zh/configuration/)
- [环境变量详解](https://xcanwin.github.io/manyoyo/zh/configuration/environment)
- [配置文件详解](https://xcanwin.github.io/manyoyo/zh/configuration/config-files)

## 📚 完整文档

在线文档：**https://xcanwin.github.io/manyoyo/**

**中文文档：**
- [快速开始](https://xcanwin.github.io/manyoyo/zh/guide/quick-start)
- [安装详解](https://xcanwin.github.io/manyoyo/zh/guide/installation)
- [配置系统](https://xcanwin.github.io/manyoyo/zh/configuration/)
- [故障排查](https://xcanwin.github.io/manyoyo/zh/troubleshooting/)

**English Documentation:**
- [Quick Start](https://xcanwin.github.io/manyoyo/en/guide/quick-start)
- [Installation](https://xcanwin.github.io/manyoyo/en/guide/installation)
- [Configuration](https://xcanwin.github.io/manyoyo/en/configuration/)
- [Troubleshooting](https://xcanwin.github.io/manyoyo/en/troubleshooting/)

## 卸载

```bash
# 卸载全局安装
npm uninstall -g @xcanwin/manyoyo

# 清理配置（可选）
rm -rf ~/.manyoyo/
```

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！

访问 [GitHub Issues](https://github.com/xcanwin/manyoyo/issues) 报告问题或提出建议。
