# 容器模式

MANYOYO 支持三种容器模式，提供不同级别的容器嵌套能力。

## 模式概览

| 模式 | 简称 | 容器嵌套 | 安全性 | 适用场景 |
|------|------|----------|--------|----------|
| Common | `common` | ❌ 不支持 | ⭐⭐⭐⭐⭐ 最安全 | 日常开发，无需容器操作 |
| Docker-in-Docker | `dind` | ✅ 支持 | ⭐⭐⭐⭐ 较安全 | 需要运行容器，如 CI/CD |
| Socket Mount | `sock` | ✅ 支持 | ⭐ 危险 | 特殊场景，需要完全权限 |

## Common 模式（默认）

### 特点

- **无容器嵌套能力**：容器内无法运行 Docker/Podman 命令
- **最安全**：完全隔离，无法访问宿主机的容器运行时
- **轻量级**：无额外开销
- **默认模式**：无需指定参数

### 使用方式

```bash
# 默认就是 common 模式
manyoyo -y c

# 显式指定
manyoyo -m common -y c
manyoyo --cont-mode common -y c
```

### 适用场景

- 日常编程开发
- 代码编写和测试
- 不涉及容器操作的任务
- 对安全性要求最高的场景

### 限制

```bash
# 容器内无法运行
docker ps        # ❌ 错误：无法连接到 Docker daemon
podman ps        # ❌ 错误：无法连接到 Podman
docker build     # ❌ 无法构建镜像
```

### 配置示例

```json5
// ~/.manyoyo/run/dev.json
{
    "containerMode": "common",  // 或省略（默认）
    "envFile": ["anthropic_claudecode"],
    "yolo": "c"
}
```

## Docker-in-Docker 模式

### 特点

- **支持容器嵌套**：可以在容器内运行容器
- **较安全**：使用独立的容器运行时，不影响宿主机
- **真正隔离**：容器内的容器与宿主机完全隔离
- **性能开销**：需要在容器内运行完整的容器运行时

### 使用方式

```bash
# 使用 dind 模式
manyoyo -m dind -y c
manyoyo --cont-mode dind -y c

# 进入 shell 使用
manyoyo -n dind-dev -m dind -x /bin/bash
```

### 容器内操作（简版）

```bash
# 进入容器
manyoyo -n dind-dev -m dind -x /bin/bash

# Podman（推荐）
podman ps -a

# Docker（需要先启动 daemon）
nohup dockerd &
sleep 10
docker ps -a
```

完整流程（原理、性能、安全、CI 示例）请查看：  
[Docker-in-Docker 完整指南](../advanced/docker-in-docker.md)

### 适用场景

- **CI/CD 构建**：需要在容器中构建和测试镜像
- **多阶段构建**：测试不同的容器配置
- **容器化应用开发**：开发和测试容器化应用
- **Docker Compose**：在容器中运行 docker-compose

### 优势

- ✅ 安全隔离：容器内的容器不影响宿主机
- ✅ 环境一致：可以在容器中复现完整的容器环境
- ✅ 易于清理：删除外层容器，内层容器自动清理
- ✅ 权限控制：不需要访问宿主机的容器运行时

### 限制

- ⚠️ 性能开销：需要运行完整的容器运行时
- ⚠️ 镜像共享：无法直接访问宿主机的镜像
- ⚠️ 磁盘占用：容器内的镜像占用额外空间
- ⚠️ Docker 需要手动启动：dockerd 不会自动启动

### 配置示例

```json5
// ~/.manyoyo/run/dind.json
{
    "containerName": "my-dind",
    "containerMode": "dind",
    "envFile": ["anthropic_claudecode"],
    "volumes": [
        // 挂载 Docker 配置（可选）
        "~/.docker:/root/.docker:ro"
    ]
}
```

### 深入示例

完整配置与实战示例请查看：  
[Docker-in-Docker 完整指南](../advanced/docker-in-docker.md)

## Socket Mount 模式（危险）

