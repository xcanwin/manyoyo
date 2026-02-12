# 故障排查指南

本页用于快速定位 MANYOYO 常见问题，并给出最短排查路径。

## 快速入口

- 构建失败：[`build-errors`](./build-errors.md)
- 运行异常：[`runtime-errors`](./runtime-errors.md)

## 常见问题速查

| 症状 | 可能原因 | 快速命令 | 详情 |
| --- | --- | --- | --- |
| `manyoyo --ib` 失败 | 网络/磁盘/权限 | `df -h`、`manyoyo --ib --iv 1.8.0-common` | [构建问题](./build-errors.md) |
| `pinging container registry failed` | 本地镜像未构建 | `manyoyo --ib --iv 1.8.0-common` | [镜像拉取失败](./build-errors.md#镜像拉取失败) |
| `permission denied` | Docker/Podman 权限不足 | `groups`、`docker ps` | [权限问题](./runtime-errors.md#权限不足) |
| 环境变量未生效 | `envFile` 路径/格式错误 | `manyoyo --ef /abs/path/example.env --show-config` | [环境变量问题](./runtime-errors.md#环境变量未生效) |

## 最小诊断流程

1. 基础检查

```bash
manyoyo -V
node --version
docker --version   # 或 podman --version
```

2. 查看最终配置和命令

```bash
manyoyo --show-config
manyoyo --show-command
manyoyo -r claude --show-config
```

3. 检查镜像与容器状态

```bash
docker images | grep manyoyo   # 或 podman images
manyoyo -l
```

4. 验证环境文件加载（`--ef` 仅支持绝对路径）

```bash
manyoyo --ef /abs/path/anthropic_claudecode.env --show-config
manyoyo --ef /abs/path/anthropic_claudecode.env -x env | grep ANTHROPIC
```

## 配置检查要点

- 运行配置位于 `~/.manyoyo/manyoyo.json` 的 `runs.<name>`。
- `manyoyo -r <name>` 只按名称读取 `~/.manyoyo/manyoyo.json` 中的 `runs.<name>`。
- `envFile` 必须是绝对路径数组。

## 获取帮助

1. 收集信息

```bash
uname -a
manyoyo -V
manyoyo --show-config
manyoyo -l
```

2. 导出日志

```bash
manyoyo --ib --iv 1.8.0-common 2>&1 | tee build-error.log
docker logs <容器名> 2>&1 | tee runtime-error.log  # 或 podman logs
```

3. 提交 Issue

- 仓库地址：[GitHub Issues](https://github.com/xcanwin/manyoyo/issues)
- 请附：复现步骤、错误日志、系统信息、脱敏后的配置片段。
