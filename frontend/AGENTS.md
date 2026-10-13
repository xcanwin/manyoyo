# frontend/ 协作指引

根目录 `AGENTS.md` 的补充，仅在改动默认 Web 前端时适用。本目录是独立 Vite 项目：TypeScript + React + shadcn/ui + ES Modules，沿用目录内既有格式与工具链（根仓库的 CommonJS / 四空格约定不适用于此）。它是 `serve` 唯一的 Web 界面。

- 开发：`npm run dev:web`；构建：`npm run build:web`（产出单文件 `lib/web/index.html`，随 `npm run prepack` 自动执行）。
- 发布控制台页面（维护者工具，不进用户界面）：入口 `release.html` + `src/release/`，`npm run build:release`（仓库根目录）构建成 `scripts/release/console.html`；服务端与说明见根目录 `AGENTS.md` 的 `scripts/release/` 一条。
- 测试：Vitest，用例与源码同目录（`*.test.ts` / `*.test.tsx`），`npm run test:web` 运行，也随 `npm test` / `npm run test:unit` 自动执行。
- `/agent/stream` 的 NDJSON 事件协议是跨前后端的契约，本目录涉及 `src/lib/api.ts` 的 `StreamEvent` 与 `workspace-panel.tsx` 的事件分支，改动须同步服务端，详见 `lib/web/AGENTS.md`。其中 `trace` 事件**不保证带结构化 `traceEvent`**（stderr、非 JSON 的 stdout 只有 `text`），一律先过 `toTraceEvent()` 兜底，别写 `if (event.traceEvent)` 这种会吞掉原始输出的分支。
- 校验：`npm run typecheck`（`tsc -b --noEmit`，必须带 `-b`：根 tsconfig 是 `files: []` 的 solution 配置，裸 `tsc --noEmit` 一个源文件都不会检查）+ `npm run lint`（eslint），两条都不在根目录 `npm test` 里。lint 基线是 4 error + 2 warning 的既存问题（`app-sidebar`、`logs-dialog`、`markdown-content`、`workspace-panel`），以「数量没变多」为准，不要顺手去修无关文件。
- eslint 用的是 React Compiler 规则集：`react-hooks/set-state-in-effect`（effect 里直接 setState）和 `react-hooks/refs`（渲染期读 ref）都报 error。状态由外部 props 驱动、确实只能在 effect 里对账时，`eslint-disable-next-line` 要贴在 **setState 那一行**，贴在 `React.useEffect(` 上不生效。

## 组件地图

先按这张表定位，别从 `find src` 开始列文件：

