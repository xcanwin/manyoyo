---
title: 介绍 | MANYOYO
description: MANYOYO 是什么、能做什么：让 Claude Code、Codex、Gemini、OpenCode 在容器里放心跑 YOLO 模式，AI 随便折腾，伤不到你的电脑。
---

# 介绍

**MANYOYO（慢悠悠）** 让 Claude Code / Codex / Gemini / OpenCode 在容器里放心跑 YOLO 模式：AI 随便折腾，伤不到你的电脑。

## 为什么需要它

AI Agent CLI 要读写你的代码、执行 shell 命令、装依赖。免确认（YOLO / SOLO）模式效率最高，但直接在宿主机上跑，风险边界不清晰。MANYOYO 把它们收进一个容器沙箱：Agent 只能看到你给它的工作目录，容器出问题随时删掉重来。

## 能做什么

- **多 Agent**：`claude`、`codex`、`gemini`、`opencode` 一个入口，随时切换。
- **容器隔离**：基于 Docker / Podman，降低宿主机暴露面。
- **网页界面**：浏览器里对话、看文件、开终端，手机也能用。
- **统一配置**：运行配置、环境变量、挂载与镜像参数集中在 `~/.manyoyo/manyoyo.json`。
- **一条命令**安装、升级、卸载。

| 对比项 | 裸跑 Agent CLI | MANYOYO |
| --- | --- | --- |
| 宿主机暴露面 | 高 | 更低 |
| 运行边界 | 分散 | 集中到容器与配置 |
| 环境复现 | 弱 | 强（镜像 + 配置） |
| 高风险模式说明 | 通常依赖工具自身 | 明确提示 YOLO / SOLO / sock 风险 |

## 安全边界

MANYOYO 降低风险，但不是“绝对安全”，见[安全须知](./security.md)。

## 下一步

- [安装](./quick-start.md)
- [第一次使用](./first-run.md)
