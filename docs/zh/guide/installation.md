---
title: 安装详解 | MANYOYO
description: MANYOYO 安装指南，涵盖 Node.js 与 Docker/Podman 前置条件、全局安装、镜像构建参数和常见安装问题。
---

# 安装详解

本页面提供 MANYOYO 的详细安装指南，包括前置条件、安装步骤和镜像构建。

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
manyoyo -V

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

更新到最新版本：

```bash
npm update -g @xcanwin/manyoyo
```

检查更新：

```bash
npm outdated -g @xcanwin/manyoyo
```

## 拉取基础镜像（Podman 用户）

::: warning 仅 Podman 用户需要
Docker 用户可以跳过此步骤，Docker 会自动拉取基础镜像。
:::

Podman 用户需要手动拉取 Ubuntu 基础镜像：

```bash
podman pull ubuntu:24.04
```

验证镜像：

```bash
podman images | grep ubuntu
```

## 构建沙箱镜像

MANYOYO 使用自定义的容器镜像，包含预装的 AI CLI 工具和开发环境。

### 推荐方式：使用 manyoyo 构建

```bash
# 构建推荐版本（common）
manyoyo build --iv 1.8.0-common

# 构建后验证
docker images | grep manyoyo  # 或 podman images
```

**优势**：
- 自动使用缓存加速构建
- 首次构建：自动下载 Node.js、JDT LSP、gopls 等到 `docker/cache/`
- 2天内再次构建：直接使用本地缓存，速度提升约 **5 倍**
- 缓存过期后：自动重新下载最新版本

### 构建选项

#### 完整版本（full）

包含所有支持的 AI CLI 工具和开发环境：

```bash
manyoyo build --iv 1.8.0-full
# 或显式指定构建参数
manyoyo build --iv 1.8.0-full --iba TOOL=full
```

**包含工具**：
- Claude Code
- Codex
- Gemini
- OpenCode
- Python、Node.js、Go、Java 开发环境
- 常用 LSP 服务器

**镜像大小**：约 3-5 GB

#### 精简版本（common）

仅包含常用组件：

```bash
manyoyo build --iba TOOL=common
```

**包含工具**：
- Claude Code
- Codex
- Python、Node.js 基础环境
- 常用 CLI 工具

**镜像大小**：约 1-2 GB

**适用场景**：
- 磁盘空间有限
- 使用 Claude Code / Codex
- 快速测试

#### 自定义版本

选择特定的工具组合：

```bash
# 仅安装指定工具
manyoyo build --iba TOOL=go,codex,java,gemini

# 组件说明：
# - python: Python 环境
# - nodejs: Node.js 环境
# - claude: Claude Code
# - codex: Codex
# - gemini: Gemini
# - opencode: OpenCode
# - go: Go 环境和 gopls
# - java: Java 环境和 JDT LSP
```

#### 自定义镜像名称和版本

```bash
# 自定义镜像名和版本
manyoyo build --in myimage --iv 1.8.0-common
# 生成镜像：myimage:1.8.0-common

# 指定完整的镜像名
manyoyo build --in localhost/myuser/sandbox --iv 1.0.0-common
# 生成镜像：localhost/myuser/sandbox:1.0.0-common
```

#### 特殊构建参数

```bash
# 跳过 Git SSL 验证（仅限开发环境）
manyoyo build --iba GIT_SSL_NO_VERIFY=true

# 禁用国内镜像源（国外用户）
manyoyo build --iba NODE_MIRROR= --iba NPM_REGISTRY=

# 使用自定义镜像源
manyoyo build --iba NODE_MIRROR=https://custom-mirror.com
```

### 手动构建（不推荐）

如果需要更多控制，可以手动使用 Docker/Podman 命令：

```bash
iv=1.8.0
podman build \
    -t localhost/xcanwin/manyoyo:$iv-full \
    -f docker/manyoyo.Dockerfile . \
    --build-arg TOOL=full \
    --no-cache
```

::: warning 不推荐手动构建
手动构建不会使用 MANYOYO 的缓存机制，构建时间会显著增加。
:::

