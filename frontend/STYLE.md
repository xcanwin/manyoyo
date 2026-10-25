# 前端样式规范（frontend/）

本项目网页界面的**唯一样式规范**。新增或改动任何界面前先读这一页；改完按第 15 节自查。规范没写到的冷门情况，按 shadcn 的默认做法处理；同一种写法第二次出现时补进本页。

标 **〔待建〕** 的条目，基础组件还不支持；补齐之前按条目里的意思就近实现，补齐后删掉标记（只删标记，不改条目）。

本项目用的是 base-ui 版的 shadcn（`components.json` 的 style 是 `base-nova`），通用规则见 shadcn skill（Skill 工具，名称 `shadcn`）。本页只写本项目的决定，以及和 shadcn 默认做法不同的地方。

---

## 1. 三条总原则
1. **组件优先**：shadcn 有的组件和 variant 就用它（`Field`、`Card`、`Badge`、`Alert`、`Skeleton`、`Separator`、`ToggleGroup`……，`Table`、`Empty` 已装），不手写长得像它们的 `div`。
2. **`className` 只管布局**：只写间距、栅格、宽度、显示与隐藏；**不写颜色、字号、字重、行高、高度、内边距**去覆盖组件自带的样式。需要不同大小用 `size` variant；缺档位就去组件的 `cva` 里加一档，不在调用处零散覆盖。
3. **同类长得一样**：同一种信息（字段标签、说明、状态、时间、路径、操作按钮）在所有页面、弹窗里用同一个组件、同一种写法。写新界面前先看同类界面现在怎么写的。

## 2. 字号与字重（界面字只有这几档）

| 档 | 用途 | 大小 / 字重 / 颜色 | 用什么 |
|---|---|---|---|
| 标题 | 弹窗、侧板、整页的标题 | 16px / 500 | `DialogTitle`、`SheetTitle`；整页标题用 `PageHeader` |
| 区块标题 | 卡片、设置分组、表单分节、折叠区的标题 | 14px / 600 | `CardTitle`（默认 14px/600）；表单分节用 `FieldLegend variant="label"`（`ui/field.tsx` 本地修改为 600）；折叠区用 `SectionToggle` |
| 正文 | 正文、字段标签、按钮、输入框、下拉、表格单元、菜单项 | 14px；标签和按钮 500，其余 400 | 组件默认值（`Label`、`FieldLabel`、`Button`、`SelectItem` 都已是 14px） |
| 副标题 | 弹窗 / 侧板标题下面那句说明、提示条的正文 | 14px / 400，灰色 | `DialogDescription`、`SheetDescription`、`AlertDescription` |
| 表头 | 表格、可编辑行的列名 | 12px / 600，前景色（不用灰色） | `DataTable`、`ColumnHeader` |
| 辅助 | 字段说明、徽章、提示气泡、配置键、时间戳、计数、“（可选）” | 12px / 400，灰色 | `FieldDescription`、`CardDescription`、`Badge`、`Tooltip`、`Hint`（`Hint` 带 `font-normal`，放进加粗的标签里也保持 400） |

- **没写字号的文字默认 14px**：`index.css` 的 `@layer base` 给 `body` 设了 `text-sm`。去掉调用处的 `text-sm` 之前确认它在 body 之下，不在 `<pre>` 等自带字号的元素里。
- **手机上的输入框、下拉、文本域是 16px**（`text-base md:text-sm`，已写在 `ui/input|textarea|select`）：iOS 聚焦小于 16px 的输入框会自动放大整页。这是唯一允许“同一控件手机比桌面大”的地方，别的地方不要模仿。
- **内容区不受上表限制**。它们是“被展示的内容”，不是界面文字，各自沿用登记的数值：
  - 聊天正文：markdown，14px
  - 代码块、diff、日志行、文件编辑器、终端：等宽 12～13px
  - 执行过程说明：`trace-block.tsx` 的 `NARRATION_TEXT`

  新增内容区组件时，把用到的数值作为常量写在组件文件里，并补进本节。
- **调用处禁止**写 `text-xs`、`text-sm`、`text-base`、`text-[..px]`、`font-medium`、`font-semibold`、`leading-*`。12px 灰色说明用 `Hint`；区块标题用 `CardTitle` 或 `FieldLegend`。
- 等宽字只加 `font-mono`，不再另写字号：配置键、路径、地址、命令、哈希、Key 末 4 位都是等宽。

