# AI 智能体

MANYOYO 支持多种 AI CLI 工具（智能体），提供快捷方式启动 YOLO/SOLO 模式。

> 提示：运行配置统一写在 `~/.manyoyo/manyoyo.json` 的 `runs.<name>`，`envFile` 使用绝对路径，`env` 使用对象（map）。

## 支持的智能体

### Claude Code

Anthropic 官方的 Claude AI 命令行工具。

**快捷方式**：
```bash
manyoyo run -y c          # 推荐
manyoyo run -y claude
manyoyo run -y cc
```

**等同于**：
```bash
manyoyo run -x claude --dangerously-skip-permissions
```

**恢复会话**：
```bash
manyoyo run -n <容器名> -- -c
manyoyo run -n <容器名> -- --continue
```

**配置示例**：
```json5
// ~/.manyoyo/manyoyo.json 的 runs.claude
{
    "envFile": ["/abs/path/anthropic_claudecode.env"],
    "yolo": "c"
}
```

**环境变量**：
```bash
# ~/.manyoyo/env/anthropic_claudecode.env
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
export ANTHROPIC_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-5"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5"
export CLAUDE_CODE_SUBAGENT_MODEL="claude-sonnet-4-5"
```

**常用命令**：
```bash
# 启动 YOLO 模式
manyoyo run -r claude

# 查看版本
manyoyo run -r claude -- --version

# 查看帮助
manyoyo run -r claude -- --help

# 恢复上次会话
manyoyo run -r claude -- -c
```

### Gemini

Google 的 Gemini AI 命令行工具。

**快捷方式**：
```bash
manyoyo run -y gm         # 推荐
manyoyo run -y gemini
manyoyo run -y g
```

**等同于**：
```bash
manyoyo run -x gemini --yolo
```

**恢复会话**：
```bash
manyoyo run -n <容器名> -- -r
manyoyo run -n <容器名> -- --resume
```

**配置示例**：
```json5
// ~/.manyoyo/manyoyo.json 的 runs.gemini
{
    "envFile": ["/abs/path/gemini.env"],
    "yolo": "gm"
}
```

**环境变量**：
```bash
# ~/.manyoyo/env/gemini.env
export GEMINI_API_KEY="your-api-key"
export GEMINI_MODEL="gemini-2.0-flash-exp"
```

**常用命令**：
```bash
# 启动 YOLO 模式
manyoyo run -r gemini

# 查看版本
manyoyo run -r gemini -- --version

# 恢复会话
manyoyo run -r gemini -- -r
```

### Codex

OpenAI 的 Codex 命令行工具。

**快捷方式**：
```bash
manyoyo run -y cx         # 推荐
manyoyo run -y codex
```

**等同于**：
```bash
manyoyo run -x codex --dangerously-bypass-approvals-and-sandbox
```

**恢复会话**：
```bash
manyoyo run -n <容器名> -- resume --last
manyoyo run -n <容器名> -- resume <session-id>
```

**配置示例**：
```json5
// ~/.manyoyo/manyoyo.json 的 runs.codex
{
    "envFile": ["/abs/path/openai_codex.env"],
    "volumes": [
        "/Users/pc_user/.codex/auth.json:/root/.codex/auth.json"
    ],
    "yolo": "cx"
}
```

**环境变量**：
```bash
# ~/.manyoyo/env/openai_codex.env
export OPENAI_BASE_URL=https://chatgpt.com/backend-api/codex
```

**常用命令**：
```bash
# 启动 YOLO 模式
manyoyo run -r codex

# 查看会话列表
manyoyo run -r codex -- list

# 恢复最后会话
manyoyo run -r codex -- resume --last

# 恢复特定会话
manyoyo run -r codex -- resume <session-id>
```

### OpenCode

开源的 AI 代码助手。

**快捷方式**：
```bash
manyoyo run -y oc         # 推荐
manyoyo run -y opencode
```

**等同于**：
```bash
manyoyo run -x "OPENCODE_PERMISSION='{\"*\":\"allow\"}' opencode"
```

