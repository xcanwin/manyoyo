---
title: 第一次使用 | MANYOYO
description: 安装后的首次配置：网页向导四步选 Agent、填 Key、选工作目录、设密码；无图形界面的机器用命令行向导 manyoyo setup 并通过 ssh -L 访问。
---

# 第一次使用

安装完成后的首次配置，两种方式二选一，看你的机器有没有图形界面。

## 有图形界面：网页向导

安装完成后浏览器自动打开并已登录，按向导四步走：

1. 选择 Agent（Claude Code / Codex / Gemini / OpenCode）
2. 填 API Key（或兼容服务的 Base URL），可以点「测试连接」
3. 选择工作目录（Agent 只能看到这里）
4. 设置登录密码（首次必填，至少 8 位，用户名是 `admin`），然后保存，直接进入对话

顶部进度条显示容器环境与镜像的准备进度，准备好之前可以先填前三步。

## 无图形界面（SSH、服务器）：命令行向导

SSH 登录或没有图形界面的 Linux 不会打开浏览器，改用命令行向导：

```bash
manyoyo setup
```

依次选 Agent、填 Key、选工作目录、设登录密码，可选 apt / npm / pip 软件源（输入 Key 和密码时不回显）。需要交互式终端。

配置完成后服务在 `127.0.0.1:<端口>` 后台运行。在**你自己的电脑**上转发端口，再用浏览器访问：

```bash
ssh -L <端口>:127.0.0.1:<端口> <用户名>@<服务器地址>
# 然后浏览器打开 http://127.0.0.1:<端口>，用户名 admin，密码是 manyoyo setup 里设的
```

判断不对时强制指定：`manyoyo --headless`（无图形界面）或 `manyoyo --gui`（有图形界面），也可以设环境变量 `MANYOYO_HEADLESS=1` 或 `0`。更多远程访问方式见[网页服务认证](../advanced/web-server-auth.md)。

## 下一步

- [日常使用](./daily.md)
- [命令行运行 Agent](./basic-usage.md)
- [迁移已有 Agent 配置](./migrate.md)