### 特点

- **直接访问宿主机容器运行时**：挂载 `/var/run/docker.sock`
- **极度危险**：容器可以完全控制宿主机的容器
- **性能最佳**：无额外开销
- **共享镜像**：可以直接使用宿主机的镜像

### 使用方式

```bash
# 使用 sock 模式（危险！）
manyoyo -m sock -x /bin/bash
manyoyo --cont-mode sock -x /bin/bash
```

::: danger 危险警告
Socket Mount 模式下，容器可以：
- 访问和操作宿主机的所有容器
- 创建特权容器逃逸到宿主机
- 删除或修改宿主机的容器和镜像
- 访问其他容器的数据
- 完全控制宿主机的容器运行时

**仅在完全信任的环境中使用！**
:::

### 容器内操作

```bash
# 进入容器
manyoyo -n sock-dev -m sock -x /bin/bash

# 直接使用宿主机的 Podman/Docker
$ podman ps -a     # 看到的是宿主机的容器
$ docker ps -a     # 看到的是宿主机的容器
$ docker images    # 看到的是宿主机的镜像
```

### 适用场景

- **容器编排开发**：开发 Docker/Podman 相关工具
- **容器管理工具**：如 Portainer、Watchtower
- **特殊需求**：必须访问宿主机容器运行时

### 安全风险

#### 风险 1：容器逃逸

```bash
# 容器内可以创建特权容器
docker run --privileged --pid=host -it ubuntu

# 在特权容器内访问宿主机
nsenter -t 1 -m -u -n -i sh
# 现在在宿主机上！
```

#### 风险 2：数据泄露

```bash
# 可以访问其他容器的数据
docker cp <其他容器>:/sensitive/data ./

# 可以查看其他容器的环境变量
docker inspect <其他容器> | grep -i env
```

#### 风险 3：恶意操作

```bash
# 可以删除所有容器
docker rm -f $(docker ps -aq)

# 可以删除所有镜像
docker rmi -f $(docker images -q)

# 可以运行恶意容器
docker run -d malicious-image
```

### 防护措施

如果必须使用 sock 模式，请采取以下措施：

#### 1. 最小权限原则

```bash
# 仅在需要时使用，完成后立即删除容器
manyoyo -n temp-sock -m sock --rm-on-exit -x /bin/bash
```

#### 2. 监控和审计

```bash
# 记录所有操作
manyoyo -m sock -x /bin/bash 2>&1 | tee sock-audit.log

# 定期检查容器
docker ps -a
docker images
```

#### 3. 网络隔离

```bash
# 限制容器网络访问
# 在宿主机上配置防火墙规则
```

#### 4. 使用只读挂载（部分场景）

```bash
# 如果只需要查看，使用只读挂载
manyoyo -v "/var/run/docker.sock:/var/run/docker.sock:ro" -x /bin/bash
```

### 配置示例

```json5
// ~/.manyoyo/run/sock.json（谨慎使用！）
{
    "containerName": "my-sock",
    "containerMode": "sock",  // 危险！
    "envFile": ["anthropic_claudecode"]
}
```

## 模式对比详解

### 功能对比

| 功能 | Common | Docker-in-Docker | Socket Mount |
|------|--------|------------------|--------------|
| 运行容器内容器 | ❌ | ✅ | ✅ |
| 访问宿主机镜像 | ❌ | ❌ | ✅ |
| 访问宿主机容器 | ❌ | ❌ | ✅ |
| 环境隔离 | ✅ | ✅ | ❌ |
| 安全性 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐ |
| 性能 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

### 安全性对比

```
Common 模式：
宿主机
  └─ MANYOYO 容器（完全隔离）
      └─ AI 智能体
          └─ 无容器操作权限

Docker-in-Docker 模式：
宿主机
  └─ MANYOYO 容器（隔离）
      ├─ AI 智能体
      └─ 独立的容器运行时
          └─ 嵌套容器（隔离）

Socket Mount 模式：
宿主机
  ├─ MANYOYO 容器（共享 socket）
  │   └─ AI 智能体
  │       └─ 可以完全控制宿主机容器！
  └─ 其他容器（可能被影响）
```

