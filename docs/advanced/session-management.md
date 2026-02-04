# 会话管理

本页面介绍 MANYOYO 的会话管理机制，包括会话创建、恢复、持久化和最佳实践。

## 什么是会话

在 MANYOYO 中，**会话（Session）** 指的是：
- 一个运行的容器实例
- 容器内 AI 智能体的工作状态
- 智能体的对话历史和上下文

## 会话生命周期

```
创建 → 运行 → 暂停/退出 → 恢复 → 删除
  ↓      ↓         ↓          ↓       ↓
 容器   AI工作   容器保留   继续工作  清理
```

## 创建会话

### 自动命名会话

```bash
# 自动生成容器名（基于时间戳）
manyoyo -y c
# 生成名称如：myy-0204-1430

# 查看容器名
manyoyo -l
```

**命名规则**：`myy-{月日}-{时分}`
- 例如：`myy-0204-1430` 表示 2月4日 14:30 创建

### 命名会话

```bash
# 创建命名会话（推荐）
manyoyo -n my-project -y c

# 优势：
# - 容易记忆
# - 便于管理多个项目
# - 配置文件可以固定名称
```

### 使用配置文件创建会话

```bash
# 方式 1：运行配置（推荐）
cat > ~/.manyoyo/run/project-a.json << 'EOF'
{
    "containerName": "myy-project-a",
    "envFile": ["anthropic_claudecode"],
    "yolo": "c"
}
EOF

manyoyo -r project-a

# 方式 2：项目配置
cat > ./myproject/.manyoyo.json << 'EOF'
{
    "containerName": "myy-myproject",
    "envFile": ["anthropic_claudecode"],
    "yolo": "c"
}
EOF

cd myproject
manyoyo -r ./.manyoyo.json
```

## 会话恢复

### 退出提示

当你退出容器会话后，系统会提示：

```
容器退出，请选择操作：
  y - 保持容器在后台运行（默认）
  n - 删除容器
  1 - 使用首次命令重新进入
  x - 执行新命令
  i - 进入交互式 shell
```

### 选项说明

#### y - 保持运行（推荐）

```bash
# 选择 'y' 后，容器在后台运行
# 稍后可以恢复会话

# 恢复 Claude Code 会话
manyoyo -n my-project -- -c

# 恢复 Codex 会话
manyoyo -n my-project -- resume --last

# 恢复 Gemini 会话
manyoyo -n my-project -- -r
```

**适用场景**：
- 临时离开，稍后继续工作
- 需要保留 AI 对话历史
- 测试未完成，需要继续

#### n - 删除容器

```bash
# 选择 'n' 后，容器被删除
# 所有数据和历史丢失
```

**适用场景**：
- 一次性测试
- 不需要保留历史
- 想要释放资源

#### 1 - 重新进入

```bash
# 选择 '1' 后，使用启动时的命令重新进入
# 例如，如果启动时是 'manyoyo -y c'
# 则重新运行 'claude --dangerously-skip-permissions'
```

**适用场景**：
- AI 意外退出
- 需要重启 AI 工具
- 清空当前会话但保留容器

#### x - 执行新命令

```bash
# 选择 'x' 后，可以执行任意命令
# 提示输入命令

# 例如：
x
请输入要执行的命令: npm test
```

**适用场景**：
- 需要运行测试
- 检查 AI 做的修改
- 执行自定义脚本

#### i - 进入 shell

```bash
# 选择 'i' 后，进入 /bin/bash

# 可以：
$ ls -la              # 查看文件
$ git status          # 检查代码
$ npm test            # 运行测试
$ claude --version    # 检查工具版本
```

**适用场景**：
- 需要手动检查
- 调试问题
- 运行多个命令

### 智能体特定的恢复命令

不同 AI CLI 工具有不同的恢复方式：

#### Claude Code

```bash
# 恢复最后会话
manyoyo -n my-session -- -c
manyoyo -n my-session -- --continue

# 查看可用会话
manyoyo -n my-session -x "claude --list-sessions"
```

#### Codex

