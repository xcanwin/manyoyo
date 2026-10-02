---
title: 日常使用 | MANYOYO
description: MANYOYO 的日常操作：启动与停止服务、升级与回滚、卸载、管理私有 Podman，以及隐私说明。
---

# 日常使用

启动、停止、升级、回滚、卸载，都是一条命令。新开一个终端（或在当前终端执行 `exec "$SHELL" -l`）后使用。

## 启动

```bash
manyoyo
```

启动（或复用）本机的网页服务并打开浏览器，已自动登录。服务在后台一直运行。

## 停止

```bash
manyoyo serve 127.0.0.1:<端口> --stop     # 端口见启动时打印的地址
```

## 升级与回滚

```bash
manyoyo update              # 升级到最新版本
manyoyo update --rollback   # 回到上一版本
```

升级只下载变化的部分，几十 MB。

## 卸载

```bash
manyoyo uninstall
```

只移除程序本身；配置、会话历史、日志和工作目录逐项询问，默认保留。`--yes` 只确认卸载程序，不会删除任何用户数据。复用你自己的 Docker / Podman 时，只会询问是否删除 manyoyo 的容器和镜像，不会动运行时本身。

## 管理私有 Podman

macOS 安装包使用 MANYOYO 自带的私有 Podman，系统里的 `podman` 命令管不到它：

```bash
manyoyo podman ps -a                 # 执行一次
eval "$(manyoyo podman env)"         # 当前终端起，直接用 podman ps -a、podman logs ...
```

函数只在当前终端有效，关闭终端即失效。

## 隐私

安装器和版本检查**不收集、不上传任何信息**：`serve` 每天最多向 GitHub Release 查询一次新版本，请求只带固定的 `User-Agent`，不附带任何本机信息，可在全局配置里设置 `"updateCheck": false` 关闭。Key 只保存在你本机的 `~/.manyoyo/manyoyo.json`。

## 下一步

- [命令速查](../reference/cli-options.md)
- [命令行运行 Agent](./basic-usage.md)
- [常见问题](../troubleshooting/README.md)
