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
- **灵活自定义**：支持自定义 `BASEURL`、`AUTH_TOKEN` 等变量
- **配置管理**：快捷导入配置文件
- **高级模式**：支持危险容器嵌套（mount-docker-socket）、自定义沙箱镜像

---

## 快速开始

```bash
npm install -g @xcanwin/manyoyo    # 安装
podman pull ubuntu:24.04           # 拉取基础镜像
manyoyo --ib --iv 1.7.0            # 构建镜像
manyoyo -y c                       # 运行 Claude Code YOLO 模式
```

## 安装

### 全局安装（推荐）

```bash
npm install -g @xcanwin/manyoyo
```

### 本地开发

```bash
npm install -g .
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

## 基础用法

### AI CLI 快捷方式

```bash
# Claude Code
manyoyo -y c          # 或: claude, cc

# Gemini
manyoyo -y gm         # 或: gemini, g

# Codex
manyoyo -y cx         # 或: codex

# OpenCode
manyoyo -y oc         # 或: opencode
```

### 容器管理

```bash
# 列出所有容器
manyoyo -l

# 创建命名容器
manyoyo -n myy-dev -y c

# 恢复会话
manyoyo -n myy-dev -- -c            # Claude Code
manyoyo -n myy-dev -- resume --last # Codex

# 进入 shell
manyoyo -n myy-dev -x /bin/bash

# 删除容器
manyoyo -n myy-dev --crm
```

## 配置

### 环境变量

```bash
# 字符串形式
manyoyo -e "ANTHROPIC_BASE_URL=https://api.anthropic.com" \
        -e "ANTHROPIC_AUTH_TOKEN=sk-xxx" \
        -y c

# 文件形式（推荐）
mkdir -p ~/.manyoyo/env/
cat > ~/.manyoyo/env/anthropic.env << 'EOF'
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
EOF

manyoyo --ef anthropic -y c
```

### 运行配置

```bash
# 创建运行配置
mkdir -p ~/.manyoyo/run/
cat > ~/.manyoyo/run/claude.json << 'EOF'
{
    "envFile": ["anthropic"],
    "yolo": "c"
}
EOF

# 使用配置
manyoyo -r claude
```

详细配置请参考：
- [环境变量详解](https://xcanwin.github.io/manyoyo/zh/configuration/environment)
- [配置文件详解](https://xcanwin.github.io/manyoyo/zh/configuration/config-files)
- [配置示例](https://xcanwin.github.io/manyoyo/zh/configuration/examples)

## 容器模式

MANYOYO 支持三种容器模式：

| 模式 | 安全性 | 容器嵌套 | 适用场景 |
|------|--------|----------|----------|
| **common**（默认） | ⭐⭐⭐⭐⭐ | ❌ | 日常开发 |
| **dind** | ⭐⭐⭐⭐ | ✅ | CI/CD |
| **sock** | ⭐ 危险 | ✅ | 特殊需求 |

```bash
# Docker-in-Docker 模式（安全的嵌套容器）
manyoyo -m dind -x /bin/bash

# Socket Mount 模式（危险！可访问宿主机容器）
manyoyo -m sock -x /bin/bash
```

详细说明请参考：[容器模式详解](https://xcanwin.github.io/manyoyo/zh/reference/container-modes)

## 📚 完整文档

访问完整在线文档：**https://xcanwin.github.io/manyoyo/**

**中文文档：**
- [快速开始](https://xcanwin.github.io/manyoyo/zh/guide/quick-start) - 2分钟上手指南
- [安装详解](https://xcanwin.github.io/manyoyo/zh/guide/installation) - 详细安装步骤
- [基础用法](https://xcanwin.github.io/manyoyo/zh/guide/basic-usage) - 常用命令和操作
- [配置系统](https://xcanwin.github.io/manyoyo/zh/configuration/) - 环境变量和配置文件
- [AI 智能体](https://xcanwin.github.io/manyoyo/zh/reference/agents) - 各智能体使用指南
- [故障排查](https://xcanwin.github.io/manyoyo/zh/troubleshooting/) - 常见问题解决方案

**English Documentation:**
- [Quick Start](https://xcanwin.github.io/manyoyo/en/guide/quick-start)
- [Installation](https://xcanwin.github.io/manyoyo/en/guide/installation)
- [Configuration](https://xcanwin.github.io/manyoyo/en/configuration/)
- [Troubleshooting](https://xcanwin.github.io/manyoyo/en/troubleshooting/)

## 文档站开发

```bash
# 本地开发
npm run docs:dev

# 构建文档
npm run docs:build

# 预览构建产物
npm run docs:preview
```

文档基于 VitePress 构建，并通过 GitHub Actions 自动部署到 GitHub Pages。

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
