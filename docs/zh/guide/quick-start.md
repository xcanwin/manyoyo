---
title: 快速开始 | MANYOYO
description: 下载离线包，一条命令装好 MANYOYO 与容器环境，浏览器自动打开向导，几分钟内开始使用 AI Agent 沙箱。
---

# 快速开始

目标：**下载离线包 → 一条命令 → 浏览器**。不需要先装 Node.js、Docker 或 Podman，也不需要自己构建镜像。

> 离线包支持 macOS（Apple 芯片与 Intel，本页下面的步骤）和 Linux（Debian / Ubuntu，见[Linux 安装](#linux-debian-ubuntu)）。Windows 以及已经装好 npm / Docker / Podman 的用户，见[安装详解](./installation.md)和[迁移已有 Agent 配置](./migrate.md)。

## 1. 下载

打开 [GitHub Releases](https://github.com/xcanwin/manyoyo/releases/latest)，按你的 Mac 选一个 `.run` 文件：

| 你的 Mac | 在终端执行 `uname -m` 的结果 | 完整包（推荐） | 精简包 |
|---|---|---|---|
| Apple 芯片（M 系列） | `arm64` | `manyoyo-<版本>-macos-arm64.run` | `manyoyo-<版本>-macos-arm64-lite.run` |
| Intel | `x86_64` | `manyoyo-<版本>-macos-x64.run` | `manyoyo-<版本>-macos-x64-lite.run` |

- **完整包**约 1.8GB：自带 Node.js、容器运行环境（Podman 与虚拟机）和 MANYOYO 镜像，纯净的 Mac 直接可用。
- **精简包**约 0.8GB：只带 Node.js、MANYOYO 和镜像，要求你已经装好并启动了 Docker Desktop / OrbStack / Podman。
- 同时下载同一页上对应架构的 `SHA256SUMS-macos-<arch>`，用来校验文件完整。
- 文件如果被拆成 `.run.001`、`.run.002` 等分卷，把它们全部下载到同一个目录，后面的 `.run` 文件名换成 `.run.001`（例如 `sh manyoyo-*-macos-arm64.run.001`）即可，安装包会自己按序拼接并校验，缺卷或大小不对时会提示是哪一卷。备选：`cat manyoyo-*.run.* > manyoyo-合并.run` 手动合并后当普通 `.run` 使用。

**国内下载提示**：文件较大，建议使用支持断点续传的方式，下载中断后可以接着下：

```bash
curl -L -C - -O <Release 页面里该文件的下载地址>
```

也可以使用 aria2、迅雷等下载工具。

## 2. 校验（建议）

```bash
shasum -a 256 -c SHA256SUMS-macos-arm64        # Intel 用 SHA256SUMS-macos-x64
sh manyoyo-*-macos-arm64.run --check           # 只校验安装包自身，不改动系统
```

## 3. 一条命令安装

```bash
sh manyoyo-*-macos-arm64.run
```

安装器会：校验 → 解压到 `~/.manyoyo` → 创建并启动容器运行环境 → 后台导入镜像 → 自动打开浏览器。整个过程不需要管理员密码，也不会改动系统目录，只会在你的 shell 配置里加一小段带标记的 `PATH` 设置。完整包大约 1.5 到 2 分钟。

脚本很短，想先看再执行：`sed -n '1,/^__MANYOYO_PAYLOAD_BELOW__$/p' manyoyo-*.run`。

## 4. 浏览器里的向导

安装完成后浏览器会自动打开并已登录，按向导四步走：

1. 选择 Agent（Claude Code / Codex / Gemini / OpenCode）
2. 填 API Key（或兼容服务的 Base URL），可以点「测试连接」
3. 选择工作目录（Agent 只能看到这里）
4. 设置登录密码（首次必填，至少 8 位，用户名是 `admin`；本机执行 `manyoyo` 仍会自动登录，密码用于登出后或其他浏览器 / 设备），然后保存，直接进入对话

顶部进度条显示容器环境与镜像的准备进度，准备好之前可以先填前三步。

## 5. 之后怎么用

新开一个终端（或在当前终端执行 `exec "$SHELL" -l`），然后：

```bash
manyoyo                 # 启动（或复用）本机服务并打开浏览器，已自动登录
manyoyo update          # 升级：只下载变化的部分，可用 manyoyo update --rollback 回滚
manyoyo uninstall       # 卸载：配置、会话历史和工作目录逐项询问，默认保留
```

`manyoyo` 启动的服务在后台一直运行，关闭它：

```bash
manyoyo serve 127.0.0.1:<端口> --stop     # 端口见启动时打印的地址
```

安装完成后，下载的 `.run` 文件可以删除。

## 管理私有 Podman

离线完整包使用 MANYOYO 自带的私有 Podman，系统里的 `podman` 命令管不到它。

```bash
manyoyo podman ps -a                 # 执行一次
eval "$(manyoyo podman env)"          # 当前终端起，直接用 podman ps -a、podman logs ...
```

函数只在当前终端有效，关闭终端即失效。

## Linux（Debian / Ubuntu）

Linux 包只有一种，**不自带容器运行环境**：用你系统里的 Podman 或 Docker（安装器不会替你执行 `sudo`，也不会装系统软件）。要求 Ubuntu 22.04 / Debian 12 或更高（glibc 2.35 起）。

```bash
uname -m                                           # x86_64 选 x64，aarch64 选 arm64
sha256sum -c SHA256SUMS-linux-x64                  # 校验（arm64 用 SHA256SUMS-linux-arm64）
sh manyoyo-<版本>-linux-x64.run                    # 安装
```

1. **先装好容器运行时**（没有的话安装器会告诉你，装好后重新运行安装包即可续上）：`sudo apt update && sudo apt install -y podman`，或按 Docker 官方文档安装 docker。常见问题安装器会直接提示：docker 需要把用户加入 `docker` 组，rootless podman 需要 `uidmap` 与 `/etc/subuid`、`/etc/subgid`。
2. **有头与无头自动判断**：
   - **有头**（本机有图形界面、不是 SSH 会话）：和 macOS 一样，自动启动服务并打开浏览器，在网页向导里完成配置。
   - **无头**（SSH 登录、没有 `DISPLAY` / `WAYLAND_DISPLAY`）：不打开浏览器，用命令行向导 `manyoyo setup` 配置：选 Agent、填 Key、选工作目录、设登录密码，可选 apt / npm / pip 软件源（输入 Key 和密码时不回显）。
   - 判断不对时强制指定：安装包与 `manyoyo` 都支持 `--headless` / `--gui`，也可以设环境变量 `MANYOYO_HEADLESS=1`（无头）或 `0`（有头）。
3. **无头环境怎么用网页**：配置完成后服务在 `127.0.0.1:<端口>` 后台运行，在你自己的电脑上转发端口再访问：

   ```bash
   ssh -L <端口>:127.0.0.1:<端口> <用户名>@<服务器地址>
   # 然后浏览器打开 http://127.0.0.1:<端口>，用户名 admin，密码是 manyoyo setup 里设的
   ```

   关闭服务：`manyoyo serve 127.0.0.1:<端口> --stop`。
4. 升级、回滚、卸载与 macOS 相同：`manyoyo update`、`manyoyo update --rollback`、`manyoyo uninstall`（卸载只询问是否删除 manyoyo 的容器和镜像，不会动你的 Podman / Docker）。
5. 下载提示：同 macOS，建议用 `curl -L -C - -O <下载地址>` 断点续传。

## 隐私

安装器和版本检查**不收集、不上传任何信息**：安装全程不联网；`serve` 每天最多向 GitHub Release 查询一次新版本，请求只带固定的 `User-Agent`，不附带任何本机信息，可在全局配置里设置 `"updateCheck": false` 关闭。Key 只保存在你本机的 `~/.manyoyo/manyoyo.json`。

## 遇到问题

- 安装日志在 `~/.manyoyo/logs/install/`，失败后修好问题直接重新运行安装包即可续上。
- 运行 `manyoyo doctor` 检查环境，`manyoyo doctor --fix` 自动修复可修复的项。
- 更多见[故障排查](../troubleshooting/README.md)。

## 下一步

- [基础用法](./basic-usage.md)
- [迁移已有 Agent 配置](./migrate.md)
- [配置系统](../configuration/README.md)
- [命令参考](../reference/cli-options.md)
- [故障排查](../troubleshooting/README.md)
