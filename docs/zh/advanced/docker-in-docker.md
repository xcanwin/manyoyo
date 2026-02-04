# Docker-in-Docker 完整指南

本页面提供 Docker-in-Docker (DinD) 模式的完整使用指南，包括原理、配置、最佳实践和安全性分析。

## 什么是 Docker-in-Docker

Docker-in-Docker 是指在 Docker 容器内运行 Docker daemon，从而在容器中创建和管理其他容器的技术。

### 应用场景

- **CI/CD 流水线**：在容器化的 CI 环境中构建和测试 Docker 镜像
- **开发环境隔离**：为每个项目提供独立的容器运行时环境
- **多租户容器平台**：为不同用户提供隔离的容器环境
- **容器化应用测试**：测试需要容器支持的应用程序

## MANYOYO 中的 DinD 实现

MANYOYO 提供两种容器嵌套方案：

1. **Docker-in-Docker (dind)**：真正的容器嵌套，安全隔离 ✅ 推荐
2. **Socket Mount (sock)**：挂载宿主机 socket，危险但性能好 ⚠️ 谨慎使用

本文主要介绍 **dind 模式**。

## 快速开始

### 基础使用

```bash
# 启动 dind 模式容器
manyoyo -m dind -x /bin/bash

# 在容器内使用 Podman（开箱即用）
podman ps -a
podman run hello-world
podman build -t myimage .

# 或使用 Docker（需要先启动 dockerd）
nohup dockerd &
sleep 10
docker ps -a
```

### 配置文件方式

```bash
# 创建 dind 配置
cat > ~/.manyoyo/run/dind.json << 'EOF'
{
    "containerName": "myy-dind",
    "containerMode": "dind",
    "envFile": ["anthropic_claudecode"],
    "yolo": "c"
}
EOF

# 使用配置启动
manyoyo -r dind
```

## 工作原理

### 架构图

```
宿主机
  └─ MANYOYO 外层容器（dind 模式）
      ├─ Podman/Docker daemon（独立运行时）
      ├─ AI 智能体（可以操作容器）
      └─ 嵌套容器（完全隔离）
          ├─ 应用容器 A
          ├─ 应用容器 B
          └─ 应用容器 C
```

### 技术实现

MANYOYO 的 dind 模式基于以下技术：

1. **特权容器**：外层容器需要一定权限来运行容器运行时
2. **独立存储**：嵌套容器使用独立的存储后端
3. **网络隔离**：嵌套容器拥有独立的网络栈
4. **进程隔离**：完全的 PID 命名空间隔离

## Podman vs Docker

### Podman（推荐）

**优势**：
- 开箱即用，无需手动启动 daemon
- Rootless 模式，更安全
- 兼容 Docker CLI 命令
- 轻量级，资源占用少

**使用方法**：
```bash
# 进入 dind 容器
manyoyo -m dind -x /bin/bash

# 直接使用 Podman
podman ps -a
podman images
podman run -d nginx
podman build -t myapp .
```

### Docker

**优势**：
- 完整的 Docker 生态支持
- Docker Compose 支持
- 某些工具要求必须使用 Docker

**使用方法**：
```bash
# 进入 dind 容器
manyoyo -m dind -x /bin/bash

# 启动 dockerd（后台运行）
nohup dockerd > /var/log/dockerd.log 2>&1 &

# 等待启动完成
sleep 10

# 验证
docker version
docker ps -a

# 使用 Docker
docker run hello-world
docker build -t myapp .
```

## 完整示例

### 示例 1：AI 辅助容器化应用开发

