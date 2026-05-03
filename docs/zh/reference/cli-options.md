---
title: 命令参考 | MANYOYO
description: 基于最新 --help 的 MANYOYO CLI 结构、常用参数与高频命令速查。
---

# 命令参考

本文以当前 `manyoyo --help` 与各子命令 `--help` 为准，优先说明命令分层、参数归属和高频用法。

## 主命令结构

| 命令 | 用途 |
| --- | --- |
| `manyoyo run` | 启动或连接容器，并在容器内执行命令 |
| `manyoyo build` | 构建沙箱镜像 |
| `manyoyo rm <name>` | 删除指定容器 |
| `manyoyo ps` | 列举容器 |
| `manyoyo images` | 列举镜像 |
| `manyoyo serve [listen]` | 启动网页交互服务，默认 `127.0.0.1:3000` |
| `manyoyo playwright` | 管理 Playwright 插件服务 |
| `manyoyo plugin` | 插件命名空间；目前常见用法是 `plugin playwright ...` |
| `manyoyo config show` | 显示最终生效配置 |
| `manyoyo config command` | 显示将执行的容器命令 |
| `manyoyo init [agents]` | 初始化本机 Agent 配置到 `~/.manyoyo` |
| `manyoyo update` | 更新 MANYOYO；本地 file 安装场景会跳过 |
| `manyoyo install <name>` | 安装 manyoyo 命令（docker-cli-plugin） |
| `manyoyo prune` | 清理悬空镜像和 `<none>` 镜像 |

## 参数归属

### `run` / `config show` / `config command`

这三组命令共享同一套核心运行参数，常用项如下：

| 参数 | 说明 |
| --- | --- |
| `-r, --run <name>` | 读取 `~/.manyoyo/manyoyo.json` 的 `runs.<name>` |
| `--hp, --host-path <path>` | 宿主机工作目录 |
| `-n, --cont-name <name>` | 容器名称 |
| `--cp, --cont-path <path>` | 容器工作目录 |
| `-m, --cont-mode <mode>` | 容器模式：`common` / `dind` / `sock` |
| `--in, --image-name <name>` | 镜像名称 |
| `--iv, --image-ver <version>` | 镜像版本，格式必须为 `x.y.z-后缀`，如 `1.9.0-common` |
| `-e, --env <env>` | 追加环境变量，可多次传入 |
| `--ef, --env-file <file>` | 追加环境文件，仅支持绝对路径 |
| `-v, --volume <volume>` | 追加挂载卷，可多次传入 |
| `-p, --port <port>` | 追加端口映射，可多次传入 |
| `--worktrees` / `--wt` | 启用 Git worktrees 支持，自动挂载项目级 `worktrees/<project>/` 根目录 |
| `--worktrees-root <path>` / `--wtr <path>` | 指定项目级 Git worktrees 根目录，仅支持绝对路径；传入后会隐式启用 `--worktrees` |
| `--sp` / `-s` / `--ss` / `-- <args...>` | 组合前缀、主命令和后缀参数 |
| `-x, --shell-full <command...>` | 直接传完整命令；与 `--sp/-s/--ss/--` 互斥 |
| `-y, --yolo <cli>` | 快速进入 Agent 的免确认模式 |
| `--first-shell*` / `--first-env*` | 仅首次创建容器时执行 |
| `--rm-on-exit` | 退出后自动删除容器，仅 `run` 支持 |
| `-q, --quiet <item>` | 静默输出，可多次使用 |

### `serve`

`serve` 继承大部分 `run` 参数，并额外增加网页认证参数：

| 参数 | 说明 |
| --- | --- |
| `[listen]` | 监听地址，仅支持 `<port>` 或 `<host:port>` |
| `-U, --user <username>` | 登录用户名，默认 `admin` |
| `-P, --pass <password>` | 登录密码；未设置时启动时随机生成 |
| `-d, --detach` | 后台启动网页服务并立即返回；未设置密码时会打印本次随机密码 |
| `--stop` | 停止后台网页服务；必须传入 `[listen]`，按监听地址精确停止对应实例 |
| `--restart` | 重启后台网页服务；必须传入 `[listen]`，会先停止对应实例再按当前参数启动 |

