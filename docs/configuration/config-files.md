---
title: 配置文件详解
description: "~/.manyoyo/manyoyo.json 的全部字段、合并规则与最小示例"
---

# 配置文件详解

本页列出 `~/.manyoyo/manyoyo.json` 的所有字段。文件为 JSON5 格式（支持注释），完整模板见仓库 `manyoyo.example.json`。

## 文件与优先级

只有一个配置文件：`~/.manyoyo/manyoyo.json`。顶层字段是全局配置，`runs.<name>` 是运行配置，用 `-r <name>` 加载。

优先级：命令行 > `runs.<name>` > 全局配置 > 默认值。

- 标量字段：取最高优先级的值。
- `env`：按 key 合并，后者覆盖前者。
- `envFile`、`volumes`、`ports`、`imageBuildArgs`：按「全局 → `runs.<name>` → 命令行」追加。
- `serverUser` / `serverPass`：命令行 > `runs.<name>` > 全局配置 > 环境变量 > 默认值。

```json5
{
    "imageName": "ghcr.io/xcanwin/manyoyo",
    "imageVersion": "2.1.1-full",
    "runs": {
        "claude": {
            "envFile": ["/abs/path/anthropic_claudecode.env"],
            "yolo": "c"
        }
    }
}
```

## 容器与镜像

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `containerName` | 字符串 | `my-{月日-时分}` | 容器名，支持 `{now}`（→ `MMDD-HHmm`） |
| `hostPath` | 字符串 | 当前目录 | 挂载到容器的宿主机工作目录 |
| `containerPath` | 字符串 | 同 `hostPath` | 容器内工作目录 |
| `imageName` | 字符串 | `ghcr.io/xcanwin/manyoyo` | 镜像名（不含版本） |
| `imageVersion` | 字符串 | 无 | 格式 `x.y.z-后缀`，如 `2.1.1-common`、`2.1.1-full` |
| `containerMode` | 字符串 | `common` | `common` / `dind` / `sock`，见 [容器模式](../reference/container-modes.md) |
| `imageBuildArgs` | 字符串数组 | 无 | 构建参数 `KEY=VALUE`，追加合并，如 `TOOL=common` |

## 环境、挂载与端口

| 字段 | 类型 | 合并规则 | 说明 |
| --- | --- | --- | --- |
| `envFile` | 字符串数组 | 追加 | 环境文件，**仅支持绝对路径** |
| `env` | 对象 | 按 key 覆盖 | 直接指定环境变量 |
| `volumes` | 字符串数组 | 追加 | `宿主机路径:容器路径[:ro]`，宿主机路径支持绝对路径与 `~` / `$HOME` 前缀 |
| `ports` | 字符串数组 | 追加 | 透传为 `--publish`，如 `"8080:80"` |

```json5
{
    "env": { "TZ": "Asia/Shanghai" },
    "volumes": ["~/.ssh:/root/.ssh:ro"],
    "ports": ["127.0.0.1:8443:443"]
}
```

挂载与 `sock` 模式的安全提示见 [安全说明](../guide/security.md)。

## 命令

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `yolo` | 字符串 | `c` / `gm` / `cx` / `oc`（或 `claude` / `gemini` / `codex` / `opencode`），跳过权限确认，详见 [智能体](../reference/agents.md) |
| `shellPrefix` | 字符串 | 命令前缀，常用于临时环境变量 |
| `shell` | 字符串 | 主命令，如 `claude` |
| `shellSuffix` | 字符串 | 追加在 `shell` 后，如 `resume --last`；可被 `--ss` 或 `-- ...` 覆盖（后者最高） |
| `first` | 对象 | 仅在**新建容器后**执行一次，复用容器时不执行；含 `shellPrefix` / `shell` / `shellSuffix`（覆盖型）、`env`（按 key 合并）、`envFile`（追加） |
| `agentPromptCommand` | 字符串 | 网页 AGENT 模式的提示词命令模板，须含 `{prompt}`；为空时按 `shell` / `yolo` 自动推断 |
| `quiet` | 字符串数组 | 静默显示，可选 `tip` / `cmd` / `full` |

```json5
{
    "first": { "shell": "echo setup-once", "env": { "BOOTSTRAP": "1" } },
    "shell": "codex",
    "shellSuffix": "resume --last"
}
```

## 全局专属字段

以下字段只在全局配置生效，不支持 `runs.<name>`。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `containerRuntime` | 字符串 | `auto` | `auto` / `docker` / `podman`；`auto` 优先私有 Podman，其次 daemon 可用的 docker / podman。`manyoyo doctor` 会显示选中的运行时 |
| `updateCheck` | 布尔 | `true` | `serve` 每天最多查询一次新版本；请求不带本机信息，`false` 则完全不请求 |
| `mirrors` | 对象 | 官方源 | 容器内软件源 `apt` / `npm` / `pip`（`http(s)://` 地址，留空为官方源），新建容器时生效；`apt` 只填镜像站主机，如 `https://mirrors.aliyun.com`。`env` 里的同名变量优先 |

## 网页服务

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `serverUser` | 字符串 | `admin` | 登录用户名，环境变量 `MANYOYO_SERVER_USER` |
| `serverPass` | 字符串 | 随机生成 | 登录密码，环境变量 `MANYOYO_SERVER_PASS` |
| `serve.title` | 字符串 | 按会话 Agent 名动态显示 | 一旦设置（含空字符串）即固定显示；`runs.<name>.serve` 优先于全局 |
| `serve.quickChat` | 对象 | 无 | 网页「快捷对话」：`path` 为工作根目录，`run` 为使用的 `runs.<name>` |

认证与对外监听的注意事项见 [网页服务](../guide/web.md) 与 [安全说明](../guide/security.md)。

## 插件

`plugins.playwright` 配置 `manyoyo playwright`，`runs.<name>.plugins.playwright` 可覆盖全局。字段说明见 [Playwright 插件](../advanced/playwright.md)，默认值见 `manyoyo.example.json`。

## 调试配置

```bash
manyoyo config show             # 全局配置合并结果
manyoyo config show -r claude   # 某个运行配置的合并结果
manyoyo config command -r claude  # 将要执行的命令
```

配置没生效时先确认是有效的 JSON5，再用 `config show` 看最终值；`envFile` 没加载时确认是绝对路径。

## 下一步

- [配置系统概览](./README.md)
- [环境变量详解](./environment.md)
- [配置示例](./examples.md)