## 缓存机制

MANYOYO 自动管理构建缓存以加速重复构建：

### 缓存目录

```bash
docker/cache/
├── node-v22.x.x-linux-x64.tar.xz
├── gopls-v0.x.x-linux-amd64.tar.gz
├── jdt-language-server-x.x.x.tar.gz
└── ...
```

### 缓存有效期

- **有效期**：2 天
- **首次构建**：下载所有依赖到缓存目录
- **2天内再次构建**：直接使用缓存，速度提升约 **5 倍**
- **缓存过期后**：自动重新下载最新版本

### 手动管理缓存

```bash
# 查看缓存
ls -lh docker/cache/

# 清理缓存（不推荐，会导致下次构建变慢）
rm -rf docker/cache/

# 手动更新缓存时间戳
touch docker/cache/*
```

## 验证安装

完成安装后，进行以下验证：

### 1. 验证 MANYOYO 安装

```bash
# 查看版本
manyoyo -V

# 查看帮助
manyoyo -h
```

### 2. 验证镜像

```bash
# 列出镜像
docker images | grep manyoyo  # 或 podman images

# 应该看到类似：
# localhost/xcanwin/manyoyo  1.8.0-common  xxx  xxx  xxGB
```

### 3. 初始化 Agent 配置（推荐）

```bash
# 从宿主机已有的 claude/codex/gemini/opencode 配置迁移
manyoyo init all
```

### 4. 创建测试容器

```bash
# 创建并运行测试容器
manyoyo run -n test-container -x echo "MANYOYO works!"

# 查看容器
manyoyo ls

# 删除测试容器
manyoyo rm test-container
```

### 5. 测试 AI CLI 工具

```bash
# 使用初始化后的运行配置（推荐）
manyoyo run -r claude

# 或仅检查 CLI 版本
manyoyo run -n test -x claude --version

# 测试 Python
manyoyo run -n test -x python3 --version

# 测试 Node.js
manyoyo run -n test -x node --version
```

## 故障排查

安装相关问题已统一收敛到：
- [故障排查指南](../troubleshooting/README.md)
- [构建问题详解](../troubleshooting/build-errors.md)
- [运行时问题详解](../troubleshooting/runtime-errors.md)

建议先执行以下最小检查：

```bash
# 检查网络和磁盘
curl -I https://mirrors.tencent.com
df -h

# 先构建精简版本，验证基础链路
manyoyo build --iba TOOL=common
```

如果遇到 `permission denied`，可先执行：

```bash
sudo usermod -aG docker $USER
newgrp docker
```

## 升级指南

### 升级 MANYOYO

```bash
# 更新到最新版本
npm update -g @xcanwin/manyoyo

# 验证新版本
manyoyo -V
```

### 升级镜像

```bash
# 构建新版本镜像
manyoyo build --iv 1.8.0-common

# 更新全局配置
cat > ~/.manyoyo/manyoyo.json << 'EOF'
{
    "imageVersion": "1.8.0-common"
}
EOF

# 清理旧镜像（可选）
manyoyo prune
docker system prune -a  # 或 podman system prune -a
```

## 卸载

### 卸载 MANYOYO

```bash
# 卸载全局安装
npm uninstall -g @xcanwin/manyoyo

# 删除配置目录（可选）
rm -rf ~/.manyoyo/
```

### 清理镜像和容器

```bash
# 删除所有 MANYOYO 容器
docker ps -a | grep my | awk '{print $1}' | xargs docker rm

# 删除所有 MANYOYO 镜像
docker images | grep manyoyo | awk '{print $3}' | xargs docker rmi

# 清理悬空镜像
manyoyo prune
```

## 下一步

安装完成后，您可以：

1. [快速开始](./quick-start.md) - 了解基本使用流程
2. [基础用法](./basic-usage.md) - 学习常用命令和操作
3. [配置系统](../configuration/README.md) - 设置环境变量和配置文件
4. [命令参考](../reference/cli-options.md) - 查看所有命令行选项
