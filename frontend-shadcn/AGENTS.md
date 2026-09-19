# frontend-shadcn/ 协作指引

根目录 `AGENTS.md` 的补充，仅在改动默认 Web 前端时适用。本目录是独立 Vite 项目：TypeScript + React + ES Modules，沿用目录内既有格式与工具链（根仓库的 CommonJS / 四空格约定不适用于此）。与 `lib/web/frontend/` 并存，不共用组件。

- 开发：`npm run dev:web-shadcn`；构建：`npm run build:web-shadcn`（产出单文件 `lib/web/frontend/shadcn.html`，随 `npm run prepack` 自动执行）。
- 测试：Vitest，用例与源码同目录（`*.test.ts` / `*.test.tsx`），`npm run test:web-shadcn` 运行，也随 `npm test` / `npm run test:unit` 自动执行。
- `/agent/stream` 的 NDJSON 事件协议是跨三处的契约，本目录涉及 `src/lib/api.ts` 的 `StreamEvent` 与 `workspace-panel.tsx` 的事件分支，改动须同步服务端与旧前端，详见 `lib/web/AGENTS.md`。
- 校验：`npm run typecheck`（`tsc --noEmit`）+ `npm run lint`（eslint），两条都不在根目录 `npm test` 里。lint 基线是 4 error + 2 warning 的既存问题（`app-sidebar`、`logs-dialog`、`markdown-content`、`workspace-panel`），以「数量没变多」为准，不要顺手去修无关文件。
- eslint 用的是 React Compiler 规则集：`react-hooks/set-state-in-effect`（effect 里直接 setState）和 `react-hooks/refs`（渲染期读 ref）都报 error。状态由外部 props 驱动、确实只能在 effect 里对账时，`eslint-disable-next-line` 要贴在 **setState 那一行**，贴在 `React.useEffect(` 上不生效。

## 组件地图

先按这张表定位，别从 `find src` 开始列文件：

- `App.tsx`：整体布局与跨面板状态（会话选择、未保存修改拦截 `confirmLeaveIfDirty`、主题）。
- `workspace-panel.tsx`（1300+ 行，中枢）：顶部标签页（活动/终端/文件/详情/配置/检查）切换与各视图挂载、消息流与 Composer、`/agent/stream` 事件分支、各类弹窗编排。中间工作台的改动基本都落在这里。
- `app-sidebar.tsx`（800+ 行）：容器 / AGENT 列表与增删改克隆，移动端形态是 `Sheet` 侧栏。
- `files-panel.tsx` + `code-mirror-editor.tsx`：文件浏览与编辑，切走标签前经 `confirmLeaveIfDirty` 拦一次未保存修改。
- `terminal-view.tsx`：xterm 终端面板，含按键条与移动端输入条。
- `html-preview-panel.tsx`：`Sheet` 里的沙箱 iframe 预览（`allow-scripts` 且不给 `allow-same-origin`）。
- 弹窗类：`system-settings-dialog` / `create-container-dialog` / `agent-template-dialog` / `model-dialog` / `logs-dialog` / `search-dialog` / `directory-picker-dialog` / `clone-name-dialog` / `prompt-dialog` / `quick-chat-setup-dialog`。
- 消息渲染：`markdown-content.tsx` / `trace-block.tsx` + `lib/markdown-render.ts` / `lib/sanitize.ts`。
- `lib/api.ts`：所有 HTTP 与流式调用的出口，`StreamEvent` 类型定义也在这里。
- `hooks/`：`use-mobile`（移动端断点）、`use-sessions`、`use-agent-recovery-poll`、`use-resizable-width`、`use-confirm-dialog`、`use-unsaved-changes-dialog`。
- `components/ui/`（26 个）：shadcn 原样组件，默认不改；要调样式先想能不能在调用处用 variant 解决。

## 移动端

手机访问是主要使用场景之一，新增或改动界面时默认要在窄屏下验证一遍：

