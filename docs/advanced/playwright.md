---
title: Playwright 插件 | MANYOYO
description: 让容器内的 Agent 操控浏览器：默认开箱即用，另有 headed、chrome、vnc 三种模式，附 MCP 接入与常见问题。
---

# Playwright 插件

容器里的 Agent 用 `playwright-cli` 操控浏览器，**默认就能用，不用配置**：浏览器跑在容器内的虚拟屏里，是一个有头浏览器（语言、时区跟随宿主机，不带自动化特征）。想换个浏览器再用 `manyoyo playwright`。

## 我想… → 命令

| 我想… | 命令 | 浏览器在哪 |
| --- | --- | --- |
| 让 Agent 上网查资料、测网页（默认） | 什么都不用做，直接 `manyoyo run` | 容器内虚拟屏 |
| 亲眼看着 Agent 操作浏览器 | `manyoyo playwright up headed` | 宿主机，有窗口 |
| 用我自己 Chrome 的登录状态 | `manyoyo playwright up chrome` | 你正在用的 Chrome |
| 没有桌面，想通过网页看浏览器 | `manyoyo playwright up vnc` | 独立容器，noVNC 观看 |

容器里手动试一下（Agent 也是这样用）：

```bash
manyoyo run -n demo -x sleep infinity &      # 后台起一个容器
podman exec demo playwright-cli open http://host.containers.internal:3000   # docker 用 docker exec
podman exec demo playwright-cli snapshot     # 读回页面内容
manyoyo rm demo                              # 用完删掉容器
```

宿主机上的本地服务：默认、vnc 模式用上面的 `host.containers.internal`；headed / chrome 的浏览器在宿主机上，改用 `http://127.0.0.1:端口`。

同一时间只有一个模式；切换后**已运行的容器自动跟随，不用重建**，容器里已打开浏览器的会话先 `playwright-cli close` 再重新 `open`。

```bash
manyoyo playwright status   # 当前模式；headed / chrome / vnc 会真实探测（打开一个页面），不可用时退出码非 0
manyoyo playwright down     # 回到默认模式
manyoyo playwright logs     # 浏览器服务日志
```

## 各模式

**headed**：宿主机起一个有窗口的浏览器服务，容器里的 Agent 连上它。首次会下载浏览器；缺系统库时只打印安装命令（不会偷偷 sudo）。系统禁止非特权用户命名空间时（如 Ubuntu 23.10+）会提示并改为无沙箱启动。需要宿主机有图形界面（`DISPLAY`）；Linux 没有请改用 `vnc`。

**chrome**：控制你正在用的 Chrome。先在 Chrome 打开 `chrome://inspect/#remote-debugging` 并开启；Chrome 可能弹出“允许远程调试”确认框，请点允许。Chrome 重启后无需重建容器。⚠️ 容器内 Agent 能操作你已登录的所有网站，只在可信环境使用；不支持扩展。

**vnc**：首次构建一个基于 manyoyo 镜像的小镜像，起容器 `my-playwright-vnc`；`up` 输出带密码的 noVNC 地址（`http://127.0.0.1:6080/...`），密码可用 `status` 再次查看。noVNC 与 VNC 端口只发布到 `127.0.0.1`。

**扩展**（仅 headed、vnc）：`manyoyo playwright ext-download` 下载内置扩展，`up headed --ext-name adguard` 或 `--ext-path /abs/dir` 加载。

## 宿主机上的 Agent 与 MCP

- 宿主机上的 Agent 想用同一个浏览器：`up` 的输出末尾有一行 `PLAYWRIGHT_MCP_CONFIG=~/.manyoyo/plugin/playwright/host.json claude`，宿主机需 `npm i -g @playwright/cli`。
- 想用 MCP 而不是 `playwright-cli`：`manyoyo playwright mcp-add` 打印在容器内注册命令（stdio，自动跟随当前模式，注册一次即可）。

## 常见问题

- 不确定哪里坏了 → `manyoyo playwright status`
- headed 报没有图形界面 → `manyoyo playwright up vnc`
- 端口被占用 → 在 `~/.manyoyo/manyoyo.json` 设置 `plugins.playwright.port`
- 容器里浏览器连不上宿主机 → `manyoyo playwright down` 后重新 `up`（失效时 `run` 会自动回退到默认模式并提示）
- 让浏览器打开宿主机上的本地服务 → 见上文；docker 把 `host.containers.internal` 换成 `host.docker.internal`

## 配置项（`plugins.playwright`，可被 `runs.<name>` 覆盖）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `8935` | headed / chrome / vnc 的浏览器服务端口 |
| `vncPort` / `novncPort` | `5900` / `6080` | vnc 模式的原生 VNC 与 noVNC 端口 |
| `locale` / `timezoneId` | 跟随宿主机 | 浏览器语言与时区 |
| `navigatorPlatform` | 空（用真实值） | 强制 `navigator.platform`，一般不要设 |
| `disableWebRTC` | `false` | 禁用 WebRTC |
| `devtoolsActivePortPath` | 自动探测 | chrome 模式的 `DevToolsActivePort` 文件 |
| `extensionProdversion` | `132.0.0.0` | `ext-download` 的 Chrome 版本号 |

Linux 上 headed / chrome 的服务监听 `0.0.0.0`（容器才连得到），仅靠 32 字节随机 token 保护，建议用防火墙限制来源；macOS 上 chrome 与 vnc 只监听 `127.0.0.1`，headed 同样监听 `0.0.0.0`（playwright 只绑 loopback 时会拒绝容器的 Host 头）。

命令速查见 [命令速查](../reference/cli-options.md)，配置见[配置系统](../configuration/README.md)。
