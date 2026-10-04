---
title: 配置入门 | MANYOYO
description: 一个配置文件、四层优先级和最小示例，几分钟搞懂 MANYOYO 配置
---

# 配置入门

本页说明 MANYOYO 的配置放在哪、多个来源冲突时谁生效。不配置也能用，需要固定 Agent、环境变量或挂载时再看。

## 一个文件

全局配置只有一个：`~/.manyoyo/manyoyo.json`，任何 `manyoyo` 命令都会自动读取（存在时）。格式是 JSON5，支持注释、尾随逗号和不加引号的键名：

```json5
{
    // 全局默认值
    imageVersion: "2.1.1-common",
    runs: {
        // 命名的运行配置：manyoyo run -r claude
        claude: {
            envFile: ["/abs/path/anthropic.env"],
            yolo: "c",
        },
    },
}
```

- `manyoyo run -r <name>` 读取 `runs.<name>`，只接受名称，不接受文件路径。
- `envFile` 与 `--ef` 仅支持绝对路径。
- `containerName` 支持 `{now}` 模板（展开为 `MMDD-HHmm`）。
- 全部字段见[配置文件](./config-files.md)。

## 四层优先级

**命令行 > `runs.<name>` > 全局配置 > 默认值**

不同类型的参数合并方式不同：

| 类型 | 参数 | 行为 |
| --- | --- | --- |
| 标量 | `containerName`、`hostPath`、`containerPath`、`imageName`、`imageVersion`、`containerMode`、`yolo`、`shellPrefix`、`shell`、`serverUser`、`serverPass` | 只取优先级最高的一个 |
| map | `env` | 按 key 合并，同名 key 高优先级覆盖 |
| 数组 | `envFile`、`volumes`、`ports`、`imageBuildArgs` | 按「全局 → `runs.<name>` → 命令行」依次追加，全部生效 |
| 首次执行 | `first.shellPrefix/shell/shellSuffix`、`first.env`、`first.envFile` | 仅新建容器时执行一次；各字段规则同上 |

`serverUser` / `serverPass` 额外支持环境变量 `MANYOYO_SERVER_USER` / `MANYOYO_SERVER_PASS` 兜底（优先级低于全局配置、高于默认值），详见[网页服务](../guide/web.md)。

## 最小示例

```bash
# 全局：imageVersion 2.1.1-common；runs.demo：imageVersion 2.1.1-full，env VAR2
# 命令行：-e VAR3=value3
manyoyo run -r demo -e "VAR3=value3"
# 镜像用 2.1.1-full（runs 覆盖全局）；VAR2、VAR3 以及全局 env 都生效
```

## 看最终结果

```bash
manyoyo config show -r demo      # 合并后的最终配置
manyoyo config command -r demo   # 将执行的容器命令
```

## 下一步

- [环境变量](./environment.md)：传 API 地址和 Token
- [配置文件](./config-files.md)：全部字段
- [配置示例](./examples.md)
