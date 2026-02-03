# 快速开始

## 前置条件

- Node.js `>=22`
- Docker 或 Podman（推荐 Podman）

## 安装 manyoyo

```bash
npm install -g @xcanwin/manyoyo
```

本地开发调试也可以直接安装当前仓库：

```bash
npm install -g .
```

## 构建沙箱镜像

Docker/Podman 都可执行：

```bash
manyoyo --ib --iv 1.7.0
```

常用构建参数：

```bash
manyoyo --ib --iba TOOL=common
manyoyo --ib --iba TOOL=go,codex,java,gemini
manyoyo --ib --in myimage --iv 2.0.0
```

## 启动容器并进入 Agent

```bash
manyoyo -y c
```

常见恢复命令：

```bash
manyoyo -n test -- -c            # Claude Code
manyoyo -n test -- resume --last # Codex
manyoyo -n test -- -r            # Gemini
```

## 环境变量与配置文件

你可以通过 `-e` 或 `--ef` 传入 API 地址和 Token：

```bash
manyoyo -e "ANTHROPIC_BASE_URL=https://xxxx" \
        -e "ANTHROPIC_AUTH_TOKEN=your-key" \
        -x claude
```

更多完整配置与高级场景请查看仓库根目录的 `README.md` 与 `config.example.json`。