```bash
# 恢复最后会话
manyoyo -n my-session -- resume --last

# 恢复特定会话
manyoyo -n my-session -- resume <session-id>

# 列出所有会话
manyoyo -n my-session -- list
```

#### Gemini

```bash
# 恢复会话
manyoyo -n my-session -- -r
manyoyo -n my-session -- --resume

# 清除会话历史
manyoyo -n my-session -- --clear
```

#### OpenCode

```bash
# 恢复会话
manyoyo -n my-session -- -c
manyoyo -n my-session -- --continue
```

## 会话持久化

### 容器持久化

容器状态由 Docker/Podman 管理：

```bash
# 查看所有会话（包括停止的）
manyoyo -l
docker ps -a | grep myy

# 容器状态
docker ps -a --format "table {{.Names}}\t{{.Status}}"
```

### 数据持久化

#### 1. 工作目录挂载

```bash
# 默认挂载当前目录
manyoyo -y c  # 当前目录自动挂载

# 指定工作目录
manyoyo --hp /path/to/project -y c

# 代码修改会保存在宿主机
```

#### 2. 额外数据挂载

```bash
# 挂载数据目录
manyoyo -v "/data:/workspace/data" -y c

# 挂载配置文件
manyoyo -v "~/.gitconfig:/root/.gitconfig:ro" -y c
```

#### 3. 使用 volumes（推荐）

```bash
# 创建持久化卷
docker volume create myproject-data

# 挂载卷
manyoyo -v "myproject-data:/workspace/data" -y c

# 数据在容器删除后仍然保留
```

### AI 对话历史持久化

不同 AI 工具的历史存储位置：

#### Claude Code

```bash
# 历史存储在容器内
# 位置：~/.claude/sessions/

# 挂载会话目录（可选）
manyoyo -v "~/.claude:/root/.claude" -y c
```

#### Codex

```bash
# 历史存储在容器内
# 位置：~/.codex/sessions/

# 挂载会话目录
manyoyo -v "~/.codex:/root/.codex" -y c
```

## 多会话管理

### 并行会话

```bash
# 项目 A
manyoyo -n project-a --hp ~/projects/a -y c

# 项目 B
manyoyo -n project-b --hp ~/projects/b -y c

# 项目 C
manyoyo -n project-c --hp ~/projects/c -y c

# 查看所有会话
manyoyo -l
```

### 会话切换

```bash
# 在项目 A 中工作
manyoyo -n project-a -- -c

# 切换到项目 B
manyoyo -n project-b -- -c

# 切换到项目 C
manyoyo -n project-c -- -c
```

### 会话隔离

每个会话完全独立：
- 独立的文件系统
- 独立的环境变量
- 独立的 AI 对话历史
- 独立的进程空间

## 会话清理

### 手动清理

```bash
# 删除单个会话
manyoyo -n my-session --crm
manyoyo -n my-session --cont-remove

# 或使用 Docker 命令
docker rm -f my-session
```

### 自动清理

```bash
# 一次性会话（退出后自动删除）
manyoyo -n temp --rm-on-exit -y c

# 适用场景：
# - 临时测试
# - 快速验证
# - 不需要保留历史
```

### 批量清理

```bash
# 清理所有停止的 MANYOYO 容器
docker ps -a | grep myy | grep Exited | awk '{print $1}' | xargs docker rm

# 清理所有 MANYOYO 容器（危险！）
docker ps -a | grep myy | awk '{print $1}' | xargs docker rm -f
```

## 会话监控

### 查看会话状态

```bash
# 列出所有 MANYOYO 会话
manyoyo -l

# 详细状态
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# 资源使用情况
docker stats $(docker ps -q --filter "name=myy")
```

### 查看会话日志

```bash
# 查看容器日志
docker logs my-session

# 实时日志
docker logs -f my-session

# 最后 100 行
docker logs --tail 100 my-session
```

### 进入运行中的会话

```bash
# 进入 shell 检查
manyoyo -n my-session -x /bin/bash

# 查看进程
$ ps aux

# 查看文件
$ ls -la

# 查看环境变量
$ env | grep ANTHROPIC
```

