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
| 从本机 Agent 初始化配置 | `manyoyo --init-config all` |
| 列出容器 | `manyoyo -l` |
| 创建容器并启动 Claude Code | `manyoyo -n test --ef /abs/path/.env -y c` |
| 进入 shell | `manyoyo -n test -x /bin/bash` |
| 执行自定义命令 | `manyoyo -n test -x echo "hello world"` |
| 删除容器 | `manyoyo -n test --crm` |
| 清理悬空镜像 | `manyoyo --irm` |

## 常见参数速查

| 参数 | 说明 |
| --- | --- |
| `-n, --name` | 容器名称 |
| `-y` | 快速进入 Agent 模式 |
| `-x` | 在容器内执行命令 |
| `-e` | 直接传入环境变量 |
| `--ef` | 读取环境变量文件（仅支持绝对路径） |
| `-r` | 读取 `~/.manyoyo/manyoyo.json` 的 `runs.<name>` |
| `--ib` | 构建沙箱镜像 |
| `--iv` | 指定镜像版本标签（格式：`x.y.z-后缀`，如 `1.7.4-common`） |
| `--iba` | 传递镜像构建参数（如 `TOOL=common`） |
| `--init-config [agents]` | 从本机 Agent 配置初始化 `~/.manyoyo` |
| `--server [port]` | 启动网页交互服务（默认 `3000`） |
| `--server-user <username>` | 网页服务登录用户名 |
| `--server-pass <password>` | 网页服务登录密码 |
| `-q` | 静默输出（可多次使用） |

## 配置文件规则

- `manyoyo -r claude` 会读取 `~/.manyoyo/manyoyo.json` 的 `runs.claude`
- `manyoyo --ef /abs/path/my.env` 仅支持绝对路径环境文件
- 任何命令都会优先加载全局配置 `~/.manyoyo/manyoyo.json`

完整参数请以 `README.md` 为准。
