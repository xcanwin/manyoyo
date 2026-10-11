# lib/web/ 协作指引

根目录 `AGENTS.md` 的补充，仅在改动 Web 服务端时适用。前端在 `frontend/`，见该目录的 `AGENTS.md`。

## lib/web/server.js（6000+ 行单文件）

与 `bin/manyoyo.js` 一样无分区注释，靠函数名定位：`Grep "^function <名>"`。它是仓库里最大的文件，改动前先确认要落在哪一层（HTTP 路由 / 会话历史读写 / 容器执行 / 流式协议），不要在路由 handler 里堆业务逻辑。

- `resolveYoloCommand()` 委托到 `lib/agent-adapters/index.js`，与 `bin/manyoyo.js` 共用同一份映射，无需分别维护。
- Agent 会话恢复参数：Claude/Gemini → `-r`，Codex → `resume`，OpenCode → `-c`。
- 会话控制事件：`/agent/stream`、`/agent/stop` 通过 `createWebStreamEmitter()` / `appendWebSessionControlEvent()` 写入 `lib/core/event-store.js`（`FileEventStore`），`GET /api/sessions/:name/audit` 导出该会话的事件与投影。
- **`/agent/stream` 的 NDJSON 事件协议是跨前后端的契约**，改一处必须同步另一处：服务端 `lib/web/server.js`、前端 `frontend/src/lib/api.ts` 的 `StreamEvent` + `workspace-panel.tsx` 的事件分支
  - `content_chunk`：token 级增量，前端**追加**；`reset: true` 表示换了一条 assistant 消息、从空白重新开始。只发新增片段，不要改成重发累计全文（几千个增量就是 O(n²) 流量）。
  - `content_delta`：每条 assistant 消息落地时下发一次的权威全文，前端**整体覆盖**。
  - `trace`：**不保证带结构化 `traceEvent`**。stderr 行（`emitStderrTraceLine`）和解析不出 JSON 的 stdout 行只有 `text` + `stream`，前端靠 `toTraceEvent()` 兜底成 `kind="output"` 的事件展示。新增只认 `traceEvent` 的分支等于把自定义 CLI、CLI 报错的输出全吞掉。
  - `ping`：保活心跳，前端忽略。`DEFAULT_AGENT_STREAM_HEARTBEAT_MS` 必须明显小于反向代理的空闲读超时（nginx `proxy_read_timeout` 默认 60s），否则 agent 静默期间流会被 RST，浏览器侧表现为输入框上方冒出 `network error`。
  - token 级增量**不写**事件日志、历史落盘按 `AGENT_STREAM_PARTIAL_PERSIST_INTERVAL_MS` 节流；新增逐事件的落盘/日志动作前先想清楚它会不会被每个 token 触发一次。
