---
title: 网页服务与远程访问 | MANYOYO
description: 介绍 manyoyo serve 网页服务的启动方式、认证网关、登录流程、远程访问（ssh -L）与对外监听安全建议。
---

# 网页服务与远程访问

本页讲 `manyoyo serve` 网页服务：怎么启动、怎么登录、怎么远程访问。风险与边界见[安全须知](./security.md)；SSH 机器上的 `ssh -L` 访问见[第一次使用](./first-run.md)。

容器跑起来后，可在「设置容器」标签页随时修改它的环境变量、自启动脚本和网络规则，见[管理容器的 env、网络与自启动](./container-manage.md)。

当前网页交互支持三种模式：`命令模式`、`AGENT 模式`、`交互终端`。其中 `AGENT 模式` 需要会话配置 `agentPromptCommand`（模板内必须包含 `{prompt}`）。

## 监听地址与启动方式

`serve` 仅支持 `<ip:port>` 格式，例如 `127.0.0.1:3000`、`0.0.0.0:3000`。

默认监听地址为 `127.0.0.1:3000`。

```bash
# 仅本机访问（默认）
manyoyo serve

# 指定监听地址
manyoyo serve 127.0.0.1:3000

# 局域网访问（需配合强密码与防火墙）
manyoyo serve 0.0.0.0:3000 -U admin -P 'StrongPassword'

# 后台启动
manyoyo serve 127.0.0.1:3000 -U admin -P 'StrongPassword' -d

# 后台启动并自动生成密码（会直接打印本次随机密码）
manyoyo serve 127.0.0.1:3000 -d

# 停止指定后台服务
manyoyo serve 127.0.0.1:3000 --stop

# 重启指定后台服务
manyoyo serve 127.0.0.1:3000 -U admin -P 'StrongPassword' -d --restart
```

## 认证参数优先级

网页认证参数包括 `serverUser` 与 `serverPass`，支持命令行、配置文件、环境变量。

优先级如下：

`命令行参数 > runs.<name> > 全局配置 > 环境变量 > 默认值`

对应环境变量：

- `MANYOYO_SERVER_USER`
- `MANYOYO_SERVER_PASS`

默认值：

- `serverUser`: `admin`
- `serverPass`: 未显式设置时，启动时自动生成随机密码并输出到终端

## 认证网关行为

`serve` 模式采用全局认证网关，除登录相关放行路由外，其余页面和接口默认要求登录。

当前匿名放行路由：

- `/auth/login`（`GET` 是登录页，`POST` 是登录接口）
- `/auth/logout`

未登录访问任何页面路径都会跳转到 `/auth/login`，接口与 `/auth/*` 则直接返回 `401`。

## 输入框

模式（💬 Agent 对话 / 系统命令）、模型、发送和停止都是输入框里的图标按钮，鼠标悬停能看到说明。在 Agent 对话里：

- 开头打 `/` 会列出能用的斜杠命令（目前只有 Claude Code，跑过一轮之后才有）。
- 打 `@` 会列出工作目录里的文件，选中后插入相对路径。
- ↑↓ 选择、Enter 或 Tab 确认、Esc 关闭。

## 任务进行中追加提示词

Agent 在跑任务时，输入框不会被禁用，可以继续输入。输入内容后，发送键左边会出现“插入时机”按钮，点它选择何时生效（记住上次的选择，输入框的提示文字也会写明当前时机）：

- 立即插入：打断当前这一轮，马上带着新提示词接着做（已做完的工作保留）。
- 当前这一步结束后插入：等这一次工具调用或这段说明结束再打断；等了 2 分钟还没等到就改为立即插入。
- 这一轮结束后发送：排队，等这一轮结束后自动发出（默认）。

排队中的提示词显示在消息流底部，可以撤回（✕）或编辑（✎）。点“停止”只停当前这一轮，排队的提示词会保留，可以取消或点“继续发送”。系统命令模式不支持追加。

Agent 派出的子 Agent 和任务清单也会显示在“执行过程”里：子 Agent 默认收起成一行，点开看它做了什么；任务清单只显示一块最新状态。Agent 还在执行时，它正在说的话显示在“执行过程”里，回复框等这一轮结束才出现，里面就是最终结论。执行过程右侧的“对齐到底部”按钮会让这段过程的底部一直贴着窗口底部，自己滚动一下就取消。

