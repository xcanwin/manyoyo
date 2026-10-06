---
title: 安装 | MANYOYO
description: 一条命令安装 MANYOYO 与容器运行环境，按屏幕提示完成配置，几分钟内开始使用 AI Agent 沙箱。
---

# 安装

在终端执行这一条命令，装完按屏幕提示完成配置：

```bash
curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | sh
```

## macOS / Linux（推荐）

- **macOS**：不需要预装任何东西，安装包自带 Node.js、容器运行环境和 MANYOYO 镜像（约 1.8GB，下载需要几分钟）。
- **Linux（Ubuntu 22.04 / Debian 12 及以上）**：缺少容器环境时，安装器会说明原因，征得你同意后用 sudo 自动安装。
- macOS 不需要管理员密码；Linux 只有在你同意安装缺失的组件时才会用到 sudo。

装完后下一步：[第一次使用](./first-run.md)。

## 已有 Node.js 和 Docker/Podman

已经装好 Node.js（>= 22）与 Docker 或 Podman 的用户（包括 Windows 的 WSL），用 npm 安装：

```bash
npm install -g @xcanwin/manyoyo
manyoyo
```

更多安装方式（低权限 npm、源码）见[安装详解](../advanced/installation.md)。

::: details 下载慢或打不开 GitHub？
- **设代理**：在终端先执行 `export https_proxy=http://127.0.0.1:7890`（换成你的代理地址）再安装；macOS 开了系统代理会自动识别，`manyoyo update` 同样走代理。
- **手动下载**：打开 [Releases](https://github.com/xcanwin/manyoyo/releases/latest)，下载 `manyoyo-<版本>-<系统>-<芯片>.run`（Apple 芯片选 `macos-arm64`，Intel Mac 选 `macos-x64`，Linux 选 `linux-arm64` / `linux-x64`），然后执行 `sh manyoyo-*.run`。
- **用镜像**：`MANYOYO_DOWNLOAD_BASE=<镜像地址前缀>` 只替换安装包的来源，校验清单仍取自 GitHub 官方，所以镜像改不了内容（被改动的包会校验失败）。

```bash
curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | MANYOYO_DOWNLOAD_BASE=<镜像地址前缀> sh
```

升级时连不上 GitHub：下载 `manyoyo-<版本>-<系统>-<芯片>-app.tar.gz` 和 `SHA256SUMS` 到同一目录，执行 `manyoyo update --file <升级包路径>`；或下载完整安装包 `sh manyoyo-*.run` 覆盖安装。失败时屏幕上会直接列出这些文件的完整地址。
:::

::: details 高级参数
```bash
# 指定版本
curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | MANYOYO_VERSION=8.1.0 sh
# 强制按无图形界面（--headless）或有图形界面（--gui）处理
curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | sh -s -- --headless
# 只安装：不启动服务、不打开浏览器、不问怎么配置（装完自己运行 manyoyo 或 manyoyo setup）
curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | sh -s -- --install-only
```

默认自动判断：SSH 登录、或 Linux 下没有 `DISPLAY` / `WAYLAND_DISPLAY` 视为无图形界面。无图形界面且有终端时，安装结束会问你在终端里配置还是启动网页版，见[第一次使用](./first-run.md)。
:::

## 遇到问题

- 安装日志在 `~/.manyoyo/logs/install/`，失败后修好问题直接重新运行安装命令即可续上。
- 运行 `manyoyo doctor` 检查环境，`manyoyo doctor --fix` 自动修复可修复的项。
- 更多见[常见问题](../troubleshooting/README.md)。

## 下一步

- [第一次使用](./first-run.md)
- [日常使用](./daily.md)
- [迁移已有 Agent 配置](./migrate.md)
