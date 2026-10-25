# frontend/ 协作指引

根目录 `AGENTS.md` 的补充，仅在改动默认 Web 前端时适用。本目录是独立 Vite 项目：TypeScript + React + shadcn/ui + ES Modules，沿用目录内既有格式与工具链（根仓库的 CommonJS / 四空格约定不适用于此）。它是 `serve` 唯一的 Web 界面。

- **样式规范见同目录的 `STYLE.md`（唯一出处），新增或改动任何界面前必读**：字号档位、颜色、间距与控件尺寸、表单、按钮、页面布局、弹窗尺寸与遮罩、表格、手机端、自查。
- 开发：`npm run dev:web`；构建：`npm run build:web`（产出单文件 `lib/web/index.html`，随 `npm run prepack` 自动执行）。
- 发布控制台页面（维护者工具，不进用户界面）：入口 `release.html` + `src/release/`，`npm run build:release`（仓库根目录）构建成 `scripts/release/console.html`；服务端与说明见根目录 `AGENTS.md` 的 `scripts/release/` 一条。
- 测试：Vitest，用例与源码同目录（`*.test.ts` / `*.test.tsx`），`npm run test:web` 运行，也随 `npm test` / `npm run test:unit` 自动执行。
- `/agent/stream` 的 NDJSON 事件协议是跨前后端的契约，本目录涉及 `src/lib/api.ts` 的 `StreamEvent` 与 `workspace-panel.tsx` 的事件分支，改动须同步服务端，详见 `lib/web/AGENTS.md`。其中 `trace` 事件**不保证带结构化 `traceEvent`**（stderr、非 JSON 的 stdout 只有 `text`），一律先过 `toTraceEvent()` 兜底，别写 `if (event.traceEvent)` 这种会吞掉原始输出的分支。
- 校验：`npm run typecheck`（`tsc -b --noEmit`，必须带 `-b`：根 tsconfig 是 `files: []` 的 solution 配置，裸 `tsc --noEmit` 一个源文件都不会检查）+ `npm run lint`（eslint），两条都不在根目录 `npm test` 里。lint 基线是 4 error + 2 warning 的既存问题（`app-sidebar`、`logs-dialog`、`markdown-content`、`workspace-panel`），以「数量没变多」为准，不要顺手去修无关文件。
- eslint 用的是 React Compiler 规则集：`react-hooks/set-state-in-effect`（effect 里直接 setState）和 `react-hooks/refs`（渲染期读 ref）都报 error。状态由外部 props 驱动、确实只能在 effect 里对账时，`eslint-disable-next-line` 要贴在 **setState 那一行**，贴在 `React.useEffect(` 上不生效。

## 组件地图

先按这张表定位，别从 `find src` 开始列文件：

