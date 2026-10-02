---
title: 迁移已有 Agent 配置 | MANYOYO
description: 宿主机已可用 Claude/Codex/Gemini/OpenCode 时，最快把配置迁移到 MANYOYO 并立即在沙箱内访问大模型。
---

# 迁移已有 Agent 配置

本页面针对已经装好 npm / Docker 或 Podman、且宿主机上已有可用 Agent 的用户（刚开始用 MANYOYO 请先看[安装](./quick-start.md)）：
- 宿主机上已经能运行 `claude` / `codex` / `gemini` / `opencode`
- 已经能访问大模型（环境变量或本地认证已配置）

目标是用最短路径把现有配置迁移到 MANYOYO 沙箱。

> 默认镜像是预构建的 `ghcr.io/xcanwin/manyoyo`，本地没有时会自动拉取，不需要执行 `manyoyo build`；只有自定义镜像时才需要构建。

## 1. 安装 manyoyo

```bash
npm install -g @xcanwin/manyoyo
manyoyo -v
```

## 2. 安装 Podman / Docker

容器运行时安装或切换可参考：
- [安装 Podman（推荐）](../advanced/installation.md#安装-podman推荐)
- [安装 Docker（可选）](../advanced/installation.md#安装-docker可选)

## 3. 立即迁移配置

```bash
manyoyo init all
```

## 4. 直接启动 Agent

```bash
manyoyo run -r claude
manyoyo run -r codex
manyoyo run -r gemini
manyoyo run -r opencode
```

如果只想先验证帮助与配置链路，可先执行：

```bash
manyoyo --help
manyoyo run --help
manyoyo config show -r claude
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
