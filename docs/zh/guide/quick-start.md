# 快速开始

## 前置条件

在开始之前，请确保您的系统满足以下要求：

- **Node.js** >= 22.0.0 - [安装指南](./installation.md#安装-nodejs)
- **Docker** 或 **Podman**（推荐 Podman）- [安装指南](./installation.md#安装-podman推荐)
- **磁盘空间**：至少 10GB 可用空间
- **网络连接**：稳定的网络连接（首次构建需要下载依赖）

验证前置条件：

```bash
# 检查 Node.js 版本
node --version  # 应该 >= 22.0.0

# 检查 Docker 或 Podman
docker --version   # 或
podman --version

# 检查磁盘空间
df -h
```

::: tip
如果未安装必需软件，请参考[安装详解](./installation.md)。
:::

## 安装 manyoyo

```bash
npm install -g @xcanwin/manyoyo
```

本地开发调试也可以直接安装当前仓库：

```bash
npm install -g .
```

## 构建沙箱镜像

Docker/Podman 都可执行：

```bash
manyoyo --ib --iv 1.7.0
```

常用构建参数：

```bash
manyoyo --ib --iba TOOL=common
manyoyo --ib --iba TOOL=go,codex,java,gemini
manyoyo --ib --in myimage --iv 2.0.0
```

## 启动容器并进入 Agent

```bash
manyoyo -y c
```

常见恢复命令：

```bash
manyoyo -n test -- -c            # Claude Code
manyoyo -n test -- resume --last # Codex
manyoyo -n test -- -r            # Gemini
```

## 配置环境变量

AI CLI 工具需要 API Key 才能工作。您可以通过环境变量或配置文件提供。

### 方式 1：使用环境变量（临时测试）

```bash
manyoyo -e "ANTHROPIC_BASE_URL=https://api.anthropic.com" \
        -e "ANTHROPIC_AUTH_TOKEN=sk-your-key" \
        -x claude
```

### 方式 2：使用环境文件（推荐）

创建环境文件：

```bash
# 创建目录
mkdir -p ~/.manyoyo/env/

# 创建环境文件
cat > ~/.manyoyo/env/anthropic.env << 'EOF'
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="sk-your-actual-key-here"
EOF

# 使用环境文件
manyoyo --ef anthropic -y c
```

### 方式 3：使用运行配置（最推荐）

创建运行配置：

```bash
# 创建目录
mkdir -p ~/.manyoyo/run/

# 创建运行配置
cat > ~/.manyoyo/run/claude.json << 'EOF'
{
    "envFile": ["anthropic"],
    "yolo": "c"
}
EOF

# 使用运行配置（最简单）
manyoyo -r claude
```

详细配置请参考：
- [环境变量详解](../configuration/environment.md)
- [配置文件详解](../configuration/config-files.md)
- [配置示例](../configuration/examples.md)

## 故障排查

如果遇到问题，请参考：

- **构建失败**：[构建问题排查](../troubleshooting/build-errors.md)
- **容器启动失败**：[运行时问题排查](../troubleshooting/runtime-errors.md)
- **环境变量未生效**：[环境变量故障排查](../troubleshooting/runtime-errors.md#环境变量未生效)

常见问题快速解决：

```bash
# 检查镜像是否存在
docker images | grep manyoyo

# 查看容器日志
docker logs <容器名>

# 验证环境变量
manyoyo --ef anthropic --show-config

# 测试容器
manyoyo -x echo "Hello MANYOYO"
```

## 下一步

现在您已经完成了快速开始，可以继续：

- [安装详解](./installation.md) - 深入了解安装选项和构建参数
- [基础用法](./basic-usage.md) - 学习更多命令和操作
- [配置系统](../configuration/) - 掌握高级配置技巧
- [命令参考](../reference/cli-options.md) - 查看所有命令选项