## 3. 颜色
- **只用语义 token**：`bg-background`、`bg-muted`、`text-muted-foreground`、`text-destructive`、`border-border` 等。不写 `emerald-600`、`red-400` 这类原色，也不写 `dark:` 颜色覆盖。
- **状态颜色**（`index.css` 的 `--success` / `--warning` token，`Badge`、`Alert` 的 `success` / `warning` variant）：
  - 成功 / 可用 / 运行中 = success
  - 警告 / 需要注意 / 未验证 = warning
  - 失败 / 错误 / 危险操作 = destructive
  - 中性信息 = secondary / muted

  现有的 `emerald`、`amber`、`red` 原色都要换成这些 token。
- 悬停、选中态必须肉眼可辨：悬停前后、选中与背景的亮度差（oklab L）**至少 0.03**，亮色、暗色主题都要达到。`--muted` / `--secondary` / `--accent` 固定在 `oklch(0.93)`；用 `bg-muted` 做悬停底色时透明度**不低于 70**（`hover:bg-muted/70`，亮色下 `/60` 只有 0.027、`/50` 只有 0.024，不够），守卫的 `hover-weak` 规则会拦。改这几个变量后，必须在两种主题下实测。

## 4. 间距、尺寸与圆角
- **间距只用三档**：
  - `gap-2`（8px）：同一组控件之间、图标与文字之间、按钮之间；
  - `gap-4`（16px）：字段之间、卡片内各块之间、弹窗内各块之间；
  - `gap-6`（24px）：页面上的大区块之间。

  一律用 `flex` / `grid` 加 `gap-*`，不用 `space-x-*` / `space-y-*`。
  - 小于 8px 的 `gap-0.5` / `gap-1` / `gap-1.5` 只用在**一个复合元素内部**：标题和它的说明叠放、图标和文字、一组徽章。控件与控件之间、字段与字段之间不用。
- **控件高度**统一为 32px：`Input`、`SelectTrigger`、`Button`（default）、`Toggle`、`TabsList` 默认都是 32px。
  - 紧凑场景（表格行内、工具栏）用 `sm`（28px）；`xs`（24px）只用于表格行内的图标小按钮。
  - **同一行里的控件高度必须相同**：输入框旁边的按钮用 default，不用 sm。
- **宽度**：表单里的 `Input`、`Textarea`、`SelectTrigger` 一律 `w-full`，跟随字段宽度。`SelectTrigger` 默认是 `w-fit`，在表单里必须写 `w-full`。工具栏里的下拉可以 `w-fit`。
- 圆角、阴影、边框用组件自带的；同宽同高写 `size-*`；截断写 `truncate`。
- **滚动区**：内容和滚动区左右边缘各留 16px，滚动条贴着外框，不贴着内容。弹窗里用 `DialogBody`；自己写的滚动区照它的写法：负外边距抵掉父级内边距，再用同样的内边距补回来（`-mx-4 px-4`）。原因：画在盒子外面的描边（`ring`、`outline`、阴影）贴着滚动区边缘时会被 `overflow` 切掉一边，滚动条也会贴着内容。放在页面里的块状组件（卡片等）描边一律用 `border`，不用 `ring`（`ui/card.tsx` 已改）；`ring` 只留给浮层和焦点态。

## 5. 表单（页面和弹窗通用）
- **结构**：`FieldGroup` > `Field` > `FieldLabel` + 控件 + `FieldDescription`（说明在控件下面）。不要用裸 `div` + `Label` 拼。分节用 `FieldSet` + `FieldLegend`。
- **标签**：
  - 只用 `FieldLabel`（或 `Label`），不用 `span`、`div` 自己写字号字重。
  - 标签在控件上方；只有开关（`Switch`）和复选框用水平布局：`Field orientation="horizontal"`，标签在左、开关在右。
  - 用户自己填的数据（环境变量名、规则里的域名）不是“标签”，原样用等宽字显示即可；常见的变量名（`ANTHROPIC_BASE_URL` 等）在 `lib/config-labels.ts` 登记中文名后，按“中文名 + 等宽键名”显示。
  - **标签写中文**；需要露出配置键时，在标签右边加灰色 12px 等宽的键名（沿用 `create-container-dialog.tsx` 的 `KeyLabel`、`lib/config-labels.ts` 的中文名登记）。不要直接拿 `containerName` 这类英文键当标签。
  - 可选字段在标签后加 `（可选）`，用辅助档字号。必填不加星号：默认就是必填，或者说明里写清楚。
