---
title: Playwright 插件 | MANYOYO
description: 用 manyoyo playwright 管理 Playwright 插件服务：场景、MCP 接入、playwright-cli、浏览器扩展与真实 Chrome 附着。
---

# Playwright 插件

让 Agent 通过 MCP 或 playwright-cli 控制浏览器的插件。常用命令：

```bash
manyoyo playwright ls
manyoyo playwright up mcp-host-headless
manyoyo playwright up mcp-host-headless --ext-path /abs/path/extA --ext-name adguard
manyoyo playwright status mcp-host-headless
manyoyo playwright logs mcp-host-headless
manyoyo playwright mcp-add --host localhost
manyoyo playwright cli-add
manyoyo playwright up cli-host-headless
manyoyo playwright up dev-host-headed
manyoyo run -r codex
```

启动 `cli-host-headed` 时会自动创建 `~/.manyoyo/.cache/ms-playwright`；如需让容器内 `playwright-cli` 复用宿主缓存，可在配置里挂载 `~/.manyoyo/.cache/ms-playwright:/root/.cache/ms-playwright`。

如需让 agent 控制宿主机正在运行的正式 Chrome，可执行 `manyoyo playwright up dev-host-headed`；它会尝试用 Chrome 打开 `chrome://inspect/#remote-debugging`，提示启用 remote debugging，并分别输出容器 agent 与宿主机 agent 的使用命令。容器内自动附着仍需提前配置 `cliSessionScene` 与相关挂载。该模式会控制真实浏览器实例，可能访问已有登录态与 Cookie，仅建议在可信本机环境使用。

更多配置细节见[配置系统](../configuration/README.md)与[命令速查](../reference/cli-options.md)。
