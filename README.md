<p align="center">
  <img src="./assets/manyoyo-logo-09-cyberpunk-terminal.svg" alt="MANYOYO logo" width="560" />
</p>

# <p align="center"><a href="https://github.com/xcanwin/manyoyo">MANYOYO（慢悠悠）</a></p>
<p align="center"><b>Open-source sandbox for AI coding agents: run Claude Code, Codex, Gemini CLI and OpenCode in YOLO mode safely inside Docker/Podman</b></p>
<p align="center">开源 AI 编程智能体安全沙箱：让 Claude Code / Codex / Gemini CLI / OpenCode 在 Docker/Podman 容器里放心跑 YOLO 模式，AI 随便折腾，伤不到你的电脑。</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@xcanwin/manyoyo"><img alt="npm" src="https://img.shields.io/npm/v/@xcanwin/manyoyo?style=flat-square" /></a>
  <a href="https://github.com/xcanwin/manyoyo/actions/workflows/npm-publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/xcanwin/manyoyo/npm-publish.yml?style=flat-square" /></a>
  <a href="https://github.com/xcanwin/manyoyo/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" /></a>
</p>

<p align="center">
  <a href="#中文"><b>中文</b></a> |
  <a href="#english">English</a>
</p>

---

<a name="中文"></a>

## 安装（二选一即可）

### 1. macOS / Linux（推荐）

```bash
curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | sh
```

装完按屏幕提示完成配置。macOS 不需要预装任何东西。Linux：缺少容器环境时，安装器会说明原因，征得你同意后用 sudo 自动安装。

下载慢或打不开 GitHub？先在终端设置代理（`export https_proxy=http://127.0.0.1:7890`，macOS 的系统代理会自动识别），或见[安装文档](https://xcanwin.github.io/manyoyo/guide/quick-start)里的手动下载办法。

### 2. 已有 Node.js 和 Docker/Podman

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

默认镜像 `ghcr.io/xcanwin/manyoyo` 首次使用时自动拉取；需要自定义镜像时再执行 `manyoyo build --iv 2.2.0-common`。更多命令见[命令速查](https://xcanwin.github.io/manyoyo/reference/cli-options)。

## 它能做什么

- **多 Agent**：`claude`、`codex`、`gemini`、`opencode` 一个入口
- **容器隔离**：基于 Docker / Podman，Agent 只能看到你给它的工作目录
- **网页界面**：浏览器里对话、看文件、开终端，手机也能用
- **统一配置**：运行配置、环境变量、挂载与镜像参数集中在 `~/.manyoyo/manyoyo.json`
- **一条命令**安装、升级、卸载

## 安全须知

MANYOYO 降低风险，但不是“绝对安全”：主要隔离手段是容器而不是虚拟机；`YOLO / SOLO` 仍可能执行危险命令；`sock` 模式会暴露宿主机 Docker socket；对外监听必须设强密码。详见[安全须知](https://xcanwin.github.io/manyoyo/guide/security)。

## 文档

<https://xcanwin.github.io/manyoyo/>：[安装](https://xcanwin.github.io/manyoyo/guide/quick-start)、[命令速查](https://xcanwin.github.io/manyoyo/reference/cli-options)、[配置](https://xcanwin.github.io/manyoyo/configuration/)、[故障排查](https://xcanwin.github.io/manyoyo/troubleshooting/)

---

<a name="english"></a>

## Install (pick one)

### 1. macOS / Linux (recommended)

```bash
curl -fsSL https://xcanwin.github.io/manyoyo/install.sh | sh
```

When it finishes, follow the on-screen prompts to finish setup. macOS needs nothing installed first. Linux: if the container runtime is missing, the installer explains why and, with your consent, installs it with sudo.

Slow or cannot reach GitHub? Set a proxy in the terminal first (`export https_proxy=http://127.0.0.1:7890`; the macOS system proxy is detected automatically), or see the manual download steps in the [install guide](https://xcanwin.github.io/manyoyo/en/guide/quick-start).

### 2. Already have Node.js and Docker/Podman

```bash
npm install -g @xcanwin/manyoyo
manyoyo
```

## Daily use

```bash
manyoyo            # open the web UI
manyoyo update     # upgrade
manyoyo uninstall  # uninstall (config and data are kept by default)
```

## Command line (optional)

```bash
manyoyo init all   # import the agent configs already on this machine
manyoyo run -y c   # start Claude Code in YOLO mode inside the sandbox
```

The default image `ghcr.io/xcanwin/manyoyo` is pulled automatically on first use; run `manyoyo build --iv 2.2.0-common` only if you need a custom image. More commands: [CLI reference](https://xcanwin.github.io/manyoyo/en/reference/cli-options).

## What it does

- **Multiple agents**: `claude`, `codex`, `gemini`, `opencode` behind one entry point
- **Container isolation**: Docker / Podman; the agent only sees the work directory you give it
- **Web UI**: chat, browse files and open a terminal in the browser, phone friendly
- **One config**: run profiles, environment variables, mounts and image arguments in `~/.manyoyo/manyoyo.json`
- **One command** to install, upgrade and uninstall

## Security notes

MANYOYO reduces risk but is not "absolutely safe": the main isolation is a container, not a virtual machine; `YOLO / SOLO` can still run dangerous commands; `sock` mode exposes the host Docker socket; set a strong password before listening on a public address. See [Security notes](https://xcanwin.github.io/manyoyo/en/guide/security).

## Docs

<https://xcanwin.github.io/manyoyo/en/>: [Install](https://xcanwin.github.io/manyoyo/en/guide/quick-start), [CLI reference](https://xcanwin.github.io/manyoyo/en/reference/cli-options), [Configuration](https://xcanwin.github.io/manyoyo/en/configuration/), [FAQ](https://xcanwin.github.io/manyoyo/en/troubleshooting/)