- 断点统一走 `useIsMobile()`（768px），不要各处自己写 media query 判断。
- shadcn 的 `Sheet` / `Dialog` 默认样式是按桌面分栏设计的（`data-[side=right]:w-3/4`、`data-[side=right]:border-l` 等），移动端全屏时这些宽度和**边框**都要显式压制，否则贴在屏幕边缘的边框会变成一条莫名其妙的竖线。压制必须带同样的 `data-[side=*]:` 前缀才够特异性，裸的 `w-full` / `border-l-0` 会被盖掉；只想在桌面端保留时配 `sm:` 变体（媒体查询规则排在后面，能压住无条件规则）。参考 `html-preview-panel.tsx`。
- **xterm 在移动端接不住输入法**：合成阶段（候选词、联想）的内容不会进 `onData`，表现是键盘弹出、打字却什么都不显示。终端类输入不要指望它的隐藏 textarea，现在的做法是把那个 textarea 设成 `readOnly` + `inputmode="none"`（不再唤起会吞字的键盘），另给一条普通 `<input>` 输入条承接输入，见 `terminal-view.tsx`。
- 虚拟键盘弹出会触发容器尺寸变化；依赖 `ResizeObserver` 的组件（如 xterm 的 `fitAddon`）要能接住这种抖动，并跳过尺寸为 0 的回调（标签页隐藏时是 `display:none`）。

## 样式规范

遵循 shadcn skill 的通用规则（Skill 工具，名称 `shadcn`），此外项目内额外约束几条容易回归的问题：

- **hover / active 态必须肉眼可辨**：`index.css` 里 `--muted`/`--secondary`/`--accent` 与 `--background` 的 oklch lightness 差值曾经只有 0.005（背景改浅到 `oklch(0.975)` 但没跟着调这三个 token），导致 `ghost`/`outline`/`secondary` 变体的按钮、下拉菜单项、弹出面板选项在浅色主题下悬浮/选中几乎看不出变化。现状是三个 token 固定在 `oklch(0.93)`，与背景保持约 0.04 的差值——**改动这几个 CSS 变量或新增依赖它们的组件后，必须在浏览器里同时用亮色和暗色主题实测悬浮/选中态**，不能只看代码 diff 判断「应该能看见」。
- **不用 className 覆盖 `Button`/`Input` 等组件自带的内边距、字号**（例如手写 `py-*`、`text-*` 覆盖默认值）。需要不同大小时用已有的 `size` variant（`xs`/`sm`/`default`/`lg`/`icon*`）；确实缺档位就去 `buttonVariants`（或对应组件的 `cva` 定义）里加一档，不要在调用处零散覆盖——否则各处按钮粗细不一致，且下次升级 shadcn 组件版本时这些覆盖会被悄悄绕过。
- **`DialogContent` 是 `grid gap-4`，直接子元素之间才有间距**。表单类弹窗如果用 `<form>` 包住 `FieldGroup` + `DialogFooter`（提交需要整体在 `<form>` 里），`<form>` 本身会挡住这层 grid gap，字段和底部按钮栏会贴在一起——`<form>` 必须显式补 `className="flex flex-col gap-4"`。不需要 `<form>` 包裹时（`FieldGroup`/`DialogFooter` 直接作为 `DialogContent` 的子元素）不用管，gap 是自动的。参考 `prompt-dialog.tsx`、`create-container-dialog.tsx`、`clone-name-dialog.tsx`。
- **确认类弹窗（删除确认、未保存修改提示等）一律用 `Dialog`，不用 `AlertDialog`**：base-ui 的 `AlertDialog` 语义上要求必须点按钮才能关闭，默认不响应背景点击、`AlertDialogContent` 也没有右上角关闭按钮；本项目约定所有弹窗都可以背景点击 / 右上角 ✕ 关闭（等价于「取消」），因此统一用 `Dialog` + 手动的「取消」`Button`（`variant="outline"`，`onClick` 里做取消逻辑），不要用 `AlertDialogCancel`。参考实现见 `src/hooks/use-confirm-dialog.tsx`、`use-unsaved-changes-dialog.tsx`。
- 避免常驻高开销视觉效果：不要在常驻元素使用 `animation: ... infinite`，避免大面积叠加 `backdrop-filter` / `filter` 模糊；确需使用时仅限短时场景，并提供 `prefers-reduced-motion` 降级。
