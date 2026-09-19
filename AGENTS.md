# AGENTS.md

本文件是 MANYOYO 仓库面向所有 AI 编码智能体（Claude Code、Codex、Gemini CLI、OpenCode 等）的统一协作指引，原 `CLAUDE.md` 内容已合并至此。核心原则：最小改动、可验证、中英文文档一致。新增功能前先明确范围与安全影响，再动手改代码。

## 项目概述

MANYOYO（慢悠悠）是一款 AI 智能体 CLI 安全沙箱，为安全运行 AI 编程助手（Claude Code、Gemini、Codex、OpenCode）的 YOLO/SOLO 模式提供隔离的 Docker/Podman 容器环境。

- 运行环境：Node.js >= 22，容器运行时支持 `podman` 或 `docker`。
- CLI 入口：`manyoyo` 与 `my` 指向同一可执行文件 `bin/manyoyo.js`。
- 文档栈：VitePress，中文主维护 `docs/zh/`，英文 `docs/en/`，结构需保持一致；根目录兼容页与历史页按需保留。
- `serve` 网页模式采用全局认证网关；除登录路由外，所有页面与接口默认都需认证。

## 协作偏好

- 交流必须使用中文，回复简洁实用。
- 代码改动尽量最小化，避免无关重构。
- 不提供时间预估或承诺时间线。
- 多方案时给出清晰选项，避免来回确认。
- 功能演进默认直接切换：除非明确要求，否则不引入兼容层、过渡开关、旧路径提示等历史包袱。
- 未明确要求时不自动提交；需要提交时先给出 commit message 和命令让用户确认。
- 文档保持简洁、减少重复，保留可导航性与兼容链接。

## 项目结构

- `bin/manyoyo.js`：CLI 入口与主流程编排（CommonJS）；参数解析、容器主流程优先就近维护。
- `lib/container-run.js`：CLI/Web 共享的 `buildContainerRunArgs` / `buildContainerRunCommand`。
- `lib/container-modes.js`：`resolveContainerMode`，common/dind/sock 别名与运行参数，供 `bin/manyoyo.js` 与 `lib/doctor.js` 复用。
- `lib/image-build.js`：`prepareBuildCache` / `buildImage`，含构建缓存管理与 build args 解析。
- `lib/agent-resume.js`：Agent 程序识别、resume 参数推断与提示词命令模板生成。
- `lib/agent-adapters/`：`resolveYoloCommand` 单一数据源，`bin/manyoyo.js` 与 `lib/web/server.js` 共用，新增 YOLO 智能体只需改这里。
- `lib/doctor.js`：`runDoctorChecks`，`manyoyo doctor` 的运行时/镜像/配置/Agent/模式/插件/端口诊断。
- `lib/codex-output.js`：Codex JSONL 输出解析与最终消息提取，供 Web 与发布脚本复用。
- `lib/global-config.js` + `lib/init-config.js`：`~/.manyoyo/manyoyo.json` 读写、`imageVersion` 同步与 `init` 初始化逻辑。
- `lib/runtime-resolver.js` + `lib/runtime-normalizers.js` + `lib/worktrees.js`：运行配置四层合并、参数归一化（`parseEnvEntry` / `normalizeVolume`）与 Git worktrees 挂载推导（`--wt` / `--wtr`）。
- `lib/json5-text-edit.js`：JSON5 配置文本的局部定位与替换，供全局配置与 Web 配置编辑复用。
- `lib/log-path.js` + `lib/serve-log.js` + `lib/serve-log-reader.js`：日志分目录规则、`serve` 日志脱敏与进程快照、倒序分页读取。
- `lib/capacity.js`：基于镜像、容器可写层与宿主机磁盘空间的容量估算，供 Web 接口复用。
- `lib/core/events.js` + `lib/core/event-store.js`：会话控制事件的创建/校验/投影与 `FileEventStore`（JSONL 追加日志 + 快照），供会话审计导出复用；`lib/core/app-error.js` 暂未接入现有 `sendJson` 错误响应。
- `lib/dev-release.js` + `scripts/dev-release.js`：维护者发布向导、版本建议、提交文案清洗与标签选择。
- `lib/plugin/index.js` + `lib/plugin/playwright.js`：插件命令分发与 Playwright 插件主逻辑（场景管理、MCP 集成、扩展下载、容器/宿主启动链路）。
- `lib/plugin/playwright-assets/`：Playwright 场景的 Docker Compose 与 Dockerfile 模板。
- `lib/web/server.js`：`serve` 网页服务、全局认证网关、WebSocket 终端与 API 路由。
- `frontend-shadcn/`：默认 Web 前端（`/` 路由，`/shadcn` 为别名）的 Vite + React + TypeScript 源码与 Vitest 测试；`npm run build:web-shadcn` 将单文件产物写入 `lib/web/frontend/shadcn.html`。与 `lib/web/frontend/` 并存，不共用组件。
- `lib/web/frontend/`：shadcn 单文件产物及旧版 `/legacy` 前端静态资源（`app/login/markdown-renderer/file-browser/codemirror` 的 `html/css/js`）；`chat-behavior.js` 是抽出的纯函数模块，仿 `markdown-renderer.js` 的 `window.Manyoyo*` + Node `vm` 单测模式。
- 终端 vendor 资源（`/app/vendor/xterm.css`、`xterm.js`、`xterm-addon-fit.js`）由 `lib/web/server.js` 从 `@xterm/*` 依赖映射提供。
- `docker/manyoyo.Dockerfile` + `docker/cache/`：多阶段镜像构建与构建缓存（Node.js、JDT LSP、gopls，有效期 2 天）。
- `docker/res/`：各 Agent 默认配置、Playwright 资源与 supervisor 模板。
- `scripts/`：`dev-release.js`（发布向导）、`build-web-code-editor.js`、`build-web-shadcn.js` / `dev-web-shadcn.js`。
- `docs/`：VitePress 文档；中文主目录 `docs/zh/`，英文 `docs/en/`。
- `test/`：Node 侧 Jest 测试，文件名 `*.test.js`；`frontend-shadcn/src/` 为 Vitest 测试，文件名 `*.test.ts` / `*.test.tsx`。
- `assets/` 与 `manyoyo.example.json`：资源与配置模板。

