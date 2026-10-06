---
title: 环境变量 | MANYOYO
description: 把 API 地址、Token 等环境变量传给容器内的 Agent，用 -e 或环境文件
---

# 环境变量

本页说明如何把 `BASE_URL`、`AUTH_TOKEN` 等环境变量传给容器内的 Agent CLI。

## 两种传入方式

```bash
# 1. 命令行 -e：适合临时测试（会留在命令历史里）
manyoyo run -e "ANTHROPIC_BASE_URL=https://xxxx" -e "ANTHROPIC_AUTH_TOKEN=your-key" -x claude

# 2. 环境文件 --ef：推荐，密钥不进命令历史
manyoyo run --ef /abs/path/anthropic.env -x claude
```

`--ef`（以及配置里的 `envFile`）**仅支持绝对路径**，环境文件在新容器里是**实时读取**的：每次执行命令时重新读取，改了文件下一条命令就生效（已在运行的进程除外）；也可以在网页「容器」页的“环境变量文件”里随时增删。`-e` 可多次传入。

## 环境文件格式

```bash
# 以 # 开头的行和空行会被忽略
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
API_TIMEOUT_MS=3000000      # 不带 export 也可以
GREETING=hello world        # 值里的空格不需要引号
```

- 支持 `KEY=VALUE` 与 `export KEY=VALUE`，值可用单引号、双引号或不加引号；值里的空格不需要引号（`KEY=abc 123`），值两端成对的引号会被去掉。
- 同一套语法也用于网页「环境变量」的文本视图和容器里的 `/run/manyoyo/env`，只需要学这一种。它与 docker / podman 的 `--env-file` 一致（不展开变量、不执行命令），并且兼容 shell / dotenv 的 `export` 前缀和引号写法。
- 不支持行尾注释：`#` 只在行首才是注释。
- 变量名须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`；值不能包含换行、`;`、`&`、`|`、`` ` ``、`$`、`<`、`>` 等 shell 特殊字符。

## 各 Agent 示例

```bash
mkdir -p ~/.manyoyo/env

# Claude Code
cat > ~/.manyoyo/env/claude.env << 'EOF'
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
export ANTHROPIC_MODEL="claude-sonnet-4-5"
EOF

# Codex
cat > ~/.manyoyo/env/codex.env << 'EOF'
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_API_KEY="sk-xxxxxxxx"
EOF

# Gemini
cat > ~/.manyoyo/env/gemini.env << 'EOF'
export GEMINI_API_KEY="your-api-key"
EOF
```

使用时 `manyoyo run --ef $HOME/.manyoyo/env/claude.env -x claude`，或写进 `runs.<name>.envFile` 后用 `manyoyo run -r <name>`。OpenCode 的变量见 [Agent 参考](../reference/agents.md)。

## 同名变量谁生效

后加载的覆盖先加载的，顺序为：

1. 各层 `envFile`（全局 → `runs.<name>` → `--ef`）
2. 全局 `env`
3. `runs.<name>.env`
4. 命令行 `-e`

所以同名变量以 `-e` 为准，其次是 `runs.<name>.env`，最后才是环境文件。

## 建议

- 文件名要有区分度（如 `claude-work.env`），非敏感配置与密钥拆成两个文件，只有密钥文件不进版本控制。
- 密钥与访问风险见[安全说明](../guide/security.md)。
- `MANYOYO_SERVER_USER` / `MANYOYO_SERVER_PASS` 是 MANYOYO 自身用于 `serve` 认证的变量，不会注入容器，见[网页服务](../guide/web.md)。

## 变量没生效？

```bash
manyoyo config show -r claude                       # 看合并后的最终配置
manyoyo run -r claude -x env | grep ANTHROPIC       # 看容器里实际拿到的值
```

常见原因：文件路径不是绝对路径、格式不合法、多个来源设置了同名变量。

## 下一步

- [配置概览](./README.md)：四层优先级
- [配置文件](./config-files.md)：在 `runs` 里使用 `envFile`
- [配置示例](./examples.md)