- `App.tsx`：整体布局与跨面板状态（会话选择、未保存修改拦截 `confirmLeaveIfDirty`、主题）。
- `workspace-panel.tsx`（1900+ 行，中枢）：顶栏（侧栏按钮 · 会话标题（点击改名，写的是 AGENT 备注）· ⋯）；⋯ 里按归属分组：AGENT 组是聊天 / Agent详情，容器组是文件 / 终端 / 改动 / 设置容器 / 容器详情（不是聊天时标题后面淡色显示当前视图名）。各视图挂载、消息流与 Composer、`/agent/stream` 事件分支、各类弹窗编排都在这里。会话显示名一律用 `lib/api.ts` 的 `sessionDisplayTitle`（备注 > Agent 标题 > 首条消息 > AGENT N），不要再写 `agentRemark || agentName`。
- Composer（`workspace-panel.tsx`）：输入框和按钮在同一个圆角框里，按钮都是无文字图标（`aria-label` + `title`；手机 `icon-xl` = 40px，桌面 `icon-lg`），**测试和 `test/integration/helpers/chat-experience/harness.js` 按 `aria-label`（“发送”“停止”“插入时机”“切换模式”“选择模型…”）找按钮**。执行中没输入只有停止；有输入时是 插入时机 + 停止 + 发送（追加）。空会话（Agent 模式、没消息没排队）时整个 Composer 放到页面中间（`centered`），下面是 `STARTER_PROMPTS`。`/` 斜杠命令与 `@` 文件补全在 `composer-suggestions.tsx`（焦点留在输入框，弹层吃掉 ↑↓/Enter/Tab/Esc，输入法组词期间不触发；`@` 走 `fs/list` 的 `prefix` + `limit`）。
- 提醒与同步提示：`hooks/use-attention.ts`（任务结束但没看到的会话数 → 标签页标题 `(N) `，可选浏览器通知，开关在系统设置“页面”）；`hooks/use-resume-indicator.ts` + `use-sync-loop` 的 `onResumeSync`（离开 ≥5 秒回来或 `online` 才提示，定时同步与重新聚焦不提示；>300ms 才出进度线，成功显示 1.5 秒“已同步”）。一次性操作结果用 `sonner` 的 `toast`（`components/ui/sonner.tsx` 接的是本项目的 `theme-provider`，不是 next-themes），表单校验、断线这类持续状态仍就地显示。
- `changes-panel.tsx`：“改动”视图，打开或点刷新才请求 `git/changes`，diff 只按行着色、纯文本渲染。
- `app-sidebar.tsx`（800+ 行）：容器 / AGENT 列表与增删改克隆，移动端形态是 `Sheet` 侧栏。
- `files-panel.tsx` + `code-mirror-editor.tsx`：文件浏览与编辑，切走标签前经 `confirmLeaveIfDirty` 拦一次未保存修改。
- `terminal-view.tsx`：xterm 终端面板，含按键条与移动端输入条。
- `html-preview-panel.tsx`：`Sheet` 里的沙箱 iframe 预览（`allow-scripts` 且不给 `allow-same-origin`）。
- 弹窗类：`system-settings-dialog` / `create-container-dialog` / `agent-template-dialog` / `model-menu`（聊天输入框左下角的模型下拉，选项来自会话 env，CLI 内置目录后台补充）/ `logs-dialog` / `search-dialog` / `directory-picker-dialog` / `clone-name-dialog` / `prompt-dialog` / `quick-chat-setup-dialog`。
- 消息渲染：`markdown-content.tsx` / `trace-block.tsx` + `lib/markdown-render.ts` / `lib/sanitize.ts`。**图片只在消毒之后统一处理**（`resolveImageSrc`，markdown 写法和原始 HTML 的 `<img>` 都经过它）：站内 `/api/sessions/` 原样用；外链变成点击确认的链接；`data:` 等协议只留 alt；有会话上下文（`sessionName` + `baseDir`）时容器内绝对 / 相对路径且扩展名在 fs/raw 白名单里的改写成 fs/raw，其余变成可点开的路径（`data-open-path`，点击交给 `onOpenPath` → 文件页的 `openRequest`）。代码高亮（`lib/code-highlight.ts`）复用 CodeMirror 已打包的语言包 + legacy-modes 的 shell，在消毒后的 DOM 上用 textContent 原地生成 span（不经过 HTML 解析）；单块 2 万字、每条消息 4 万字以上不高亮。产物是单文件，动态 import 会被内联，“按需加载”不成立。
- 执行过程（`trace-block.tsx`）：说明行标题 `[说明]`，正文默认展开；工具行标题只到 `[工具] <工具名> ✅/❎`（`lib/api.ts` 的 `formatTraceRowTitle`，执行中不带图标），描述（`traceRowDescription`：description → 参数摘要 → 命令）在标题下面单独一段，与 `[说明]` 正文共用 `NARRATION_BOX` / `NARRATION_TEXT` 两个样式常量（必须一模一样）；“全部收起”时描述段隐藏；点开一行显示详情（描述 → 工具 → 工具参数 → 命令 → 结果 / 错误），描述段不再重复。右侧三个按钮（对齐顶部 / 展开收起全部细节 / 对齐底部）；对齐按钮不自己滚动，而是给滚动容器派发 `TRACE_ALIGN_EVENT`（带这一段的 `data-trace-key`），由消息流设置锚点并立即滚动（不用平滑滚动：动画目标在点击时算好，执行过程继续变长，停下时已不在底部）。开合状态分两层：`mode`（默认 / 全展开 / 全收起）和用户手动开合过的行（`rowOverrides`）。**执行中**（执行过程与回复都是 pending）回复框不渲染（`mergeTraceIntoReply` 的 `hideBubble`），正在输出的文字（`liveText`）作为最后一行 `[说明]` 实时显示、标题行末尾带一行预览；正式的说明事件到了就由它接替（同样式、同高度）。原因：每条新的 assistant 消息开始时流式回复会被清空重来，放在回复框里会让视野上下抖（实测 9 次、最大 73px），也容易把中间说明当成最终回复。截断的 trace（`traceTruncated`）按消息缓存最近一份完整版，执行中显示“完整版 + 列表里新增的事件”，不回退、不闪“正在加载完整内容…”；本地流式拿到的完整内容也记进这个缓存，流结束换成服务端截断版时直接用。
- 子 Agent 与任务清单（`trace-block.tsx` + `lib/api.ts`）：`buildTraceTree` 把合并后的事件按 `parentToolId` 挂成树（找不到发起者的当顶层，不丢）；子 Agent 行标题 `[子 Agent] <类型> ✅/❎ · N 步`（描述同工具行，放在标题下面；点开后在详情最前），默认收起，点开显示内部事件，缩进最多 3 层；“展开全部细节”覆盖嵌套行；执行过程标题的“N 步”只数顶层；`mergeToolTraceEvents` 的 key 含 `parentToolId`（`traceRowKey` 同样）。TodoWrite / TaskCreate / TaskUpdate 在执行过程顶部合成**一个**“任务清单”区块（`buildTaskList`，☑/◐/☐，超过 8 项折叠），原始工具行标题改成 `[任务清单] 更新 N 项`。
- 追加提示词（`workspace-panel.tsx` 的 `Composer` / `handleSend`、`lib/queue.ts`、`queued-prompts.tsx`）：任务进行中输入框保持可用；发送按钮旁的下拉选插入时机（`now` / `step` / `turn`，记在 `manyoyo:queue-when`，默认 `turn`），命令模式不显示。进行中点发送不开新流，而是写待发箱后 `POST /agent/queue`，成功才清待发箱；队列来自 `/messages` 的 `queue`，显示为消息流底部的“排队中”气泡（取消 / 编辑 = 取消后放回输入框）。没有任务在跑而队列还有内容时显示“继续发送”。流里收到 `queue_next` 后这条流到此为止，稍后多对两次账，让下一轮的 pending 交给恢复轮询。滚动规则不变：用户发送时强制贴底，气泡在底部按贴底规则跟随（`temp` 里的 `scroll-queue.js` 复测过）。
- 消息流滚动（`workspace-panel.tsx` 的 `ActivityView` + `lib/chat-behavior.ts`）：**默认固定不动，新内容只往下追加**。锚点三种：贴底（`bottom`）、贴着某一段执行过程的底部（`trace` + `pinnedTraceRef` 记的 `data-trace-key`）、不动（`none`）。**锚点只由三类事件改变**：用户滚动引起的滚动事件（按停下的位置判断，2px 容差）、执行过程的对齐按钮、发送（`followSignal` 强制贴底）。内容 / 尺寸变化（layout effect 与同时观察内容和滚动容器的 ResizeObserver）只按锚点补滚动，**从不重新判断锚点**——旧逻辑在“用户最近操作过”时按当前位置重新判断，执行中 1.5 秒内必有新内容，于是点完“对齐到底部”立刻被判成“不贴着”（实测 566/568 帧偏离、最大 1828px）。补滚动只在用户正在滚动（滚轮 / 触摸 / 按键 / 点在滚动条上，`isScrollInput`，1.5 秒，`isFollowPaused`）或选中了文字时暂停，普通点击不暂停。消息行的 React key 用 `messageRenderKey`（执行过程的 `renderKey` → id），发送时给执行过程占位生成 `renderKey`，`reuseUnchanged` 换成服务端版本时把它带过去：否则占位换 id、配上回复、回复换 id 都会让执行过程重新挂载（展开状态丢失、整段收起）。**改执行过程或滚动逻辑必须跑 `npm run test:experience`**（`test/integration/web-chat-experience.test.js`：真实浏览器 + 容器里的假 claude，逐帧判定回跳、贴住、阅读被拉走、重新挂载、最终回复，约 3 分钟）；探针与驱动在 `test/integration/helpers/chat-experience/`，单个用例可以用驱动脚本对着已在跑的 serve 跑。驱动与探针文件带 `/* istanbul ignore file */`（传给浏览器执行的函数被覆盖率插桩后在页面里报 `cov_xxx is not defined`，只在 `npm test` 的覆盖率模式下出现）；手机触摸滚动要用 CDP `Input.dispatchTouchEvent`（headless 下 `synthesizeScrollGesture` 的 touch 手势不滚动）；全新会话内容不满一屏时测不出抖动，用例前先预热一轮。
- 聊天里的新交互（见 `lib/web/AGENTS.md` 对应服务端说明）：`model-denied-notice.tsx`（模型地址被拦的提示条，由 `lib/model-denied.ts` 从历史推出，刷新也在）；图片 `hooks/use-composer-images.ts` + `components/composer-images.tsx` + `lib/chat-images.ts`（选中 / 粘贴 / 拖入就上传，草稿只存容器内路径）；回退 `rewind-dialog.tsx`、改动页「按轮」视图（`lib/rounds.ts` 从用户消息的 `snapBefore/snapAfter` 推出轮次）；用户消息上只有一个「回退到这里」按钮（删除对话 = 回退时选“只恢复对话”，不再单独提供删除 / 隐藏）。
- 系统设置「基础」分类（`basic-settings.tsx`）：配置里没写的字段也能直接填（留空 = 用默认值，不会写进空串）；镜像名可输入（候选来自 `GET /api/images`，本机已有的版本号合规镜像），镜像版本是只列该镜像本机版本的下拉，换成本机另一个镜像时版本联动（`lib/image-options.ts`）。新填的顶层字段靠 `lib/json5-path-edit.ts` 的 `upsertTopLevelValue` 插进配置文本，冲突重放（`config-rebase.ts`）时只补“打开时就没有”的字段，别人删掉的仍记为 missing。
- `lib/api.ts`：所有 HTTP 与流式调用的出口，`StreamEvent` 类型定义与会话/trace 相关纯函数也在这里。
- `lib/sync-scheduler.ts`：同步调度纯函数。`decideSyncDelay`（有焦点 6s / 没焦点 30s / 隐藏或空闲 10 分钟暂停）、`createSingleFlight`（单飞）、`createCoalescer`（visibilitychange 与 focus 300ms 合并）。
- `lib/message-sync.ts`：`/messages` 增量同步的纯函数——page / tail / reset / before 的合并、稳定前缀 anchor、内容没变的消息复用原对象（DOM 不重建）、流结束后用最近一页对账（`reconcileWithPage`）、trace 按需加载的缓存键与 LRU。
- `lib/composer-store.ts`：提示词本地草稿与待发箱（`manyoyo:composer:<会话名>`，localStorage 不可用时静默降级）。发送前同步写待发箱（`lib/send-flow.ts` 的 `beginSend`），收到 `meta` 才清；发送失败后先分类（`classifySendError`）：有 HTTP 状态码是明确拒绝，立刻放回输入框（输入框非空时不覆盖，给“恢复”入口）；**网络错误先向服务端对账再放回**（`resolveFailedSend`：找到同一个 clientId 就是已发出，不放回；对账也失败就保留待发箱并提示“暂时无法确认”，恢复联网后由同步里的 `checkOutbox` 自动判定）；放回的内容原样重发沿用原 clientId（服务端按它去重，返回 409 `duplicate:true`），改动过才换新的；`clearAllComposerData` 供登出清空（目前前端没有登出入口，加入口时要调用它）。
- `lib/terminal-resize.ts`：终端 fit 后列数/行数变化的防抖上报（`{type:'resize',cols,rows}`）、容器尺寸为 0 不建连。
- `lib/format.ts`：时间与体积的统一格式化（`formatDateTime` 固定 zh-CN 24 小时制 `MM/DD HH:mm`、`formatBytes`）。新增展示时间/体积的地方一律用它，别再各写一个 `toLocaleString()`。
- `hooks/`：`use-mobile`（移动端断点）、`use-sessions`、`use-agent-recovery-poll`（页面隐藏时不发请求，可见后立刻补一次，退避计数不清零）、`use-resizable-width`、`use-confirm-dialog`、`use-unsaved-changes-dialog`。
- `components/ui/`：shadcn 组件，默认不改；要调样式先想能不能在调用处用 variant 解决。**有本地修改的文件**（每处都有“本地修改 / 本地新增”注释，升级 shadcn 时用 `npx shadcn@latest add <组件> --diff` 合并，别直接 `--overwrite`）：`dialog.tsx`（`size` 档、`DialogBody`、嵌套弹窗也渲染遮罩 `forceRender`、父弹窗 `data-nested-dialog-open` 缩放变暗）、`sheet.tsx` / `alert-dialog.tsx`（共用 `overlay-class.ts` 的遮罩）、`field.tsx`（`FieldLegend variant="label"` 字重 600）、`card.tsx`（`CardTitle` 14px / 600；描边用 `border` 而不是 `ring`，贴着 overflow 边缘不会被切）、`badge.tsx` / `alert.tsx`（`success` / `warning` variant）、`table.tsx`（表头 12px 黑色加粗吸顶）；`index.css` 增加了 `--success` / `--warning`，以及手机端点击区域工具类 `touch-hit`（`relative` + `::after` 向外扩到约 40px；用在手机上嵌在文字行 / 表格行里的 `icon-xs` / `icon-sm`；相邻按钮之间必须留 `gap-3` 以上，否则点击区域重叠；DataTable 手机卡片的操作区已自带）。`table.tsx`、`empty.tsx` 是 `npx shadcn@latest add` 装的（CLI 会写出 `from "cn"` 的错误导入并在 package.json 加一个 `cn` 依赖，装完要改成 `@/lib/utils` 并还原 package.json）。
- 样式基础组件（规范见 `STYLE.md`）：`data-table.tsx`（只读数据列表，桌面表格 / 手机卡片，空状态与加载中）、`hint.tsx`（辅助档文字）、`page-header.tsx`（整页标题行 / 40px 工具栏）、`sticky-footer.tsx`（整页表单底部保存栏）、`key-value-list.tsx`（只读“名称：值”）、`column-header.tsx`（可编辑行的表头单元）；`src/style-guard.test.ts` 是守卫（弹窗尺寸、手写表格、原色、手写字号、`leading-*`、`dark:` 颜色覆盖、space-*），规则本身在 `scripts/guard-rules.mjs`。白名单只减不增：修掉一处违规后在 `frontend/` 下跑 `node scripts/guard-sync.mjs` 把白名单刷新成实际次数（次数变大或出现新文件直接失败；确需新增例外，传理由作参数：`node scripts/guard-sync.mjs "理由"`，并在 STYLE.md 第 14 节有依据）。

