# 故障排查指南

本页面提供 MANYOYO 常见问题的快速索引和解决方案。

## 快速导航

### 构建相关问题
- [镜像构建失败](./build-errors#镜像构建失败)
- [镜像拉取失败](./build-errors#镜像拉取失败)
- [网络连接问题](./build-errors#网络连接问题)
- [磁盘空间不足](./build-errors#磁盘空间不足)

### 运行时问题
- [容器启动失败](./runtime-errors#容器启动失败)
- [权限不足](./runtime-errors#权限不足)
- [环境变量未生效](./runtime-errors#环境变量未生效)
- [容器内无法访问宿主机文件](./runtime-errors#容器内无法访问宿主机文件)
- [AI CLI 工具报错](./runtime-errors#ai-cli-工具报错)

## 常见问题速查表

| 问题症状 | 可能原因 | 快速解决方案 | 详细文档 |
|---------|---------|-------------|---------|
| `manyoyo --ib` 构建失败 | 网络问题、磁盘空间不足 | 检查网络和磁盘空间 | [构建问题](./build-errors) |
| `pinging container registry failed` | 镜像未构建 | 运行 `manyoyo --ib --iv 1.7.0` | [镜像拉取失败](./build-errors#镜像拉取失败) |
| 容器无法启动 | 端口冲突、权限问题 | 检查日志和权限 | [容器启动失败](./runtime-errors#容器启动失败) |
| `permission denied` | Docker/Podman 权限不足 | 添加用户到 docker 组 | [权限不足](./runtime-errors#权限不足) |
| 环境变量未生效 | 文件格式错误、路径错误 | 检查环境文件格式 | [环境变量未生效](./runtime-errors#环境变量未生效) |
| AI CLI 报错缺少 API Key | 环境变量未配置 | 配置环境文件 | [AI CLI 工具报错](./runtime-errors#ai-cli-工具报错) |

## 调试工具

### 查看配置

```bash
# 显示最终生效的配置
manyoyo --show-config

# 显示将要执行的命令
manyoyo --show-command

# 显示特定运行配置
manyoyo -r claude --show-config
```

### 查看容器状态

```bash
# 列出所有 manyoyo 容器
manyoyo -l

# 查看容器日志（Docker）
docker logs <容器名>

# 查看容器日志（Podman）
podman logs <容器名>

# 查看容器详细信息
docker inspect <容器名>
```

### 测试环境变量

```bash
# 在容器中查看所有环境变量
manyoyo --ef myconfig -x env

# 查看特定环境变量
manyoyo --ef myconfig -x 'env | grep ANTHROPIC'

# 测试环境文件加载
manyoyo --ef myconfig --show-config
```

### 测试网络连接

```bash
# 测试国内镜像源
curl -I https://mirrors.tencent.com

# 测试 API 端点
curl -I https://api.anthropic.com

# 在容器中测试网络
manyoyo -x curl -I https://api.anthropic.com
```

## 诊断流程

### 1. 先完成安装验证

系统要求、版本、镜像、测试容器等基础检查，建议先按安装文档执行：
- [安装详解：验证安装](../guide/installation#验证安装)

### 2. 按问题类型进入专项排查

- 构建相关问题：[`build-errors`](./build-errors)
- 运行时相关问题：[`runtime-errors`](./runtime-errors)

### 3. 验证配置文件

```bash
# 检查全局配置
cat ~/.manyoyo/manyoyo.json

# 验证 JSON 格式
cat ~/.manyoyo/manyoyo.json | jq .

# 检查运行配置
cat ~/.manyoyo/run/claude.json | jq .
```

### 4. 测试环境变量

```bash
# 检查环境文件存在
ls -la ~/.manyoyo/env/

# 查看环境文件内容
cat ~/.manyoyo/env/anthropic_claudecode.env

# 测试加载
manyoyo --ef anthropic_claudecode --show-config
```

## 获取帮助

如果问题仍未解决，请按以下步骤获取帮助：

### 1. 收集诊断信息

```bash
# 系统信息
uname -a
node --version
docker --version  # 或 podman --version

# MANYOYO 配置
manyoyo -V
manyoyo --show-config

# 容器状态
manyoyo -l
docker ps -a | grep myy
```

### 2. 查看详细日志

```bash
# 容器日志
docker logs <容器名> 2>&1 | tee manyoyo-error.log

# 如果是构建失败
manyoyo --ib --iv 1.7.0 2>&1 | tee build-error.log
```

### 3. 提交 Issue

访问 [GitHub Issues](https://github.com/xcanwin/manyoyo/issues) 并提供：
- 问题描述和复现步骤
- 错误信息和日志
- 系统环境信息
- 相关配置文件（移除敏感信息）

## 相关文档

- [构建问题详解](./build-errors) - 镜像构建相关问题
- [运行时问题详解](./runtime-errors) - 容器运行相关问题
- [配置系统](../configuration/) - 配置文件和环境变量
- [命令参考](../reference/cli-options) - 命令行选项说明