- **占位符**只写示例值（`例如 https://api.deepseek.com`），不写操作说明。说明放 `FieldDescription`。
- **校验**：`Field` 上加 `data-invalid`，控件上加 `aria-invalid`，错误文字用 `FieldError`（或灰色 `FieldDescription` 换成错误内容）。不用另外的红字 `div`。
- **布局**：默认一列；桌面端只有成对的短字段（端口 + 协议、名称 + 版本）才并排两列；手机端一律单列。
- **选项**：2～5 个短选项用 `ToggleGroup`，更多用 `Select`，可搜索的用 `Command`。**每个选项带一句说明**的单选（向导里的“选 Agent”“接入方式”）用选项卡片：`role="radio"` + `aria-checked` 的按钮组（沿用 `setup-wizard.tsx` 的写法），不用 ToggleGroup。
- **模块顺序**按依赖关系排（先选 Agent 再填 Key）；和已有字段语义重叠时，先合并概念再做界面（别让两套 env 并存）。
- **列表编辑**（一行一项的 env、规则等）一律用 `RowList`：表头 + 每行输入 + 删除 + 下方添加 + 页脚保存。不要发明“端口/协议塞进一个输入框”这类复合文本语法。
- **保存按钮的位置**：
  - 弹窗：放 `DialogFooter`；
  - 页面里的卡片：放带底色的 `CardFooter`；
  - 整页表单：放底部固定栏（`StickyFooter`）。

## 6. 按钮与图标
- 用 `variant` 表达语义：主操作 `default`；次要 `outline`；工具栏、行内 `ghost`；危险 `destructive`；文字链接 `link`。**一个区域只有一个主操作**。
- 大小只用 `size`：`default` / `sm` / `xs` / `lg` / `icon` / `icon-sm` / `icon-xs` / `icon-lg` / `icon-xl`。
- 图标用 lucide；按钮里的图标加 `data-icon="inline-start|inline-end"`，**不给图标写尺寸 class**。
- **只有图标的按钮**必须有 `aria-label` 和 `title`（或 `Tooltip`）。测试按 `aria-label` 找按钮，改名要同步测试。
- **加载中**：`Spinner` + `disabled`，按钮文字不变或改成“正在…”。
- **底栏按钮的顺序**：主操作在最右，“取消”（`outline`）在它左边，危险操作单独放最左或放进确认框。手机上 `DialogFooter` 是整行宽、上下排列，不要覆盖它。

## 7. 页面布局（文件、终端、改动、设置容器、详情等主视图）
- **结构**：顶部工具栏 → 内容区。
  - 工具栏：左边是区块标题档的标题，右边是 `sm` / `icon-sm` 按钮，底部一条分隔线，高度 40px。
  - 内容区：内边距桌面 `p-4`、手机 `p-3`；大区块之间 `gap-6`。
- **页面内容宽度三档**（都靠左对齐）：只有字段的表单类页面 `max-w-2xl`；字段里夹着可编辑行或小表格的页面（设置容器）`max-w-5xl`；表格、列表类页面占满宽度。系统设置右侧内容区同样按这三档。
- **只读的“名称：值”信息**（容器详情、Agent 详情）一律用 `KeyValueList`：桌面两列（标签用辅助档、值用正文），手机单列。
- **卡片**：用完整结构 `CardHeader` / `CardTitle` / `CardDescription` / `CardAction` / `CardContent` / `CardFooter`，不要把所有内容都塞进 `CardContent`。卡片之间 `gap-4`。不要卡片套卡片。
- **折叠区**：每块上方一条分割线，标题行悬停 `hover:bg-muted`，默认收起；展开态不另加背景或描边（沿用 `SectionToggle` / `denied-list.tsx` 的写法）。
- **可点的列表项、导航**（系统设置左栏、侧栏）：
  - 选中：`bg-muted` 底色，不用竖线；
  - 未选中悬停：`hover:bg-muted/70`；
  - 三种状态肉眼可辨。

## 8. 弹层：选择与尺寸

| 场景 | 组件 | 尺寸 |
|---|---|---|
| 确认、单个输入（删除确认、改名） | `Dialog` | `sm` · 384px |
| 简短表单（2～6 个字段） | `Dialog` | `md` · 448px（默认） |
| 较长表单、分步表单（新建容器、编辑模型服务、回退） | `Dialog` | `lg` · 576px |
| 管理类、数据多（系统设置、磁盘占用、模型服务、日志、容器状态、目录内容） | `Dialog` | `wide` · `min(96vw, 80rem)` × `85dvh` |
| 边看边用的预览、手机侧栏 | `Sheet` | 沿用现状 |
| 一次性结果 | `toast`（`components/ui/sonner.tsx`） | — |
| 持续状态（校验、断线、风险、需要修复） | `Alert`，就地显示 | — |
| 操作入口很多的“更多” | `DropdownMenu` | — |
| 解释性的小提示 | `Tooltip`（只放一句话；内容是可交互的就用 `Popover`） | — |

