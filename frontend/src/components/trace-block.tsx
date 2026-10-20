import * as React from "react"
import {
  CheckIcon,
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  AlignLeftIcon,
  CircleDotIcon,
  CircleIcon,
  CircleCheckIcon,
  CopyIcon,
  BotIcon,
  MessageSquareIcon,
  OctagonAlertIcon,
  PlugIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  apiGet,
  buildTaskList,
  buildToolArgumentParts,
  buildTraceTree,
  MAX_TRACE_INDENT_DEPTH,
  type TaskItem,
  type TraceNode,
  compactToolArguments,
  formatTraceRowTitle,
  mergeToolTraceEvents,
  traceRowDescription,
  summarizeTraceFlow,
  type ChatMessage,
  type TraceEvent,
} from "@/lib/api"
import { buildTraceUrl, createLruCache, traceCacheKey } from "@/lib/message-sync"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

// 执行过程的对齐按钮发给消息流的事件（detail: { edge: "top" | "bottom", key }），由消息流滚动并设置锚点
export const TRACE_ALIGN_EVENT = "manyoyo:trace-align"

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  tool: WrenchIcon,
  command: TerminalIcon,
  mcp: PlugIcon,
  subagent: BotIcon,
  agent_message: MessageSquareIcon,
  error: OctagonAlertIcon,
}

// compact：只给“工具参数”用——单行 键=值，点一下展开全文（value 是缩进好的全文）
type BodyPart = { label: string; value: string; compact?: string }

// 列表里的 trace 长字段被服务端截断过（traceTruncated）：展开时才按需下载完整内容，按消息缓存最近一份完整版。
// 任务还在跑、列表里又多了事件时，显示“完整版 + 列表里新增的事件”，不回退成截断版、不闪“正在加载”
//（旧做法按事件数做缓存键，每来一个事件就在两种内容之间来回切，视野跟着上下跳）；结束后再补拉一次完整版
const NO_EVENTS: TraceEvent[] = []
type FullTrace = { count: number; events: TraceEvent[] }
const fullTraceCache = createLruCache<FullTrace>(40)

// [说明] 正文与工具 / 子 Agent 描述段共用的样式：两者看起来必须一模一样
const NARRATION_BOX = "px-1.5 pt-1 pb-1.5 pl-6"
const NARRATION_TEXT = "text-[13px] leading-[1.75] whitespace-pre-wrap text-foreground"

function stringifyPretty(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// 按事件种类展示命令/工具/参数/结果/错误等字段，参数与结果都是
// JSON.stringify(value, null, 2) 后的原文
function buildBodyParts(event: TraceEvent): BodyPart[] {
  const parts: BodyPart[] = []
  const push = (label: string, value: unknown) => {
    const text = stringifyPretty(value).trim()
    if (text) parts.push({ label, value: text })
  }

  if (event.kind === "command") {
    push("命令", event.command)
    if (typeof event.exitCode === "number") {
      push("退出码", String(event.exitCode))
    } else {
      push("状态", event.status)
    }
    push("结果", event.result)
    push("错误", event.error)
  }
  if (event.kind === "mcp" || event.kind === "tool") {
    // 顺序：描述 → 工具 → 工具参数 → 命令 → 结果 / 错误。描述放最前：紧跟在命令后面会被误当成命令的输出；
    // 工具参数（Agent 调用工具时传的参数）紧跟在“工具”后面，一行展示
    const argParts = buildToolArgumentParts(event)
    const pick = (label: string) => argParts.filter((part) => part.label === label)
    pick("描述").forEach((part) => push(part.label, part.value))
    push("工具", event.kind === "mcp" ? [event.server, event.toolName].filter(Boolean).join(".") : event.toolName)
    pick("工具参数").forEach((part) => {
      const text = stringifyPretty(part.value).trim()
      const compact = compactToolArguments(part.value)
      if (text) parts.push({ label: "工具参数", value: text, compact })
    })
    argParts.filter((part) => !["描述", "工具参数"].includes(part.label)).forEach((part) => push(part.label, part.value))
    push("结果", event.result)
    push("错误", event.error)
  }
  if (event.kind === "subagent") {
    // 描述已不在标题里：点开后放在详情最前，与工具行一致（只出现一次）
    push("描述", event.description)
    push("提示词", event.prompt)
    push("结果", event.result)
    push("错误", event.error)
  }
  if ((event.kind === "agent_message" || event.kind === "status" || event.kind === "error") && event.detail) {
    push("详情", event.detail)
  }
  return parts
}

function CopyBodyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板权限被拒绝时静默失败，不打断阅读
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="复制"
      aria-label="复制"
      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </button>
  )
}

