---
title: 快速开始 | MANYOYO
description: 宿主机已可用 Claude/Codex/Gemini/OpenCode 时，最快把配置迁移到 MANYOYO 并立即在沙箱内访问大模型。
---

# 快速开始

本页面针对这类用户：
- 宿主机上已经能运行 `claude` / `codex` / `gemini` / `opencode`
- 已经能访问大模型（环境变量或本地认证已配置）

目标是用最短路径迁移到 MANYOYO 沙箱。

## 1. 安装 manyoyo

```bash
npm install -g @xcanwin/manyoyo
manyoyo -V
```

## 2. 安装 Podman / Docker

容器运行时安装或切换可参考：
- [安装 Podman（推荐）](./installation.md#安装-podman推荐)
- [安装 Docker（可选）](./installation.md#安装-docker可选)

## 3. 构建沙箱镜像

```bash
manyoyo build --iv 1.8.0-common
```

## 4. 立即迁移配置

```bash
manyoyo init all
```

## 5. 直接启动 Agent

```bash
manyoyo run -r claude
manyoyo run -r codex
manyoyo run -r gemini
manyoyo run -r opencode
```

## 故障排查

如果 `init` 提示某些变量未找到，直接编辑 `~/.manyoyo/manyoyo.json` 的对应 `runs.<agent>.env`：

```bash
vim ~/.manyoyo/manyoyo.json

# 示例：查看 runs.claude.env
node -e "console.log(require('json5').parse(require('fs').readFileSync(process.env.HOME+'/.manyoyo/manyoyo.json','utf8')).runs?.claude?.env)"
```

更多问题见：[故障排查](../troubleshooting/README.md)

## 下一步

- [基础用法](./basic-usage.md)
- [配置系统](../configuration/README.md)
- [命令参考](../reference/cli-options.md)
- [故障排查](../troubleshooting/README.md)
