# <p align="center"><a href="https://github.com/xcanwin/manyoyo">MANYOYO（慢悠悠）</a></p>
<p align="center">一款AI智能体安全沙箱，保障PC安全，可以随心所欲运行YOLO/SOLO模式。</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@xcanwin/manyoyo"><img alt="npm" src="https://img.shields.io/npm/v/@xcanwin/manyoyo?style=flat-square" /></a>
  <a href="https://github.com/xcanwin/manyoyo/actions/workflows/npm-publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/xcanwin/manyoyo/npm-publish.yml?style=flat-square" /></a>
  <a href="https://github.com/xcanwin/manyoyo/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

<p align="center">
  <a href="README.md"><b>中文</b></a> |
  <a href="docs/README_EN.md">English</a>
</p>
<p align="center">
  📚 在线文档：<a href="https://xcanwin.github.io/manyoyo/">https://xcanwin.github.io/manyoyo/</a>
</p>

---

## 2 分钟快速开始

**Docker 用户：**
```bash
npm install -g @xcanwin/manyoyo    # 安装
manyoyo --ib --iv 1.7.0            # 构建镜像
manyoyo -y c                        # 运行 Claude Code YOLO 模式
```

**Podman 用户：**
```bash
npm install -g @xcanwin/manyoyo    # 安装
podman pull ubuntu:24.04           # 拉取基础镜像
manyoyo --ib --iv 1.7.0            # 构建镜像
manyoyo -y c                        # 运行 Claude Code YOLO 模式
```

---

**MANYOYO** 是一款 AI 智能体提效安全沙箱，安全、高效、省 token，专为 Agent YOLO 模式设计，保障宿主机安全。

预装常见 Agent 与工具，进一步节省 token。循环自由切换 Agent 和 `/bin/bash`，进一步提效。

**MANYOYO** 提供隔离的 Docker/Podman 容器环境，用于安全运行 AI 智能体命令行工具。

## 功能亮点

- **多智能体支持**：支持 claude code, gemini, codex, opencode
- **安全隔离**：保护宿主机，支持安全容器嵌套（Docker-in-Docker）
- **快速启动**：快捷开启常见 Agent YOLO / SOLO 模式（例如 claude --dangerously-skip-permissions）
- **便捷操作**：快速进入 `/bin/bash`
- **会话恢复**：安装 Skills Marketplace 可快速恢复会话
- **灵活自定义**：支持自定义 `BASEURL`、`AUTH_TOKEN` 等变量
- **配置管理**：快捷导入配置文件
- **高级模式**：支持危险容器嵌套（mount-docker-socket）、自定义沙箱镜像

## 文档站开发

```bash
# 本地开发
npm run docs:dev

# 构建文档
npm run docs:build

# 预览构建产物
npm run docs:preview
```

文档基于 VitePress 构建，并通过 GitHub Actions 自动部署到 GitHub Pages。
首次启用时，请在 GitHub 仓库 `Settings -> Pages` 中将 Source 设为 `GitHub Actions`。
也可以配置仓库 Secret `PAGES_ADMIN_TOKEN`（PAT，含 Pages/Administration 写权限）让工作流自动启用 Pages。

# 使用方法

## 1. 安装 manyoyo

### 全局安装（推荐）

```bash
npm install -g @xcanwin/manyoyo
```

### 本地开发

```bash
npm install -g .
```

## 2. 安装 podman

