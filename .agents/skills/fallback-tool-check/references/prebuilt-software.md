# 预装软件参考（按需探测版）

本清单用于“失败后兜底”，不是每次执行前都要先跑全量检查。

## 触发条件

仅在以下情况使用本清单：
- 业务命令失败且疑似缺工具（如 `command not found`）。
- 新机器/新 CI 环境，工具可用性未知。
- 用户明确要求先做环境盘点。

## 默认流程

1. 先直接执行业务命令。
2. 失败后只探测当前任务需要的命令。
3. 缺失再最小安装，随后回到原命令验证。

## 常见任务与优先命令

- 文本搜索/文件定位：`rg` `find` `ls`
- HTTP 请求/下载：`curl` `wget`
- 网络诊断：`ping` `dig` `nslookup` `nc` `openssl`
- JSON 处理：`jq`
- JavaScript/TypeScript：`node` `npm`
- Python：`python3` `pip`/`pip3`
- 版本控制：`git` `gh`
- 容器：`docker` `podman`
- Java：`java` `javac` `mvn`
- Go：`go` `gopls`
- Agent CLI：`codex` `claude` `gemini` `opencode`

## 安装名映射（仅在缺失时使用）

### APT

- `rg` -> `ripgrep`
- `dig`/`nslookup` -> `dnsutils`
- `nc` -> `ncat`
- `pip`/`pip3` -> `python3-pip`
- `docker` -> `docker.io`
- `java`/`javac` -> `openjdk-21-jdk`
- `mvn` -> `maven`
- `go` -> `golang`

### pip

- `yaml` 相关 -> `PyYAML`
- `dotenv` 相关 -> `python-dotenv`
- `pyjson5` -> `pyjson5`
- `jsonschema` -> `jsonschema`

### npm 全局

- `codex` -> `@openai/codex`
- `claude` -> `@anthropic-ai/claude-code`
- `gemini` -> `@google/gemini-cli`
- `opencode` -> `opencode-ai`

## 探测模板

最小探测（默认）：

```bash
command -v <cmd1> <cmd2> <cmd3> || true
```

一次性批量探测（仅在允许场景）：

```bash
command -v python3 pip node npm git gh jq rg curl wget docker podman java javac mvn go gopls codex claude gemini opencode || true
```
