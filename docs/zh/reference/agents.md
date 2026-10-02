---
title: AI 智能体
description: 四个内置智能体的启动缩写、所需环境变量与会话恢复方式
---

# AI 智能体

本页告诉你怎么用一条命令启动 Claude Code、Gemini、Codex、OpenCode 的 YOLO 模式，以及各自需要配置什么。YOLO 模式会跳过权限确认，务必只在容器里使用，详见 [安全说明](../guide/security.md)。

## 速查

| 智能体 | 缩写（`-y`） | 实际执行的命令 | 恢复会话（`--` 之后） |
|--------|--------------|----------------|------------------------|
| Claude Code | `c` / `cc` / `claude` | `IS_SANDBOX=1 claude --dangerously-skip-permissions` | `-r`（选择）或 `-c`（最近一次） |
| Gemini | `gm` / `g` / `gemini` | `gemini --yolo` | `-r` |
| Codex | `cx` / `codex` | `codex --dangerously-bypass-approvals-and-sandbox` | `resume`（`resume --last` 为最近一次） |
| OpenCode | `oc` / `opencode` | `OPENCODE_PERMISSION='{"*":"allow"}' opencode` | `-c` |

通用用法：

```bash
manyoyo run -y c                    # 新建容器并启动（以 Claude Code 为例）
manyoyo run -n my-session -y c      # 指定容器名
manyoyo run -n my-session -- -c     # 回到已有容器，并给智能体传恢复参数
```

## 推荐做法：写成运行配置

每个智能体在 `~/.manyoyo/manyoyo.json` 的 `runs.<name>` 里写一份，之后只需 `manyoyo run -r <name>`。`envFile` 必须是绝对路径，`env` 是对象。把 Key 放在 env 文件里，不要写进配置。

```json5
{
    "runs": {
        "claude":   { "yolo": "c",  "envFile": ["/abs/path/anthropic_claudecode.env"] },
        "gemini":   { "yolo": "gm", "envFile": ["/abs/path/gemini.env"] },
        "codex":    { "yolo": "cx", "envFile": ["/abs/path/openai_codex.env"] },
        "opencode": { "yolo": "oc", "envFile": ["/abs/path/opencode.env"] }
    }
}
```

`manyoyo init all` 可一次生成这些条目。镜像选 `2.1.0-common` 或 `2.1.0-full` 均已包含这四个智能体。

## Claude Code

```bash
manyoyo run -r claude
manyoyo run -n <容器名> -- -c      # 继续最近一次会话
```

环境变量（`anthropic_claudecode.env`）：

```bash
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
export ANTHROPIC_MODEL="claude-sonnet-4-5"    # 可选
```

## Gemini

```bash
manyoyo run -r gemini
manyoyo run -n <容器名> -- -r
```

环境变量（`gemini.env`）：

```bash
export GEMINI_API_KEY="your-api-key"
export GEMINI_MODEL="gemini-2.0-flash-exp"    # 可选
```

## Codex

```bash
manyoyo run -r codex
manyoyo run -n <容器名> -- resume --last
manyoyo run -n <容器名> -- resume <session-id>
```

使用账号登录而非 Key 时，把宿主机的登录文件挂进容器（写在 `runs.codex` 里）：

```json5
"volumes": ["/Users/<你>/.codex/auth.json:/root/.codex/auth.json"]
```

环境变量（`openai_codex.env`）：

```bash
export OPENAI_BASE_URL=https://chatgpt.com/backend-api/codex
```

## OpenCode

```bash
manyoyo run -r opencode
manyoyo run -n <容器名> -- -c
```

环境变量（`opencode.env`）：

```bash
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

## 常见坑

- **智能体启动后提示未登录或认证失败**：先 `manyoyo config show -r <name>` 确认 `envFile` 生效，再用 `manyoyo run -r <name> -x 'env | grep -E "ANTHROPIC|OPENAI|GEMINI"'` 看变量是否进了容器。改过 env 文件后需 `manyoyo rm <容器名>` 重建容器。
- **恢复会话没有内容**：会话保存在容器里，容器被 `manyoyo rm` 删除后无法恢复；也要确认用的是上表对应智能体的恢复参数。
- **想在容器里换另一个智能体**：`manyoyo run -n <容器名> -x /bin/bash` 进 shell，直接运行上表的完整命令；更省事的是为每个智能体建一个独立容器（如 `-n proj-claude`、`-n proj-codex`）。
- **提示找不到命令**：用 `manyoyo run -x which claude`（或 gemini / codex / opencode）确认镜像里装了该智能体，必要时换 `2.1.0-full`。

## 下一步

- [基础用法](../guide/basic-usage.md)
- [环境变量详解](../configuration/environment.md)
- [运行时问题](../troubleshooting/runtime-errors.md#ai-cli-工具报错)
