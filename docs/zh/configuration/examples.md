# 配置示例

本页面提供实用的 MANYOYO 配置示例，涵盖常见使用场景。

## 快速开始示例

### 最小全局配置

```bash
mkdir -p ~/.manyoyo/

cat > ~/.manyoyo/manyoyo.json << 'EOF'
{
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.7.0-full"
}
EOF
```

使用：
```bash
manyoyo -y c  # 自动使用全局配置中的镜像
```

## Claude Code 配置示例

### 基础配置

基础模板（环境变量、运行配置、常用命令）已统一在参考文档维护：  
[AI 智能体 / Claude Code](../reference/agents#claude-code)。

### 高级配置（自定义 Base URL）

**环境文件**（`~/.manyoyo/env/anthropic_custom.env`）：
```bash
# 使用自定义 API 端点
export ANTHROPIC_BASE_URL="https://custom-api.example.com"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"

# 自定义超时时间
export API_TIMEOUT_MS=5000000

# 使用特定模型
export ANTHROPIC_MODEL="claude-opus-4-5"
export CLAUDE_CODE_SUBAGENT_MODEL="claude-haiku-4-5"

# 启用调试
export DEBUG="anthropic:*"
```

**运行配置**（`~/.manyoyo/run/claude-custom.json`）：
```json5
{
    "containerName": "my-claude-custom",
    "envFile": [
        "anthropic_custom"
    ],
    "yolo": "c",
    "quiet": ["tip"]  // 不显示提示信息
}
```

### OAuth 认证配置

```bash
# 环境文件
cat > ~/.manyoyo/env/anthropic_oauth.env << 'EOF'
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export CLAUDE_CODE_OAUTH_TOKEN="your-oauth-token"
export API_TIMEOUT_MS=3000000
EOF
```

## Codex 配置示例

### 基础配置

基础模板（环境变量、运行配置、会话恢复）已统一在参考文档维护：  
[AI 智能体 / Codex](../reference/agents#codex)。

### API Key 认证配置

```bash
# 环境文件
cat > ~/.manyoyo/env/openai_api.env << 'EOF'
export OPENAI_API_KEY="sk-xxxxxxxx"
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_MODEL="gpt-4-turbo"
EOF
```

**运行配置**：
```json5
{
    "envFile": [
        "openai_api"
    ],
    "yolo": "cx"
}
```

## Gemini 配置示例

### 基础配置

基础模板（环境变量、运行配置、恢复命令）已统一在参考文档维护：  
[AI 智能体 / Gemini](../reference/agents#gemini)。

## OpenCode 配置示例

### 基础配置

基础模板（环境变量、运行配置、快捷方式）已统一在参考文档维护：  
[AI 智能体 / OpenCode](../reference/agents#opencode)。

## Docker-in-Docker 配置示例

### 安全的嵌套容器

**运行配置**（`~/.manyoyo/run/dind.json`）：
```json5
{
    "containerName": "my-dind",
    "containerMode": "dind",
    "envFile": [
        "anthropic_claudecode"
    ],
    "volumes": [
        "~/.docker:/root/.docker:ro"  // 挂载 Docker 配置（只读）
    ]
}
```

**使用**：
```bash
# 启动 Docker-in-Docker 容器
manyoyo -r dind -x /bin/bash

# 在容器内使用 Podman
podman ps -a

# 在容器内启动 dockerd 并使用 Docker
nohup dockerd &
docker ps -a
```

### 挂载 Socket（危险）

**运行配置**（`~/.manyoyo/run/sock.json`）：
```json5
{
    "containerName": "my-sock",
    "containerMode": "sock",  // 危险：可访问宿主机一切
    "envFile": [
        "anthropic_claudecode"
    ]
}
```

**警告**：此模式允许容器完全访问宿主机的 Docker，具有极高安全风险！

## 多环境配置示例

### 开发、测试、生产环境

**全局配置**（`~/.manyoyo/manyoyo.json`）：
```json5
{
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.7.0-full",
    "env": [
        "TZ=Asia/Shanghai"
    ]
}
```

**开发环境**（`~/.manyoyo/run/dev.json`）：
```json5
{
    "containerName": "my-dev",
    "envFile": [
        "anthropic_dev"
    ],
    "env": [
        "NODE_ENV=development",
        "DEBUG=*"
    ],
    "yolo": "c"
}
```

**测试环境**（`~/.manyoyo/run/test.json`）：
```json5
{
    "containerName": "my-test",
    "envFile": [
        "anthropic_test"
    ],
    "env": [
        "NODE_ENV=test",
        "CI=true"
    ],
    "yolo": "c"
}
```

**生产环境**（`~/.manyoyo/run/prod.json`）：
```json5
{
    "containerName": "my-prod",
    "envFile": [
        "anthropic_prod"
    ],
    "env": [
        "NODE_ENV=production"
    ],
    "yolo": "c",
    "quiet": ["tip", "cmd"]  // 生产环境静默输出
}
```

**使用**：
```bash
manyoyo -r dev   # 开发环境
manyoyo -r test  # 测试环境
manyoyo -r prod  # 生产环境
```

## 项目特定配置示例

### Web 项目配置

**项目配置**（`./myproject/.manyoyo.json`）：
```json5
{
    "containerName": "my-webapp",
    "envFile": [
        "anthropic_claudecode"
    ],
    "env": [
        "PROJECT_NAME=webapp",
        "NODE_ENV=development"
    ],
    "volumes": [
        "./node_modules:/workspace/node_modules",
        "./dist:/workspace/dist"
    ],
    "yolo": "c"
}
```

**使用**：
```bash
cd myproject
manyoyo -r ./.manyoyo.json
```

### 数据科学项目配置

**项目配置**（`./ml-project/.manyoyo.json`）：
```json5
{
    "containerName": "my-ml",
    "envFile": [
        "anthropic_claudecode"
    ],
    "env": [
        "JUPYTER_ENABLE_LAB=yes",
        "PYTHONPATH=/workspace"
    ],
    "volumes": [
        "./data:/workspace/data:ro",     // 数据目录（只读）
        "./models:/workspace/models",    // 模型目录
        "./notebooks:/workspace/notebooks"
    ],
    "yolo": "c"
}
```

## 组合配置示例

### 多个环境文件组合

**基础环境**（`~/.manyoyo/env/base.env`）：
```bash
# 通用配置
export TZ=Asia/Shanghai
export LANG=en_US.UTF-8
```

**API 配置**（`~/.manyoyo/env/anthropic_base.env`）：
```bash
# API 基础配置
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export API_TIMEOUT_MS=3000000
export ANTHROPIC_MODEL="claude-sonnet-4-5"
```

**密钥配置**（`~/.manyoyo/env/anthropic_secrets.env`）：
```bash
# 敏感信息（不提交到版本控制）
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
```

**运行配置**（`~/.manyoyo/run/claude-full.json`）：
```json5
{
    "envFile": [
        "base",              // 通用配置
        "anthropic_base",    // API 配置
        "anthropic_secrets"  // 密钥（后加载，会覆盖前面的同名变量）
    ],
    "yolo": "c"
}
```

### 全局 + 运行 + 命令行组合

**全局配置**（`~/.manyoyo/manyoyo.json`）：
```json5
{
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.7.0-full",
    "env": [
        "TZ=Asia/Shanghai"  // 全局环境变量
    ]
}
```

**运行配置**（`~/.manyoyo/run/claude.json`）：
```json5
{
    "envFile": [
        "anthropic_claudecode"
    ],
    "env": [
        "DEBUG=false"  // 运行配置环境变量（与全局合并）
    ],
    "yolo": "c"
}
```

**命令行**：
```bash
# 命令行环境变量（与全局和运行配置合并）
manyoyo -r claude -e "LOG_LEVEL=debug"

# 最终环境变量：
# - TZ=Asia/Shanghai（来自全局）
# - DEBUG=false（来自运行配置）
# - LOG_LEVEL=debug（来自命令行）
# - ANTHROPIC_* （来自 anthropic_claudecode.env）
```

## 自定义镜像配置示例

### 使用自定义镜像

**全局配置**：
```json5
{
    "imageName": "localhost/myuser/custom-manyoyo",
    "imageVersion": "2.0.0-full"
}
```

**构建自定义镜像**：
```bash
manyoyo --ib --in myuser/custom-manyoyo --iv 2.0.0 --iba TOOL=full
```

### 最小化镜像配置

**全局配置**：
```json5
{
    "imageVersion": "1.7.0-common"  // 使用精简版镜像
}
```

**构建精简镜像**：
```bash
manyoyo --ib --iv 1.7.0 --iba TOOL=common
```

## 团队协作配置示例

### 配置模板

**团队共享配置模板**（`config.example.json`）：
```json5
{
    // 团队统一镜像
    "imageName": "localhost/team/manyoyo",
    "imageVersion": "1.7.0-full",

    // 项目环境变量
    "env": [
        "PROJECT_NAME=team-project",
        "NODE_ENV=development"
    ],

    // 环境文件（需要复制示例文件并配置）
    "envFile": [
        "anthropic_team"  // 参考 anthropic_team.example.env
    ]
}
```

**使用方式**：
```bash
# 团队成员首次使用
cp config.example.json ~/.manyoyo/run/team.json
cp anthropic_team.example.env ~/.manyoyo/env/anthropic_team.env

# 编辑配置（填入自己的 API Key）
vim ~/.manyoyo/env/anthropic_team.env

# 使用团队配置
manyoyo -r team
```

## 调试配置示例

### 查看最终配置

```bash
# 查看配置合并结果
manyoyo -r claude --show-config

# 查看将要执行的命令
manyoyo -r claude --show-command

# 查看环境变量
manyoyo -r claude -x env | grep ANTHROPIC
```

### 启用详细日志

**运行配置**：
```json5
{
    "envFile": [
        "anthropic_claudecode"
    ],
    "env": [
        "DEBUG=*",           // 启用所有调试日志
        "LOG_LEVEL=debug"
    ],
    "yolo": "c"
}
```

## 最佳实践总结

### 1. 文件组织

```bash
~/.manyoyo/
├── manyoyo.json                                   # 全局配置
├── env/                                            # 环境变量目录
│   ├── base.env                                   # 通用环境变量
│   ├── anthropic_[claudecode]_claudecode.env      # Claude 配置
│   ├── anthropic_secrets.env                      # 密钥（不提交）
│   ├── openai_[gpt]_codex.env                    # Codex 配置
│   └── gemini.env                                 # Gemini 配置
└── run/                                            # 运行配置目录
    ├── claude.json                                # Claude 运行配置
    ├── codex.json                                 # Codex 运行配置
    ├── gemini.json                                # Gemini 运行配置
    ├── dev.json                                   # 开发环境配置
    ├── test.json                                  # 测试环境配置
    └── prod.json                                  # 生产环境配置
```

### 2. 命名规范

- 环境文件：`<provider>_[<tool>]_<purpose>.env`
- 运行配置：`<tool>.json` 或 `<env>_<tool>.json`
- 使用描述性名称，便于理解和维护

### 3. 安全实践

- 敏感信息单独存放在 `*_secrets.env`
- 不要将包含密钥的文件提交到版本控制
- 使用 `.gitignore` 排除敏感文件
- 提供示例配置文件（`.example` 后缀）

### 4. 配置分层

```
全局配置（~/.manyoyo/manyoyo.json）
  ↓ 通用设置（镜像、时区等）
运行配置（~/.manyoyo/run/*.json）
  ↓ 工具/环境特定设置
命令行参数
  ↓ 临时覆盖和调试
```

## 相关文档

- [配置系统概览](./index) - 了解配置原理
- [环境变量详解](./environment) - 深入了解环境变量
- [配置文件详解](./config-files) - 学习所有配置选项
