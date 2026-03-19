# 基础用法

本页只保留日常高频路径，和当前 `--help` 结构保持一致。

## 先看帮助

```bash
manyoyo --help
manyoyo run --help
manyoyo serve --help
manyoyo config show --help
manyoyo playwright --help
```

## 容器日常操作

```bash
# 列出容器与镜像
manyoyo ps
manyoyo images

# 新建或连接容器
manyoyo run -r claude
manyoyo run -n my-dev -x /bin/bash

# 一次性容器
manyoyo run --rm-on-exit -x /bin/bash

# 删除容器
manyoyo rm my-dev
```

## 命令执行方式

推荐优先使用 `-x, --shell-full`，最直接：

```bash
manyoyo run -x 'claude --version'
manyoyo run -x 'echo "Start" && ls -la && echo "End"'
```

需要拆分前缀、主命令和参数时，再使用 `--sp` / `-s` / `--ss` 或 `--`：

```bash
manyoyo run --sp 'DEBUG=1' -s claude -- --version
manyoyo run -s claude --ss '--help'
manyoyo run -r codex --ss 'resume --last'
```

首次创建容器时附带初始化命令：

```bash
manyoyo run -n demo --first-shell "npm ci" -s "npm test"
manyoyo run -n demo --first-env NODE_ENV=development -x /bin/bash
```

## Agent 快捷模式

`-y, --yolo` 会直接启用对应 Agent 的免确认模式：

```bash
manyoyo run -y c
manyoyo run -y gm
manyoyo run -y cx
manyoyo run -y oc
```

支持的缩写以 `manyoyo run --help` 为准。该模式适合可控环境，不适合高风险宿主机。

## 配置与环境变量

```bash
# 直接传环境变量
manyoyo run -e "DEBUG=true" -e "HTTP_PROXY=http://127.0.0.1:7890" -x /bin/bash

# 读取绝对路径环境文件
manyoyo run --ef /abs/path/anthropic_claudecode.env -x claude
manyoyo run --ef /abs/path/base.env --ef /abs/path/secret.env -x claude

# 读取 runs.<name>
manyoyo run -r claude
manyoyo run -r claude -e "DEBUG=true"
```

排查配置时优先使用：

```bash
manyoyo config show -r claude
manyoyo config command -r claude
```

## 会话恢复

不同 Agent 的恢复参数不同，直接把后缀透传给原始 CLI：

```bash
manyoyo run -n my-project -- -c
manyoyo run -n my-project -- resume --last
manyoyo run -n my-project -- -r
```

如果你不确定当前命令如何拼装，先看：

```bash
manyoyo config command -r claude
```

## 网页服务

`serve` 复用大部分 `run` 参数，只是额外增加了网页认证：

```bash
manyoyo serve 127.0.0.1:3000
manyoyo serve 0.0.0.0:3000 -U admin -P strong-password
manyoyo config show --serve 127.0.0.1:3000
```

对外监听时必须设置强密码，并限制来源地址。

## Playwright 插件

优先使用一级命令 `manyoyo playwright`；`manyoyo plugin playwright` 主要用于兼容命名空间调用。

```bash
manyoyo playwright ls
manyoyo playwright up mcp-host-headless
manyoyo playwright up mcp-host-headless --ext-path /abs/path/extA --ext-name adguard
manyoyo playwright status mcp-host-headless
manyoyo playwright logs mcp-host-headless
manyoyo playwright mcp-add --host localhost
manyoyo playwright cli-add
manyoyo playwright up cli-host-headless
manyoyo run -r codex
```

启动 `cli-host-headed` 时会自动创建 `~/.manyoyo/.cache/ms-playwright`；如需让容器内 `playwright-cli` 复用宿主缓存，可在配置里挂载 `~/.manyoyo/.cache/ms-playwright:/root/.cache/ms-playwright`。

更多配置细节见[配置系统](../configuration/README.md)与[命令参考](../reference/cli-options.md)。
