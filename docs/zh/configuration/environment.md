# 环境变量详解

环境变量用于给容器内的 CLI 工具传递配置信息，如 BASE_URL、AUTH_TOKEN 等敏感信息。

## 设置方式

MANYOYO 支持两种方式设置环境变量：

### 1. 字符串形式（命令行）

使用 `-e` 参数直接在命令行中指定环境变量：

```bash
manyoyo -e "ANTHROPIC_BASE_URL=https://xxxx" -e "ANTHROPIC_AUTH_TOKEN=your-key" -x claude
```

**特点**：
- 适合临时使用或测试
- 支持多次使用 `-e` 参数
- 不适合包含敏感信息（会在命令历史中保留）

### 2. 文件形式（推荐）

使用 `--ef` 参数从文件加载环境变量：

```bash
manyoyo --ef /abs/path/anthropic_claudecode.env -x claude
```

**特点**：
- 适合长期使用和团队协作
- 敏感信息不会出现在命令历史中
- 支持版本控制（排除 `.env` 文件）
- 支持注释和更好的组织

## 环境文件格式

环境文件使用 `.env` 格式，支持以下语法：

```bash
# 这是注释，会被忽略

# 标准格式（推荐）
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"

# 简化格式（也支持）
API_TIMEOUT_MS=3000000
ANTHROPIC_MODEL="claude-sonnet-4-5"

# 单引号和双引号都支持
TESTPATH='/usr/local/bin'
MESSAGE="Hello World"

# 注释可以放在任何位置
# export DISABLED_VAR="不会生效"
```

**注意事项**：
- 以 `#` 开头的行会被忽略
- 支持 `KEY=VALUE` 和 `export KEY=VALUE` 两种格式
- 值可以用单引号、双引号或不加引号
- 空行会被忽略

## 环境文件路径规则

`--ef` 仅支持绝对路径：

```bash
manyoyo --ef /abs/path/myconfig.env
# 加载：指定绝对路径文件
```

## 常用示例

### Claude Code 环境配置

创建环境文件：

```bash
# 创建环境文件目录（绝对路径）
mkdir -p $HOME/.manyoyo/env/

# 创建 Claude Code 环境文件
cat > $HOME/.manyoyo/env/anthropic_[claudecode]_claudecode.env << 'EOF'
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
# export CLAUDE_CODE_OAUTH_TOKEN="sk-xxxxxxxx"  # OAuth 方式
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"        # API Key 方式
export API_TIMEOUT_MS=3000000
export ANTHROPIC_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-5"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5"
export CLAUDE_CODE_SUBAGENT_MODEL="claude-sonnet-4-5"
EOF
```

使用环境文件：

```bash
# 在任意目录下使用（绝对路径）
manyoyo --ef $HOME/.manyoyo/env/anthropic_[claudecode]_claudecode.env -x claude

# 或结合 runs 配置使用
manyoyo -r claude  # ~/.manyoyo/manyoyo.json 的 runs.claude 中指定 envFile
```

### Codex 环境配置

创建环境文件：

```bash
# 创建环境文件目录（绝对路径）
mkdir -p $HOME/.manyoyo/env/

# 创建 Codex 环境文件
cat > $HOME/.manyoyo/env/openai_[gpt]_codex.env << 'EOF'
export OPENAI_BASE_URL=https://chatgpt.com/backend-api/codex
EOF
```

使用环境文件：

```bash
# 在任意目录下使用（绝对路径）
manyoyo --ef $HOME/.manyoyo/env/openai_[gpt]_codex.env -x codex

# 或结合 runs 配置使用
manyoyo -r codex  # ~/.manyoyo/manyoyo.json 的 runs.codex 中指定 envFile
```

### Gemini 环境配置

创建环境文件：

```bash
# 创建 Gemini 环境文件
cat > $HOME/.manyoyo/env/gemini.env << 'EOF'
export GEMINI_API_KEY="your-api-key"
export GEMINI_MODEL="gemini-2.0-flash-exp"
EOF
```

使用环境文件：

