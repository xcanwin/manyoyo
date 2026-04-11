<p align="center">
  <img src="./assets/manyoyo-logo-09-cyberpunk-terminal.svg" alt="MANYOYO logo" width="560" />
</p>

# <p align="center"><a href="https://github.com/xcanwin/manyoyo">MANYOYO（慢悠悠）</a></p>
<p align="center">面向 AI Agent CLI 的 Docker / Podman 安全沙箱。</p>
<p align="center">用于隔离 Claude Code、Codex、Gemini、OpenCode 等命令行智能体，降低宿主机风险，并保持可复现的运行环境。</p>
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
  文档：<a href="https://xcanwin.github.io/manyoyo/">https://xcanwin.github.io/manyoyo/</a>
</p>

---

## 当前分支说明

当前分支是 `Flutter`，用于研究 `macOS / Windows / iOS / Android` 应用形态：

- Flutter 端当前定位为 MANYOYO Web 的宿主壳
- Web 主线仍在 `main` 分支
- 平台工程统一放在 `apps/flutter/`

最简运行入口：

```bash
cd apps/flutter
flutter pub get
flutter run -d macos
```

其他平台可直接替换目标设备：

```bash
flutter run -d windows
flutter run -d ios
flutter run -d android
```

分支内更完整说明见 [apps/flutter/README.md](apps/flutter/README.md)。

## 为什么是 MANYOYO

AI Agent CLI 往往需要：

- 访问代码仓库
- 执行 shell 命令
- 读写文件
- 安装依赖或调用容器能力

直接在宿主机上裸跑这些工具，风险边界通常不清晰。**MANYOYO** 的目标不是替代容器平台，而是把常见 Agent CLI 的运行方式收敛到一个更清晰、可复现、可审计的沙箱入口。

你可以把它理解为：

- 面向 Agent CLI 的运行包装层
- 面向团队协作的配置与镜像约定
- 面向高风险模式的显式边界说明

## 核心能力

- **多 Agent 支持**：支持 `claude`、`gemini`、`codex`、`opencode`
- **容器隔离**：基于 Docker / Podman 运行，降低宿主机暴露面
- **YOLO / SOLO 工作流**：适配跳过权限确认的高效率模式
- **统一配置入口**：集中管理 `runs.<name>`、环境变量、挂载与镜像参数
- **命令可预览**：支持查看配置合并结果与最终命令拼装
- **会话与 Web 模式**：支持容器会话管理与网页访问入口
- **镜像可定制**：支持 common / full / 自定义工具集镜像

## 快速开始

```bash
npm install -g @xcanwin/manyoyo
podman pull ubuntu:24.04                        # 仅 Podman 需要
manyoyo build --iv 1.9.0-common
manyoyo init all
manyoyo run -r claude
manyoyo serve 127.0.0.1:3000 -U admin -P 123456 # Web UI 模式
```

系统要求：

- Node.js >= 22
- Podman（推荐）或 Docker

注意：

- `YOLO / SOLO` 会跳过权限确认，只适合在可控环境中使用
- `sock` 模式会暴露宿主机 Docker socket，不属于强隔离

## 适合什么场景

- 在容器中运行 **Claude Code YOLO / SOLO**
- 为 **Codex CLI** 提供独立于宿主机的运行边界
- 隔离运行 **Gemini CLI / OpenCode** 的代码任务
- 用统一镜像和配置管理团队 Agent 环境
- 在调试和自动化任务中快速切换 Agent 与 `/bin/bash`

## 裸跑 vs MANYOYO

| 对比项 | 裸跑 Agent CLI | MANYOYO |
| --- | --- | --- |
| 宿主机暴露面 | 高 | 更低 |
| 运行边界 | 分散 | 集中到容器与配置 |
| 环境复现 | 弱 | 强（镜像 + 配置） |
| 高风险模式说明 | 通常依赖工具自身 | 明确提示 YOLO / SOLO / sock 风险 |
| 团队统一性 | 弱 | 更强 |

