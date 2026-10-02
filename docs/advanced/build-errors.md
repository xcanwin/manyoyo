---
title: "构建问题排查 | MANYOYO"
description: "按错误信息排查 MANYOYO 自定义镜像构建失败：网络、权限、缓存与平台问题的原因与最短解决办法。"
---

# 构建问题排查

按错误信息查原因和最短解决办法。默认镜像 `ghcr.io/xcanwin/manyoyo` 会自动拉取，只有[自定义镜像](./custom-image.md)才需要构建。示例使用 `2.1.0-common`，请替换为实际标签。

## 构建失败的通用排查

先保存日志，再按下面的症状对号入座：

```bash
manyoyo build --iv 2.1.0-common 2>&1 | tee build.log
grep -i "error\|failed\|fatal" build.log
```

仍找不到原因时，先构建精简版验证基础链路，成功后再构建完整版：

```bash
manyoyo build --iv 2.1.0-common --iba TOOL=common
manyoyo build --iv 2.1.0-full --iba TOOL=full
```

## 镜像拉取失败

```text
Error: pinging container registry localhost failed
```

原因：本地没有镜像，且无法访问镜像仓库（网络、代理或指定了不存在的标签）。

```bash
# 查看本机已有标签
docker images | grep manyoyo  # 或 podman images

# 使用已有标签
manyoyo run --iv <x.y.z-后缀> -y c

# 或在本地构建
manyoyo build --iv 2.1.0-common
```

想长期使用某个标签，在 `~/.manyoyo/manyoyo.json` 里设置 `"imageVersion": "2.1.0-common"`。

## 网络问题

```text
Error: unable to download from https://...
Error: connection timeout
```

原因：访问不了镜像源、DNS 解析失败或需要代理。

```bash
# 连通性与代理
curl -I https://mirrors.tencent.com
echo $HTTP_PROXY $HTTPS_PROXY

# DNS
nslookup mirrors.tencent.com
```

- **代理**：Docker 在 `~/.docker/config.json` 的 `proxies.default` 里设置 `httpProxy` / `httpsProxy` / `noProxy`；Podman 导出 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 环境变量后重新构建。
- **DNS**：Docker 在 `/etc/docker/daemon.json` 设置 `"dns": ["8.8.8.8"]`，Podman 在 `~/.config/containers/containers.conf` 的 `[containers]` 下设置 `dns_servers = ["8.8.8.8"]`，然后重启服务。
- **防火墙（firewalld）**：`sudo firewall-cmd --permanent --zone=trusted --add-interface=docker0 && sudo firewall-cmd --reload`（Podman 用 `cni-podman0`）。
- **国外网络**：默认镜像源是国内站点，可置空后用官方源：

```bash
manyoyo build --iv 2.1.0-common --iba NODEJS_MIRROR= --iba NPM_REGISTRY= --iba PIP_INDEX_URL=
```

- **Git SSL 证书校验失败**（仅限开发环境）：`--iba GIT_SSL_NO_VERIFY=true`。
- **下载超时**：缓存会放在 `docker/cache/`（2 天有效），重试通常能跳过已下载的部分。

## 磁盘空间不足

```text
Error: no space left on device
```

原因：构建需要至少约 10GB 空闲空间。

```bash
df -h
docker system df  # 或 podman system df

manyoyo prune                # 清理悬空和 <none> 镜像
docker builder prune -a      # 清理构建缓存
rm -rf docker/cache/         # 清理 MANYOYO 下载缓存（下次构建会重新下载）
```

不要轻易用 `docker system prune -a`，它会删除所有未使用的镜像和已停止的容器。系统盘不够用时，把数据目录移到大盘：Docker 在 `/etc/docker/daemon.json` 设置 `"data-root"`，Podman 在 `~/.config/containers/storage.conf` 的 `[storage]` 下设置 `graphroot`。

## 权限问题

```text
Error: permission denied while trying to connect to the Docker daemon socket
```

原因：当前用户不在 `docker` 组。

```bash
sudo usermod -aG docker $USER
newgrp docker
docker ps
```


## 平台问题

- **Windows WSL2**：确认 Docker Desktop 启用了 WSL2 后端并为当前发行版开启集成（`docker version` 能连上），或直接在 WSL 里安装原生 Docker / Podman。

## 缓存问题

缓存目录 `docker/cache/`（Node.js、JDT LSP、gopls），2 天内有效。

- **缓存损坏、构建时报解压或校验错误**：`rm -rf docker/cache/` 后重新构建。
- **缓存没生效**：`find docker/cache/ -type f -mtime +2` 列出的文件已过期，会被重新下载。

## 需要更详细的输出

手动构建并显示完整过程：

```bash
podman build -t ghcr.io/xcanwin/manyoyo:test-full \
    -f docker/manyoyo.Dockerfile . \
    --build-arg TOOL=full --no-cache --progress=plain
```

## 下一步

- [自定义镜像](./custom-image.md)：构建参数与缓存机制
- [运行时问题](../troubleshooting/runtime-errors.md)：容器运行阶段的错误
- [故障排查首页](../troubleshooting/README.md)