### 目录速查

- `docs/zh/guide/` `docs/zh/configuration/` `docs/zh/reference/` `docs/zh/advanced/` `docs/zh/troubleshooting/`
- `docs/en/guide/` `docs/en/configuration/` `docs/en/reference/` `docs/en/advanced/` `docs/en/troubleshooting/`
- `docs/guide/` `docs/configuration/` `docs/reference/` `docs/advanced/` `docs/troubleshooting/`
- `lib/web/` `lib/web/frontend/` `frontend-shadcn/`
- `docker/` `bin/` `scripts/` `test/` `assets/` `coverage/`

## 构建、测试与开发命令

```bash
npm install              # 开发阶段安装/更新依赖（会更新 package-lock.json）
npm ci --include=optional # 提交前与 CI 的可复现安装（CI 不再执行 npm install）

npm run test:unit        # 开发阶段（快）：test/ 下 Jest 单测 + 前端 Vitest
npm test                 # 提交前：Jest 覆盖率（输出 coverage/）+ frontend-shadcn Vitest
                         # 注意：test/manyoyo.test.js 里 Container Mode ×3 和
                         # doctor --json ×1 会真的调 docker/podman 二进制，
                         # 没装容器运行时的环境上这 4 个必失败，不是你改坏的

npx jest test/manyoyo.test.js                 # 运行单个测试文件
npx jest --testNamePattern="关键词"            # 按测试名称匹配运行

# 文档：必须先 ci 安装再构建，不能并行
npm run docs:dev|build|preview                # 启动/构建/预览文档站点，build 会检查 dead links

npm install -g . / npm link / npm run install-link   # 本地全局安装或软链 CLI

npm run build:web-editor # 由 lib/web/frontend/codemirror-entry.js 打包生成
                         # codemirror.bundle.js（已加入 .gitignore，npm install 的
                         # prepare 钩子自动执行，本地调试可手动重跑）
npm run build:web-shadcn # 构建 frontend-shadcn 单文件产物 shadcn.html，随 npm run prepack 自动执行；
                         # 缺少前端依赖时会在 frontend-shadcn/ 执行 npm ci
npm run dev:web-shadcn   # frontend-shadcn 本地开发（Vite dev server）
npm run test:web-shadcn  # frontend-shadcn 的 Vitest 单测，随 npm test / test:unit 自动执行
npm run dev:release      # 维护者发布向导（--yes 自动确认，--version 指定版本）
npm run lint             # 占位的 lint 检查（不做风格约束）
```

