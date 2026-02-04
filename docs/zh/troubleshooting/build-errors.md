# 构建问题排查

本页面介绍 MANYOYO 镜像构建过程中可能遇到的问题及解决方案。

## 镜像构建失败

### 问题描述

执行 `manyoyo --ib` 时报错，构建过程中断。

### 常见错误信息

```bash
# 网络超时
Error: unable to download from https://...
Error: connection timeout

# 磁盘空间不足
Error: no space left on device

# 权限问题
Error: permission denied while trying to connect to the Docker daemon socket
```

### 解决方案

#### 1. 检查网络连接

```bash
# 测试国内镜像源
curl -I https://mirrors.tencent.com

# 测试 npm 镜像
curl -I https://registry.npmmirror.com

# 如果网络不通，检查代理设置
echo $HTTP_PROXY
echo $HTTPS_PROXY
```

**配置代理**（如果需要）：
```bash
# 临时设置代理
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080

# 或在 Docker/Podman 配置中设置代理
# Docker: ~/.docker/config.json
# Podman: ~/.config/containers/containers.conf
```

#### 2. 检查磁盘空间

```bash
# 查看磁盘空间（需要至少 10GB）
df -h

# 清理 Docker/Podman 缓存
docker system prune -a  # 或 podman system prune -a

# 清理悬空镜像
manyoyo --irm
```

#### 3. 使用 --yes 跳过确认

```bash
# 跳过所有交互式确认
manyoyo --ib --iv 1.7.0 --yes
```

#### 4. 国外用户修改镜像源

如果在国外，可能需要禁用国内镜像源：

编辑 `docker/manyoyo.Dockerfile`，注释掉镜像源相关的 ARG：
```dockerfile
# ARG NODE_MIRROR=https://mirrors.tencent.com/nodejs-release/
# ARG NPM_REGISTRY=https://registry.npmmirror.com
```

或使用空值：
```bash
manyoyo --ib --iv 1.7.0 --iba NODE_MIRROR= --iba NPM_REGISTRY=
```

#### 5. 分步构建调试

```bash
# 先构建基础版本（更快，问题更少）
manyoyo --ib --iv 1.7.0 --iba TOOL=common

# 基础版本成功后，再构建完整版本
manyoyo --ib --iv 1.7.0 --iba TOOL=full
```

#### 6. 查看详细构建日志

```bash
# 保存构建日志
manyoyo --ib --iv 1.7.0 2>&1 | tee build.log

# 查找错误关键字
grep -i "error\|failed\|fatal" build.log
```

### 构建超时

**问题**：构建过程中下载文件超时

**解决方案**：
```bash
# 增加 Docker/Podman 超时时间
# Docker: 编辑 /etc/docker/daemon.json
{
    "max-concurrent-downloads": 3,
    "max-download-attempts": 5
}

# 重启 Docker
sudo systemctl restart docker

# 或使用缓存加速（推荐）
# MANYOYO 会自动缓存下载的文件到 docker/cache/
# 首次构建后，2天内再次构建会使用缓存，速度提升约 5 倍
```

### Git SSL 验证问题

**问题**：构建时 Git 报 SSL 证书验证失败

**解决方案**：
```bash
# 构建时跳过 Git SSL 验证（不推荐，仅限开发环境）
manyoyo --ib --iv 1.7.0 --iba GIT_SSL_NO_VERIFY=true
```

## 镜像拉取失败

### 问题描述

运行 `manyoyo` 命令时提示：
```bash
Error: pinging container registry localhost failed
```

### 原因

MANYOYO 默认使用本地镜像（`localhost/xcanwin/manyoyo`），需要先构建。

### 解决方案

#### 1. 构建本地镜像（推荐）

```bash
# 构建镜像
manyoyo --ib --iv 1.7.0

# 验证镜像
docker images | grep manyoyo  # 或 podman images
```

#### 2. 修改配置使用已构建的镜像

如果已经构建了其他版本的镜像：

```bash
# 查看已有镜像
docker images | grep manyoyo

# 修改全局配置
cat > ~/.manyoyo/manyoyo.json << 'EOF'
{
    "imageVersion": "1.6.0-full"  # 使用已有的版本
}
EOF
```

#### 3. 指定镜像版本

```bash
# 命令行指定版本
manyoyo --iv 1.6.0-full -y c
```

### 镜像不存在

**问题**：指定的镜像版本不存在

**解决方案**：
```bash
# 列出所有 manyoyo 镜像
docker images | grep manyoyo

# 使用存在的版本
manyoyo --iv <existing-version> -y c

# 或构建新版本
manyoyo --ib --iv 1.7.0
```

## 网络连接问题

### DNS 解析失败

**问题**：构建时无法解析域名

**解决方案**：
```bash
# 测试 DNS
nslookup mirrors.tencent.com

# 修改 Docker/Podman DNS 设置
# Docker: /etc/docker/daemon.json
{
    "dns": ["8.8.8.8", "114.114.114.114"]
}

# Podman: ~/.config/containers/containers.conf
[containers]
dns_servers = ["8.8.8.8", "114.114.114.114"]

# 重启服务
sudo systemctl restart docker  # 或 podman
```

### 防火墙阻止

**问题**：防火墙阻止容器网络访问

**解决方案**：
```bash
# 检查防火墙状态
sudo firewall-cmd --state

# 临时允许 Docker/Podman 网络
sudo firewall-cmd --zone=trusted --add-interface=docker0  # 或 cni-podman0

# 永久配置
sudo firewall-cmd --permanent --zone=trusted --add-interface=docker0
sudo firewall-cmd --reload
```

