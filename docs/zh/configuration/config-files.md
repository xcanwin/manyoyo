# 配置文件详解

配置文件用于简化 MANYOYO 命令行操作，避免重复输入参数。使用 **JSON5 格式**，支持注释和更好的可读性。

## 配置文件类型

MANYOYO 支持两种配置文件：

### 1. 全局配置

**文件路径**：`~/.manyoyo/manyoyo.json`

**特点**：
- 自动加载（运行任何 manyoyo 命令时）
- 适合设置默认镜像、通用环境变量等
- 优先级最低

**示例**：
```json5
{
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.7.0-full"
}
```

### 2. 运行配置

**文件路径**：
- `~/.manyoyo/run/<name>.json`（使用 `-r <name>`）
- 或自定义路径（使用 `-r ./path.json`）

**特点**：
- 需要显式加载（使用 `-r` 参数）
- 适合设置特定项目或工具的配置
- 优先级高于全局配置

**示例**：
```json5
{
    "envFile": ["anthropic_claudecode"],
    "yolo": "c"
}
```

## 配置选项详解

参考 `config.example.json` 查看所有可配置项。以下是详细说明：

### 容器基础配置

#### containerName
- **类型**：字符串
- **默认值**：`myy-{月日-时分}`（自动生成）
- **说明**：容器名称，用于标识和管理容器
- **示例**：
```json5
{
    "containerName": "myy-dev"
}
```

#### hostPath
- **类型**：字符串
- **默认值**：当前工作目录
- **说明**：宿主机工作目录，会挂载到容器中
- **示例**：
```json5
{
    "hostPath": "/Users/username/projects/myproject"
}
```

#### containerPath
- **类型**：字符串
- **默认值**：与 hostPath 相同
- **说明**：容器内的工作目录
- **示例**：
```json5
{
    "containerPath": "/workspace/myproject"
}
```

#### imageName
- **类型**：字符串
- **默认值**：`localhost/xcanwin/manyoyo`
- **说明**：镜像名称（不含版本号）
- **示例**：
```json5
{
    "imageName": "localhost/myuser/manyoyo"
}
```

#### imageVersion
- **类型**：字符串
- **默认值**：无
- **说明**：镜像版本标签
- **格式**：`<version>-<variant>`
- **示例**：
```json5
{
    "imageVersion": "1.7.0-full"  // full 版本包含所有工具
}
```

可用的变体：
- `full` - 完整版本（推荐）
- `common` - 常用工具版本
- 自定义 - 使用 `--iba TOOL=xxx` 构建

#### containerMode
- **类型**：字符串
- **可选值**：`common`, `dind`, `sock`
- **默认值**：`common`
- **说明**：容器嵌套模式
- **示例**：
```json5
{
    "containerMode": "dind"  // Docker-in-Docker 模式
}
```

模式说明：
- `common` - 普通模式，无容器嵌套能力
- `dind` - Docker-in-Docker 模式，安全的嵌套容器
- `sock` - 挂载 Docker Socket 模式（危险，可访问宿主机一切）

### 环境变量配置

#### envFile
- **类型**：字符串数组
- **合并方式**：累加合并
- **说明**：环境文件列表，按顺序加载
- **示例**：
```json5
{
    "envFile": [
        "anthropic_claudecode",  // 加载 ~/.manyoyo/env/anthropic_claudecode.env
        "secrets"                // 加载 ~/.manyoyo/env/secrets.env
    ]
}
```

#### env
- **类型**：字符串数组
- **合并方式**：累加合并
- **说明**：直接指定环境变量
- **示例**：
```json5
{
    "env": [
        "DEBUG=true",
        "LOG_LEVEL=info"
    ]
}
```

### 挂载卷配置

#### volumes
- **类型**：字符串数组
- **合并方式**：累加合并
- **说明**：额外的挂载卷
- **格式**：`宿主机路径:容器路径[:选项]`
- **示例**：
```json5
{
    "volumes": [
        "/Users/pc_user/.codex/auth.json:/root/.codex/auth.json",
        "/tmp/cache:/workspace/cache:ro"  // 只读挂载
    ]
}
```

### 命令配置

#### shellPrefix
- **类型**：字符串
- **说明**：命令前缀，通常用于设置临时环境变量
- **示例**：
```json5
{
    "shellPrefix": "DEBUG=1"
}
```

#### shell
- **类型**：字符串
- **说明**：要执行的主命令
- **示例**：
```json5
{
    "shell": "claude"
}
```

#### yolo
- **类型**：字符串
- **可选值**：`c`, `gm`, `cx`, `oc`（或完整名称 `claude`, `gemini`, `codex`, `opencode`）
- **说明**：YOLO 模式快捷方式，跳过权限确认
- **示例**：
```json5
{
    "yolo": "c"  // 等同于 claude --dangerously-skip-permissions
}
```

### 其他配置

#### quiet
- **类型**：字符串数组
- **可选值**：`tip`, `cmd`, `full`
- **说明**：静默显示选项
- **示例**：
```json5
{
    "quiet": ["tip", "cmd"]  // 不显示提示和命令
}
```

#### imageBuildArgs
- **类型**：字符串数组
- **合并方式**：累加合并
- **说明**：镜像构建参数，传递给 Dockerfile
- **格式**：`KEY=VALUE`
- **示例**：
```json5
{
    "imageBuildArgs": [
        "TOOL=common",
        "GIT_SSL_NO_VERIFY=true"
    ]
}
```

## 配置路径规则