**恢复会话**：
```bash
manyoyo run -n <容器名> -- -c
manyoyo run -n <容器名> -- --continue
```

**配置示例**：
```json5
// ~/.manyoyo/manyoyo.json 的 runs.opencode
{
    "envFile": ["/abs/path/opencode.env"],
    "yolo": "oc"
}
```

**环境变量**：
```bash
# ~/.manyoyo/env/opencode.env
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

**常用命令**：
```bash
# 启动 YOLO 模式
manyoyo run -r opencode

# 查看版本
manyoyo run -r opencode -- --version

# 恢复会话
manyoyo run -r opencode -- -c
```

## YOLO 模式说明

YOLO（You Only Live Once）模式是指 AI 智能体跳过权限确认，自动执行命令的模式。

### 为什么使用 YOLO 模式？

**优势**：
- 提高效率，减少交互
- 适合自动化场景
- 在隔离的容器中运行，保护宿主机安全

**风险**：
- AI 可能执行危险命令（如 `rm -rf`）
- 在 MANYOYO 容器中，风险被限制在容器内

### 安全隔离

MANYOYO 提供安全的容器隔离：

```
宿主机
  └─ MANYOYO 容器（隔离环境）
      └─ AI 智能体（YOLO 模式）
          ├─ 文件操作 → 仅影响容器内
          ├─ 进程操作 → 仅影响容器内
          └─ 网络操作 → 可配置隔离
```

**保护机制**：
- 容器文件系统隔离
- 资源限制
- 网络隔离（可选）
- 可以随时删除容器重新开始

## 智能体对比

| 智能体 | 快捷键 | 恢复命令 | 主要用途 | 支持语言 |
|--------|--------|----------|----------|----------|
| Claude Code | `-y c` | `-- -c` | 通用编程辅助 | 多语言 |
| Gemini | `-y gm` | `-- -r` | 通用编程辅助 | 多语言 |
| Codex | `-y cx` | `-- resume --last` | 代码生成 | 多语言 |
| OpenCode | `-y oc` | `-- -c` | 开源代码助手 | 多语言 |

## 会话管理

### 创建新会话

```bash
# 创建新会话（自动生成容器名）
manyoyo run -y c

# 创建命名会话
manyoyo run -n my-session -y c
```

### 恢复会话

不同智能体有不同的恢复方式：

```bash
# Claude Code
manyoyo run -n my-session -- -c

# Gemini
manyoyo run -n my-session -- -r

# Codex
manyoyo run -n my-session -- resume --last

# OpenCode
manyoyo run -n my-session -- -c
```

### 会话持久化

容器状态决定会话是否保留：

```bash
# 退出后保持容器运行（会话保留）
# 选择 'y' 在交互式提示中

# 删除容器（会话丢失）
manyoyo rm my-session
```

### 查看会话

```bash
# 列出所有容器会话
manyoyo ls

# 查看特定容器
docker ps -a | grep my-session
```

## 智能体之间切换

### 在容器中切换

```bash
# 启动 Claude Code
manyoyo run -n dev -y c

# 退出后，进入 shell
manyoyo run -n dev -x /bin/bash

# 在 shell 中手动运行其他智能体
gemini --yolo
codex --dangerously-bypass-approvals-and-sandbox
```

### 使用不同容器

```bash
# Claude Code 容器
manyoyo run -n claude-session -y c

# Codex 容器
manyoyo run -n codex-session -y cx

# 根据需要切换
manyoyo run -n claude-session -- -c
manyoyo run -n codex-session -- resume --last
```

## 与 /bin/bash 循环切换

MANYOYO 支持在 AI 智能体和 shell 之间灵活切换：

### 从智能体切换到 Shell

```bash
# 启动智能体
manyoyo run -n dev -y c

# 工作一段时间后，退出智能体

# 选择 'i' 进入交互式 shell
# 或使用命令
manyoyo run -n dev -x /bin/bash
```

### 从 Shell 切换到智能体

```bash
# 在 shell 中
manyoyo run -n dev -x /bin/bash

