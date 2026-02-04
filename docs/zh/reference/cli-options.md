# 命令参考

## 常用命令

| 场景 | 命令 |
| --- | --- |
| 查看帮助 | `manyoyo -h` |
| 查看版本 | `manyoyo -V` |
| 列出容器 | `manyoyo -l` |
| 创建容器并启动 Claude Code | `manyoyo -n test --ef .env -y c` |
| 进入 shell | `manyoyo -n test -x /bin/bash` |
| 执行自定义命令 | `manyoyo -n test -x echo "hello world"` |
| 删除容器 | `manyoyo -n test --crm` |
| 清理悬空镜像 | `manyoyo --irm` |

## 常见参数速查

| 参数 | 说明 |
| --- | --- |
| `-n, --name` | 容器名称 |
| `-y` | 快速进入 Agent 模式 |
| `-x` | 在容器内执行命令 |
| `-e` | 直接传入环境变量 |
| `--ef` | 读取环境变量文件（`.env`） |
| `-r` | 读取 JSON5 配置文件 |
| `--ib` | 构建沙箱镜像 |
| `--iv` | 指定镜像版本 |
| `--iba` | 传递镜像构建参数（如 `TOOL=common`） |
| `-q` | 静默输出（可多次使用） |

## 配置文件规则

- `manyoyo -r myconfig` 会读取 `~/.manyoyo/run/myconfig.json`
- `manyoyo -r ./myconfig.json` 会读取当前目录配置
- 任何命令都会优先加载全局配置 `~/.manyoyo/manyoyo.json`

完整参数请以 `README.md` 为准。
