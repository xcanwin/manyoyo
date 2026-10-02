---
title: 安装 | MANYOYO
description: 一条命令安装 MANYOYO 与容器运行环境，浏览器自动打开向导，几分钟内开始使用 AI Agent 沙箱。
---

# 安装

在终端执行这一条命令，装完浏览器会自动打开向导：

```bash
curl -fsSL https://github.com/xcanwin/manyoyo/raw/main/scripts/install.sh | sh
```

## macOS / Linux（推荐）

- **macOS**：不需要预装任何东西，安装包自带 Node.js、容器运行环境和 MANYOYO 镜像（约 1.8GB，下载需要几分钟）。
- **Linux（Debian / Ubuntu，Ubuntu 22.04 / Debian 12 及以上）**：需要已经装好 Docker 或 Podman，没有时安装器会提示怎么装。
- 整个过程不需要管理员密码，也不会改动系统目录。

装完后下一步：[第一次使用](./first-run.md)。

## 已有 Node.js 和 Docker/Podman

已经装好 Node.js（>= 22）与 Docker 或 Podman 的用户（包括 Windows 的 WSL），用 npm 安装：

```bash
npm install -g @xcanwin/manyoyo
manyoyo
```

更多安装方式（低权限 npm、源码）见[安装详解](../advanced/installation.md)。

::: details 手动下载
打开 [Releases](https://github.com/xcanwin/manyoyo/releases/latest)，下载 `manyoyo-<版本>-<系统>-<芯片>.run`（Apple 芯片选 `macos-arm64`，Intel Mac 选 `macos-x64`），然后执行 `sh manyoyo-*.run`。
:::

::: details 下载慢或打不开？
把下载地址指向你信任的镜像：

```bash
curl -fsSL https://github.com/xcanwin/manyoyo/raw/main/scripts/install.sh | MANYOYO_DOWNLOAD_BASE=<镜像地址前缀> sh
```

`raw.githubusercontent.com` 也打不开时，用上面的「手动下载」。
:::

::: details 高级参数
```bash
# 指定版本
curl -fsSL https://github.com/xcanwin/manyoyo/raw/main/scripts/install.sh | MANYOYO_VERSION=8.1.0 sh
# 强制按无图形界面（--headless）或有图形界面（--gui）处理
curl -fsSL https://github.com/xcanwin/manyoyo/raw/main/scripts/install.sh | sh -s -- --headless
```

默认自动判断：SSH 登录、或 Linux 下没有 `DISPLAY` / `WAYLAND_DISPLAY` 视为无图形界面。
:::

## 遇到问题

- 安装日志在 `~/.manyoyo/logs/install/`，失败后修好问题直接重新运行安装命令即可续上。
- 运行 `manyoyo doctor` 检查环境，`manyoyo doctor --fix` 自动修复可修复的项。
- 更多见[常见问题](../troubleshooting/README.md)。

## 下一步

- [第一次使用](./first-run.md)
- [日常使用](./daily.md)
- [迁移已有 Agent 配置](./migrate.md)