- Jest 已忽略 `temp/` 工作目录，避免本地研究目录或临时副本干扰测试扫描。
- `npm test` 会执行入口文档示例版本检查，要求示例版本与 `package.json.imageVersion` 同主版本号。

## 编码风格

- Node.js >= 22，CommonJS（`require` / `module.exports`），不使用 ES Modules（`import` / `export`）。
- 四空格缩进，分号结尾；各 `lib/` 文件顶部 `'use strict'`，只暴露纯函数或类，不依赖全局状态。
- `bin/manyoyo.js` 负责传入 `ctx` 对象，模块不直接读取全局变量。
- `frontend-shadcn/` 是例外：TypeScript、React 与 ES Modules，沿用该目录既有格式与 Vite 工具链。
- CLI 选项声明靠近 `bin/manyoyo.js`；配置合并与归一化优先维护 `lib/runtime-resolver.js`、`lib/runtime-normalizers.js`，worktrees 逻辑维护 `lib/worktrees.js`。
- 命名清晰简短；优先小步改动，避免无关重构，保持改动范围清晰。

## 核心架构

### bin/manyoyo.js（2200+ 行单文件）

无分区注释，靠函数名定位：`Grep "^function <名>"`。主流程编排在此，配置合并/归一化改动优先落到 `lib/runtime-resolver.js`、`lib/runtime-normalizers.js`。

**配置管理**

- 全局配置：`~/.manyoyo/manyoyo.json`（JSON5，支持注释），模板见 `manyoyo.example.json`。
- 四层优先级：命令行 > `runs.<name>` > 全局配置 > 默认值。
- 覆盖模式（标量）：`containerName`、`imageName`、`yolo`、`containerMode` 等。
- 合并模式：`env`（map，按 key 覆盖）；`envFile`、`volumes`、`ports`、`imageBuildArgs`（数组，按「全局 → runs.<name> → 命令行」追加）。`first.env` 与 `first.envFile` 沿用同样规则。
- `envFile` **仅支持绝对路径**；`containerName` 支持 `{now}` 模板（→ `MMDD-HHmm`）。

**YOLO 模式映射**（`lib/agent-adapters/index.js` 的 `AGENT_ADAPTERS`，`setYolo()` 与 `lib/web/server.js` 的 `resolveYoloCommand()` 均委托到这里，单一数据源）

- `c`/`cc`/`claude` → `IS_SANDBOX=1 claude --dangerously-skip-permissions`
- `gm`/`g`/`gemini` → `gemini --yolo`
- `cx`/`codex` → `codex --dangerously-bypass-approvals-and-sandbox`
- `oc`/`opencode` → `OPENCODE_PERMISSION='{"*":"allow"}' opencode`

**容器模式**（`setContMode()`）

- `common`（默认）：标准容器
- `dind`：`--privileged`，需手动启 `dockerd`
- `sock`：`--privileged + -v /var/run/docker.sock`，可访问宿主机 Docker（有安全风险）

**容器生命周期**

- 入口点为 `tail -f /dev/null`，默认命令存储在容器标签 `manyoyo.default_cmd`。
- 容器就绪等待：指数退避 100ms→2000ms，最多 30 次。

### lib/web/server.js（6000+ 行单文件）

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

### lib/web/frontend/（旧版 `/legacy` 前端）

