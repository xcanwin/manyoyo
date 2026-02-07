# 基础用法

本页面介绍 MANYOYO 的基本使用方法，包括常用命令、容器管理和日常操作。

## 帮助和版本信息

### 查看帮助

```bash
# 显示帮助信息
manyoyo -h
manyoyo --help

# 显示简短帮助
manyoyo
```

### 查看版本

```bash
# 显示 MANYOYO 版本
manyoyo -V
manyoyo --version
```

## 容器管理

### 列出容器

```bash
# 列出所有 MANYOYO 容器
manyoyo -l
manyoyo --cont-list

# 使用 Docker/Podman 命令查看
docker ps -a | grep myy
podman ps -a | grep myy
```

### 创建容器

```bash
# 创建并运行容器（自动生成容器名）
manyoyo -x echo "Hello MANYOYO"

# 指定容器名称
manyoyo -n myy-dev -x /bin/bash

# 使用时间戳容器名（默认）
manyoyo -y c  # 自动生成名称如 myy-0204-1430
```

### 删除容器

```bash
# 删除指定容器
manyoyo -n myy-dev --crm
manyoyo -n myy-dev --cont-remove

# 退出时自动删除（一次性模式）
manyoyo -n temp --rm-on-exit -x /bin/bash
```

### 容器状态

```bash
# 查看运行中的容器
docker ps  # 或 podman ps

# 查看所有容器（包括已停止）
docker ps -a

# 查看容器详细信息
docker inspect <容器名>
docker logs <容器名>
```

## 运行命令

### 基本命令执行

```bash
# 执行单个命令
manyoyo -x echo "Hello World"

# 执行多个命令（使用 && 连接）
manyoyo -x 'echo "Start" && ls -la && echo "End"'

# 使用完整命令（-x 或 --shell-full）
manyoyo --sf 'python3 --version'
```

### 交互式 Shell

```bash
# 进入交互式 bash
manyoyo -x /bin/bash

# 在现有容器中进入 shell
manyoyo -n myy-dev -x /bin/bash

# 指定工作目录
manyoyo --hp /path/to/project -x /bin/bash
```

### 命令组合

MANYOYO 支持三种方式组合命令：

#### 1. 使用 --shell-full（推荐）

```bash
# 完整命令
manyoyo -x 'claude --version'
```

#### 2. 使用 --shell-prefix, --shell, --

```bash
# 设置环境变量 + 命令 + 参数
manyoyo --sp 'DEBUG=1' -s claude -- --version

# 等同于：DEBUG=1 claude --version
```

#### 3. 分步设置

```bash
# 仅设置命令
manyoyo -s claude

# 添加前缀
manyoyo --sp 'DEBUG=1' -s claude

# 添加后缀参数
manyoyo -s claude -- --help
```

## AI CLI 快捷方式

MANYOYO 提供快捷方式启动 AI CLI 工具的 YOLO/SOLO 模式（跳过权限确认）。

### Claude Code

```bash
# 使用快捷方式
manyoyo -y c          # 推荐
manyoyo -y claude
manyoyo -y cc

# 等同于
manyoyo -x claude --dangerously-skip-permissions
```

### Gemini

```bash
# 使用快捷方式
manyoyo -y gm         # 推荐
manyoyo -y gemini
manyoyo -y g

# 等同于
manyoyo -x gemini --yolo
```

### Codex

```bash
# 使用快捷方式
manyoyo -y cx         # 推荐
manyoyo -y codex

# 等同于
manyoyo -x codex --dangerously-bypass-approvals-and-sandbox
```

### OpenCode

```bash
# 使用快捷方式
manyoyo -y oc         # 推荐
manyoyo -y opencode

# 等同于
manyoyo -x "OPENCODE_PERMISSION='{\"*\":\"allow\"}' opencode"
```

## 环境变量和配置

### 使用环境变量