## 保存不覆盖别人的修改

- **系统设置对话框保存的是打开时读到的整份配置文本**，`PUT /api/config` 带 `If-Match`（`GET` 的 `etag`）。弹窗里的子面板（快捷对话、软件源）自己直接写配置文件，**必须接 `onSaved` 走 `handleSubPanelSaved`**（把最新内容和版本号接过来，用 `lib/config-rebase.ts` 的 `rebaseLeafEdits` 重放自己改过的字段）；不要再写只合并个别字段的对症代码（`c322c4b` 的 `syncQuickChatIntoRaw` 就是这样，漏掉了软件源和“键不存在”的情况，已删除）。保存遇到 409：表单模式自动在最新内容上重放并最多重试一次，字段两边都改了以我的为准并在提示里写字段名；JSON 文本模式不自动处理，给“重新加载（放弃我的修改）/仍然保存（覆盖对方的修改）”两个按钮。测试在 `system-settings-dialog.test.tsx`，用假 fetch 模拟服务端文件状态（`FAKE_SERVER_LEGACY=1` 可模拟改版前的服务端复现原始问题）。
- 文件面板读取时记下 `etag`，保存带 `If-Match`，409 显示“文件已在容器里被修改”+“重新加载 / 仍然保存”（“仍然保存”先取最新的 etag 再写），样式沿用容器管理页环境变量冲突提示。