### 代理配置问题

**问题**：需要通过代理访问网络，但构建时未使用代理

**解决方案**：
```bash
# 配置构建时的代理
# Docker: ~/.docker/config.json
{
    "proxies": {
        "default": {
            "httpProxy": "http://proxy.example.com:8080",
            "httpsProxy": "http://proxy.example.com:8080",
            "noProxy": "localhost,127.0.0.1"
        }
    }
}

# Podman: 使用环境变量
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080
export NO_PROXY=localhost,127.0.0.1

# 重新构建
manyoyo --ib --iv 1.7.0
```

## 磁盘空间不足

### 问题描述

构建过程中报错：
```bash
Error: no space left on device
```

### 解决方案

#### 1. 检查磁盘空间

```bash
# 查看磁盘使用情况
df -h

# 查看 Docker/Podman 占用空间
docker system df  # 或 podman system df
```

#### 2. 清理无用镜像和容器

```bash
# 清理所有无用资源（危险！会删除所有未使用的镜像和容器）
docker system prune -a

# 或分步清理
docker container prune  # 清理停止的容器
docker image prune      # 清理悬空镜像
docker volume prune     # 清理无用卷

# MANYOYO 提供的清理命令
manyoyo --irm           # 清理悬空和 <none> 镜像
```

#### 3. 移动 Docker/Podman 数据目录

如果系统盘空间不足，可以将数据目录移到其他盘：

**Docker**：
```bash
# 停止 Docker
sudo systemctl stop docker

# 移动数据目录
sudo mv /var/lib/docker /mnt/large-disk/docker

# 修改配置 /etc/docker/daemon.json
{
    "data-root": "/mnt/large-disk/docker"
}

# 启动 Docker
sudo systemctl start docker
```

**Podman**：
```bash
# 修改配置 ~/.config/containers/storage.conf
[storage]
driver = "overlay"
graphroot = "/mnt/large-disk/podman"
```

#### 4. 清理构建缓存

```bash
# 清理 Docker 构建缓存
docker builder prune -a

# 清理 MANYOYO 缓存（如果不需要加速）
rm -rf docker/cache/
```

## 权限问题

### Docker Socket 权限不足

**问题**：
```bash
Error: permission denied while trying to connect to the Docker daemon socket
```

**解决方案**：
```bash
# 方案 1：将用户添加到 docker 组（推荐）
sudo usermod -aG docker $USER

# 重新登录或运行
newgrp docker

# 验证
docker ps

# 方案 2：使用 sudo（不推荐）
sudo manyoyo --ib --iv 1.7.0
```

### 文件权限问题

**问题**：构建时无法写入文件

**解决方案**：
```bash
# 检查目录权限
ls -la docker/

# 修改权限
chmod -R 755 docker/

# 检查 SELinux 状态（如果适用）
getenforce

# 临时禁用 SELinux（不推荐）
sudo setenforce 0
```

## 平台兼容性问题

### ARM64/M1 Mac 问题

**问题**：在 ARM64 架构（如 M1/M2 Mac）上构建失败

**解决方案**：
```bash
# 指定平台构建
docker build --platform linux/amd64 ...

# 或使用 buildx
docker buildx build --platform linux/amd64,linux/arm64 ...

# MANYOYO 会自动检测平台，通常无需手动指定
```

### Windows WSL2 问题

**问题**：在 Windows WSL2 环境中构建失败

**解决方案**：
```bash
# 确保 Docker Desktop 已启用 WSL2 后端
# 确保当前 WSL 发行版已集成 Docker

# 检查 Docker 状态
docker version

# 如果无法连接，重启 Docker Desktop
# 或在 WSL 中安装原生 Docker（推荐）
```

## 缓存相关问题

### 缓存文件损坏

**问题**：使用缓存构建时报错

**解决方案**：
```bash
# 清理缓存目录
rm -rf docker/cache/

# 重新构建（会重新下载）
manyoyo --ib --iv 1.7.0
```

### 缓存未生效

**问题**：明明有缓存，但构建还是很慢

**解决方案**：
```bash
# 检查缓存目录
ls -la docker/cache/

# 检查缓存时间（超过2天会重新下载）
find docker/cache/ -type f -mtime +2

# 手动更新缓存时间（不推荐）
touch docker/cache/*
```

## 调试技巧

### 启用详细日志

```bash
# 查看详细构建过程
manyoyo --ib --iv 1.7.0 2>&1 | tee build.log

# 在 Docker 中启用调试
export DOCKER_BUILDKIT=0  # 使用传统构建器，输出更详细
```

### 手动构建测试

```bash
# 手动构建以调试问题
cd docker/
podman build -t localhost/xcanwin/manyoyo:test-full \
    -f manyoyo.Dockerfile .. \
    --build-arg TOOL=full \
    --no-cache \
    --progress=plain  # 显示详细输出
```

### 分步构建

```bash
# 构建到特定阶段
podman build --target=base -f docker/manyoyo.Dockerfile .

# 测试特定构建参数
manyoyo --ib --iv 1.7.0 --iba TOOL=common --yes
```

## 相关文档

- [故障排查首页](./index.md) - 问题索引和快速导航
- [运行时问题](./runtime-errors.md) - 容器运行时问题
- [配置系统](../configuration/) - 配置文件和环境变量
