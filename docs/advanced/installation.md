---
title: 安装详解 | MANYOYO
description: MANYOYO 安装指南，涵盖 Node.js 与 Docker/Podman 前置条件、全局安装、镜像构建参数和常见安装问题。
---

# 安装详解

本页面提供 MANYOYO 的详细安装指南，包括前置条件、安装步骤和镜像构建。

## 推荐：一键安装

macOS 与 Linux（Debian / Ubuntu）用户优先用[一条命令安装](../guide/quick-start.md)，macOS 无需管理员密码，Linux 只有缺少容器环境、且你同意时才会用 `sudo` 安装。下面的 npm / 包管理器 / 源码方式适用于 Windows(WSL)，以及已经装好 Node.js 与 Docker / Podman、想自己管理版本的用户。

## 系统要求

### 必需

- **Node.js** >= 22.0.0
- **Docker** 或 **Podman**（推荐使用 Podman）

### 推荐

- 磁盘空间：至少 10GB 可用空间（用于镜像和缓存）
- 内存：至少 4GB RAM
- 网络：稳定的网络连接（首次构建需要下载依赖）

## 验证前置条件

在安装 MANYOYO 之前，请确认已安装必需的软件：

```bash
# 检查 Node.js 版本（需要 >= 22.0.0）
node --version

# 检查 npm 版本
npm --version

# 检查 Docker 或 Podman
docker --version   # 或
podman --version
```

如果未安装，请先安装这些软件：

### 安装 Node.js

**macOS/Linux**：
```bash
# 使用 nvm（推荐）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 22
nvm use 22

# 或使用系统包管理器
# macOS
brew install node@22

# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Windows（原生）**：
- 从 [Node.js 官网](https://nodejs.org/) 下载安装器（适合 PowerShell/Windows 原生开发）

**Windows（WSL2）**：
- WSL2 下按 Linux 方式安装，推荐使用 `nvm`（适合 Bash/Linux 开发流程）

```bash
# 在 WSL 终端执行
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 22
nvm use 22
```

### 安装 Podman（推荐）

**macOS**：
```bash
brew install podman

# 初始化 Podman 机器
podman machine init
podman machine start
```

**Linux**：
```bash
# Fedora/RHEL/CentOS
sudo dnf install podman

# Ubuntu/Debian
sudo apt-get update
sudo apt-get install podman

# Arch Linux
sudo pacman -S podman
```

**Windows**：
- 从 [Podman 官网](https://podman.io/docs/installation) 下载安装器

### 安装 Docker（可选）

如果选择使用 Docker 而不是 Podman：

**macOS/Windows**：
- 下载 [Docker Desktop](https://www.docker.com/products/docker-desktop/)

**Linux**：
```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# 添加用户到 docker 组
sudo usermod -aG docker $USER
newgrp docker
```

## 安装 MANYOYO

### 全局安装（推荐）

使用 npm 全局安装 MANYOYO：

```bash
npm install -g @xcanwin/manyoyo
```

### 低权限全局安装（macOS/Linux/WSL）

如果 `npm install -g xxx` 报 `EACCES` / `permission denied`，可以改用用户目录作为全局前缀，避免 `sudo`：

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

说明：
- 这类权限问题主要出现在 macOS/Linux/WSL 使用系统 Node.js 前缀（如 `/usr/local`）时
- Windows 原生环境通常不使用 `sudo`
- 如果你使用 zsh，请把 PATH 追加到 `~/.zprofile` 或 `~/.zshrc`

安装完成后，验证安装：

```bash
# 查看版本
manyoyo -v

# 查看帮助信息
manyoyo -h
```

### 本地开发安装

如果需要从源码安装（用于开发或测试）：

```bash
# 克隆仓库
git clone https://github.com/xcanwin/manyoyo.git
cd manyoyo

# 安装依赖
npm install

# 全局链接（开发模式）
npm install -g .

# 或使用 npm link
npm link
```

### 更新 MANYOYO

```bash
npm update -g @xcanwin/manyoyo
manyoyo -v
```

## 验证安装

```bash
manyoyo -v                                      # 版本
manyoyo init all                                # 从宿主机已有的 claude/codex/gemini/opencode 配置迁移（推荐）
manyoyo run -n test-container -x echo "MANYOYO works!"   # 创建并运行测试容器
manyoyo ps                                      # 查看容器
manyoyo rm test-container                       # 删除测试容器
manyoyo run -r claude                           # 使用初始化后的运行配置
```

默认镜像首次使用时自动拉取，只有自定义镜像才需要构建，见[自定义镜像](./custom-image.md)。安装或运行出错，见[故障排查](../troubleshooting/README.md)与[构建问题](./build-errors.md)。

## 升级与卸载

升级镜像：自定义镜像构建新标签后，把 `~/.manyoyo/manyoyo.json` 的 `imageVersion` 改为 `"2.2.0-common"`，再用 `manyoyo prune` 清理悬空镜像。

卸载 npm 安装的 MANYOYO：

```bash
npm uninstall -g @xcanwin/manyoyo
manyoyo ps && manyoyo rm <名称>   # 确认名称后逐个删除容器（可选）
rm -rf ~/.manyoyo/                # 删除配置、历史与日志（可选，不可恢复）
```

离线包安装的升级与卸载用 `manyoyo update` 与 `manyoyo uninstall`，见[安装](../guide/quick-start.md)。

## 离线包结构

给维护者和想了解安装包内部的用户。一键安装脚本 `scripts/install.sh` 只负责下载、校验并启动 `.run`；真正的安装逻辑在 `.run` 解开后的 `install/install.sh`。

- **Release 里的资产**：每个平台（`macos` / `linux`）× 芯片（`arm64` / `x64`）各有一个安装包 `manyoyo-<版本>-<系统>-<芯片>.run` 和一个升级包 `manyoyo-<版本>-<系统>-<芯片>-app.tar.gz`，外加一个校验清单 `SHA256SUMS`，共 9 个文件。`-app.tar.gz` 是 `manyoyo update` 自动下载的（只含 Node.js 与 manyoyo，几十 MB），不需要手动下载。
- **安装包自校验**：`.run` 在安装前会校验自身。想只校验、不安装：`sh manyoyo-*.run --check`；列出内容：`--list`；只解开到某个目录：`--extract <目录>`。
- **手动对照校验值**：`grep "$(shasum -a 256 manyoyo-*-macos-arm64.run | cut -d' ' -f1)" SHA256SUMS`，有输出（带文件名的一行）就是一致。
- **先看脚本再执行**：`sed -n '1,/^__MANYOYO_PAYLOAD_BELOW__$/p' manyoyo-*.run`。
- **分卷**：单个文件超过 GitHub 的 2 GiB 上限时才会拆成 `.run.001`、`.run.002` 等。把它们全部下载到同一个目录，对第 1 卷执行 `sh manyoyo-*.run.001`，安装包会自己按序拼接并校验；也可以 `cat manyoyo-*.run.* > manyoyo-合并.run` 手动合并后当普通 `.run` 使用。
- **安装位置**：`~/.manyoyo/app/<版本>/` 是程序，`app/current` 指向当前版本，升级时原子切换并保留上一版本以便 `update --rollback`。

## 下一步

1. [安装](../guide/quick-start.md)：一条命令装好
2. [基础用法](../guide/basic-usage.md)：常用命令和操作
3. [配置系统](../configuration/README.md)：环境变量和配置文件