// "结果" 用代码块包裹并带复制按钮，其余字段（参数/命令等）只需要代码块展示
function CompactParams({ part }: { part: BodyPart }) {
  const [full, setFull] = React.useState(false)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{part.label}</span>
      {full ? (
        <pre
          onClick={() => setFull(false)}
          title="点一下收成一行"
          className="cursor-pointer overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs leading-[1.6] whitespace-pre-wrap text-foreground"
        >
          {part.value}
        </pre>
      ) : (
        <button
          type="button"
          onClick={() => setFull(true)}
          title="点一下看全文"
          className="truncate rounded-md bg-muted px-2 py-1 text-left font-mono text-xs text-foreground"
        >
          {part.compact}
        </button>
      )}
    </div>
  )
}

function TraceBodySection({ part, copyable }: { part: BodyPart; copyable: boolean }) {
  if (part.compact !== undefined) return <CompactParams part={part} />
  // 截断版本只能看，不能复制：复制按钮只给完整内容
  const isResult = part.label === "结果" && copyable
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{part.label}</span>
        {isResult ? <CopyBodyButton text={part.value} /> : null}
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs leading-[1.6] whitespace-pre-wrap text-foreground">
        {part.value}
      </pre>
    </div>
  )
}

// 默认状态：说明展开，工具行只露标题和描述；mode=all 全展开，mode=none 全收起
function defaultRowOpen(event: TraceEvent, mode: ExpandMode): boolean {
  if (mode === "all") return true
  if (mode === "none") return false
  return event.kind === "agent_message"
}

type ExpandMode = "default" | "all" | "none"