```bash
# 字符串形式（-e 参数）
manyoyo -e "ANTHROPIC_BASE_URL=https://api.anthropic.com" \
        -e "ANTHROPIC_AUTH_TOKEN=sk-xxx" \
        -x claude

# 多个环境变量
manyoyo -e "VAR1=value1" \
        -e "VAR2=value2" \
        -e "VAR3=value3" \
        -x /bin/bash
```

### 使用环境文件

```bash
# 加载环境文件
manyoyo --ef anthropic_claudecode -x claude

# 加载多个环境文件
manyoyo --ef base --ef anthropic_secrets -x claude

# 使用相对路径
manyoyo --ef ./local.env -x claude
```

### 使用运行配置

```bash
# 加载运行配置
manyoyo -r claude

# 运行配置 + 环境变量覆盖
manyoyo -r claude -e "DEBUG=true"

# 运行配置 + 额外环境文件
manyoyo -r claude --ef additional
```

详细配置请参考[配置系统](../configuration/)。

## 目录和挂载

### 工作目录

```bash
# 默认挂载当前目录
manyoyo -y c  # 当前目录挂载到容器相同路径

# 指定宿主机工作目录
manyoyo --hp /path/to/project -y c

# 指定容器工作目录
manyoyo --cp /workspace -y c

# 同时指定两者
manyoyo --hp /Users/me/project --cp /workspace -y c
```

### 额外挂载

```bash
# 挂载单个文件
manyoyo -v "/Users/me/.ssh/config:/root/.ssh/config:ro" -y c

# 挂载多个目录
manyoyo -v "/data:/workspace/data" \
        -v "/cache:/workspace/cache" \
        -y c

# 挂载选项
# :ro - 只读
# :rw - 读写（默认）
# :z  - SELinux 私有标签
# :Z  - SELinux 共享标签
```

## 会话管理

### 创建会话

```bash
# 创建新会话（自动生成名称）
manyoyo -y c

# 创建命名会话
manyoyo -n my-project --ef anthropic -y c
```

### 恢复会话

不同 AI CLI 工具有不同的恢复命令：

```bash
# Claude Code
manyoyo -n my-project -- -c

# Codex
manyoyo -n my-project -- resume --last

# Gemini
manyoyo -n my-project -- -r

# OpenCode
manyoyo -n my-project -- -c
```

### 交互式会话提示

退出容器会话后，系统将提示您选择操作：

```
容器退出，请选择操作：
  y - 保持容器在后台运行（默认）
  n - 删除容器
  1 - 使用首次命令重新进入
  x - 执行新命令
  i - 进入交互式 shell
```

**选项说明**：

- **y（默认）**：保持容器运行，稍后可以恢复
- **n**：删除容器，释放资源
- **1**：使用启动容器时的命令重新进入
- **x**：执行新的自定义命令
- **i**：进入 /bin/bash 交互式 shell

**示例**：
```bash
# 启动容器
manyoyo -n dev -y c

# 工作一段时间后退出
# 系统提示选择操作

# 选择 'y' - 保持运行
# 稍后恢复会话
manyoyo -n dev -- -c

# 或选择 'i' - 进入 shell 检查
manyoyo -n dev -x /bin/bash
```

## 静默模式

静默模式可以减少输出信息，适合脚本和 CI/CD。

### 静默选项

```bash
# 静默提示信息
manyoyo -q tip -x echo "Hello"

# 静默命令显示
manyoyo -q cmd -x echo "Hello"

# 静默所有输出
manyoyo -q full -x echo "Hello"

# 组合多个静默选项
manyoyo -q tip -q cmd -x echo "Hello"
```

### 自动确认

```bash
# 跳过所有交互式确认（用于脚本）
manyoyo --yes --ib --iv 1.7.0

# 组合使用
manyoyo --yes -q full -x echo "Automated"
```

## 镜像管理

### 指定镜像

```bash
# 使用默认镜像名，指定版本
manyoyo --iv 1.7.0-full -y c

# 使用自定义镜像
manyoyo --in myuser/sandbox --iv 1.0.0 -y c

# 完整镜像标识
manyoyo --in localhost/xcanwin/manyoyo --iv 1.7.0-full -y c
```

### 构建镜像