- **历史读写在 `lib/web/history-store.js`**：进程内缓存 + 原子写（`writeConfigFileSecure`，0600）+ 合并写盘。读靠 `stat` 的 `ino + mtimeMs + size` 判断缓存是否还有效（别的进程原子替换也能识别）；`loadWebSessionHistory` 返回的是**缓存里的同一个对象**，改了必须 `saveWebSessionHistory`，只读路由不要改它（`getWebAgentSession(..., { create: true })` 会在缓存里留一个未保存的空 agent，只在马上要写的路径里用）。流式过程中的 trace patch 和控制事件走 `{ defer: true }`（只改内存，最迟 `AGENT_STREAM_PARTIAL_PERSIST_INTERVAL_MS` 后落盘）；`process.exit` / serve 关闭会 flush；`result` / `error` 类事件（`WEB_STREAM_FLUSH_EVENT_TYPES`）和所有非 defer 写入立即写盘并带上攒着的内容。`kill -9` 最多丢约 1 秒的 trace。文件解析失败会留一份 `.corrupt-<时间>` 备份再按空历史处理，不要绕过它。磁盘格式只有 `agents.<id>.messages`（不再有顶层 `messages`，紧凑 JSON），老版本（含 `update --rollback`）读取时优先用 `agents`，能读新文件。
- `GET /api/sessions` 以前是同步 IO 大户（逐容器读 + 解析整份历史），现在命中缓存基本是 0 次解析，但新增的同步操作仍要先实测；`buildSessionSummary()` 支持传入调用方加载好的 history，不要重复读。（`docker ps -a` + 批量 `inspect` 实测仅约 90ms，不是瓶颈）
- **`/messages` 是分页 + 增量**（`lib/web/messages-view.js`）：`?limit=`（1～200，默认 60，起点往前对齐到 user 消息）/ `?after=<id>&epoch=<e>`（tail，锚点之后的消息；epoch 不符、锚点不存在或超过 120 条时返回最近一页并标 `mode: "reset"`）/ `?before=<id>`（更早一页）；`GET /messages/<id>/trace` 取完整执行过程。查询参数全部白名单校验，非法返回 400。**稳定前缀约定**：第一条 pending 消息之前的消息不再被修改——违反约定的写操作（删除非 pending 消息、克隆）必须给该 agent 换新的 `epoch`（`removeWebSessionMessage` 与 clone 已处理；新增修改历史消息的写操作要自己判断）。500 条上限从头裁掉**不换** epoch（tail 响应带 `firstId`，前端据此裁掉本地被丢弃的开头）。列表里的 trace 消息会被精简（长字符串截成 200 字符，带 `traceTruncated`），`/audit` 与 trace 接口输出完整内容。
- **ETag / 压缩**（`sendJson` / `sendHtml` → `sendBody`）：`/messages` 的 ETag 是 `bootId + 进程内历史版本号 + 查询摘要`（不用 mtime：同一毫秒内两次写入大小相同会误回 304 显示旧内容）；`/sessions`、`detail` 用响应体 sha1；index.html 按文件 stat 缓存并带 ETag。这些响应 `Cache-Control: no-cache`，其余仍是 `no-store`。>1KB 的 JSON/HTML 异步 gzip；**NDJSON 流和 WebSocket 不压缩**（压缩会被缓冲，破坏实时性），`X-Accel-Buffering: no` 必须保留。
- 请求处理链路上注册在**全局认证网关之前**的代码（如 `res.on('finish')` 之类的钩子）必须自带 try/catch：那里抛异常会冒泡成 `uncaughtException`，而 `bin/manyoyo.js` 的处理器直接 `process.exit(1)`——等于未认证请求可打挂 serve。回归用例见 `test/web-server-auth.test.js` 的 `Web Server Robustness`。
- **终端 WebSocket**：`/api/sessions/:name/terminal/ws`，在 `server.on('upgrade')` 里做 Origin 校验 + 认证 + 容器名校验，再交给 `bindTerminalWebSocket()`。上行 `input` / `resize` / `ping` / `close`，下行 `output` / `status`（`ready` / `closed`）/ `error` / `pong`；实现是 `docker exec` 里用 `script` 或 python `pty` 引导出的伪 TTY。**动态 resize**：bootstrap 的 rc 把 `tty` 输出写进容器里 `/tmp/manyoyo-term-<随机id>.tty`；收到 `resize` 后（整数、40～500 列、12～200 行，否则整条忽略；节流，同一时刻只有一个 exec）用固定脚本 `TERMINAL_RESIZE_SCRIPT` 在容器里读该文件，内容必须整行匹配 `/dev/pts/<数字>` 才执行 `stty -F`。**这个 tty 文件容器里的进程可写，只能当不可信输入**（脚本只认普通文件、不跟符号链接、最多读 64 字节），用例见 `test/web-terminal-resize.test.js`。降级成非 TTY 时 resize 自然无效。并发上限 `WEB_TERMINAL_MAX_SESSIONS = 20`，每条连接对应一个 `ptyProcess`，`ws` 关闭即 `SIGTERM`——所以前端任何「卸载终端组件」的改动都等于杀掉用户正在跑的 shell。
- 空闲保活是 `/agent/stream` 那条心跳规则的同类问题，**两个入口都要守**：终端侧服务端每 `WEB_TERMINAL_PING_INTERVAL_MS`（30s）发 WebSocket ping 帧，连续 `WEB_TERMINAL_MAX_MISSED_PONGS`（3 次，约 90s）无 pong 才判死；前端另发应用层 `ping`（浏览器 JS 发不出 ping 帧，上行需要自己造流量）。判死阈值不要收紧到一个周期：手机切后台会让连接短暂挂起，误杀等于用户的 shell 没了。升级后的 socket 还要 `setTimeout(0)` + `setKeepAlive`，解除 HTTP 侧空闲超时。
- 新增接口/页面必须走全局认证网关，禁止在业务路由里零散补认证；匿名白名单见根 `AGENTS.md` 的安全约束。

## 容器管理接口

`lib/web/container-manage.js`（路由工厂，由 `handleWebApi` 追加进路由表）：`/api/containers/:name/{env,autostart,autostart/run,autostart/log,network,network/allow,network/denied,expose}` 与 `/api/containers/orphans`。旧容器（无 `manyoyo.id`）GET 返回 `{legacy:true}`、写返回 409。`PUT env` 用 `If-Match`（etag）防止覆盖容器内的修改；放开类改动（切到 `custom`、新增很宽的允许规则、非 loopback 暴露）服务端也要求 `confirmRisk:true`；`network` 是 v2 规则表（`outbound` / `inbound`，旧 v1 读取时自动转换，`@container:<名称>` 保存时换成 id）。serve 运行时就绪后 `startContainerServices` 订阅 `<runtime> events`（start / die）补下发规则、拉起 `autostartOnServe` 容器、恢复端口暴露；事件流断开重连（运行时重启）后 `reconcileContainerServices` 再对账一次；过滤代理是 sidecar 容器（`lib/egress-sidecar.js`），由网络管理器 `ensure()` 保证在运行，不在 serve 进程里。`GET network` 带 `denied`（最近被拦截，已放行的不列）、`derived`（别的容器入站放行本容器产生的出站派生行）与 `peers[].ip`；`network/allow` 在出站用户规则最前插入允许域名行；`/agent/stream` 进行中 `createWebDeniedNotifier` 每 2 秒读一次拦截记录，有新域名就推一条 `trace`（只有 `text`，同一域名同一轮一次）。所有 exec 经 `spawnContainerExec`（env 临时文件在子进程 close 时删）。

## lib/web/index.html

前端构建产物（`npm run build:web`，已 `.gitignore`），由 `loadIndexHtml()` 按文件 stat 缓存读取（文件变了才重读），`/` 与登录页 `/auth/login` 共用。服务端不托管其它前端静态资源，别往 `lib/web/` 里放散装 js/css。

## 测试

Web 相关改动优先补 `test/web-server-auth.test.js`；涉及认证时至少验证未登录 `401`、登录成功可访问、登出后失效。
