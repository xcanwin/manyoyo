---
title: 命令参考 | MANYOYO
description: MANYOYO 命令行参数与常用命令速查，覆盖容器管理、环境变量注入、YOLO/SOLO 模式、调试与清理操作。
---

# 命令参考

## 常用命令

| 场景 | 命令 |
| --- | --- |
| 查看帮助 | `manyoyo -h` |
| 查看版本 | `manyoyo -V` |
| 从本机 Agent 初始化配置 | `manyoyo init all` |
| 列出容器 | `manyoyo ls` |
| 创建容器并启动 Claude Code | `manyoyo run -n test --ef /abs/path/.env -y c` |
| 进入 shell | `manyoyo run -n test -x /bin/bash` |
| 执行自定义命令 | `manyoyo run -n test -x echo "hello world"` |
| 删除容器 | `manyoyo rm test` |
| 清理悬空镜像 | `manyoyo prune` |

## 常见参数速查

| 参数 | 说明 |
| --- | --- |
| `run -n, --cont-name` | 容器名称 |
| `run -y` | 快速进入 Agent 模式 |
| `run -x` | 在容器内执行命令 |
| `run -e` | 直接传入环境变量 |
| `run -p` | 直接传入端口映射（等价 `--publish`） |
| `run --ef` | 读取环境变量文件（仅支持绝对路径） |
| `run -r` | 读取 `~/.manyoyo/manyoyo.json` 的 `runs.<name>` |
| `build` | 构建沙箱镜像 |
| `run/build --iv` | 指定镜像版本标签（格式：`x.y.z-后缀`，如 `1.8.0-common`） |
| `build --iba` | 传递镜像构建参数（如 `TOOL=common`） |
| `update` | 更新 MANYOYO；若检测为本地 file 安装（`npm install -g .`/`npm link`）则跳过，否则执行 `npm update -g @xcanwin/manyoyo` |
| `init [agents]` | 从本机 Agent 配置初始化 `~/.manyoyo` |
| `serve [port]` | 启动网页交互服务（默认 `127.0.0.1:3000`，支持 `<port>` 或 `<host:port>`） |
| `-u <username>` | 网页服务登录用户名 |
| `-P <password>` | 网页服务登录密码（未设置时自动生成随机密码） |
| `-q` | 静默输出（可多次使用） |

## 配置文件规则

- `manyoyo run -r claude` 会读取 `~/.manyoyo/manyoyo.json` 的 `runs.claude`
- `manyoyo run --ef /abs/path/my.env` 仅支持绝对路径环境文件
- 任何命令都会优先加载全局配置 `~/.manyoyo/manyoyo.json`

## 网页服务认证说明

- `serve` 支持 `3000` 或 `0.0.0.0:3000` 两种写法
- 网页认证参数优先级：命令行参数 > `runs.<name>` > 全局配置 > 环境变量 > 默认值
- 环境变量键名：`MANYOYO_SERVER_USER`、`MANYOYO_SERVER_PASS`
- 建议参考 [网页服务认证与安全实践](../advanced/web-server-auth.md) 了解登录与安全基线

完整参数请以 `README.md` 为准。