### 运行配置路径解析

```bash
# 短名称（推荐）
manyoyo -r claude
# 加载：~/.manyoyo/run/claude.json

# 相对路径
manyoyo -r ./config.json
# 加载：当前目录的 config.json

# 绝对路径
manyoyo -r /abs/path/config.json
# 加载：指定路径的配置文件
```

### 全局配置

全局配置始终从固定位置加载：
```bash
~/.manyoyo/manyoyo.json
```

## 配置合并规则

参考[配置系统概览](./index#优先级机制)了解详细的合并规则。

简要说明：

### 覆盖型参数
取最高优先级的值：
```
命令行参数 > 运行配置 > 全局配置 > 默认值
```

### 合并型参数
按顺序累加合并：
```
全局配置 + 运行配置 + 命令行参数
```

## 完整配置示例

### 示例：全局配置

```json5
// ~/.manyoyo/manyoyo.json
{
    // 使用自定义镜像
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.7.0-full",

    // 全局环境变量
    "env": [
        "TZ=Asia/Shanghai",
        "LANG=en_US.UTF-8"
    ],

    // 默认静默提示
    "quiet": ["tip"]
}
```

### 示例：Claude Code 运行配置

```json5
// ~/.manyoyo/run/claude.json
{
    // 加载 Claude 环境变量
    "envFile": [
        "anthropic_claudecode"
    ],

    // 使用 YOLO 模式
    "yolo": "c",

    // 额外挂载 SSH 配置
    "volumes": [
        "~/.ssh:/root/.ssh:ro"
    ]
}
```

### 示例：Codex 运行配置

```json5
// ~/.manyoyo/run/codex.json
{
    // 加载 Codex 环境变量
    "envFile": [
        "openai_[gpt]_codex"
    ],

    // 挂载认证文件
    "volumes": [
        "/Users/pc_user/.codex/auth.json:/root/.codex/auth.json"
    ],

    // 使用 YOLO 模式
    "yolo": "cx"
}
```

### 示例：Docker-in-Docker 配置

```json5
// ~/.manyoyo/run/dind.json
{
    // 使用 Docker-in-Docker 模式
    "containerMode": "dind",

    // 容器名称
    "containerName": "myy-dind",

    // 额外挂载 Docker 配置
    "volumes": [
        "~/.docker:/root/.docker:ro"
    ]
}
```

### 示例：项目特定配置

```json5
// ./myproject/.manyoyo.json
{
    // 项目容器名称
    "containerName": "myy-myproject",

    // 项目环境变量
    "env": [
        "PROJECT_NAME=myproject",
        "NODE_ENV=development"
    ],

    // 使用项目本地环境文件
    "envFile": [
        "./local.env"
    ]
}
```

## 调试配置

### 查看最终配置

```bash
# 显示所有配置源的合并结果
manyoyo --show-config

# 显示特定运行配置的合并结果
manyoyo -r claude --show-config

# 显示将要执行的命令
manyoyo -r claude --show-command
```

### 常见配置问题

#### 配置未生效

**症状**：修改配置文件后，参数没有生效

**解决方案**：
1. 检查配置文件格式（必须是有效的 JSON5）
2. 确认文件路径正确
3. 使用 `--show-config` 查看最终配置
4. 注意覆盖型参数只取最高优先级的值

```bash
# 验证配置格式
cat ~/.manyoyo/run/claude.json | jq .

# 查看最终配置
manyoyo -r claude --show-config
```

#### 配置冲突

**症状**：多个配置源设置了同一参数，不确定哪个生效

**解决方案**：
1. 理解优先级规则（覆盖型 vs 合并型）
2. 使用 `--show-config` 查看最终值
3. 必要时移除低优先级配置中的冲突项

#### 环境变量未加载

**症状**：配置文件中指定了 envFile，但环境变量未生效

**解决方案**：
1. 确认环境文件路径正确
2. 检查环境文件格式
3. 使用 `--show-config` 查看加载的环境文件列表
4. 在容器中运行 `env` 命令验证

```bash
# 查看配置中的环境文件
manyoyo -r claude --show-config | grep envFile

# 在容器中验证环境变量
manyoyo -r claude -x env | grep ANTHROPIC
```

## 最佳实践

### 1. 分层配置

```bash
# 全局配置：设置通用选项
~/.manyoyo/manyoyo.json

# 运行配置：设置工具特定选项
~/.manyoyo/run/claude.json
~/.manyoyo/run/codex.json

# 项目配置：设置项目特定选项
./project/.manyoyo.json
```

### 2. 使用注释

```json5
{
    // 生产环境配置
    "imageVersion": "1.7.0-full",

    // 开发时可以临时切换
    // "imageVersion": "1.6.0-common",

    "envFile": [
        "anthropic_base",    // 基础配置
        "anthropic_secrets"  // 敏感信息
    ]
}
```

### 3. 版本控制

```bash
# 提交到版本控制
.manyoyo.json           # 项目配置
config.example.json     # 配置示例

# 排除敏感信息
.gitignore:
  *.env
  secrets.json
```

### 4. 配置模板

创建配置模板供团队使用：
```bash
# 复制示例配置
cp ~/.manyoyo/run/claude.example.json ~/.manyoyo/run/claude.json

# 编辑配置
vim ~/.manyoyo/run/claude.json
```

## 相关文档

- [配置系统概览](./index) - 了解配置优先级机制
- [环境变量详解](./environment) - 学习如何配置环境变量
- [配置示例](./examples) - 查看更多实用示例