- `App.tsx`：整体布局与跨面板状态（会话选择、未保存修改拦截 `confirmLeaveIfDirty`、主题）。
- `workspace-panel.tsx`（1300+ 行，中枢）：顶部标签页（聊天/文件/终端/设置容器/容器详情/Agent详情）切换与各视图挂载、消息流与 Composer、`/agent/stream` 事件分支、各类弹窗编排。中间工作台的改动基本都落在这里。
- `app-sidebar.tsx`（800+ 行）：容器 / AGENT 列表与增删改克隆，移动端形态是 `Sheet` 侧栏。
- `files-panel.tsx` + `code-mirror-editor.tsx`：文件浏览与编辑，切走标签前经 `confirmLeaveIfDirty` 拦一次未保存修改。
- `terminal-view.tsx`：xterm 终端面板，含按键条与移动端输入条。
- `html-preview-panel.tsx`：`Sheet` 里的沙箱 iframe 预览（`allow-scripts` 且不给 `allow-same-origin`）。
- 弹窗类：`system-settings-dialog` / `create-container-dialog` / `agent-template-dialog` / `model-menu`（聊天输入框左下角的模型下拉，选项来自会话 env，CLI 内置目录后台补充）/ `logs-dialog` / `search-dialog` / `directory-picker-dialog` / `clone-name-dialog` / `prompt-dialog` / `quick-chat-setup-dialog`。
- 消息渲染：`markdown-content.tsx` / `trace-block.tsx` + `lib/markdown-render.ts` / `lib/sanitize.ts`。
- 执行过程（`trace-block.tsx`）：展开整段后“说明”默认展开、工具行标题下直接显示“描述”，命令 / 结果等点开那一行才显示；右侧三个按钮（对齐顶部 / 展开收起全部细节 / 对齐底部）。开合状态分两层：`mode`（默认 / 全展开 / 全收起）和用户手动开合过的行（`rowOverrides`，key 是 `kind:toolId` 或 `kind-序号`，新事件到来不会改回默认）。每行顺序：描述 → 工具 → 工具参数（Agent 调用工具时传的参数，`compactToolArguments` 单行 `键=值`，点一下看全文）→ 命令 → 结果 / 错误。
- 聊天自动滚动（`workspace-panel.tsx` 的 `ChatView` + `lib/chat-behavior.ts` 的 `shouldFollowBottom`）：内容更新后只有**更新之前视野就贴着底部**、用户没往上翻、最近 1.5 秒没有滚轮 / 触摸 / 点击 / 按键、没有选中文字时才跟随到底。只看“有没有往上翻过”不够：展开很长的执行过程后视野停在过程顶部，没有任何滚动事件，旧逻辑会把人一次次拉到底（B1 的根因，真实浏览器复现：scrollTop 0 → 2655）。展开 / 收起某一行、懒加载补全内容不能让视野里的内容跳。
- `lib/api.ts`：所有 HTTP 与流式调用的出口，`StreamEvent` 类型定义与会话/trace 相关纯函数也在这里。
- `lib/sync-scheduler.ts`：同步调度纯函数。`decideSyncDelay`（有焦点 6s / 没焦点 30s / 隐藏或空闲 10 分钟暂停）、`createSingleFlight`（单飞）、`createCoalescer`（visibilitychange 与 focus 300ms 合并）。
- `lib/message-sync.ts`：`/messages` 增量同步的纯函数——page / tail / reset / before 的合并、稳定前缀 anchor、内容没变的消息复用原对象（DOM 不重建）、流结束后用最近一页对账（`reconcileWithPage`）、trace 按需加载的缓存键与 LRU。
- `lib/composer-store.ts`：提示词本地草稿与待发箱（`manyoyo:composer:<会话名>`，localStorage 不可用时静默降级）。发送前同步写待发箱（`lib/send-flow.ts` 的 `beginSend`），收到 `meta` 才清；发送失败后先分类（`classifySendError`）：有 HTTP 状态码是明确拒绝，立刻放回输入框（输入框非空时不覆盖，给“恢复”入口）；**网络错误先向服务端对账再放回**（`resolveFailedSend`：找到同一个 clientId 就是已发出，不放回；对账也失败就保留待发箱并提示“暂时无法确认”，恢复联网后由同步里的 `checkOutbox` 自动判定）；放回的内容原样重发沿用原 clientId（服务端按它去重，返回 409 `duplicate:true`），改动过才换新的；`clearAllComposerData` 供登出清空（目前前端没有登出入口，加入口时要调用它）。
- `lib/terminal-resize.ts`：终端 fit 后列数/行数变化的防抖上报（`{type:'resize',cols,rows}`）、容器尺寸为 0 不建连。
- `lib/format.ts`：时间与体积的统一格式化（`formatDateTime` 固定 zh-CN 24 小时制 `MM/DD HH:mm`、`formatBytes`）。新增展示时间/体积的地方一律用它，别再各写一个 `toLocaleString()`。
- `hooks/`：`use-mobile`（移动端断点）、`use-sessions`、`use-agent-recovery-poll`（页面隐藏时不发请求，可见后立刻补一次，退避计数不清零）、`use-resizable-width`、`use-confirm-dialog`、`use-unsaved-changes-dialog`。
- `components/ui/`（26 个）：shadcn 原样组件，默认不改；要调样式先想能不能在调用处用 variant 解决。

## 保存不覆盖别人的修改

