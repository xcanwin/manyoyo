---
title: 命令速查 | MANYOYO
description: 按 --help 分组列出 MANYOYO 全部命令，每条一行说明加一个示例，并附常用参数速查。
---

# 命令速查

本页按 `manyoyo --help` 的分组列出全部命令，每条一行说明加一个示例。查看某条命令的全部选项：`manyoyo <命令> --help`。

## 打开网页界面

不带参数运行 `manyoyo`，打开网页界面（首次使用进入配置向导）。无图形界面（SSH 等）时自动改为打印端口转发提示；判断不对时用 `--headless` / `--gui` 强制指定。详见[日常使用](../guide/daily.md)。

```bash
manyoyo
```

## 日常

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `update` | 升级到最新版本；`--rollback` 回到上一版本 | `manyoyo update` |
| `uninstall` | 卸载 MANYOYO（配置和数据默认保留）；`--yes` 只确认卸载程序本身 | `manyoyo uninstall` |
| `setup` | 命令行配置向导（无图形界面时使用） | `manyoyo setup` |
| `doctor` | 诊断容器运行时、镜像、配置和端口；`--json` 输出 JSON，`--fix` 自动修复 | `manyoyo doctor` |

## 命令行运行

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `run` | 启动容器并运行命令（容器已存在则连接） | `manyoyo run -y c` |
| `init [agents]` | 导入本机已有的 Agent 配置到 `~/.manyoyo` | `manyoyo init all` |
| `config show` | 显示最终生效的配置 | `manyoyo config show -r claude` |
| `config command` | 显示将执行的容器命令 | `manyoyo config command -r claude` |

## 容器与镜像

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `ps` | 列出容器 | `manyoyo ps` |
| `images` | 列出镜像 | `manyoyo images` |
| `rm <name>` | 删除指定容器 | `manyoyo rm my-0101-1200` |
| `build` | 构建沙箱镜像 | `manyoyo build --iv 2.1.0-common` |
| `prune` | 清理悬空镜像 | `manyoyo prune` |
| `podman <参数...>` | 用私有 Podman 执行命令（参数原样传入，仅离线完整包安装后可用） | `manyoyo podman ps -a` |

## 网页服务与插件

| 命令 | 说明 | 示例 |
| --- | --- | --- |
| `serve [listen]` | 启动网页服务，默认 `127.0.0.1:3000` | `manyoyo serve 127.0.0.1:3000 -d` |
| `playwright` | 管理 Playwright 插件服务 | `manyoyo playwright up mcp-host-headless` |

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
| `--iv, --image-ver <version>` | 镜像版本，格式必须为 `x.y.z-后缀`，如 `2.1.0-common` |
| `-e, --env <env>` | 追加环境变量，可多次传入 |
| `--ef, --env-file <file>` | 追加环境文件，仅支持绝对路径 |
| `-v, --volume <volume>` | 追加挂载卷，可多次传入 |
| `-p, --port <port>` | 追加端口映射，可多次传入 |
| `--worktrees` / `--wt` | 启用 Git worktrees 支持，自动挂载项目级 `worktrees/<project>/` 根目录 |
| `--worktrees-root <path>` / `--wtr <path>` | 指定项目级 Git worktrees 根目录，仅支持绝对路径；传入后会隐式启用 `--worktrees` |
| `--sp` / `-s` / `--ss` / `-- <args...>` | 组合前缀、主命令和后缀参数 |
| `-x, --shell-full <command...>` | 直接传完整命令；与 `--sp/-s/--ss/--` 互斥 |
| `-y, --yolo <cli>` | 以免确认模式启动 Agent：`c`=Claude、`cx`=Codex、`gm`=Gemini、`oc`=OpenCode |
| `--first-shell*` / `--first-env*` | 仅首次创建容器时执行 |
| `--rm-on-exit` | 退出后自动删除容器，仅 `run` 支持 |
| `-q, --quiet <item>` | 隐藏部分输出，可多次使用：`cnew` 创建/连接容器提示、`crm` 删除容器提示、`tip` 首次命令提示、`cmd` 将执行的命令、`askkeep` 简化保留容器提问、`full` 全部 |

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

### `doctor`

| 参数 | 说明 |
| --- | --- |
| `-r, --run <name>` | 读取运行配置后再诊断 |
| `--port <port>` | 额外检查指定监听端口是否可用 |
| `--json` | 以 JSON 输出稳定诊断结果（`ok` + `checks[]`，含选中的 `runtimeCommand` / `runtimeSource`），便于脚本消费 |
| `--fix` | 自动修复可修复项：启动 Podman machine / macOS 上的 Docker Desktop、拉取缺失镜像、生成默认配置；端口占用时只给出建议端口。未通过的检查项带 `fix: {attempted, fixed, message}` |

### `playwright`

| 命令 | 用途 |
| --- | --- |
| `manyoyo playwright ls` | 列出可用场景 |
| `manyoyo playwright up [scene]` | 启动场景，默认 `mcp-host-headless` |
| `manyoyo playwright down [scene]` | 停止场景 |
| `manyoyo playwright status [scene]` | 查看状态 |
| `manyoyo playwright health [scene]` | 健康检查 |
| `manyoyo playwright logs [scene]` | 查看日志 |
| `manyoyo playwright mcp-add` | 输出 MCP 接入命令，首行标注在容器中执行 |
| `manyoyo playwright cli-add` | 输出宿主机安装 playwright-cli skill 的命令，首行标注在宿主机中执行 |
| `manyoyo playwright ext-download` | 下载内置扩展到本地目录 |

`playwright up` 额外支持：

| 参数 | 说明 |
| --- | --- |
| `--ext-path <path>` | 追加扩展目录，目录内需包含 `manifest.json` |
| `--ext-name <name>` | 追加 `~/.manyoyo/plugin/playwright/extensions/` 下的扩展 |

## 配置与优先级

优先级与合并规则见[配置入门](../configuration/README.md)；`--ef` 与 `--first-env-file` 仅支持绝对路径。

- `--worktrees` 默认按 `<主仓库父目录>/worktrees/<主仓库目录名>` 推导项目级 worktrees 根目录；从某个 worktree 目录启动时，会额外挂载主仓库根目录与该根目录
- `--worktrees-root` 是“项目级 worktrees 根目录”（如 `/Users/name/github/worktrees/manyoyo`），不是主仓库目录，也不是单个分支目录
- `sock` 模式、`-y/--yolo` 与对外监听 `serve` 的风险见[安全说明](../guide/security.md)

## 下一步

- [日常使用](../guide/daily.md)
- [配置概览](../configuration/README.md)
