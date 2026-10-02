---
title: "会话管理与恢复 | MANYOYO"
description: "创建、恢复、保留和清理 MANYOYO 容器会话，以及各 Agent 的会话恢复方式。"
---

# 会话管理

本页说明如何创建、恢复、保留和清理容器会话。会话 = 一个容器 + 容器内智能体的工作状态与对话历史。

> 运行配置写在 `~/.manyoyo/manyoyo.json` 的 `runs.<name>`，`envFile` 用绝对路径，`env` 用对象。

## 创建会话

```bash
# 命名会话（推荐，便于恢复）
manyoyo run -n my-project -y c

# 不指定名称时自动生成 my-{月日}-{时分}，用 manyoyo ps 查看
manyoyo run -y c

# 用运行配置固定名称与参数
manyoyo run -r project-a
```

```json
{
    "runs": {
        "project-a": {
            "containerName": "my-project-a",
            "hostPath": "/abs/path/project-a",
            "envFile": ["/abs/path/anthropic_claudecode.env"],
            "yolo": "c"
        }
    }
}
```

`containerName` 支持 `{now}` 模板（展开为 `MMDD-HHmm`）。

## 退出时的选择

退出智能体后会询问是否保留容器：

| 选项 | 作用 |
|------|------|
| `y`（默认） | 容器留在后台，之后可恢复 |
| `n` | 删除容器，数据与历史丢失 |
| `1` | 用首次命令（容器标签 `manyoyo.default_cmd`）重新进入 |
| `r` | 在首次命令后追加恢复参数（仅首次命令是 Agent 时出现） |
| `x` | 输入并执行新命令 |
| `i` | 进入交互式 shell |

不想被询问可用 `-q` 的静默项隐藏提示（见 [CLI 选项](../reference/cli-options.md)），一次性任务用 `--rm-on-exit` 退出即删除：

```bash
manyoyo run -n temp --rm-on-exit -y c
```

## 恢复会话

容器仍在时，用同名重新进入；`-- ` 之后的参数追加到首次命令：

```bash
manyoyo run -n my-project              # 重新执行首次命令
manyoyo run -n my-project -- -r        # Claude / Gemini 恢复
manyoyo run -n my-project -- resume    # Codex 恢复
manyoyo run -n my-project -- -c        # OpenCode 恢复
```

各智能体的恢复参数以 `lib/agent-resume.js` 为准：Claude/Gemini → `-r`，Codex → `resume`，OpenCode → `-c`。会话启动后终端提示里也会打印当前容器可用的恢复命令。更多恢复选项见各智能体自己的 `--help`。

## 持久化范围

- **容器存在时**：文件系统、环境变量与智能体对话历史都保留在容器里；`manyoyo rm` 后一并消失。
- **工作目录**：默认挂载当前目录，用 `--hp` 指定其他目录，代码改动保存在宿主机。
- **额外数据**：用 `-v` 或 `volumes` 挂载；命名卷在容器删除后仍保留。
- **对话历史**：保存在容器内（如 `~/.claude`、`~/.codex`）。要在删除容器后保留，需要挂载对应目录；挂载宿主机凭据或配置目录的风险见 [安全须知](../guide/security.md)。

```bash
manyoyo run -n my-project -v "myproject-data:/workspace/data" -y c
```

## 多会话

每个会话有独立的文件系统、环境变量、对话历史与进程空间，按项目各开一个：

```bash
manyoyo run -n project-a --hp ~/projects/a -y c
manyoyo run -n project-b --hp ~/projects/b -y c
manyoyo ps                          # 查看全部会话
manyoyo run -n project-a -- -r      # 切回 A（Claude）
```

## 查看与进入

```bash
manyoyo ps                                  # 列出会话
manyoyo run -n my-project -x /bin/bash      # 进入运行中的容器
docker logs --tail 100 my-project           # 容器日志（Podman 同理）
```

## 清理

先 `manyoyo ps` 确认名称，再逐个删除，不要用按前缀批量匹配的命令，以免误删其他容器：

```bash
manyoyo ps
manyoyo rm <名称>
```

## 备份与快照

```bash
docker cp my-project:/root/.claude ./claude-backup    # 备份智能体历史
docker commit my-project my-project:snapshot          # 保存容器当前状态为镜像
```

快照镜像不会自动被 `manyoyo` 管理，不需要时用 `manyoyo images` 查看后清理。

## 常见问题

- **提示容器不存在**：`manyoyo ps` 确认名称；已被删除就重新 `manyoyo run -n <名称> -y c`。
- **恢复后智能体不记得之前的对话**：容器可能是新建的，或历史目录没有挂载；见上文持久化范围。
- **容器无法启动**：`docker logs <名称>` 看原因，必要时 `manyoyo rm <名称>` 后重建；运行时问题见 [运行错误](../troubleshooting/runtime-errors.md)。

## 下一步

- [基础用法](../guide/basic-usage.md)
- [AI 智能体](../reference/agents.md)
- [安全须知](../guide/security.md)
