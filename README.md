<p align="center">
  <img src="./assets/manyoyo-logo-09-cyberpunk-terminal.svg" alt="MANYOYO logo" width="560" />
</p>

# <p align="center"><a href="https://github.com/xcanwin/manyoyo">MANYOYO（慢悠悠）</a></p>
<p align="center"><b>MANYOYO – open-source sandbox for running AI coding agents (Claude Code / Codex / Gemini) safely in Docker/Podman</b></p>
<p align="center">开源 AI Agent 沙箱：让 Claude Code / Codex / Gemini / OpenCode 在容器里放心跑 YOLO 模式，AI 随便折腾，伤不到你的电脑。</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@xcanwin/manyoyo"><img alt="npm" src="https://img.shields.io/npm/v/@xcanwin/manyoyo?style=flat-square" /></a>
  <a href="https://github.com/xcanwin/manyoyo/actions/workflows/npm-publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/xcanwin/manyoyo/npm-publish.yml?style=flat-square" /></a>
  <a href="https://github.com/xcanwin/manyoyo/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

<p align="center">
  <a href="README.md"><b>中文</b></a> |
  <a href="README.en.md">English</a>
</p>
<p align="center">
  文档：<a href="https://xcanwin.github.io/manyoyo/">https://xcanwin.github.io/manyoyo/</a>
</p>

---

## 安装

### macOS / Linux（推荐）

```bash
curl -fsSL https://github.com/xcanwin/manyoyo/raw/main/scripts/install.sh | sh
```

装完按屏幕提示完成配置。macOS 不需要预装任何东西。Linux：缺少容器环境时，安装器会说明原因，征得你同意后用 sudo 自动安装。

### 已有 Node.js 和 Docker/Podman

```bash
npm install -g @xcanwin/manyoyo
manyoyo
```

## 日常使用

```bash
manyoyo            # 打开网页界面
manyoyo update     # 升级
manyoyo uninstall  # 卸载（配置和数据默认保留）
```

## 命令行用法（可选）

```bash
manyoyo init all   # 把本机已有的 Agent 配置搬进来
manyoyo run -y c   # 在沙箱里以 YOLO 模式启动 Claude Code
```

默认镜像 `ghcr.io/xcanwin/manyoyo` 首次使用时自动拉取；需要自定义镜像时再执行 `manyoyo build --iv 2.1.0-common`。更多命令见[命令速查](https://xcanwin.github.io/manyoyo/reference/cli-options)。

## 它能做什么

- **多 Agent**：`claude`、`codex`、`gemini`、`opencode` 一个入口
- **容器隔离**：基于 Docker / Podman，Agent 只能看到你给它的工作目录
- **网页界面**：浏览器里对话、看文件、开终端，手机也能用
- **统一配置**：运行配置、环境变量、挂载与镜像参数集中在 `~/.manyoyo/manyoyo.json`
- **一条命令**安装、升级、卸载

| 对比项 | 裸跑 Agent CLI | MANYOYO |
| --- | --- | --- |
| 宿主机暴露面 | 高 | 更低 |
| 运行边界 | 分散 | 集中到容器与配置 |
| 环境复现 | 弱 | 强（镜像 + 配置） |
| 高风险模式说明 | 通常依赖工具自身 | 明确提示 YOLO / SOLO / sock 风险 |

## 安全须知

MANYOYO 降低风险，但不是“绝对安全”：主要隔离手段是容器而不是虚拟机；`YOLO / SOLO` 仍可能执行危险命令；`sock` 模式会暴露宿主机 Docker socket；对外监听必须设强密码。详见[安全须知](https://xcanwin.github.io/manyoyo/guide/security)。

## 文档

- 中文：<https://xcanwin.github.io/manyoyo/>（[安装](https://xcanwin.github.io/manyoyo/guide/quick-start)、[命令速查](https://xcanwin.github.io/manyoyo/reference/cli-options)、[配置](https://xcanwin.github.io/manyoyo/configuration/)、[故障排查](https://xcanwin.github.io/manyoyo/troubleshooting/)）
- English: <https://xcanwin.github.io/manyoyo/en/>

## 许可证

MIT

## 贡献

欢迎提交 [Issue](https://github.com/xcanwin/manyoyo/issues) 和 Pull Request。