function TraceEventRow({
  event,
  complete,
  open,
  onOpenChange,
  stepCount = 0,
  nested = null,
  nestedIndent = true,
  showDescription = false,
}: {
  event: TraceEvent
  complete: boolean
  open: boolean
  onOpenChange: (next: boolean) => void
  stepCount?: number
  // 收起时在标题下面显示描述段（默认模式；“全部收起”时不显示）
  showDescription?: boolean
  // 子 Agent 里的事件行，展开后显示在它自己的详情之前
  nested?: React.ReactNode
  nestedIndent?: boolean
}) {
  const isRawOutput = event.kind === "output"
  const isStderr = isRawOutput && event.stream === "stderr"
  const Icon = isStderr
    ? TriangleAlertIcon
    : isRawOutput
      ? TerminalIcon
      : KIND_ICON[event.kind] || MessageSquareIcon
  const isNarration = event.kind === "agent_message"
  const bodyParts = React.useMemo(() => buildBodyParts(event), [event])
  const description = isNarration ? "" : traceRowDescription(event)
  const expandable = isNarration || bodyParts.length > 0 || nested !== null

  if (!expandable) {
    return (
      // 原始输出行（stdout/stderr 兜底）用等宽字体照原样展示，stderr 标红；
      // 行可能很长，截断后把全文放进 title 方便悬浮查看
      <div className="flex items-start gap-1.5 px-1.5 py-1 text-[13px]">
        <Icon
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            isStderr ? "text-destructive" : "text-muted-foreground"
          )}
        />
        <span
          title={isRawOutput ? event.text : undefined}
          className={cn(
            "flex-1 truncate",
            isRawOutput && "font-mono text-xs",
            isStderr ? "text-destructive" : "text-foreground"
          )}
        >
          {event.text}
        </span>
      </div>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-muted">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-foreground">
          {isNarration ? "[说明]" : formatTraceRowTitle(event, stepCount)}
        </span>
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
      </CollapsibleTrigger>
      {!open && showDescription && description ? (
        <div className={cn("flex flex-col gap-2", NARRATION_BOX)}>
          <p data-trace-desc className={NARRATION_TEXT}>{description}</p>
        </div>
      ) : null}
      <CollapsibleContent className={cn("flex flex-col gap-2", NARRATION_BOX)}>
        {isNarration ? (
          // 说明的详情就是正文：不再套一层“详情”小标题
          <p data-trace-narration className={NARRATION_TEXT}>{event.detail || event.text}</p>
        ) : (
          <>
            {nested !== null ? (
              <div className={cn("flex flex-col gap-0.5", nestedIndent && "border-l pl-2")}>{nested}</div>
            ) : null}
            {bodyParts.map((part) => <TraceBodySection key={part.label} part={part} copyable={complete} />)}
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

const TASK_LIST_VISIBLE = 8

function TaskStatusIcon({ status }: { status: TaskItem["status"] }) {
  if (status === "completed") return <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
  if (status === "in_progress") return <CircleDotIcon className="mt-0.5 size-3.5 shrink-0 text-foreground" />
  return <CircleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
}

// 任务清单只显示一块最新状态（☐ 待办 / ◐ 进行中 / ☑ 完成），不随每次更新刷屏；超过 8 项折叠
function TaskListBlock({ items }: { items: TaskItem[] }) {
  const [all, setAll] = React.useState(false)
  const shown = all ? items : items.slice(0, TASK_LIST_VISIBLE)
  const done = items.filter((item) => item.status === "completed").length
  return (
    <div data-task-list className="flex flex-col gap-0.5 rounded-md border bg-background/60 px-2 py-1.5">
      <span className="text-xs font-medium text-muted-foreground">任务清单 · {done}/{items.length}</span>
      {shown.map((item) => (
        <div key={item.id} className="flex items-start gap-1.5 text-[13px]">
          <TaskStatusIcon status={item.status} />
          <span className={cn("flex-1 break-words", item.status === "completed" && "text-muted-foreground line-through")}>{item.subject}</span>
        </div>
      ))}
      {items.length > TASK_LIST_VISIBLE ? (
        <button type="button" onClick={() => setAll((value) => !value)} className="self-start text-xs text-muted-foreground hover:text-foreground">
          {all ? "收起" : `还有 ${items.length - TASK_LIST_VISIBLE} 项`}
        </button>
      ) : null}
    </div>
  )
}

// 执行中正在输出的文字：作为最后一行 [说明] 实时显示（与正式的说明行同样式），正式的说明到了就由它接替
function LiveNarrationRow({ text, open }: { text: string; open: boolean }) {
  return (
    <div data-trace-live>
      <div className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px]">
        <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-foreground">[说明]</span>
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-90")} />
      </div>
      {open ? (
        <div className={cn("flex flex-col gap-2", NARRATION_BOX)}>
          <p className={NARRATION_TEXT}>{text}</p>
        </div>
      ) : null}
    </div>
  )
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean)
  return lines[lines.length - 1] || ""
}

export function TraceBlock({ trace, sessionName, liveText = "" }: { trace: ChatMessage; sessionName: string; liveText?: string }) {
  // null = 用户还没手动开合过，此时跟随"有错误就自动展开"：出错的那一轮
  // 不该把错误藏在折叠面板里。用户手动点过之后以用户的选择为准，
  // 不会因为后续又来一条 error 事件把面板重新掰开
  const [userOpen, setUserOpen] = React.useState<boolean | null>(null)
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  // 展开整段后每一行的开合：mode 是“展开全部 / 收起全部”的整体状态，rowOverrides 是用户手动开合过的行
  // （以 toolId 或序号为 key，新事件到来时不会被改回默认）
  const [mode, setMode] = React.useState<ExpandMode>("default")
  const [rowOverrides, setRowOverrides] = React.useState<Record<string, boolean>>({})
  const listEvents = trace.traceEvents || NO_EVENTS
  const truncated = trace.traceTruncated === true
  const pending = trace.pending === true
  const cacheKey = traceCacheKey(sessionName, trace.id)
  const cached = truncated ? fullTraceCache.get(cacheKey) : undefined
  const [loadState, setLoadState] = React.useState<{ key: string; failed: boolean } | null>(null)
  // 有完整版就用它，列表里比它多出来的事件（任务还在跑）接在后面
  const events = React.useMemo(
    () => (cached ? (cached.count < listEvents.length ? cached.events.concat(listEvents.slice(cached.count)) : cached.events) : listEvents),
    [cached, listEvents]
  )
  const full = cached && cached.count === listEvents.length ? cached : undefined
  const merged = React.useMemo(() => mergeToolTraceEvents(events), [events])
  const hasError = merged.some((event) => event.kind === "error")
  const open = userOpen ?? hasError
  // 任务进行中已经有一份完整版时不反复下载，结束后再补拉一次
  const needFetch = open && truncated && (!cached || (!pending && cached.count !== listEvents.length))


  React.useEffect(() => {
    if (!needFetch) return
    let cancelled = false
    apiGet(buildTraceUrl(sessionName, trace.id))
      .then((data) => {
        if (!Array.isArray(data.traceEvents)) throw new Error("bad trace")
        // 按返回的条数记：任务还在跑时服务端可能已经比请求时多了几条，按请求时的条数记会把它们重复接一遍
        fullTraceCache.set(cacheKey, { count: data.traceEvents.length, events: data.traceEvents as TraceEvent[] })
        if (!cancelled) setLoadState({ key: cacheKey, failed: false })
      })
      .catch(() => {
        if (!cancelled) setLoadState({ key: cacheKey, failed: true })
      })
    return () => {
      cancelled = true
    }
    // 不依赖事件条数：执行中每来一个事件都重新发请求会叠出一串重复下载
  }, [needFetch, cacheKey, sessionName, trace.id])

  // 本地流式拿到的是完整内容：记成这条消息的完整版。流结束对账后换成服务端的截断版时直接用它，
  // 不闪“正在加载完整内容…”（结束后条数不同再补拉一次）
  React.useEffect(() => {
    if (!truncated && listEvents.length) fullTraceCache.set(cacheKey, { count: listEvents.length, events: listEvents })
  }, [truncated, listEvents, cacheKey])

  // 执行中还没有任何事件时也显示标题行（回复框此时不单独显示，这里是唯一的进度提示）
  if (!merged.length && !pending) return null
  const tree = buildTraceTree(merged)
  const taskList = buildTaskList(merged)
  const rowOpen = (event: TraceEvent, key: string) => rowOverrides[key] ?? defaultRowOpen(event, mode)
  // 三态循环：默认（展开描述）→ 展开全部细节 → 隐藏所有细节 → 展开描述；按钮显示的是点一下会变成什么
  const nextMode: ExpandMode = mode === "default" ? "all" : mode === "all" ? "none" : "default"
  const nextLabel = mode === "default" ? "展开全部细节" : mode === "all" ? "隐藏所有细节" : "展开描述"
  const NextIcon = mode === "default" ? ChevronsUpDownIcon : mode === "all" ? ChevronsDownUpIcon : AlignLeftIcon
  function toggleAll() {
    // 点一下整体切换，并清掉各行手动状态：“全部”就是全部
    setMode(nextMode)
    setRowOverrides({})
  }
  function renderNode(node: TraceNode): React.ReactNode {
    return (
      <TraceEventRow
        key={node.key}
        event={node.event}
        complete={complete}
        open={rowOpen(node.event, node.key)}
        onOpenChange={(next) => setRowOverrides((previous) => ({ ...previous, [node.key]: next }))}
        stepCount={node.stepCount}
        nested={node.children.length > 0 ? node.children.map(renderNode) : null}
        nestedIndent={node.depth < MAX_TRACE_INDENT_DEPTH}
        showDescription={mode !== "none"}
      />
    )
  }
  const summary = summarizeTraceFlow(merged, pending)
  const complete = !truncated || full !== undefined
  const loadFailed = !cached && loadState?.key === cacheKey && loadState.failed
  // 正在输出的文字：最后一条顶层说明已经是它（正式说明到了）就不再单独显示
  const live = pending ? liveText.trim() : ""
  const lastNarration = [...tree].reverse().find((node) => node.event.kind === "agent_message")?.event
  // 与说明行显示的内容一致（detail，没有就用 text，去掉“[说明] ”前缀）
  const lastNarrationText = String(lastNarration?.detail || lastNarration?.text || "").replace(/^\[说明\]\s*/, "").trim()
  const showLive = live !== "" && !(lastNarrationText !== "" && lastNarrationText.startsWith(live))
  const traceKey = String(trace.renderKey ?? trace.id)

  // 过程很长时，滚动条要拖很久才能离开它：展开后右侧给两个按钮，把整个过程框直接对齐到聊天区的顶部 / 底部。
  // 由消息流来滚（TRACE_ALIGN_EVENT）：对齐到底部要把锚点设成“贴着这一段”，之后它怎么长都贴着；
  // 不用平滑滚动——动画目标在点击时算好，动画期间执行过程继续变长，停下时已经不在底部
  function alignInChat(edge: "top" | "bottom") {
    const box = wrapperRef.current?.closest<HTMLElement>("[data-chat-scroll]")
    box?.dispatchEvent(new CustomEvent(TRACE_ALIGN_EVENT, { detail: { edge, key: traceKey } }))
  }

  return (
    // data-trace-block / data-open：消息流据此找到“最新一段已展开的执行过程”，判断视野是否贴着它的底部
    <div ref={wrapperRef} data-trace-block data-trace-key={traceKey} data-open={open ? "true" : "false"} className="flex w-full max-w-full items-stretch gap-1 @3xl:max-w-[75%]">
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          // 在过程中间点吸顶的标题行收起时，先把这段过程的顶部贴回聊天窗口顶部再收起，
          // 否则收起后内容变短，视野会落到别的消息上
          if (!next) {
            const rect = wrapperRef.current?.getBoundingClientRect()
            const boxTop = wrapperRef.current?.closest<HTMLElement>("[data-chat-scroll]")?.getBoundingClientRect().top
            if (rect && boxTop !== undefined && rect.top < boxTop) alignInChat("top")
          }
          setUserOpen(next)
        }}
        className="min-w-0 flex-1"
      >
      {/* 展开后标题行吸顶：过程很长时也能随时点它收起；用不透明底色，否则下面的内容会从半透明背景里透出来 */}
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-1.5 rounded-lg border bg-[color-mix(in_oklab,var(--muted)_40%,var(--background))] px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted",
          open && "sticky top-0 z-10"
        )}
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        {/* 一行，超出省略：执行中这里带一行正在输出的文字作为预览，高度不能随它变 */}
        <span className="min-w-0 flex-1 truncate">
          执行过程 · {summary}
          {live ? ` · ${lastLine(live)}` : ""}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col gap-0.5 rounded-lg border bg-muted/20 p-1.5">
        {!cached && truncated ? (
          <p className="px-1.5 text-xs text-muted-foreground">
            {loadFailed ? "完整内容加载失败，收起再展开可重试" : "正在加载完整内容…"}
          </p>
        ) : null}
        {taskList.length > 0 ? <TaskListBlock items={taskList} /> : null}
        {tree.map(renderNode)}
        {showLive ? <LiveNarrationRow text={live} open={defaultRowOpen({ kind: "agent_message" } as TraceEvent, mode)} /> : null}
      </CollapsibleContent>
      </Collapsible>
      {open ? (
        // sticky：过程很长时，滚到框中间这两个按钮也一直在视野里
        <div className="sticky top-0 flex shrink-0 flex-col gap-1 self-start">
          <button
            type="button"
            onClick={() => alignInChat("top")}
            title="让这段执行过程顶部贴着聊天窗口顶部"
            aria-label="执行过程对齐到顶部"
            className="rounded-md border bg-muted/40 p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowUpToLineIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={toggleAll}
            title={nextLabel}
            aria-label={nextLabel}
            className="rounded-md border bg-muted/40 p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <NextIcon className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => alignInChat("bottom")}
            title="让这段执行过程底部贴着聊天窗口底部"
            aria-label="执行过程对齐到底部"
            className="rounded-md border bg-muted/40 p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowDownToLineIcon className="size-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  )
}
