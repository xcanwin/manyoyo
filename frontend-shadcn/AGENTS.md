# frontend-shadcn/ 协作指引

根目录 `AGENTS.md` 的补充，仅在改动默认 Web 前端时适用。本目录是独立 Vite 项目：TypeScript + React + ES Modules，沿用目录内既有格式与工具链（根仓库的 CommonJS / 四空格约定不适用于此）。与 `lib/web/frontend/` 并存，不共用组件。

- 开发：`npm run dev:web-shadcn`；构建：`npm run build:web-shadcn`（产出单文件 `lib/web/frontend/shadcn.html`，随 `npm run prepack` 自动执行）。
- 测试：Vitest，用例与源码同目录（`*.test.ts` / `*.test.tsx`），`npm run test:web-shadcn` 运行，也随 `npm test` / `npm run test:unit` 自动执行。
- `/agent/stream` 的 NDJSON 事件协议是跨三处的契约，本目录涉及 `src/lib/api.ts` 的 `StreamEvent` 与 `workspace-panel.tsx` 的事件分支，改动须同步服务端与旧前端，详见 `lib/web/AGENTS.md`。

## 样式规范

遵循 shadcn skill 的通用规则（Skill 工具，名称 `shadcn`），此外项目内额外约束几条容易回归的问题：

- **hover / active 态必须肉眼可辨**：`index.css` 里 `--muted`/`--secondary`/`--accent` 与 `--background` 的 oklch lightness 差值曾经只有 0.005（背景改浅到 `oklch(0.975)` 但没跟着调这三个 token），导致 `ghost`/`outline`/`secondary` 变体的按钮、下拉菜单项、弹出面板选项在浅色主题下悬浮/选中几乎看不出变化。现状是三个 token 固定在 `oklch(0.93)`，与背景保持约 0.04 的差值——**改动这几个 CSS 变量或新增依赖它们的组件后，必须在浏览器里同时用亮色和暗色主题实测悬浮/选中态**，不能只看代码 diff 判断「应该能看见」。
- **不用 className 覆盖 `Button`/`Input` 等组件自带的内边距、字号**（例如手写 `py-*`、`text-*` 覆盖默认值）。需要不同大小时用已有的 `size` variant（`xs`/`sm`/`default`/`lg`/`icon*`）；确实缺档位就去 `buttonVariants`（或对应组件的 `cva` 定义）里加一档，不要在调用处零散覆盖——否则各处按钮粗细不一致，且下次升级 shadcn 组件版本时这些覆盖会被悄悄绕过。
- **`DialogContent` 是 `grid gap-4`，直接子元素之间才有间距**。表单类弹窗如果用 `<form>` 包住 `FieldGroup` + `DialogFooter`（提交需要整体在 `<form>` 里），`<form>` 本身会挡住这层 grid gap，字段和底部按钮栏会贴在一起——`<form>` 必须显式补 `className="flex flex-col gap-4"`。不需要 `<form>` 包裹时（`FieldGroup`/`DialogFooter` 直接作为 `DialogContent` 的子元素）不用管，gap 是自动的。参考 `prompt-dialog.tsx`、`create-container-dialog.tsx`、`clone-name-dialog.tsx`。
- **确认类弹窗（删除确认、未保存修改提示等）一律用 `Dialog`，不用 `AlertDialog`**：base-ui 的 `AlertDialog` 语义上要求必须点按钮才能关闭，默认不响应背景点击、`AlertDialogContent` 也没有右上角关闭按钮；本项目约定所有弹窗都可以背景点击 / 右上角 ✕ 关闭（等价于「取消」），因此统一用 `Dialog` + 手动的「取消」`Button`（`variant="outline"`，`onClick` 里做取消逻辑），不要用 `AlertDialogCancel`。参考实现见 `src/hooks/use-confirm-dialog.tsx`、`use-unsaved-changes-dialog.tsx`。
- 避免常驻高开销视觉效果：不要在常驻元素使用 `animation: ... infinite`，避免大面积叠加 `backdrop-filter` / `filter` 模糊；确需使用时仅限短时场景，并提供 `prefers-reduced-motion` 降级。
