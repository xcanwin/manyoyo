---
title: Playwright 插件 | MANYOYO
description: 让容器内的 Agent 操控浏览器：默认开箱即用，另有 headed、chrome、vnc 三种模式，附 MCP 接入与常见问题。
---

# Playwright 插件

容器里的 Agent 用 `playwright-cli` 操控浏览器，**默认就能用，不用配置**：浏览器是 Google Chrome，跑在容器内的虚拟屏里，是一个有头浏览器（语言、时区跟随宿主机，不带自动化特征），默认能通过 deviceandbrowserinfo、rebrowser、okasi、incolumitas、browserscan、pixelscan、creepjs 等机器人检测站点（结果与本机真实 Chrome 一致，限制见下文[反检测与已知限制](#反检测与已知限制)）。想换个浏览器再用 `manyoyo playwright`。

## 我想… → 命令

| 我想… | 命令 | 浏览器在哪 |
| --- | --- | --- |
| 让 Agent 上网查资料、测网页（默认） | 什么都不用做，直接 `manyoyo run` | 容器内虚拟屏 |
| 亲眼看着 Agent 操作浏览器 | `manyoyo playwright up headed` | 宿主机，有窗口 |
| 用我自己 Chrome 的登录状态 | `manyoyo playwright up chrome` | 你正在用的 Chrome |
| 没有桌面，想通过网页看浏览器 | `manyoyo playwright up vnc` | 独立容器，noVNC 观看 |

容器里手动试一下（Agent 也是这样用）。先 `cd` 到一个项目目录（当前目录会被挂进容器，不能在 `$HOME` 或 `/` 下执行）：

```bash
manyoyo run -n demo -x sleep infinity &      # 后台起一个容器（会一直占着这个终端，可另开终端），约十几秒就绪（podman ps 能看到 demo）
podman exec demo playwright-cli open http://host.containers.internal:3000   # docker 用 docker exec
podman exec demo playwright-cli snapshot     # 读回页面内容（刚打开时页面可能还在加载，等几秒再读）
podman exec demo playwright-cli snapshot | grep -o 'isBot[^,]*'   # 例：读检测页里的 isBot（输出里的引号是转义的）
podman exec demo playwright-cli goto https://example.com    # 换一个页面（会话已打开时用 goto）
manyoyo rm demo                              # 用完删掉容器
```

宿主机上的本地服务：默认、vnc 模式用上面的 `host.containers.internal`；headed / chrome 的浏览器在宿主机上，改用 `http://127.0.0.1:端口`。

同一时间只有一个模式；切换后**已运行的容器自动跟随，不用重建**，容器里已打开浏览器的会话，按 `playwright-cli close` → `manyoyo playwright up/down` → `playwright-cli open` 的顺序操作。

```bash
manyoyo playwright status   # 当前模式；headed / chrome / vnc 会真实探测（打开一个页面），不可用时退出码非 0
manyoyo playwright down     # 回到默认模式
manyoyo playwright logs     # 浏览器服务日志
```

## 各模式

**headed**：宿主机起一个有窗口的浏览器服务，容器里的 Agent 连上它。优先使用宿主机已安装的 Google Chrome；没有时退回自动下载的 Chromium 并提示（Chromium 的品牌与编解码器与 Chrome 不同，部分检测站点会识别出来），缺系统库时只打印安装命令（不会偷偷 sudo）。系统禁止非特权用户命名空间时（如 Ubuntu 23.10+）会提示并改为无沙箱启动。需要宿主机有图形界面（`DISPLAY`）；Linux 没有请改用 `vnc`。

**chrome**：控制你正在用的 Chrome。先在 Chrome 打开 `chrome://inspect/#remote-debugging` 并开启；Chrome 每次新连接（每次 `playwright-cli open`、每次 `status`）都会弹出“要允许远程调试吗？”，请点“允许”，不点会超时（`up` 最多等 60 秒）。Chrome 重启后无需重建容器。⚠️ 容器内 Agent 能操作你已登录的所有网站，只在可信环境使用；不支持扩展。

**vnc**：首次构建一个基于 manyoyo 镜像的小镜像，起容器 `my-playwright-vnc`；`up` 输出带密码的 noVNC 地址（`http://127.0.0.1:6080/...`），密码可用 `status` 再次查看。noVNC 与 VNC 端口只发布到 `127.0.0.1`。

**扩展**（仅 headed、vnc）：`manyoyo playwright ext-download` 下载内置扩展，`up headed --ext-name adguard` 或 `--ext-path /abs/dir` 加载。

## 宿主机上的 Agent 与 MCP

- 宿主机上的 Agent 想用同一个浏览器：`up` 的输出末尾有一行 `PLAYWRIGHT_MCP_CONFIG=~/.manyoyo/plugin/playwright/host.json claude`，宿主机需安装**钉版本**的 CLI：`npm i -g @playwright/cli@0.1.19`（容器内客户端与宿主机浏览器服务要求 minor 版本完全一致，装别的版本会报 `428 Playwright version mismatch`；版本以 `package.json` 的 `playwrightCliVersion` 为准）。
- 想用 MCP 而不是 `playwright-cli`：`manyoyo playwright mcp-add` 打印在容器内注册命令（stdio，自动跟随当前模式，注册一次即可）。

## 反检测与已知限制

- 浏览器是 Google Chrome stable，内核驱动是 [patchright-core](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)（开源补丁版 Playwright，去掉 CDP 自动化痕迹；已钉死版本与 integrity，构建时校验）。语言、时区由浏览器进程的原生环境提供，页面与 Worker 一致。
- 行为层没做：鼠标轨迹、打字节奏都是脚本式的，基于行为评分的站点（如 incolumitas 的行为分）不保证通过。
- `playwright-cli eval` / `run-code` 的 `page.evaluate` 在页面主世界执行（与普通 Playwright 一致，读得到页面自己定义的 JS 全局变量）；镜像构建时已把 patchright 默认的“隔离世界”改回主世界。
- 时区默认跟随宿主机，不跟随出口 IP；带代理访问时，请用 `plugins.playwright.timezoneId` 设成出口地区的时区，否则 browserscan 一类站点会提示“时区与 IP 不符”。
- 自定义 `locale` / `timezoneId` 靠进程环境变量生效：容器内与 Linux 宿主机已验证；macOS / Windows 的 headed 上未验证（默认跟随宿主机，不受影响）。
- 容器没有 GPU，WebGL 是软件渲染（SwiftShader），不伪造显卡信息；WebRTC 默认已禁用（否则 STUN 会暴露本机公网 IP），视频会议类网站需要时设 `disableWebRTC: false`。
- pixelscan 会显示 “Masking detected”：本机真实 Chrome 同样如此（来自网络与平台差异，不是自动化痕迹）。默认禁用 WebRTC 后，pixelscan 的定位检测会一直停在 “Collecting Data…”、给不出 consistent/inconsistent 结论（“No automated behavior detected” 仍正常）；要看完整结论请设 `disableWebRTC: false`。

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
| `locale` / `timezoneId` | 跟随宿主机 | 浏览器语言与时区（带代理时建议设成出口地区的时区） |
| `navigatorPlatform` | 空（用真实值） | 强制 `navigator.platform`，一般不要设 |
| `disableWebRTC` | `true` | 禁用 WebRTC（默认禁用，避免暴露本机公网 IP；视频会议类网站需设为 `false`） |
| `devtoolsActivePortPath` | 自动探测 | chrome 模式的 `DevToolsActivePort` 文件 |
| `extensionProdversion` | `132.0.0.0` | `ext-download` 的 Chrome 版本号 |

Linux 上 headed / chrome 的服务监听 `0.0.0.0`（容器才连得到），仅靠 32 字节随机 token 保护，建议用防火墙限制来源；macOS 上 chrome 与 vnc 只监听 `127.0.0.1`，headed 同样监听 `0.0.0.0`（playwright 只绑 loopback 时会拒绝容器的 Host 头）。

命令速查见 [命令速查](../reference/cli-options.md)，配置见[配置系统](../configuration/README.md)。