- 布局是两层 grid 嵌套：`.main`（`header` + `.workspace-shell` 两个直接子元素）套着内层 `.workspace-main`（`grid-template-rows: minmax(0, 1fr) auto`，真正的「内容区 / composer」二分在这一层，composer 并非 `.main` 的直接子元素）。增删 `.workspace-main` 直接子元素时须同步调整行数，否则内容区高度失效。
- 中间工作台的「终端/文件/详情/配置/检查」5 个次要标签收在 `#workspaceSwitcherToggle` 图标按钮触发的弹出面板 `#workspaceSwitcherPanel` 里，仅「活动」作为常驻标签；`setActiveTab()` / `isActiveSessionHistoryOnly()` 逻辑本身未变，只是触发入口从常驻按钮改为面板内按钮。
- `connectTerminal()` 前须加 `isActiveSessionHistoryOnly()` 守卫（三处：`setActiveTab`、`handleSessionItemClick`、`refreshSessions`），否则点击「仅历史」会话会触发后端新建容器。

### frontend-shadcn/ 样式规范

新前端遵循 shadcn skill 的通用规则（Skill 工具，名称 `shadcn`），此外项目内额外约束几条容易回归的问题：

- **hover / active 态必须肉眼可辨**：`index.css` 里 `--muted`/`--secondary`/`--accent` 与 `--background` 的 oklch lightness 差值曾经只有 0.005（背景改浅到 `oklch(0.975)` 但没跟着调这三个 token），导致 `ghost`/`outline`/`secondary` 变体的按钮、下拉菜单项、弹出面板选项在浅色主题下悬浮/选中几乎看不出变化。现状是三个 token 固定在 `oklch(0.93)`，与背景保持约 0.04 的差值——**改动这几个 CSS 变量或新增依赖它们的组件后，必须在浏览器里同时用亮色和暗色主题实测悬浮/选中态**，不能只看代码 diff 判断「应该能看见」。
- **不用 className 覆盖 `Button`/`Input` 等组件自带的内边距、字号**（例如手写 `py-*`、`text-*` 覆盖默认值）。需要不同大小时用已有的 `size` variant（`xs`/`sm`/`default`/`lg`/`icon*`）；确实缺档位就去 `buttonVariants`（或对应组件的 `cva` 定义）里加一档，不要在调用处零散覆盖——否则各处按钮粗细不一致，且下次升级 shadcn 组件版本时这些覆盖会被悄悄绕过。
- **`DialogContent` 是 `grid gap-4`，直接子元素之间才有间距**。表单类弹窗如果用 `<form>` 包住 `FieldGroup` + `DialogFooter`（提交需要整体在 `<form>` 里），`<form>` 本身会挡住这层 grid gap，字段和底部按钮栏会贴在一起——`<form>` 必须显式补 `className="flex flex-col gap-4"`。不需要 `<form>` 包裹时（`FieldGroup`/`DialogFooter` 直接作为 `DialogContent` 的子元素）不用管，gap 是自动的。参考 `prompt-dialog.tsx`、`create-container-dialog.tsx`、`clone-name-dialog.tsx`。
- **确认类弹窗（删除确认、未保存修改提示等）一律用 `Dialog`，不用 `AlertDialog`**：base-ui 的 `AlertDialog` 语义上要求必须点按钮才能关闭，默认不响应背景点击、`AlertDialogContent` 也没有右上角关闭按钮；本项目约定所有弹窗都可以背景点击 / 右上角 ✕ 关闭（等价于「取消」），因此统一用 `Dialog` + 手动的「取消」`Button`（`variant="outline"`，`onClick` 里做取消逻辑），不要用 `AlertDialogCancel`。参考实现见 `frontend-shadcn/src/hooks/use-confirm-dialog.tsx`、`use-unsaved-changes-dialog.tsx`。
- 网页前端默认避免常驻高开销视觉效果：不要在常驻元素使用 `animation: ... infinite`，避免大面积叠加 `backdrop-filter` / `filter` 模糊；确需使用时仅限短时场景，并提供 `prefers-reduced-motion` 降级。

### docker/manyoyo.Dockerfile

两阶段构建：Stage 1 检测并补全 `docker/cache/` 缓存；Stage 2 按 `TOOL` 参数安装工具。

- `TOOL`：`full`（默认）/ `common` / `go` / `java` / `codex` / `gemini` 等
- `APT_MIRROR`、`NPM_REGISTRY`、`PIP_INDEX_URL`：镜像源加速

