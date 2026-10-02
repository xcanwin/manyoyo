---
title: 自定义镜像 | MANYOYO
description: 构建自定义 MANYOYO 沙箱镜像：manyoyo build、TOOL 工具集、镜像名与版本、构建缓存。
---

# 自定义镜像

默认镜像 `ghcr.io/xcanwin/manyoyo` 首次使用时自动拉取，**绝大多数用户不需要自己构建**。只有要换工具集、预装依赖或使用自己的镜像时，才看本页。

## 推荐方式：使用 manyoyo 构建

```bash
# 构建推荐版本（common）
manyoyo build --iv 2.1.0-common

# 构建后验证
docker images | grep manyoyo  # 或 podman images
```

**优势**：
- 自动使用缓存加速构建
- 首次构建：自动下载 Node.js、JDT LSP、gopls 等到 `docker/cache/`
- 2天内再次构建：直接使用本地缓存，速度提升约 **5 倍**
- 缓存过期后：自动重新下载最新版本

## 构建选项

### 完整版本（full）

包含所有支持的 AI CLI 工具和开发环境：

```bash
manyoyo build --iv 2.1.0-full
# 或显式指定构建参数
manyoyo build --iv 2.1.0-full --iba TOOL=full
```

**包含工具**：
- Claude Code
- Codex
- Gemini
- OpenCode
- Python、Node.js、Go、Java 开发环境
- 常用 LSP 服务器

**镜像大小**：约 3-5 GB

### 精简版本（common）

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

### 自定义版本

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

### 自定义镜像名称和版本

```bash
# 自定义镜像名和版本
manyoyo build --in myimage --iv 2.1.0-common
# 生成镜像：myimage:2.1.0-common

# 指定完整的镜像名
manyoyo build --in localhost/myuser/sandbox --iv 2.1.0-common
# 生成镜像：localhost/myuser/sandbox:2.1.0-common
```

### 特殊构建参数

```bash
# 跳过 Git SSL 验证（仅限开发环境）
manyoyo build --iba GIT_SSL_NO_VERIFY=true

# 禁用国内镜像源（国外用户）
manyoyo build --iba NODE_MIRROR= --iba NPM_REGISTRY=

# 使用自定义镜像源
manyoyo build --iba NODE_MIRROR=https://custom-mirror.com
```

## 手动构建（不推荐）

如果需要更多控制，可以手动使用 Docker/Podman 命令：

```bash
iv=1.8.0
podman build \
    -t ghcr.io/xcanwin/manyoyo:$iv-full \
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


## 下一步

- [安装详解](./installation.md)
- [镜像构建问题](./build-errors.md)
- [配置系统](../configuration/README.md)