- **系统设置对话框保存的是打开时读到的整份配置文本**，`PUT /api/config` 带 `If-Match`（`GET` 的 `etag`）。弹窗里的子面板（快捷对话、软件源）自己直接写配置文件，**必须接 `onSaved` 走 `handleSubPanelSaved`**（把最新内容和版本号接过来，用 `lib/config-rebase.ts` 的 `rebaseLeafEdits` 重放自己改过的字段）；不要再写只合并个别字段的对症代码（`c322c4b` 的 `syncQuickChatIntoRaw` 就是这样，漏掉了软件源和“键不存在”的情况，已删除）。保存遇到 409：表单模式自动在最新内容上重放并最多重试一次，字段两边都改了以我的为准并在提示里写字段名；JSON 文本模式不自动处理，给“重新加载（放弃我的修改）/仍然保存（覆盖对方的修改）”两个按钮。测试在 `system-settings-dialog.test.tsx`，用假 fetch 模拟服务端文件状态（`FAKE_SERVER_LEGACY=1` 可模拟改版前的服务端复现原始问题）。
- 文件面板读取时记下 `etag`，保存带 `If-Match`，409 显示“文件已在容器里被修改”+“重新加载 / 仍然保存”（“仍然保存”先取最新的 etag 再写），样式沿用容器管理页环境变量冲突提示。

## 同步请求

- **同步请求必须经过单飞（`createSingleFlight`，会话级封装在 `hooks/use-session-sync.ts`，定时与事件调度在 `hooks/use-sync-loop.ts`，都有 jsdom 用例），主动触发不能丢**：定时触发（`manual=false`）遇到在途请求直接跳过；发送结束、停止、切回页面这类主动触发（`manual=true`）遇到在途请求要排队、结束后补跑恰好一次。只跳过不补会漏掉“流结束后立刻对账”那一次，表现是界面停在半途状态。`/messages` 与 `/detail` 共用一个按会话创建的单飞实例，切换会话时 `abort()`；`/api/sessions` 刷新（`use-sessions`）同理。
- 定时器用 `setTimeout` 链（上一轮结束后才排下一轮），不要用 `setInterval`：慢网下会堆积请求。
- 消息合并以服务端契约为准（稳定前缀不可修改、`epoch` 变了整体重拉），细节见 `lib/web/AGENTS.md`；新增会改历史前缀的前端动作前先想清楚会不会让 tail 合并显示旧内容。

## 移动端

手机访问是主要使用场景之一，新增或改动界面时默认要在窄屏下验证一遍：

- 断点统一走 `useIsMobile()`（768px），不要各处自己写 media query 判断。
- shadcn 的 `Sheet` / `Dialog` 默认样式是按桌面分栏设计的（`data-[side=right]:w-3/4`、`data-[side=right]:border-l` 等），移动端全屏时这些宽度和**边框**都要显式压制，否则贴在屏幕边缘的边框会变成一条莫名其妙的竖线。压制必须带同样的 `data-[side=*]:` 前缀才够特异性，裸的 `w-full` / `border-l-0` 会被盖掉；只想在桌面端保留时配 `sm:` 变体（媒体查询规则排在后面，能压住无条件规则）。参考 `html-preview-panel.tsx`。
- **xterm 在移动端接不住输入法**：合成阶段（候选词、联想）的内容不会进 `onData`，表现是键盘弹出、打字却什么都不显示。终端类输入不要指望它的隐藏 textarea，现在的做法是把那个 textarea 设成 `readOnly` + `inputmode="none"`（不再唤起会吞字的键盘），另给一条普通 `<input>` 输入条承接输入，见 `terminal-view.tsx`。
- 虚拟键盘弹出会触发容器尺寸变化；依赖 `ResizeObserver` 的组件（如 xterm 的 `fitAddon`）要能接住这种抖动，并跳过尺寸为 0 的回调（标签页隐藏时是 `display:none`）。
- 贴着屏幕底边的栏（composer、终端输入条、侧栏底部按钮）内边距写成 `pb-[max(<原值>,env(safe-area-inset-bottom))]`：`index.html` 的 viewport 带 `viewport-fit=cover`，加到主屏幕全屏运行时不避让会被 home 指示条压住；桌面端 `env()` 取 0，等价于原值。

## 样式规范

遵循 shadcn skill 的通用规则（Skill 工具，名称 `shadcn`），此外项目内额外约束几条容易回归的问题：