## TDD 模式

默认适用于新增功能、行为变更、bug 修复；纯文档改动可例外。

- **Red**：先写失败测试，按变更领域选最小 case（CLI 优先 `test/manyoyo.test.js`；Web 优先 `test/web-server-auth.test.js`；插件优先 `test/plugin-command.test.js`；前端优先 `frontend-shadcn/src/**/*.test.ts`，vitest，与源码同目录）。
- **Green**：只做最小代码改动让测试通过，避免顺手重构。
- **Refactor**：在测试持续通过的前提下整理命名或重复逻辑，确保行为不变。
- 每个 bug fix 至少补一个回归用例（先失败后通过）；若无法先写失败测试，需在变更说明中写明原因与替代验证步骤。
- 开发阶段优先运行 `npm run test:unit`；提交前运行 `npm test`。

## 测试指引

- Node 侧框架为 Jest（见 `package.json` 的 `jest` 配置）；`frontend-shadcn/` 使用 Vitest。
- 新增功能优先补充对应领域测试文件的关键分支与异常路径（CLI 优先 `test/manyoyo.test.js`，Web 优先 `test/web-server-auth.test.js`）。
- 插件相关改动优先补充 `test/plugin-command.test.js`，至少覆盖 host/container 两类场景的关键分支（配置生成、参数透传、挂载或启动路径）。
- 涉及网页服务认证时，至少验证未登录 `401`、登录成功可访问、登出后失效。
- 涉及 shadcn 前端时，补充 `frontend-shadcn/src/` 对应 Vitest 用例，并通过 `npm run test:web-shadcn` 验证。

## 常用模式

### 添加新的 YOLO 智能体

1. 在 `lib/agent-adapters/index.js` 的 `AGENT_ADAPTERS` 中新增条目（`bin/manyoyo.js` 与 `lib/web/server.js` 会自动生效，无需分别修改）。
2. 更新 `docs/zh/reference/agents.md` 和 `docs/en/reference/agents.md`。

### 添加新的配置选项

1. 在 `@typedef Config` JSDoc 中定义字段。
2. 更新 `loadConfig()` / `loadRunConfig()`。
3. 在 `setupCommander()` 中添加 CLI 选项。
4. 处理配置合并（注意覆盖 vs 追加）。
5. 更新 `manyoyo.example.json` 和 `docs/configuration/`。

### 常见开发任务

- 配置合并验证：`manyoyo config show`，`manyoyo config show -r <name>`。
- 命令预览：`manyoyo config command -r <name>`，用于检查参数拼装。
- 快速迁移已有 Agent 配置：`manyoyo init all`，然后 `manyoyo run -r claude`（或 `codex/gemini/opencode`）。
- 动态容器名验证（`{now}`）：在运行配置写 `containerName: "my-<agent>-{now}"`，执行 `manyoyo config show -r <name>` 查看解析结果。
- 环境文件解析：`manyoyo config show --ef /abs/path/myenv.env`。
- 容器调试：`manyoyo run -n <name> -x /bin/bash`。
- 环境诊断：`manyoyo doctor`（人类可读）或 `manyoyo doctor --json`（脚本消费），可加 `--port <port>` 检查监听端口。
- 镜像构建：`manyoyo build --iv <x.y.z-后缀>`（如 `1.8.4-common`），可加 `--iba TOOL=common`。
- 维护者发布：`npm run dev:release`；自动确认 `-- --yes`，指定版本 `-- --version <x.y.z>`。
- 局域网监听网页服务：`manyoyo serve 0.0.0.0:3000 -U <user> -P <pass>`。
- 网页认证登录：`curl --noproxy '*' -c /tmp/manyoyo.cookie -X POST http://127.0.0.1:3000/auth/login -H 'Content-Type: application/json' -d '{"username":"<user>","password":"<pass>"}'`（需与启动参数/配置一致）。
- 若未显式设置 `-P/--pass`（或 `serverPass` / `MANYOYO_SERVER_PASS`），系统会在启动时生成随机密码并打印到终端。
- 带认证访问接口：`curl --noproxy '*' -b /tmp/manyoyo.cookie http://127.0.0.1:3000/api/sessions`。
- 导出会话操作审计记录：`curl --noproxy '*' -b /tmp/manyoyo.cookie http://127.0.0.1:3000/api/sessions/<name>/audit`。
- 删除对话历史（保留容器）：`curl --noproxy '*' -b /tmp/manyoyo.cookie -X POST http://127.0.0.1:3000/api/sessions/<name>/remove-with-history`。

