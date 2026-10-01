---
title: 快速开始 | MANYOYO
description: 下载离线包，一条命令装好 MANYOYO 与容器环境，浏览器自动打开向导，几分钟内开始使用 AI Agent 沙箱。
---

# 快速开始

目标：**下载离线包 → 一条命令 → 浏览器**。不需要先装 Node.js、Docker 或 Podman，也不需要自己构建镜像。

> 目前离线包支持 macOS（Apple 芯片与 Intel）。Linux、Windows 以及已经装好 npm / Docker / Podman 的用户，见[安装详解](./installation.md)和[迁移已有 Agent 配置](./migrate.md)。

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