- `DialogContent` 只用 `size` 选档。调用处**禁止**再写 `max-w-*`、`w-[..]`、`h-[..vh]`。
- **弹窗的结构**：`DialogHeader`（标题 + 副标题；宽窗口右侧可放工具按钮）→ 主体 → `DialogFooter`。主体太长时只让主体滚动，标题和底栏固定（`DialogBody`：`min-h-0 flex-1 overflow-y-auto`）。
- `DialogContent` 是 `grid gap-4`：用 `<form>` 包住字段和底栏时，`<form>` 要写 `flex flex-col gap-4`，否则间距会消失。
- **底栏只放和当前内容有关的操作**：内容自己会保存的（模型服务、磁盘占用、快捷对话等子面板，操作立即生效），不显示外层的“保存 / 重新加载”底栏；底栏按钮超过两个时，次要的收进 `⋯` 菜单或移到页头。手机上底栏最多一个整行的主按钮，“重新加载”“显示 JSON 设置”这类次要操作收进页头的 `⋯`。**有未保存的修改时**（例如在表单分类里改了字段、再切到自保存分类），外层底栏照常显示，保存成功后再收起，不能让修改悬着、找不到保存入口。
- **系统设置固定用 `wide`**，不随分类变宽变窄：左侧分类栏宽度固定；右侧内容区按第 7 节的三档宽度。
- **确认类一律用 `Dialog`，不用 `AlertDialog`**：所有弹窗都能点遮罩、点右上角 ✕ 关闭，等价于“取消”。参考 `hooks/use-confirm-dialog.tsx`。
- **每个弹窗、侧板都必须有标题**。视觉上不需要时，用 `className="sr-only"` 的 `DialogTitle`。

## 9. 遮罩与多层弹窗
- `Dialog`、`Sheet`、`AlertDialog` 用**同一种遮罩**：`bg-black/40`，支持时加 `backdrop-blur-sm`（4px）；淡入淡出，`motion-reduce` 下不做动画（三个 `ui/*.tsx` 共用 `ui/overlay-class.ts`）。
- **多层弹窗下层也要虚化**：base-ui 的嵌套弹窗默认不渲染遮罩（`DialogBackdrop` 的 `forceRender` 默认为 `false`），`ui/dialog.tsx` 已让嵌套弹窗也渲染遮罩，并让被盖住的父弹窗轻微缩小、变暗（`data-nested-dialog-open`），层级一眼可见。调用处什么都不用写。
- **最多两层**。需要第三层时，改成在第二层里分步进行，或者用就地展开的区域。
- **手机上的侧栏（`Sheet`）也算一层**：从手机侧栏里打开弹窗时，先收起侧栏再打开弹窗，这样后面最多还能再叠一层。
- 点遮罩、按 Esc 只关最上面一层。
- 模糊只用在遮罩上（弹窗开着时才存在）。常驻元素不用 `backdrop-filter`，也不用无限循环的动画。

## 10. 表格与列表
- **只读的数据列表**一律用 `DataTable`（`components/data-table.tsx`，基于 shadcn `Table`）：
  - 表头：12px，**黑色加粗**（前景色 + 600，不用灰色），不透明灰底（`bg-muted`），在滚动区里吸顶。可编辑行（`RowList`、规则表、环境变量表）的表头用 `ColumnHeader`，同样 12px 黑色加粗。
  - 行：正文，单行约 40px，悬停 `bg-muted/70`；可点的行整行可点，并且能用键盘聚焦。
  - 对齐：文字和数字**一律左对齐**，操作列靠右、固定宽度。
  - 长内容：路径、地址、配置名用 `font-mono` + `truncate`，完整内容放 `title`。
  - 时间、体积一律用 `lib/format.ts`。
  - 状态：用 `Badge` 的语义 variant（见第 3 节），不用彩色文字。
  - 操作：图标按钮 `icon-sm`（带 `aria-label`）。超过 3 个操作就收进 `⋯` 菜单；删除放最后，并且要确认。
  - 空状态：`Empty`（一句说明加主操作）。加载中：`Skeleton` 占 3 行。不要只写一句灰字。
- **可编辑的行**（env、网络规则）用 `RowList`，表头和行高与 `DataTable` 一致。
- **手机端（< 768px）表格变成卡片列表，不横向滚动**：
  - 每行一张卡片：标了 `primary` 的列是卡片标题，其余列显示成“辅助档标签：正文值”的两列网格，操作按钮放在卡片底部一行；
  - 列可以标 `mobile: "hidden"`，在手机上不显示。

  这些由 `DataTable` 统一处理，调用处不写手机分支。

