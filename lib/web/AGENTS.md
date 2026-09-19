# lib/web/ 协作指引

根目录 `AGENTS.md` 的补充，仅在改动 Web 服务端与旧版前端时适用。

## lib/web/server.js（6000+ 行单文件）

与 `bin/manyoyo.js` 一样无分区注释，靠函数名定位：`Grep "^function <名>"`。它是仓库里最大的文件，改动前先确认要落在哪一层（HTTP 路由 / 会话历史读写 / 容器执行 / 流式协议），不要在路由 handler 里堆业务逻辑。

- `resolveYoloCommand()` 委托到 `lib/agent-adapters/index.js`，与 `bin/manyoyo.js` 共用同一份映射，无需分别维护。
- Agent 会话恢复参数：Claude/Gemini → `-r`，Codex → `resume`，OpenCode → `-c`。
- 会话控制事件：`/agent/stream`、`/agent/stop` 通过 `createWebStreamEmitter()` / `appendWebSessionControlEvent()` 写入 `lib/core/event-store.js`（`FileEventStore`），`GET /api/sessions/:name/audit` 导出该会话的事件与投影。
- **`/agent/stream` 的 NDJSON 事件协议是跨三处的契约**，改一处必须同步另两处：服务端 `lib/web/server.js`、新前端 `frontend-shadcn/src/lib/api.ts` 的 `StreamEvent` + `workspace-panel.tsx` 的事件分支、旧前端 `lib/web/frontend/app.js`
  - `content_chunk`：token 级增量，前端**追加**；`reset: true` 表示换了一条 assistant 消息、从空白重新开始。只发新增片段，不要改成重发累计全文（几千个增量就是 O(n²) 流量）。
  - `content_delta`：每条 assistant 消息落地时下发一次的权威全文，前端**整体覆盖**。
  - `ping`：保活心跳，前端忽略。`DEFAULT_AGENT_STREAM_HEARTBEAT_MS` 必须明显小于反向代理的空闲读超时（nginx `proxy_read_timeout` 默认 60s），否则 agent 静默期间流会被 RST，浏览器侧表现为输入框上方冒出 `network error`。
  - token 级增量**不写**事件日志、历史落盘按 `AGENT_STREAM_PARTIAL_PERSIST_INTERVAL_MS` 节流；新增逐事件的落盘/日志动作前先想清楚它会不会被每个 token 触发一次。
- `GET /api/sessions` 是**同步 IO 大户**：逐容器 `readFileSync` + `JSON.parse` 整份历史。前端每标签页 6s 轮询一次，它阻塞多久事件循环就卡多久，正在跑的 `/agent/stream` 只能在空隙里把输出攒着分批推。往这条路径上加同步操作前务必实测耗时；`buildSessionSummary()` 已支持传入调用方加载好的 history，不要再重复读。（`docker ps -a` + 批量 `inspect` 实测仅约 90ms，不是瓶颈，别被旧注释误导）
- 请求处理链路上注册在**全局认证网关之前**的代码（如 `res.on('finish')` 之类的钩子）必须自带 try/catch：那里抛异常会冒泡成 `uncaughtException`，而 `bin/manyoyo.js` 的处理器直接 `process.exit(1)`——等于未认证请求可打挂 serve。回归用例见 `test/web-server-auth.test.js` 的 `Web Server Robustness`。
- **终端 WebSocket**：`/api/sessions/:name/terminal/ws`，在 `server.on('upgrade')` 里做 Origin 校验 + 认证 + 容器名校验，再交给 `bindTerminalWebSocket()`。上行 `input` / `ping` / `close`，下行 `output` / `status`（`ready` / `closed`）/ `error` / `pong`；实现是 `docker exec` 里用 `script` 或 python `pty` 引导出的伪 TTY，**不支持动态 resize**（`resize` 消息是预留的空实现，行列只在建连时由 query 参数定死）。并发上限 `WEB_TERMINAL_MAX_SESSIONS = 20`，每条连接对应一个 `ptyProcess`，`ws` 关闭即 `SIGTERM`——所以前端任何「卸载终端组件」的改动都等于杀掉用户正在跑的 shell。
- 空闲保活是 `/agent/stream` 那条心跳规则的同类问题，**两个入口都要守**：终端侧服务端每 `WEB_TERMINAL_PING_INTERVAL_MS`（30s）发 WebSocket ping 帧，连续 `WEB_TERMINAL_MAX_MISSED_PONGS`（3 次，约 90s）无 pong 才判死；前端另发应用层 `ping`（浏览器 JS 发不出 ping 帧，上行需要自己造流量）。判死阈值不要收紧到一个周期：手机切后台会让连接短暂挂起，误杀等于用户的 shell 没了。升级后的 socket 还要 `setTimeout(0)` + `setKeepAlive`，解除 HTTP 侧空闲超时。
- 终端 vendor 资源（`/app/vendor/xterm.css`、`xterm.js`、`xterm-addon-fit.js`）由本文件从 `@xterm/*` 依赖映射提供。
- 新增接口/页面必须走全局认证网关，禁止在业务路由里零散补认证；匿名白名单见根 `AGENTS.md` 的安全约束。

## lib/web/frontend/（旧版 `/legacy` 前端）

默认前端是 `frontend-shadcn/`（构建产物 `shadcn.html` 也落在本目录）；以下仅针对旧版静态资源。`chat-behavior.js` 是抽出的纯函数模块，仿 `markdown-renderer.js` 的 `window.Manyoyo*` + Node `vm` 单测模式。

- 布局是两层 grid 嵌套：`.main`（`header` + `.workspace-shell` 两个直接子元素）套着内层 `.workspace-main`（`grid-template-rows: minmax(0, 1fr) auto`，真正的「内容区 / composer」二分在这一层，composer 并非 `.main` 的直接子元素）。增删 `.workspace-main` 直接子元素时须同步调整行数，否则内容区高度失效。
- 中间工作台的「终端/文件/详情/配置/检查」5 个次要标签收在 `#workspaceSwitcherToggle` 图标按钮触发的弹出面板 `#workspaceSwitcherPanel` 里，仅「活动」作为常驻标签；`setActiveTab()` / `isActiveSessionHistoryOnly()` 逻辑本身未变，只是触发入口从常驻按钮改为面板内按钮。
- `connectTerminal()` 前须加 `isActiveSessionHistoryOnly()` 守卫（三处：`setActiveTab`、`handleSessionItemClick`、`refreshSessions`），否则点击「仅历史」会话会触发后端新建容器。

## 测试

Web 相关改动优先补 `test/web-server-auth.test.js`；涉及认证时至少验证未登录 `401`、登录成功可访问、登出后失效。