```bash
# 构建默认镜像
manyoyo --ib --iv 1.7.0

# 构建自定义镜像
manyoyo --ib --in mysandbox --iv 1.0.0

# 构建精简版本
manyoyo --ib --iba TOOL=common

# 构建特定工具
manyoyo --ib --iba TOOL=python,nodejs,claude
```

### 清理镜像

```bash
# 清理悬空镜像和 <none> 镜像
manyoyo --irm
manyoyo --image-remove

# 使用 Docker/Podman 清理
docker system prune -a  # 或 podman system prune -a
docker image prune      # 仅清理悬空镜像
```

## 调试和诊断

### 查看配置

```bash
# 显示最终生效的配置
manyoyo --show-config

# 显示特定配置的合并结果
manyoyo -r claude --show-config

# 显示将要执行的命令
manyoyo --show-command -r claude
```

### 查看日志

```bash
# 查看容器日志
docker logs <容器名>

# 实时查看日志
docker logs -f <容器名>

# 查看最后 N 行日志
docker logs --tail 100 <容器名>
```

### 调试容器

```bash
# 进入容器调试
manyoyo -n debug -x /bin/bash

# 检查容器内部状态
manyoyo -n debug -x 'env | sort'
manyoyo -n debug -x 'ls -la'
manyoyo -n debug -x 'which claude'

# 测试网络
manyoyo -n debug -x 'ping -c 3 api.anthropic.com'
manyoyo -n debug -x 'curl -I https://api.anthropic.com'
```

## 实用技巧

### 快速测试

```bash
# 测试容器是否正常
manyoyo -x echo "Container works"

# 测试环境变量
manyoyo -e "TEST=123" -x 'echo $TEST'

# 测试挂载
manyoyo -v "/tmp/test:/test" -x 'ls -la /test'
```

### 一次性容器

```bash
# 运行后自动删除
manyoyo --rm-on-exit -x 'echo "Temporary"'

# 用于临时测试
manyoyo -n temp --rm-on-exit -x /bin/bash
```

### 快速切换工具

```bash
# 启动 Claude Code
manyoyo -r claude

# 退出后，切换到 Codex
manyoyo -r codex

# 切换到交互式 shell
manyoyo -n current-container -x /bin/bash
```

### 批量操作

```bash
# 在多个项目中运行命令
for proj in project1 project2 project3; do
    cd $proj
    manyoyo -n myy-$proj -y c
    cd ..
done

# 清理所有测试容器
docker ps -a | grep myy-test | awk '{print $1}' | xargs docker rm
```

## 常见工作流

### 开发工作流

```bash
# 1. 启动开发容器
manyoyo -n dev-project --ef anthropic -y c

# 2. 工作...（AI 辅助编程）

# 3. 退出后保持运行（选择 'y'）

# 4. 需要时恢复
manyoyo -n dev-project -- -c

# 5. 进入 shell 检查
manyoyo -n dev-project -x /bin/bash

# 6. 完成后删除容器
manyoyo -n dev-project --crm
```

### 多项目工作流

```bash
# 项目 A
manyoyo -n project-a --hp ~/projects/a --ef claude -y c

# 项目 B
manyoyo -n project-b --hp ~/projects/b --ef claude -y c

# 切换回项目 A
manyoyo -n project-a -- -c

# 列出所有项目容器
manyoyo -l
```

### CI/CD 工作流

```bash
# 自动化脚本示例
#!/bin/bash

# 设置非交互模式
manyoyo --yes -q full \
    -n ci-build \
    --rm-on-exit \
    -x 'npm install && npm test && npm run build'

# 检查退出码
if [ $? -eq 0 ]; then
    echo "Build success"
else
    echo "Build failed"
    exit 1
fi
```

## 下一步

- [配置系统](../configuration/) - 学习如何使用配置文件简化操作
- [命令参考](../reference/cli-options) - 查看所有命令行选项
- [容器模式](../reference/container-modes) - 了解不同的容器嵌套模式
- [故障排查](../troubleshooting/) - 解决常见问题