## 配置与路径提示

- 配置模板：`manyoyo.example.json`；全局配置：`~/.manyoyo/manyoyo.json`（JSON5）；用户数据默认在 `~/.manyoyo/`。
- 运行配置：`~/.manyoyo/manyoyo.json` 的 `runs.<name>`（通过 `run` / `config show` / `config command` 的 `-r <name>` 读取）。
- 环境文件：`--ef/--env-file` 与 `envFile` 仅支持绝对路径（如 `/abs/path/name.env`）。
- 初始化配置：`manyoyo init [agents]` 会写入 `runs.<agent>`（含 `env` map）；目标已存在时逐个询问，`--yes` 自动覆盖。
- 网页认证配置：`serverUser`、`serverPass`（支持环境变量 `MANYOYO_SERVER_USER`、`MANYOYO_SERVER_PASS`），优先级为 命令行 > 运行配置 > 全局配置 > 环境变量 > 默认值。
- 网页服务监听：`serve [listen]` 仅支持 `<ip:port>`（IPv6 写作 `[ip]:port`），默认 `127.0.0.1:3000`。
- 镜像版本格式：`imageVersion` 与 `run/build --iv/--image-ver` 必须为 `x.y.z-后缀`（如 `1.8.1-common`）。
- `--yes` 仅用于 `build` 与 `init` 子命令；CLI 仅支持子命令入口，传入未定义参数会报 `unknown option`。
- 缓存目录：`docker/cache/`；覆盖率：`coverage/`。

## 版本对齐

- 镜像版本读取 `package.json` 的 `imageVersion` 字段（格式 `x.y.z-variant`），与 `version` 字段独立。
- `test/doc-example-version.test.js` 强制 `README.md`、`docs/{zh,en}/guide/quick-start.md`、`basic-usage.md`、`reference/cli-options.md` 的镜像版本与 `package.json.imageVersion` 同主版本，改 `imageVersion` 后不同步这 7 个文件会导致 `npm test` 失败。
- `IMAGE_VERSION`、`IMAGE_VERSION_BASE`、`imageVersion` 与文档示例保持一致；发布前核对 `version` 与 `imageVersion` 是否匹配文档。
- `package.json.playwrightCliVersion` 是 Playwright CLI 版本的单一来源；镜像内安装 `@playwright/cli` 时禁止改回 `@latest`，也不要误用 `dependencies.playwright` 作为版本来源。
- 包含文件：`README.md`、`LICENSE`、`docker/manyoyo.Dockerfile`、`manyoyo.example.json` 需与发布一致。
- `bin/manyoyo.js` 变更时同步检查 `package.json` 的 `bin` 字段。

## 安全约束