# 在容器内直接运行智能体
claude --dangerously-skip-permissions
gemini --yolo
codex --dangerously-bypass-approvals-and-sandbox

# 或退出后使用命令
manyoyo run -n dev -y c
```

### 工作流示例

```bash
# 1. 启动 Claude Code 进行开发
manyoyo run -n project -y c

# 2. AI 帮助编写代码...

# 3. 退出，进入 shell 检查
manyoyo run -n project -x /bin/bash

# 4. 在 shell 中手动测试
$ npm test
$ git status
$ ls -la

# 5. 继续使用 AI
$ claude --dangerously-skip-permissions

# 6. 或退出后恢复
manyoyo run -n project -- -c
```

## 技巧和最佳实践

### 使用运行配置

为每个智能体创建专用配置：

```bash
# 创建配置
cat > ~/.manyoyo/manyoyo.json << 'EOF'
{
    "runs": {
        "claude": {
            "envFile": ["/abs/path/anthropic_claudecode.env"],
            "yolo": "c"
        }
    }
}
EOF

# 使用配置（简单）
manyoyo run -r claude
```

### 统一容器名称

使用有意义的容器名：

```bash
# 按项目命名
manyoyo run -n webapp-claude -r claude
manyoyo run -n api-codex -r codex

# 按功能命名
manyoyo run -n dev-claude -r claude
manyoyo run -n test-gemini -r gemini
```

### 多智能体协作

在同一项目中使用多个智能体：

```bash
# Claude 用于架构设计
manyoyo run -n project-claude --hp ~/project -r claude

# Codex 用于代码生成
manyoyo run -n project-codex --hp ~/project -r codex

# 切换使用
manyoyo run -n project-claude -- -c
manyoyo run -n project-codex -- resume --last
```

### 配置环境隔离

为不同智能体配置不同的环境：

```bash
# 开发环境 - 使用 Claude
cat > ~/.manyoyo/manyoyo.json << 'EOF'
{
    "runs": {
        "dev": {
            "envFile": ["/abs/path/anthropic_dev.env"],
            "env": {
                "NODE_ENV": "development"
            },
            "yolo": "c"
        },
        "prod": {
            "envFile": ["/abs/path/gemini_prod.env"],
            "env": {
                "NODE_ENV": "production"
            },
            "yolo": "gm"
        }
    }
}
EOF
```

## 故障排查

### 智能体无法启动

**检查环境变量**：
```bash
# 验证环境变量
manyoyo config show -r claude

# 测试环境变量
manyoyo run -r claude -x 'env | grep ANTHROPIC'
```

**检查镜像**：
```bash
# 确认智能体已安装在镜像中
manyoyo run -x which claude
manyoyo run -x which gemini
manyoyo run -x which codex
```

### 会话无法恢复

**检查容器状态**：
```bash
# 查看容器是否存在
manyoyo ls
docker ps -a | grep <容器名>

# 查看容器日志
docker logs <容器名>
```

**使用正确的恢复命令**：
```bash
# Claude Code: -c 或 --continue
manyoyo run -n test -- -c

# Gemini: -r 或 --resume
manyoyo run -n test -- -r

# Codex: resume --last
manyoyo run -n test -- resume --last
```

### API 认证失败

**检查 API Key**：
```bash
# 查看环境文件
cat ~/.manyoyo/env/anthropic_claudecode.env

# 测试 API
curl -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" \
     https://api.anthropic.com/v1/messages
```

**更新配置**：
```bash
# 编辑环境文件
vim ~/.manyoyo/env/anthropic_claudecode.env

# 重新启动容器
manyoyo rm test
manyoyo run -n test -r claude
```

## 相关文档

- [基础用法](../guide/basic-usage.md) - 学习基本命令和操作
- [配置示例](../configuration/examples.md) - 查看智能体配置示例
- [环境变量详解](../configuration/environment.md) - 了解如何配置环境变量
- [运行时问题](../troubleshooting/runtime-errors.md#ai-cli-工具报错) - AI CLI 工具故障排查