## 最佳实践

### 1. 命名规范

```bash
# 按项目命名
myy-webapp
myy-api
myy-mobile

# 按功能命名
myy-dev
myy-test
myy-debug

# 按时间命名（自动）
myy-0204-1430
```

### 2. 配置文件管理

```bash
# 为每个项目创建配置
~/.manyoyo/run/
├── webapp.json
├── api.json
├── mobile.json
└── debug.json

# 快速启动
manyoyo -r webapp
manyoyo -r api
manyoyo -r mobile
```

### 3. 数据备份

```bash
# 导出容器配置
docker inspect my-session > my-session.json

# 备份挂载的数据
tar -czf backup.tar.gz ~/projects/myproject

# 备份 AI 历史（可选）
docker cp my-session:/root/.claude ./claude-backup
```

### 4. 定期清理

```bash
# 每周清理脚本
cat > ~/cleanup-manyoyo.sh << 'EOF'
#!/bin/bash
# 清理超过 7 天的停止容器
docker ps -a --filter "name=myy" --filter "status=exited" \
    --format "{{.ID}} {{.CreatedAt}}" | \
    awk '{if ($2 < systime() - 604800) print $1}' | \
    xargs -r docker rm

# 清理悬空镜像
docker image prune -f
EOF

chmod +x ~/cleanup-manyoyo.sh
```

### 5. 会话模板

```bash
# 创建会话模板
cat > ~/.manyoyo/run/template.json << 'EOF'
{
    "containerName": "myy-template",
    "envFile": ["base", "secrets"],
    "volumes": [
        "~/.ssh:/root/.ssh:ro",
        "~/.gitconfig:/root/.gitconfig:ro"
    ],
    "env": [
        "TZ=Asia/Shanghai"
    ]
}
EOF

# 基于模板创建新会话
cp ~/.manyoyo/run/template.json ~/.manyoyo/run/newproject.json
# 修改 containerName 和特定配置
```

## 高级技巧

### 会话快照

```bash
# 提交容器为镜像（保存当前状态）
docker commit my-session my-session:snapshot-$(date +%Y%m%d)

# 从快照创建新会话
docker run -it my-session:snapshot-20240204
```

### 会话导出/导入

```bash
# 导出会话
docker export my-session > my-session.tar

# 导入到其他机器
cat my-session.tar | docker import - my-session:imported
```

### 会话共享

```bash
# 多人协作（同一容器）
# 人员 A 创建会话
manyoyo -n shared-session -y c

# 人员 B 进入相同会话
manyoyo -n shared-session -x /bin/bash

# 注意：不推荐多人同时使用 AI
```

## 故障排查

### 会话无法恢复

**问题**：提示容器不存在

**解决方案**：
```bash
# 检查容器是否存在
manyoyo -l
docker ps -a | grep my-session

# 如果不存在，创建新会话
manyoyo -n my-session -y c
```

### AI 历史丢失

**问题**：恢复会话后，AI 不记得之前的对话

**解决方案**：
```bash
# 检查容器是否是新创建的
docker ps -a --format "{{.Names}}\t{{.CreatedAt}}"

# 挂载会话目录（下次创建时）
manyoyo -v "~/.claude:/root/.claude" -n my-session -y c
```

### 容器无法启动

**问题**：会话启动失败

**解决方案**：
```bash
# 查看容器日志
docker logs my-session

# 删除并重新创建
manyoyo -n my-session --crm
manyoyo -n my-session -y c
```

## 与 Skills Marketplace 集成

如果安装了 Skills Marketplace，可以获得更强大的会话管理功能：

```bash
# 列出所有会话（包括云端）
claude --list-sessions

# 恢复云端会话
claude --resume-session <session-id>

# 同步会话到云端
claude --sync-sessions
```

## 相关文档

- [基础用法](../guide/basic-usage.md) - 学习基本命令
- [AI 智能体](../reference/agents.md) - 了解各智能体的会话管理
- [配置示例](../configuration/examples.md) - 查看配置示例
- [容器模式](../reference/container-modes.md) - 了解容器管理