- **hover / active 态必须肉眼可辨**：`index.css` 里 `--muted`/`--secondary`/`--accent` 与 `--background` 的 oklch lightness 差值曾经只有 0.005（背景改浅到 `oklch(0.975)` 但没跟着调这三个 token），导致 `ghost`/`outline`/`secondary` 变体的按钮、下拉菜单项、弹出面板选项在浅色主题下悬浮/选中几乎看不出变化。现状是三个 token 固定在 `oklch(0.93)`，与背景保持约 0.04 的差值——**改动这几个 CSS 变量或新增依赖它们的组件后，必须在浏览器里同时用亮色和暗色主题实测悬浮/选中态**，不能只看代码 diff 判断「应该能看见」。
- **不用 className 覆盖 `Button`/`Input` 等组件自带的内边距、字号**（例如手写 `py-*`、`text-*` 覆盖默认值）。需要不同大小时用已有的 `size` variant（`xs`/`sm`/`default`/`lg`/`icon*`）；确实缺档位就去 `buttonVariants`（或对应组件的 `cva` 定义）里加一档，不要在调用处零散覆盖——否则各处按钮粗细不一致，且下次升级 shadcn 组件版本时这些覆盖会被悄悄绕过。
- **`DialogContent` 是 `grid gap-4`，直接子元素之间才有间距**。表单类弹窗如果用 `<form>` 包住 `FieldGroup` + `DialogFooter`（提交需要整体在 `<form>` 里），`<form>` 本身会挡住这层 grid gap，字段和底部按钮栏会贴在一起——`<form>` 必须显式补 `className="flex flex-col gap-4"`。不需要 `<form>` 包裹时（`FieldGroup`/`DialogFooter` 直接作为 `DialogContent` 的子元素）不用管，gap 是自动的。参考 `prompt-dialog.tsx`、`create-container-dialog.tsx`、`clone-name-dialog.tsx`。
- **确认类弹窗（删除确认、未保存修改提示等）一律用 `Dialog`，不用 `AlertDialog`**：base-ui 的 `AlertDialog` 语义上要求必须点按钮才能关闭，默认不响应背景点击、`AlertDialogContent` 也没有右上角关闭按钮；本项目约定所有弹窗都可以背景点击 / 右上角 ✕ 关闭（等价于「取消」），因此统一用 `Dialog` + 手动的「取消」`Button`（`variant="outline"`，`onClick` 里做取消逻辑），不要用 `AlertDialogCancel`。参考实现见 `src/hooks/use-confirm-dialog.tsx`、`use-unsaved-changes-dialog.tsx`。
- 避免常驻高开销视觉效果：不要在常驻元素使用 `animation: ... infinite`，避免大面积叠加 `backdrop-filter` / `filter` 模糊；确需使用时仅限短时场景，并提供 `prefers-reduced-motion` 降级。

## 界面一致性与自查

功能对、截图能用，不等于界面合格：上一轮容器管理页被人工纠正了十几处，全是一致性问题。新增或改动界面按下面做：

- **先找同页已有范式再写新控件**：字段标签（加粗 label）；一行一项的列表编辑一律用 `RowList`（表头 + 每行输入 + 删除 + 下方添加 + 页脚保存）；卡片标题加粗、保存按钮放带底色的页脚；折叠区与既有字段标签同样式（`SectionToggle` / `denied-list.tsx` 的写法），默认收起。
- **同类控件只用一个组件**；不发明复合文本语法（比如把“端口/协议”塞进一个输入框），拆成独立输入框和下拉。
- **模块顺序按依赖关系排**；与已有字段语义重叠时先合并概念再做界面（别让两套 env 并存）。
- **提示文字**：一句话、通俗、先说结果再说做法；按部署场景（本机 / 局域网 / 公网服务器）检查措辞。
- **自查流程**：亮 / 暗主题 × 桌面 / 390px 手机宽度各截一张，与同页已有控件并排对比（标签粗细、对齐、按钮位置与尺寸、页脚、折叠区、文案长度）；再派一个只看截图和本节规则的子 agent 审查；问题清零再交付。
