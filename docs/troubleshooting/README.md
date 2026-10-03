---
title: 常见问题 | MANYOYO
description: MANYOYO 常见问题按症状索引：安装、登录、权限、镜像、环境变量，每条给出最短排查路径。
---

# 常见问题

按症状找答案；找不到再看最下面的「最小诊断流程」。

## 安装与启动

**Linux 安装时提示缺少容器环境或网络组件**
按提示执行安装器给出的那条命令，再重新运行安装命令即可续上；没有终端或你选了 n 时，安装器不会执行 `sudo`。已经装好后运行出错，`manyoyo doctor` 会查出原因并给出命令。

**浏览器没有自动打开**
终端会打印一次性登录地址，60 秒内访问即可；超时再执行一次 `manyoyo`。SSH 等无图形界面的机器见[第一次使用](../guide/first-run.md)。

**忘记登录密码**
在本机执行 `manyoyo` 会自动登录，不需要密码。要重设密码，运行 `manyoyo setup`，或直接修改 `~/.manyoyo/manyoyo.json` 里的 `serverPass`。

**升级后想回到上一版本**
`manyoyo update --rollback`，见[日常使用](../guide/daily.md)。

## 运行与镜像

**`permission denied`**
Docker / Podman 权限不足。先确认 `docker ps` 能直接运行；详见[权限问题](./runtime-errors.md#权限不足)。

**`pinging container registry failed` / 镜像拉取失败**
网络无法访问镜像仓库。检查代理，或改用本地构建，见[镜像拉取失败](../advanced/build-errors.md#镜像拉取失败)。

**环境变量未生效**
`envFile` 必须是绝对路径。用 `manyoyo config show --ef /abs/path/example.env` 核对，详见[环境变量问题](./runtime-errors.md#环境变量未生效)。

**`manyoyo build` 失败**
绝大多数用户不需要自己构建。确需构建时见[镜像构建问题](../advanced/build-errors.md)。

## 最小诊断流程

```bash
manyoyo doctor                  # 检查容器运行时、镜像、配置和端口
manyoyo doctor --fix            # 自动修复可修复的项
manyoyo config show -r claude   # 查看最终生效的配置
manyoyo config command -r claude  # 查看将执行的容器命令
manyoyo ps                      # 容器状态
```

## 获取帮助

到 [GitHub Issues](https://github.com/xcanwin/manyoyo/issues) 提交，请附：复现步骤、错误日志、`manyoyo -v` 与系统信息、脱敏后的配置片段。更多运行时问题见[运行时问题](./runtime-errors.md)。