### 性能对比

**启动时间**：
- Common: 1-2 秒（最快）
- Docker-in-Docker: 10-15 秒（需要启动容器运行时）
- Socket Mount: 1-2 秒（快）

**磁盘占用**：
- Common: 基础镜像大小
- Docker-in-Docker: 基础镜像 + 嵌套容器镜像
- Socket Mount: 基础镜像大小（共享宿主机镜像）

**内存占用**：
- Common: 基础容器内存
- Docker-in-Docker: 基础容器 + 容器运行时 + 嵌套容器
- Socket Mount: 基础容器内存

## 选择指南

### 决策流程

```
需要在容器中运行容器吗？
├─ 否 → 使用 Common 模式 ✅
└─ 是 → 需要访问宿主机的容器吗？
    ├─ 否 → 使用 Docker-in-Docker 模式 ✅
    └─ 是 → 是否完全信任容器内的操作？
        ├─ 否 → 重新考虑需求，尽量使用 dind
        └─ 是 → 使用 Socket Mount 模式 ⚠️ 危险
```

### 推荐方案

**日常开发**（推荐 95% 的用户）：
```bash
manyoyo -y c  # 默认 common 模式
```

**CI/CD 构建**（需要容器嵌套）：
```bash
manyoyo -m dind -y c  # 使用 dind 模式
```

**容器管理工具开发**（特殊场景）：
```bash
# 谨慎评估后，如果必须使用
manyoyo -m sock -x /bin/bash
```

## 故障排查

### Common 模式

**问题**：需要运行容器，但使用了 common 模式

**解决方案**：
```bash
# 切换到 dind 模式
manyoyo -n new-container -m dind -y c
```

### Docker-in-Docker 模式

**问题**：docker 命令不可用

**解决方案**：
```bash
# 使用 Podman（推荐，开箱即用）
podman ps

# 或手动启动 dockerd
nohup dockerd &
sleep 10
docker ps
```

**问题**：无法拉取镜像

**解决方案**：
```bash
# 检查网络
ping -c 3 docker.io

# 配置镜像代理（如果需要）
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'EOF'
{
    "registry-mirrors": ["https://mirror.example.com"]
}
EOF
```

### Socket Mount 模式

**问题**：权限不足

**解决方案**：
```bash
# 检查 socket 文件权限
ls -la /var/run/docker.sock

# 确保用户在 docker 组中
groups | grep docker
```

**问题**：意外删除了宿主机容器

**解决方案**：
```bash
# 立即停止使用 sock 模式
manyoyo -n sock-container --crm

# 检查宿主机容器状态
docker ps -a

# 从备份恢复（如果有）
# 或重新创建必要的容器
```

## 最佳实践

### 1. 默认使用 Common 模式

除非明确需要容器嵌套，否则使用默认的 common 模式。

### 2. 优先选择 Docker-in-Docker

如果需要容器嵌套，优先选择 dind 模式而不是 sock 模式。

### 3. 最小化 Socket Mount 使用

仅在绝对必要时使用 sock 模式，并采取安全措施。

### 4. 使用配置文件

为不同模式创建专用配置：

```bash
# Common 模式（默认）
~/.manyoyo/run/dev.json

# dind 模式
~/.manyoyo/run/dind.json

# sock 模式（谨慎使用）
~/.manyoyo/run/sock.json
```

### 5. 文档化使用场景

记录为什么需要特定模式，便于团队理解。

## 相关文档

- [基础用法](../guide/basic-usage.md) - 学习基本命令
- [配置示例](../configuration/examples.md) - 查看配置示例
- [安装详解](../guide/installation.md) - 了解镜像构建
- [故障排查](../troubleshooting/README.md) - 解决容器问题