## 会话、改动与提醒

- 会话名称：没有备注时，用 Agent 自己起的标题（目前只有 Claude Code 会生成），否则用第一条消息。点顶栏的名称可以改名，清空就恢复自动名称。
- 置顶：在 AGENT 的 ⋯ 菜单里置顶，它所在的容器也会排到最前面。
- 顶栏 ⋯ 里按归属分组：聊天属于 AGENT；文件、终端、改动、设置容器属于容器。“改动”列出工作目录所在 git 仓库的改动，点文件看 diff。
- 回复里的图片：Agent 用 Markdown 图片写容器内路径（如 `![截图](/root/shot.png)`）就能直接显示。写在回复里的绝对路径可以点开，在文件页查看。
- 任务结束提醒：页面在后台时任务结束，标签页标题前会出现 `(1)` 这样的计数；在“系统设置 → 页面”里可以打开浏览器通知（需要 HTTPS 或 localhost）。
- 离开一阵子再回来，或者网络恢复后，顶栏会显示同步进度，同步完显示“已同步”。

网页里执行 Agent 时会附上系统提示词，告诉它回复显示在网页里、图片怎么写。在“系统设置 → Agent → 系统提示词”里可以关掉默认系统提示词，或写补充系统提示词（配置字段 `agentInstructions`）；它们只决定之后新建容器的初始内容。新建容器时可以直接改，已有容器在“设置容器”里改，互不影响。

## 网页前端

`serve` 模式的 Web 界面由 shadcn/ui 前端提供。

- 默认地址：`http://127.0.0.1:3000/`。未登录会跳转到 `http://127.0.0.1:3000/auth/login`，登录成功后回到 `/`
- 登录走 `/auth/login` 接口和 cookie
- 源码在仓库根目录的 `frontend/`，是独立的 Vite + React + TypeScript 项目；它使用 ES Modules，本项目其余 Node 代码仍遵循 CommonJS 约定

首次参与开发需要单独装一次它自己的依赖（体积较大，与根目录 `npm install` 分开，不会拖慢日常开发）：

```bash
cd frontend && npm ci && cd ..
```

之后按需选择：

```bash
# 只想看当前构建效果：手动构建一次，再照常启动 my serve 预览
npm run build:web
manyoyo serve

# 改 frontend/src 下的代码并实时看效果（HMR），两个终端：
manyoyo serve                # 终端一：真实后端（容器、会话、终端 WebSocket）
npm run dev:web       # 终端二：Vite 开发服务器，默认把 /api、/auth 代理到 127.0.0.1:3000
```

`my serve` 监听地址不是默认的 `127.0.0.1:3000` 时，用 `MANYOYO_SERVE_URL` 环境变量覆盖 `dev:web` 的代理目标。

发布时（`npm publish`/`npm pack`）会自动重新构建 `frontend` 并把产物打进 `lib/web/index.html`；生产环境运行 `my serve` 不需要 Node 之外的任何前端工具链。

## 登录与 API 访问示例

```bash
# 1) 登录并保存 cookie
curl --noproxy '*' -c /tmp/manyoyo.cookie \
  -X POST http://127.0.0.1:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"StrongPassword"}'

# 2) 带 cookie 访问接口
curl --noproxy '*' -b /tmp/manyoyo.cookie \
  http://127.0.0.1:3000/api/sessions

# 3) 登出
curl --noproxy '*' -b /tmp/manyoyo.cookie \
  -X POST http://127.0.0.1:3000/auth/logout
```

## 最小安全基线

- 优先使用 `127.0.0.1` 监听，仅本机访问
- 使用 `0.0.0.0` 时必须设置强密码，并通过防火墙限制来源 IP
- 不要把明文密码写入共享脚本；优先放到受保护配置文件或环境变量
- 定期更换 `serverPass`，共享环境使用独立账户与独立口令

## 常见问题

### 返回 `401 Unauthorized`

排查顺序：

1. 确认已完成 `/auth/login` 并带上 cookie
2. 确认 `-U` / `-P` 与配置项一致
3. 使用 `manyoyo config show` 检查 `serverUser`/`serverPass` 的最终来源

## 相关文档

- [命令参考](../reference/cli-options.md)
- [配置系统概览](../configuration/README.md)
- [配置文件详解](../configuration/config-files.md)