## 安全边界

MANYOYO 可以降低风险，但不是“绝对安全”：

- 它的主要隔离手段是容器，不是虚拟机
- `YOLO / SOLO` 仍然可能执行危险命令
- `sock` 模式本质上会把宿主机容器控制权暴露给容器
- 自定义挂载、环境变量和网络访问会直接影响实际安全边界

相关文档：

- [AI 智能体说明](https://xcanwin.github.io/manyoyo/zh/reference/agents)
- [容器模式说明](https://xcanwin.github.io/manyoyo/zh/reference/container-modes)
- [网页认证与安全](https://xcanwin.github.io/manyoyo/zh/advanced/web-server-auth)

## 常用命令

```bash
# 初始化与迁移
manyoyo init all

# 启动常见 Agent
manyoyo run -y c
manyoyo run -y gm
manyoyo run -y cx
manyoyo run -y oc

# 更新
manyoyo update

# 容器与调试
manyoyo ps
manyoyo images
manyoyo run -n my-dev -x /bin/bash
manyoyo rm my-dev

# Web UI 模式
manyoyo serve 127.0.0.1:3000
manyoyo serve 127.0.0.1:3000 -U admin -P 123456
manyoyo serve 127.0.0.1:3000 -U admin -P 123456 -d
manyoyo serve 127.0.0.1:3000 -d   # 未设置密码时会打印本次随机密码
manyoyo serve 127.0.0.1:3000 --stop   # 停止指定后台服务
manyoyo serve 127.0.0.1:3000 -U admin -P 123456 -d --restart   # 重启指定后台服务

# 查看配置与命令拼装
manyoyo config show
manyoyo config command
```

## 镜像构建

```bash
# common 版本
manyoyo build --iv 1.9.0-common

# full 版本
manyoyo build --iv 1.9.0-full

# 自定义工具集
manyoyo build --iba TOOL=go,codex,java,gemini
```

说明：

- 首次构建会把依赖缓存到 `docker/cache/`
- 在缓存有效期内重复构建，通常会更快
- `imageVersion` 格式必须为 `x.y.z-后缀`

## 配置模型

MANYOYO 的配置重点不是“多”，而是“可预测”：

- 标量值按 `命令行参数 > runs.<name> > 全局配置 > 默认值` 覆盖
- 数组值按 `全局配置 -> runs.<name> -> 命令行参数` 追加合并
- `env` 使用 map 合并，按 key 覆盖

相关文档：

- [配置系统概览](https://xcanwin.github.io/manyoyo/zh/configuration/)
- [配置文件详解](https://xcanwin.github.io/manyoyo/zh/configuration/config-files)
- [环境变量详解](https://xcanwin.github.io/manyoyo/zh/configuration/environment)

## 文档入口

中文文档：

- [快速开始](https://xcanwin.github.io/manyoyo/zh/guide/quick-start)
- [安装详解](https://xcanwin.github.io/manyoyo/zh/guide/installation)
- [CLI 选项](https://xcanwin.github.io/manyoyo/zh/reference/cli-options)
- [故障排查](https://xcanwin.github.io/manyoyo/zh/troubleshooting/)

English Documentation:

- [Quick Start](https://xcanwin.github.io/manyoyo/en/guide/quick-start)
- [Installation](https://xcanwin.github.io/manyoyo/en/guide/installation)
- [CLI Options](https://xcanwin.github.io/manyoyo/en/reference/cli-options)
- [Troubleshooting](https://xcanwin.github.io/manyoyo/en/troubleshooting/)

## 安装与卸载

安装：

```bash
npm install -g @xcanwin/manyoyo
```

卸载：

```bash
npm uninstall -g @xcanwin/manyoyo
rm -rf ~/.manyoyo/   # 可选
```

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request。

- Issues: <https://github.com/xcanwin/manyoyo/issues>
- Repository: <https://github.com/xcanwin/manyoyo>