```bash
# 1. 创建 dind 配置
cat > ~/.manyoyo/run/dind-dev.json << 'EOF'
{
    "containerName": "myy-dind-dev",
    "containerMode": "dind",
    "envFile": ["anthropic_claudecode"],
    "volumes": [
        "~/.docker:/root/.docker:ro"
    ],
    "yolo": "c"
}
EOF

# 2. 启动 AI 辅助开发
manyoyo -r dind-dev

# 3. AI 可以帮助：
#    - 编写 Dockerfile
#    - 构建镜像
#    - 运行容器测试
#    - 调试容器问题

# 4. 退出后检查
manyoyo -n myy-dind-dev -x /bin/bash

# 5. 查看 AI 创建的容器和镜像
podman ps -a
podman images
```

### 示例 2：CI/CD 流水线

```bash
# 1. 创建项目配置
cat > ./myproject/.manyoyo.json << 'EOF'
{
    "containerName": "myy-ci",
    "containerMode": "dind",
    "env": [
        "CI=true",
        "NODE_ENV=test"
    ]
}
EOF

# 2. 运行 CI 任务
manyoyo -r ./myproject/.manyoyo.json -x /bin/bash

# 3. 在容器内运行测试
$ npm install
$ npm test

# 4. 构建 Docker 镜像
$ podman build -t myapp:test .

# 5. 运行集成测试
$ podman run --rm myapp:test npm run integration-test

# 6. 清理
$ podman rm -f $(podman ps -aq)
```

### 示例 3：多阶段构建测试

```bash
# 进入 dind 容器
manyoyo -m dind -x /bin/bash

# 创建测试 Dockerfile
cat > Dockerfile.test << 'EOF'
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EOF

# 构建多阶段镜像
podman build -f Dockerfile.test -t webapp:test .

# 运行测试
podman run -d -p 8080:80 webapp:test

# 测试访问
curl http://localhost:8080

# 清理
podman stop $(podman ps -q)
```

## 配置选项

### 环境变量

```bash
# Docker 配置
export DOCKER_HOST=unix:///var/run/docker.sock
export DOCKER_BUILDKIT=1

# Podman 配置
export CONTAINER_HOST=unix:///run/podman/podman.sock
```

### 存储配置

```bash
# 在容器内配置 Podman 存储
mkdir -p ~/.config/containers
cat > ~/.config/containers/storage.conf << 'EOF'
[storage]
driver = "overlay"
graphroot = "/var/lib/containers/storage"

[storage.options]
mount_program = "/usr/bin/fuse-overlayfs"
EOF
```

### 网络配置

```bash
# 创建自定义网络
podman network create mynetwork

# 使用自定义网络运行容器
podman run --network mynetwork -d nginx
```

## 性能优化

### 1. 使用构建缓存

```bash
# Podman
podman build --layers -t myapp .

# Docker
docker build --cache-from myapp:latest -t myapp .
```

### 2. 多阶段并行构建

```dockerfile
FROM node:22 AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
```

### 3. 使用 BuildKit

```bash
# 启用 BuildKit（更快的构建）
export DOCKER_BUILDKIT=1
docker build -t myapp .
```

## 安全性分析

### DinD vs Socket Mount 安全对比

| 特性 | DinD 模式 | Socket Mount 模式 |
|------|-----------|-------------------|
| 容器隔离 | ✅ 完全隔离 | ❌ 可访问宿主机容器 |
| 镜像隔离 | ✅ 独立镜像库 | ❌ 共享宿主机镜像 |
| 容器逃逸风险 | ⭐⭐⭐⭐ 低 | ⭐ 高 |
| 数据泄露风险 | ⭐⭐⭐⭐ 低 | ⭐ 高 |
| 恶意操作影响 | 仅限外层容器 | 可影响宿主机 |
| 性能开销 | 有（独立运行时） | 无 |

### 安全最佳实践

#### 1. 限制资源使用

```bash
# 限制 CPU 和内存
manyoyo -m dind -x "podman run --cpus=1 --memory=512m myapp"
```

#### 2. 使用非特权模式（如果可能）

```bash
# Podman rootless 模式（更安全）
podman run --security-opt=no-new-privileges myapp
```

