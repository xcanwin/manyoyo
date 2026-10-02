# 运行时问题排查

按症状查找：错误信息 → 原因 → 解决。先跑一遍 `manyoyo doctor`，加 `--fix` 可自动修复可修复项（启动容器环境、拉取镜像、生成默认配置）。

## 容器启动失败

**容器立即退出**：默认命令执行完就会退出，或命令不存在、必需的环境变量缺失。

```bash
manyoyo ps                          # 查看容器状态
docker logs <容器名>                 # Podman 用 podman logs；私有 Podman 用 manyoyo podman logs
manyoyo run -n debug -x /bin/bash   # 进 shell 手动排查
```

**端口冲突**（`port is already allocated`）：停掉占用端口的容器，或换端口。

```bash
manyoyo ps
manyoyo rm <冲突容器名>
```

**挂载失败**（`mounts denied` / `no such file or directory`）：宿主机路径不存在，或被安全校验拒绝（不允许挂载 `/`、`/home`、`$HOME`）。改为挂载具体子目录。

**镜像版本不匹配**：用 `manyoyo images` 查看本地镜像，指定版本运行。

```bash
manyoyo run --iv 2.1.0-common
```

镜像缺失时会自动从 `ghcr.io/xcanwin/manyoyo` 拉取，无需自行构建；构建问题见 [构建错误](../advanced/build-errors.md)。

## 权限不足

**症状**：`permission denied while trying to connect to the Docker daemon socket`。

**原因**：当前用户无权访问 Docker socket。

```bash
sudo usermod -aG docker $USER && newgrp docker
docker ps    # 能直接运行即可
```

不要用 `sudo manyoyo`：配置会从 `/root/` 而不是 `~/` 读取。Podman 默认 rootless，无需 sudo。

**挂载文件无法读写**：容器内用户需要对宿主机文件有对应权限，只读内容用 `:ro` 挂载（`-v /abs/host:/work:ro`）。

**SELinux 拒绝访问**（Fedora / RHEL）：挂载加 `:z` 或 `:Z`，不要关闭 SELinux。

```bash
manyoyo run -v /abs/host/dir:/work:z
```

## 环境变量未生效

**症状**：容器内 `echo $ANTHROPIC_AUTH_TOKEN` 为空，或 Agent 报缺少密钥。

**原因与排查**：

1. `envFile` / `--ef` 只支持**绝对路径**，相对路径和 `~` 不会被解析。
2. 文件格式须为 `KEY=value` 每行一条（带 `export` 前缀也可），不要含 Windows 换行（`dos2unix file.env`），值中不要出现 `` ; & | ` $ < > `` 等被安全校验拒绝的字符，也不要用 shell 变量替换。
3. 用 `config show` 看最终生效的值：

```bash
manyoyo config show -r claude
manyoyo config show --ef /abs/path/example.env
```

4. 进入容器核对：`manyoyo run -n debug -x env | grep ANTHROPIC`。

**同名变量取值错误**：优先级为 命令行 > `runs.<name>` > 全局配置。`env` 按 key 覆盖，`envFile` 按「全局 → runs → 命令行」追加，后者覆盖前者。

## 容器内看不到宿主机文件

**原因**：没有挂载，或路径写错。默认只挂载当前目录，其他路径需显式挂载（宿主机路径用绝对路径）。

```bash
manyoyo run -v /abs/host/data:/data              # 可重复使用 -v
manyoyo config command -r <name>                 # 预览最终的挂载参数
```

符号链接：挂载目标会被解析为真实路径，链接指向挂载范围之外时容器内会断链，请直接挂载真实路径。

## AI CLI 工具报错

先确认环境文件已生效（见上一节），再按工具核对。各 Agent 的配置见 [Agent 参考](../reference/agents.md)。

| 症状 | 原因 | 解决 |
| --- | --- | --- |
| Claude Code：`Invalid API key` / `Authentication failed` | `ANTHROPIC_AUTH_TOKEN` 缺失或错误 | 检查环境文件中的密钥与 `ANTHROPIC_BASE_URL` |
| Claude Code：`model not found` | 模型名不被该服务支持 | 设置 `ANTHROPIC_MODEL` 为服务支持的名称 |
| Codex：`No authentication found` / `Unauthorized` | 容器内没有认证文件 | 挂载 `-v /abs/home/.codex/auth.json:/root/.codex/auth.json` |
| Codex：`ECONNREFUSED` / `404 Not Found` | `OPENAI_BASE_URL` 错误 | 修正为服务商给出的地址 |
| Gemini：`API key not valid` | `GEMINI_API_KEY` 错误 | 检查环境文件 |
| OpenCode：`Missing API key` | 缺少 `OPENAI_API_KEY` 等密钥 | 在环境文件中补充 |

`runs.<name>` 里设置 `envFile` 与 `volumes` 即可固化，例如：

```json
{ "runs": { "codex": { "yolo": "cx", "envFile": ["/abs/path/codex.env"], "volumes": ["/abs/home/.codex/auth.json:/root/.codex/auth.json"] } } }
```

`manyoyo init <agent>` 可导入本机已有的 Agent 配置。

## 网络连接问题

**容器内无法联网或解析域名**：

```bash
manyoyo run -x curl -sI https://example.com   # 复现
```

- DNS 异常：在 Docker `daemon.json` 配置 `"dns": ["8.8.8.8"]` 后重启 Docker。
- 防火墙拦截（firewalld）：把 Docker 网卡加入信任区域。
- 需要代理：在环境文件或 `env` 中设置 `HTTP_PROXY` / `HTTPS_PROXY`，容器内访问宿主机用 `host.docker.internal`（Podman 为 `host.containers.internal`），不要写 `127.0.0.1`。

## 性能问题

- 启动慢：首次需拉取镜像，之后用 `manyoyo prune` 清理无用资源，避免磁盘占满。
- 运行慢：Docker Desktop / Podman machine 调大 CPU 与内存；避免 bind mount 大量小文件（如 `node_modules`）。

## 调试技巧

```bash
manyoyo config show -r <name>       # 最终生效的配置
manyoyo config command -r <name>    # 将要执行的容器命令
manyoyo run -n debug -x /bin/bash   # 进入干净容器对比
manyoyo doctor --json               # 环境诊断
```

涉及 `sock` / `dind` 模式的风险见 [安全](../guide/security.md)。

## 下一步

- [故障排查总览](./README.md)
- [构建错误](../advanced/build-errors.md)
- [配置文件](../configuration/config-files.md)