- 名称验证：容器/镜像 `^[A-Za-z0-9][A-Za-z0-9_.-]*$`；env key/value 校验在 `lib/runtime-normalizers.js` 的 `parseEnvEntry()`，key 须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，value 阻止 `[\r\n\0;&|` $<>]`。
- 路径：`validateHostPath()` 阻止挂载 `/`、`/home`、`$HOME`，用 `fs.realpathSync()` 解析符号链接后验证。
- 命令执行：`spawnSync()` + 参数数组，禁止 shell 字符串拼接；新增输出涉及敏感信息时需脱敏。
- 敏感数据：`lib/serve-log.js` 的 `sanitizeSensitiveData()` 掩码含 KEY/TOKEN/SECRET/PASSWORD/AUTH/CREDENTIAL 的值（前 4 + 后 4 位）。
- 日志：新增 `~/.manyoyo/logs/` 文件必须按子命令分目录（`serve/`、`build/`、`run/`），勿堆根目录。
- 日志量：`lib/log-path.js` 只按天分文件，**没有轮转、没有保留期、没有大小上限**。不要按「每个 HTTP 请求 / 每个子进程调用 / 每个流式事件」逐条写盘（曾经这么干过，实测约 55000 条、20MB/天），高频路径上只记 warn/error。
- 在线查看日志的接口一律**不要全量 `readFileSync` + `split('\n')`**：同步读会阻塞事件循环，文件越长越糟；日期/路径类查询参数必须白名单校验（`^\d{4}-\d{2}-\d{2}$` 之类），否则会被拼出目录穿越。
- 日志内容渲染到 HTML 必须逐字段转义后再进 DOM。日志里含用户 prompt 等任意文本，用字符串拼 `innerHTML` 等于把 prompt 当代码执行。
- Web 鉴权：所有路由默认认证，匿名白名单仅限 `/auth/login`、`/auth/logout`、`/auth/frontend/login.css`、`/auth/frontend/login.js`、`/shadcn/auth/login`；新增接口/页面必须走全局认证网关，禁止在业务路由里零散补认证。
- `serve` 默认使用 shadcn 前端（`/`），`/shadcn` 仅作兼容别名；旧版前端保留在 `/legacy`。
- 使用 `serve 0.0.0.0:<port>` 对外监听时必须设置强密码，并通过防火墙限制访问来源。
- 新增容器模式或挂载选项时不放宽安全校验；`sock` 模式需明确安全风险提示（可访问宿主机 Docker socket）。
- 调整容器内 Playwright CLI 浏览器安装链路时，必须保证 `playwright-cli install-browser` 安装到全局 `@playwright/cli` 自带的 Playwright，而不是仓库本地 `node_modules/playwright`。

## 文档规范

- 中文主维护 `docs/zh/`，英文 `docs/en/`，结构需保持一致；文档改动需中英文同步更新，并保留兼容跳转页。
- 侧边栏在 `/zh/` 与 `/en/` 统一展示全章节导航；首页卡片需可点击跳转。
- 当前 `docs/`、`docs/configuration/`、`docs/troubleshooting/` 及 `docs/zh|en` 下对应目录首页使用 `README.md`；新增目录首页优先使用 `README.md`，不再新增 `index.md`。
- 文档内部链接优先使用仓库相对 `.md` / `README.md` 路径，保证 GitHub 网页浏览可直接跳转；站点路由由 VitePress 兼容。
- 文档修改后运行 `npm run docs:build`，检查 dead links 与导航行为。
- 新增配置项或 CLI 选项时，同步更新 `manyoyo.example.json`、`docs/zh/` 与 `docs/en/`；必要时同步 `README.md` 示例。

## 提交与 PR 指引

- 简短中文动词短语，文档用 `docs:` 前缀，不超过 50 字；确需补充背景时最多追加一句精简摘要，不写分点列表、不写验证过程。
- `npm run dev:release` 的发布提交使用 `commit-diff` 产出：标题不加范围前缀，正文可使用要点列表；此例外不适用于日常提交。
- 提交信息里不写 `Co-Authored-By`、生成工具署名等任何尾注。
- 未明确要求时不自动提交；需要时先给出 commit message 和命令让用户确认。
- PR 需包含：变更摘要、测试结果（如 `npm test`）、相关文档更新说明。
- 提交前：`npm test` 通过；涉及文档：`npm ci --include=optional && npm run docs:build` 无错误；涉及新配置：更新 `manyoyo.example.json`；涉及文档结构调整：中英文同步更新。

## 变更执行检查清单

1. 仅做最小且有针对性的改动。
2. 按 TDD 补测试，开发阶段跑 `npm run test:unit`，提交前跑 `npm test`。
3. 涉及文档改动时运行 `npm run docs:build`，检查 dead links 与 sidebar/nav 行为。
4. 校对版本示例：`README.md` 的快速开始与主流程示例应与 `package.json` 的 `version` / `imageVersion` 对齐；`docs/zh/`、`docs/en/` 的历史/场景示例可使用其他版本，但必须保持 `x.y.z-后缀` 格式并标注用途。
5. 反馈保持简洁，并附可选 commit 命令/message。