```bash
manyoyo --ef $HOME/.manyoyo/env/gemini.env -x gemini
```

### OpenCode 环境配置

创建环境文件：

```bash
# 创建 OpenCode 环境文件
cat > $HOME/.manyoyo/env/opencode.env << 'EOF'
export OPENAI_API_KEY="your-api-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
EOF
```

使用环境文件：

```bash
manyoyo --ef $HOME/.manyoyo/env/opencode.env -x opencode
```

## 环境变量优先级

当使用配置文件时，环境变量的加载顺序为：

1. 全局配置中的 `envFile` 数组
2. `runs.<name>` 中的 `envFile` 数组
3. 命令行 `--ef` 参数
4. 全局配置中的 `env` 对象
5. `runs.<name>` 中的 `env` 对象
6. 命令行 `-e` 参数

**注意**：后加载的环境变量会覆盖先加载的同名变量。

示例：
```bash
# 全局配置：envFile: ["/abs/path/base.env"]
# runs.claude：envFile: ["/abs/path/override.env"]
# 命令行：--ef /abs/path/custom.env -e "VAR=value"
#
# 加载顺序：
# 1. /abs/path/base.env
# 2. /abs/path/override.env
# 3. /abs/path/custom.env
# 4. 全局配置的 env 对象
# 5. runs.claude 的 env 对象
# 6. 命令行的 VAR=value
```

## MANYOYO 自身环境变量

除传入容器的 `env` / `envFile` 外，MANYOYO 还支持用于网页认证的自身环境变量：

- `MANYOYO_SERVER_USER`
- `MANYOYO_SERVER_PASS`

这两个变量用于 `--server` 模式认证，不会注入到容器内业务进程。优先级详见：

- [配置系统概览](./README.md)
- [网页服务认证与安全实践](../advanced/web-server-auth.md)

## 最佳实践

### 1. 使用命名规范

建议使用描述性的文件名：
```bash
/abs/path/env/
├── anthropic_[claudecode]_claudecode.env
├── openai_[gpt]_codex.env
├── gemini_production.env
└── opencode_dev.env
```

### 2. 分离敏感信息

将敏感信息（如 API Key）单独存储：
```bash
# base.env - 非敏感配置
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export API_TIMEOUT_MS=3000000

# secrets.env - 敏感信息（不提交到版本控制）
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
```

### 3. 使用配置文件管理

将环境文件配置到 `manyoyo.json` 的 `runs` 中，避免重复输入：
```json5
// ~/.manyoyo/manyoyo.json（片段）
{
    "runs": {
        "claude": {
            "envFile": [
                "/abs/path/anthropic_base.env",
                "/abs/path/anthropic_secrets.env"
            ]
        }
    }
}
```

### 4. 验证环境变量

使用调试命令验证环境变量是否正确加载：
```bash
# 查看最终配置
manyoyo --show-config -r claude

# 在容器中验证
manyoyo -r claude -x env | grep ANTHROPIC
```

## 故障排查

### 环境变量未生效

**症状**：CLI 工具报告缺少必需的环境变量

**解决方案**：
1. 检查文件格式（必须是 `.env` 格式）
2. 确认文件路径正确
3. 使用 `--show-config` 查看配置
4. 在容器中运行 `env` 命令检查

```bash
# 检查配置
manyoyo --show-config --ef /abs/path/myconfig.env

# 在容器中检查环境变量
manyoyo --ef /abs/path/myconfig.env -x env
```

### 环境变量值错误

**症状**：环境变量值不是预期的

**解决方案**：
1. 检查是否有多个配置源设置了同名变量
2. 确认优先级顺序
3. 检查文件中是否有重复定义

```bash
# 查看所有生效的环境变量
manyoyo --ef /abs/path/myconfig.env -x 'env | sort'
```

## 相关文档

- [配置系统概览](./README.md) - 了解配置优先级机制
- [配置文件详解](./config-files.md) - 学习如何在配置文件中使用 envFile
- [配置示例](./examples.md) - 查看完整的配置示例