## 同步请求

- **同步请求必须经过单飞（`createSingleFlight`，会话级封装在 `hooks/use-session-sync.ts`，定时与事件调度在 `hooks/use-sync-loop.ts`，都有 jsdom 用例），主动触发不能丢**：定时触发（`manual=false`）遇到在途请求直接跳过；发送结束、停止、切回页面这类主动触发（`manual=true`）遇到在途请求要排队、结束后补跑恰好一次。只跳过不补会漏掉“流结束后立刻对账”那一次，表现是界面停在半途状态。`/messages` 与 `/detail` 共用一个按会话创建的单飞实例，切换会话时 `abort()`；`/api/sessions` 刷新（`use-sessions`）同理。
- 定时器用 `setTimeout` 链（上一轮结束后才排下一轮），不要用 `setInterval`：慢网下会堆积请求。
- 消息合并以服务端契约为准（稳定前缀不可修改、`epoch` 变了整体重拉），细节见 `lib/web/AGENTS.md`；新增会改历史前缀的前端动作前先想清楚会不会让 tail 合并显示旧内容。

## 移动端

手机访问是主要使用场景之一，新增或改动界面时默认要在窄屏下验证一遍：

- 手机端的样式规则（弹窗全屏、表格变卡片、40px 可点区域、安全区、Sheet 边框压制、16px 输入框）见 `STYLE.md` 第 12 节；这里只记行为上的坑。
- 断点统一走 `useIsMobile()`（768px），不要各处自己写 media query 判断。
- **xterm 在移动端接不住输入法**：合成阶段（候选词、联想）的内容不会进 `onData`，表现是键盘弹出、打字却什么都不显示。终端类输入不要指望它的隐藏 textarea，现在的做法是把那个 textarea 设成 `readOnly` + `inputmode="none"`（不再唤起会吞字的键盘），另给一条普通 `<input>` 输入条承接输入，见 `terminal-view.tsx`。
- 虚拟键盘弹出会触发容器尺寸变化；依赖 `ResizeObserver` 的组件（如 xterm 的 `fitAddon`）要能接住这种抖动，并跳过尺寸为 0 的回调（标签页隐藏时是 `display:none`）。