## 11. 反馈与状态
- **一次性结果**（已保存、已复制、已删除）：`toast`，一句话。
- **同一处有多条同类提示**（例如几条“可以一键添加”）合并成一个 `Alert`，里面逐行列出，每行带自己的按钮；不要一条一个框堆起来。
- **持续状态**（校验错误、断线、需要修复、风险提示）：就地放 `Alert`。默认中性；错误用 `destructive`；警告、成功用 `warning` / `success`。可操作的提示把按钮放进 `AlertAction`。
- **原始报错**（request_id、堆栈、URL）不直接给用户看：先显示一句人话，原文收进可展开的“详情”（沿用模型服务测试失败的写法），用等宽辅助档。
- **加载**：整块内容用 `Skeleton`，按钮里用 `Spinner`。超过 300ms 才显示，避免闪一下。
- **空状态**：用 `Empty`。

## 12. 手机端（< 768px，一律用 `useIsMobile()` 判断）
- **弹窗**：
  - `sm` / `md`：居中，左右各留 16px；
  - `lg` / `wide`：**全屏**（贴满屏幕、无圆角、高 `100dvh`），标题栏和底栏固定，底栏避让安全区；
  - 这些由 `DialogContent` 的 `size` 自动处理。
- **侧板**（`Sheet`）全屏时，要用带 `data-[side=*]:` 前缀的写法压掉默认的宽度和边框，否则屏幕边缘会留一条竖线（参考 `html-preview-panel.tsx`）。
- **系统设置**：左侧分类栏变成顶部的分类下拉，内容区占满。
- **表格**变卡片（见第 10 节）；表单一律单列；工具栏放不下的按钮收进 `⋯` 菜单。
- **可点区域至少 40px**：手机上独立的图标按钮用 `icon-xl`（40px）；用 `icon-lg`（36px）时要加 `touch-hit`。嵌在文字行或表格行里、不方便放大的小按钮（`icon-xs` / `icon-sm`），视觉尺寸不变，用 `index.css` 的 `touch-hit` 工具类把点击区域扩到 40px（`relative` + `after:` 伪元素向外延伸）。**相邻两个带 `touch-hit` 的按钮之间至少 `gap-3`（12px）**，否则点击区域会重叠。
- **可点的图标一律用 `Button` 的 icon 档**（`icon-xs` 起），不用原生 `<button>` 套一个 16px 图标（消息下面的“复制”已改），否则点击区域怎么扩都不够 40px。
- **贴底的栏**（composer、终端输入条、弹窗底栏、侧栏底部）：内边距写成 `pb-[max(<原值>,env(safe-area-inset-bottom))]`。
- 输入框 16px（见第 2 节）。
- 同一行里混排等宽小字和正文、或者混排 `⌘` 这类回退字体字符时，都加 `leading-none`，父级 `items-center`，否则看起来上下偏。

## 13. 文字
- 一句话，通俗，先说结果再说做法；按部署场景（本机 / 局域网 / 公网服务器）检查措辞。
- 界面上不出现环境变量名和内部术语。变量名到人话的对照登记在 `EXTRA_ENV_LABELS` 一类的表里；配置键只作为辅助档的等宽小字出现。
- 同一个概念全站用同一个词。新词先查有没有现成的叫法：容器、AGENT、运行配置、模型服务、快捷对话、工作目录。

## 14. 例外（可以不完全遵守本页）
- 内容区：聊天消息、执行过程、终端、文件编辑器、diff，按第 2 节登记的数值。
- 命令面板 `search-dialog.tsx`：shadcn `Command` 的标准结构（`p-0`、`gap-0`）。
- 登录页、首次配置向导：整页布局，标题可以更大，但表单部分仍按第 5 节。
- 发布控制台（`src/release/`）：维护者工具，不在本规范范围内。

## 15. 自查（每次改界面都做）
1. **同类对比**：先打开同类界面，对齐标签、字号、按钮位置与尺寸、底栏、折叠区。
2. **截图**：亮 / 暗主题 × 1280 / 390 宽度各一张，与改前并排比较。
3. **量字号**：用 CDP 遍历文字节点，取 `getComputedStyle().fontSize`，不在第 2 节几档内、又不是登记过的内容区的，都要修。
4. **守卫测试**：`frontend/src/style-guard.test.ts` 会拦下：调用处给弹窗写宽高、手写 `<table>`、白名单以外的手写字号和原色。
5. **审查**：较大的界面改动，派一个只看截图和本页的子 agent 审查，问题清零再交付。