2.1 安装 [podman](https://podman.io/docs/installation)

2.2 拉取基础镜像

```bash
podman pull ubuntu:24.04
```

## 3. 编译镜像

以下命令只需执行一条：

```bash
# 使用 manyoyo 构建镜像（推荐，自动使用缓存加速）
manyoyo --ib --iv 1.7.0                          # 默认构建 full 版本（推荐，建议指定版本号）
manyoyo --ib --iba TOOL=common                   # 构建常见组件版本（python,nodejs,claude）
manyoyo --ib --iba TOOL=go,codex,java,gemini     # 构建自定义组件版本
manyoyo --ib --iba GIT_SSL_NO_VERIFY=true        # 构建 full 版本且跳过git的ssl验证
manyoyo --ib --in myimage --iv 2.0.0             # 自定义镜像名称和版本，得到 myimage:2.0.0-full
# 工作原理：
# - 首次构建：自动下载 Node.js、JDT LSP、gopls 等到 docker/cache/
# - 2天内再次构建：直接使用本地缓存，速度提升约 5 倍
# - 缓存过期后：自动重新下载最新版本

# 或手动构建（不推荐）
iv=1.0.0 && podman build -t localhost/xcanwin/manyoyo:$iv-full -f docker/manyoyo.Dockerfile . --build-arg TOOL=full --no-cache
```

## 4. 使用方法

### 基础命令

```bash
# 显示帮助
manyoyo -h

# 显示版本
manyoyo -V

# 列出所有容器
manyoyo -l

# 创建新容器并使用环境文件
manyoyo -n test --ef .env -y c

# 恢复现有会话
manyoyo -n test -- -c                 # Claude Code
manyoyo -n test -- resume --last      # Codex
manyoyo -n test -- -r                 # Gemini
manyoyo -n test -- -c                 # OpenCode

# 在交互式 shell 中执行命令
manyoyo -n test -x /bin/bash

# 执行自定义命令
manyoyo -n test -x echo "hello world"

# 删除容器
manyoyo -n test --crm

# 清理悬空镜像和 <none> 镜像
manyoyo --irm

# 静默显示执行命令
manyoyo -q full -x echo "hello world"
manyoyo -q tip -q cmd -x echo "hello world"  # 多次使用静默选项
```

### 环境变量

给容器内CLI传递BASE_URL和TOKEN等。

#### 字符串形式

```bash
manyoyo -e "ANTHROPIC_BASE_URL=https://xxxx" -e "ANTHROPIC_AUTH_TOKEN=your-key" -x claude
```

#### 文件形式

环境文件使用 `.env` 格式，支持注释（以 `#` 开头的行）：

```bash
export ANTHROPIC_BASE_URL="https://xxxx"
AUTH_TOANTHROPIC_AUTH_TOKEN=your-key
# MESSAGE="Hello World"  # 注释会被忽略
TESTPATH='/usr/local/bin'
```

**环境文件路径规则**：
- `manyoyo --ef myconfig` → 加载 `~/.manyoyo/env/myconfig.env`
- `manyoyo --ef ./myconfig.env` → 加载当前目录的 `myconfig.env`

#### 常用样例-Claude Code

```bash
# 创建环境文件目录
mkdir -p ~/.manyoyo/env/

# 示例：创建 Claude 环境文件
cat > ~/.manyoyo/env/anthropic_[claudecode]_claudecode.env << 'EOF'
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
# export CLAUDE_CODE_OAUTH_TOKEN="sk-xxxxxxxx"
export ANTHROPIC_AUTH_TOKEN="sk-xxxxxxxx"
export API_TIMEOUT_MS=3000000
export ANTHROPIC_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-5"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-5"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5"
export CLAUDE_CODE_SUBAGENT_MODEL="claude-sonnet-4-5"
EOF

# 在任意目录下使用环境文件
manyoyo --ef anthropic_[claudecode]_claudecode -x claude
```

#### 常用样例-Codex

```bash
# 创建环境文件目录
mkdir -p ~/.manyoyo/env/

# 示例：创建 Codex 环境文件
cat > ~/.manyoyo/env/openai_[gpt]_codex.env << 'EOF'
export OPENAI_BASE_URL=https://chatgpt.com/backend-api/codex
export OTEL_SDK_DISABLED=true
EOF

# 在任意目录下使用环境文件
manyoyo --ef openai_[gpt]_codex -x codex
```

### 配置文件

简化MANYOYO命令行操作。配置文件使用 **JSON5 格式**，支持注释、尾随逗号等特性。

#### 配置文件路径规则

- `manyoyo -r myconfig` → 加载 `~/.manyoyo/run/myconfig.json`
- `manyoyo -r ./myconfig.json` → 加载当前目录的 `myconfig.json`
- `manyoyo [任何选项]` → 始终会加载全局配置 `~/.manyoyo/manyoyo.json`

#### 配置选项

参考 `config.example.json` 文件查看所有可配置项：

```json5
{
    // 容器基础配置
    "containerName": "myy-dev",          // 默认容器名称
    "hostPath": "/path/to/project",      // 默认宿主机工作目录
    "containerPath": "/path/to/project", // 默认容器工作目录
    "imageName": "localhost/xcanwin/manyoyo",  // 默认镜像名称
    "imageVersion": "1.7.0-full",        // 默认镜像版本
    "containerMode": "common",           // 容器嵌套模式 (common, dind, sock)

    // 环境变量配置
    "envFile": [
        "claude"  // 对应 ~/.manyoyo/env/claude.env
    ],
    "env": [],                           // 默认环境变量数组

    // 其他配置
    "volumes": [],                       // 默认挂载卷数组
    "shellPrefix": "",                   // 默认命令前缀
    "shell": "",                         // 默认执行命令
    "yolo": "",                          // 默认 YOLO 模式 (c, gm, cx, oc)
    "quiet": [],                           // 默认静默选项数组 (支持 ["tip", "cmd"] 格式)
    "imageBuildArgs": []                 // 默认镜像构建参数
}
```

#### 优先级

- **覆盖型参数**：命令行 > 运行配置 > 全局配置 > 默认值
- **合并型参数**：全局配置 + 运行配置 + 命令行（按顺序累加）

#### 配置合并规则表

| 参数类型 | 参数名 | 合并行为 | 示例 |
|---------|--------|---------|------|
| 覆盖型 | `containerName` | 取最高优先级的值 | CLI `-n test` 覆盖配置文件中的值 |
| 覆盖型 | `hostPath` | 取最高优先级的值 | 默认为当前目录 |
| 覆盖型 | `containerPath` | 取最高优先级的值 | 默认与 hostPath 相同 |
| 覆盖型 | `imageName` | 取最高优先级的值 | 默认 `localhost/xcanwin/manyoyo` |
| 覆盖型 | `imageVersion` | 取最高优先级的值 | 如 `1.7.0-full` |
| 覆盖型 | `containerMode` | 取最高优先级的值 | `common`, `dind`, `sock` |
| 覆盖型 | `yolo` | 取最高优先级的值 | `c`, `gm`, `cx`, `oc` |
| 合并型 | `env` | 数组累加合并 | 全局 + 运行配置 + CLI 的所有值 |
| 合并型 | `envFile` | 数组累加合并 | 所有环境文件依次加载 |
| 合并型 | `volumes` | 数组累加合并 | 所有挂载卷生效 |
| 合并型 | `imageBuildArgs` | 数组累加合并 | 所有构建参数生效 |

#### 常用样例-全局

```bash
mkdir -p ~/.manyoyo/

cat > ~/.manyoyo/manyoyo.json << 'EOF'
{
    "imageName": "localhost/xcanwin/manyoyo",
    "imageVersion": "1.7.0-full"
}
EOF
```

#### 常用样例-Claude Code

```bash
mkdir -p ~/.manyoyo/run/

cat > ~/.manyoyo/run/claude.json << 'EOF'
{
    "envFile": [
        "anthropic_[claudecode]_claudecode"  // 自动加载 ~/.manyoyo/env/claude.env
    ],
    "yolo": "c"
}
EOF

# 在任意目录下使用运行配置
manyoyo -r claude
```

#### 常用样例-Codex

```bash
mkdir -p ~/.manyoyo/run/

cat > ~/.manyoyo/run/codex.json << 'EOF'
{
    "envFile": [
        "openai_[gpt]_codex"
    ],
    "volumes": [
        "/Users/pc_user/.codex/auth.json:/root/.codex/auth.json"
    ],
    "yolo": "cx"
}
EOF

# 在任意目录下使用运行配置
manyoyo -r codex
```

### AI CLI 快捷方式（跳过权限确认）

```bash
# Claude Code
manyoyo -y c          # 或: claude, cc

# Gemini
manyoyo -y gm         # 或: gemini, g

# Codex
manyoyo -y cx         # 或: codex

# OpenCode
manyoyo -y oc         # 或: opencode
```

### 交互式会话管理

退出容器会话后，系统将提示您选择操作：

- `y` - 保持容器在后台运行（默认）
- `n` - 删除容器
- `1` - 使用首次命令重新进入
- `x` - 执行新命令
- `i` - 进入交互式 shell

### 容器模式

#### Docker-in-Docker 开发

```bash
# Docker-in-Docker（安全的嵌套容器）
# 创建支持 Docker-in-Docker 的容器
manyoyo -n docker-dev -m dind -x /bin/bash

podman ps -a             # 现在可以在容器内使用 podman 命令

nohup dockerd &          # 在容器内启动 dockerd
docker ps -a             # 现在可以在容器内使用 docker 命令
```

#### 挂载 Docker Socket 开发

```bash
# 挂载 Docker Socket（危险的！！！容器可以访问和执行宿主机的一切）
# 创建挂载 /var/run/docker.sock 的容器
manyoyo -n socket-dev -m sock -x /bin/bash

podman ps -a             # 现在可以在容器内使用 podman 命令

docker ps -a             # 现在可以在容器内使用 docker 命令
```

### 命令行选项

| 选项 | 别名 | 描述 |
|------|------|------|
| `--hp PATH` | `--host-path` | 设置宿主机工作目录（默认：当前路径） |
| `-n NAME` | `--cont-name` | 设置容器名称 |
| `--cp PATH` | `--cont-path` | 设置容器工作目录 |
| `-l` | `--cont-list` | 列出所有 manyoyo 容器 |
| `--crm` | `--cont-remove` | 删除容器 |
| `-m MODE` | `--cont-mode` | 设置容器模式（common, dind, sock） |
| `--in NAME` | `--image-name` | 指定镜像名称 |
| `--iv VERSION` | `--image-ver` | 指定镜像版本 |
| `--ib` | `--image-build` | 构建镜像 |
| `--iba XXX=YYY` | `--image-build-arg` | 构建镜像时传参给dockerfile |
| `--irm` | `--image-remove` | 清理悬空镜像和 `<none>` 镜像 |
| `-e STRING` | `--env` | 设置环境变量 |
| `--ef FILE` | `--env-file` | 从文件加载环境变量（支持 `name` 或 `./path.env`） |
| `-v STRING` | `--volume` | 绑定挂载卷 |
| `--sp CMD` | `--shell-prefix` | 临时环境变量（作为 -s 的前缀） |
| `-s CMD` | `--shell` | 指定要执行的命令 |
| `--` | `--ss`, `--shell-suffix` | 命令参数（作为 -s 的后缀） |
| `-x CMD` | `--sf`, `--shell-full` | 完整命令（替代 --sp, -s 和 --） |
| `-y CLI` | `--yolo` | 无需确认运行 AI 智能体 |
| `--show-config` | | 显示最终生效配置并退出 |
| `--show-command` | | 显示将执行的命令并退出（存在容器时为 docker exec，不存在时为 docker run） |
| `--yes` | | 所有提示自动确认（用于CI/脚本） |
| `--rm-on-exit` | | 退出后自动删除容器（一次性模式） |
| `--install NAME` | | 安装 manyoyo 命令 |
| `-q LIST` | `--quiet` | 静默显示 |
| `-r NAME` | `--run` | 加载运行配置（支持 `name` 或 `./path.json`） |
| `-V` | `--version` | 显示版本 |
| `-h` | `--help` | 显示帮助 |

## 其他说明

### 默认配置

- **容器名称**：`myy-{月日-时分}`（基于当前时间自动生成）
- **宿主机路径**：当前工作目录
- **容器路径**：与宿主机路径相同
- **镜像**：`localhost/xcanwin/manyoyo:xxx`

### 系统要求

- Node.js >= 22.0.0
- Podman 或 Docker

### 卸载

```bash
npm uninstall -g @xcanwin/manyoyo
```

## 故障排查 FAQ

### 镜像构建失败

**问题**：执行 `manyoyo --ib` 时报错

**解决方案**：
1. 检查网络连接：`curl -I https://mirrors.tencent.com`
2. 检查磁盘空间：`df -h`（需要至少 10GB 可用空间）
3. 使用 `--yes` 跳过确认：`manyoyo --ib --iv 1.7.0 --yes`
4. 如果在国外，可能需要修改镜像源（配置文件中设置 `nodeMirror`）

### 镜像拉取失败

**问题**：提示 `pinging container registry localhost failed`

**解决方案**：
1. 本地镜像需要先构建：`manyoyo --ib --iv 1.7.0`
2. 或修改配置文件 `~/.manyoyo/manyoyo.json` 中的 `imageVersion`

### 容器启动失败

**问题**：容器无法启动或立即退出

**解决方案**：
1. 查看容器日志：`docker logs <容器名>`
2. 检查端口冲突：`docker ps -a`
3. 检查权限问题：确保当前用户有 Docker/Podman 权限

### 权限不足

**问题**：提示 `permission denied` 或无法访问 Docker

**解决方案**：
1. 将用户添加到 docker 组：`sudo usermod -aG docker $USER`
2. 重新登录或运行：`newgrp docker`
3. 或使用 `sudo` 运行命令

### 环境变量未生效

**问题**：容器内无法读取设置的环境变量

**解决方案**：
1. 检查环境文件格式（支持 `KEY=VALUE` 或 `export KEY=VALUE`）
2. 确认文件路径正确（`--ef name` 对应 `~/.manyoyo/env/name.env`）
3. 使用 `--show-config` 查看最终生效的配置

## 许可证

MIT