#### 3. 扫描镜像安全漏洞

```bash
# 使用 Trivy 扫描
podman run --rm -v /var/run/docker.sock:/var/run/docker.sock \
    aquasec/trivy image myapp:latest
```

#### 4. 定期清理

```bash
# 清理未使用的资源
podman system prune -a --volumes
```

## 故障排查

### Docker daemon 启动失败

**问题**：`dockerd` 命令无法启动

**解决方案**：
```bash
# 检查日志
tail -f /var/log/dockerd.log

# 手动启动并查看错误
dockerd --debug

# 清理旧的 socket
rm -f /var/run/docker.sock
```

### Podman 权限问题

**问题**：提示权限不足

**解决方案**：
```bash
# 检查用户命名空间
podman unshare cat /proc/self/uid_map

# 重置 Podman
podman system reset

# 检查存储配置
podman info
```

### 镜像拉取失败

**问题**：无法拉取镜像

**解决方案**：
```bash
# 检查网络
ping -c 3 docker.io

# 配置镜像代理
mkdir -p /etc/containers
cat > /etc/containers/registries.conf << 'EOF'
[[registry]]
location = "docker.io"
[[registry.mirror]]
location = "mirror.example.com"
EOF

# 或使用代理
export HTTP_PROXY=http://proxy:8080
export HTTPS_PROXY=http://proxy:8080
```

### 存储空间不足

**问题**：磁盘空间不足

**解决方案**：
```bash
# 查看存储使用情况
podman system df

# 清理无用资源
podman system prune -a --volumes

# 检查嵌套容器占用
podman ps -a --size
```

## 限制和注意事项

### 已知限制

1. **性能开销**：嵌套容器比直接容器慢 10-30%
2. **磁盘占用**：独立的镜像存储增加磁盘使用
3. **网络复杂性**：多层网络可能导致配置复杂
4. **某些功能不支持**：部分高级 Docker 特性可能不可用

### 注意事项

1. **退出清理**：删除外层容器会清理所有嵌套容器
2. **数据持久化**：重要数据应挂载到外层容器
3. **网络端口**：嵌套容器端口需要映射两次
4. **资源限制**：外层容器的资源限制会影响嵌套容器

## 对比其他方案

### DinD vs Kaniko

**Kaniko**：无 daemon 的容器镜像构建工具

| 特性 | DinD | Kaniko |
|------|------|--------|
| 需要特权 | 是 | 否 |
| 构建速度 | 快 | 较慢 |
| 缓存支持 | 完整 | 有限 |
| Dockerfile 兼容性 | 100% | ~95% |
| 适用场景 | 开发和测试 | 生产 CI/CD |

### DinD vs sysbox

**sysbox**：更安全的容器运行时

| 特性 | DinD | sysbox |
|------|------|--------|
| 安全性 | 中等 | 高 |
| 设置复杂度 | 简单 | 复杂 |
| 兼容性 | 高 | 中等 |
| 性能 | 中等 | 较好 |

## 最佳实践总结

### 开发环境

```bash
# 使用 dind 模式 + Podman
manyoyo -m dind -r claude

# AI 辅助开发容器化应用
# 快速迭代、测试、调试
```

### CI/CD 环境

```bash
# 使用自动化脚本
manyoyo --yes -m dind -x "
  podman build -t myapp:$CI_COMMIT_SHA . &&
  podman run --rm myapp:$CI_COMMIT_SHA npm test
"
```

### 生产环境

**不推荐使用 DinD**，建议：
- 使用专用的容器运行时（Kubernetes）
- 或使用 Kaniko 等无 daemon 工具

## 相关文档

- [容器模式对比](../reference/container-modes) - 了解不同容器模式
- [基础用法](../guide/basic-usage) - 学习基本命令
- [配置示例](../configuration/examples) - 查看配置示例
- [故障排查](../troubleshooting/runtime-errors) - 解决运行时问题