### `build`

| 参数 | 说明 |
| --- | --- |
| `-r, --run <name>` | 读取运行配置 |
| `--in, --image-name <name>` | 指定镜像名称 |
| `--iv, --image-ver <version>` | 指定镜像版本 |
| `--iba, --image-build-arg <arg>` | 传递 Dockerfile 构建参数，可多次使用 |
| `--update-agents` | 仅更新已有镜像内 Agent CLI 到 latest（Claude/Codex/Gemini/OpenCode），不重建 Dockerfile |
| `--yes` | 自动确认所有提示 |

### `playwright`

| 命令 | 用途 |
| --- | --- |
| `manyoyo playwright ls` | 列出可用场景 |
| `manyoyo playwright up [scene]` | 启动场景，默认 `mcp-host-headless` |
| `manyoyo playwright down [scene]` | 停止场景 |
| `manyoyo playwright status [scene]` | 查看状态 |
| `manyoyo playwright health [scene]` | 健康检查 |
| `manyoyo playwright logs [scene]` | 查看日志 |
| `manyoyo playwright mcp-add` | 输出 MCP 接入命令 |
| `manyoyo playwright cli-add` | 输出宿主机安装 playwright-cli skill 的命令 |
| `manyoyo playwright ext-download` | 下载内置扩展到本地目录 |

`playwright up` 额外支持：

| 参数 | 说明 |
| --- | --- |
| `--ext-path <path>` | 追加扩展目录，目录内需包含 `manifest.json` |
| `--ext-name <name>` | 追加 `~/.manyoyo/plugin/playwright/extensions/` 下的扩展 |

## 高频命令

```bash
# 查看帮助
manyoyo --help
manyoyo run --help
manyoyo config show --help

# 初始化并启动
manyoyo init all
manyoyo run -r claude
manyoyo run -r codex --ss "resume --last"

# 调试配置和命令拼装
manyoyo config show -r claude
manyoyo config command -r claude

# 自定义命令
manyoyo run --rm-on-exit -x /bin/bash
manyoyo run -n demo --first-shell "npm ci" -s "npm test"

# 网页服务
manyoyo serve 127.0.0.1:3000
manyoyo serve 0.0.0.0:3000 -U admin -P strong-password

# Playwright
manyoyo playwright ls
manyoyo playwright up mcp-host-headless
manyoyo plugin playwright up mcp-host-headless
manyoyo playwright up cli-host-headless
manyoyo playwright mcp-add --host localhost
```

## 配置与优先级

- 标量参数优先级：命令行参数 > `runs.<name>` > 全局配置 > 默认值
- 数组参数 `envFile` / `volumes` / `imageBuildArgs`：按“全局配置 → `runs.<name>` → 命令行参数”追加合并
- `env`：按 key 合并覆盖，优先级同标量参数
- `serve` 认证参数优先级：命令行参数 > `runs.<name>` > 全局配置 > 环境变量 > 默认值
- `--ef` 与 `--first-env-file` 仅支持绝对路径
- `--worktrees` 默认按 `<主仓库父目录>/worktrees/<主仓库目录名>` 推导项目级 worktrees 根目录；若从某个 worktree 目录启动，会额外挂载主仓库根目录与该项目的 worktrees 根目录
- `--worktrees-root` 表示“项目级 worktrees 根目录”，例如 `/Users/name/github/worktrees/manyoyo`，不是主仓库目录，也不是单个分支目录

## 安全提醒

- `sock` 模式会让容器访问宿主机 Docker socket，风险最高
- `-y, --yolo` 会跳过 Agent 权限确认，适合可控环境
- `serve 0.0.0.0:<port>` 对外监听时必须设置强密码，并配合防火墙限制来源
