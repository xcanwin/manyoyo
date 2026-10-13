import * as React from "react"
import {
  CheckIcon,
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CopyIcon,
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
  buildToolArgumentParts,
  compactToolArguments,
  mergeToolTraceEvents,
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

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  tool: WrenchIcon,
  command: TerminalIcon,
  mcp: PlugIcon,
  agent_message: MessageSquareIcon,
  error: OctagonAlertIcon,
}

// compact：只给“工具参数”用——单行 键=值，点一下展开全文（value 是缩进好的全文）
type BodyPart = { label: string; value: string; compact?: string }

// 列表里的 trace 长字段被服务端截断过（traceTruncated）：展开时才按需下载完整内容，
// 同一条消息（id + 事件数相同）只下载一次；任务还在跑、事件数变了就重新拉
const NO_EVENTS: TraceEvent[] = []
const fullTraceCache = createLruCache<TraceEvent[]>(40)

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

// 能展开的行：说明、以及有详情字段的行；原始输出行只有一行文字，不能展开
function isExpandableEvent(event: TraceEvent): boolean {
  return event.kind === "agent_message" || (event.kind !== "output" && buildBodyParts(event).length > 0)
}

// 默认状态：说明展开，工具行只露标题和描述；mode=all 全展开，mode=none 全收起
function defaultRowOpen(event: TraceEvent, mode: ExpandMode): boolean {
  if (mode === "all") return true
  if (mode === "none") return false
  return event.kind === "agent_message"
}

type ExpandMode = "default" | "all" | "none"

function traceRowKey(event: TraceEvent, index: number): string {
  return event.toolId ? `${event.kind}:${event.toolId}` : `${event.kind}-${index}`
}

function TraceEventRow({
  event,
  complete,
  open,
  showDescription,
  onOpenChange,
}: {
  event: TraceEvent
  complete: boolean
  open: boolean
  showDescription: boolean
  onOpenChange: (next: boolean) => void
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
  const expandable = isNarration || bodyParts.length > 0
  const description = bodyParts.find((part) => part.label === "描述")?.value

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
          {isNarration ? "说明" : event.text}
        </span>
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
      </CollapsibleTrigger>
      {/* 没点开这一行时，标题下面直接露出“描述”；点开后描述在详情里，不重复显示 */}
      {!open && !isNarration && showDescription && description ? (
        <p className="truncate px-1.5 pb-1 pl-6 text-xs text-muted-foreground">{description}</p>
      ) : null}
      <CollapsibleContent className="flex flex-col gap-2 px-1.5 pt-1 pb-1.5 pl-6">
        {isNarration && !bodyParts.length ? (
          <p className="text-[13px] leading-[1.75] whitespace-pre-wrap text-foreground">{event.detail || event.text}</p>
        ) : (
          bodyParts.map((part) => <TraceBodySection key={part.label} part={part} copyable={complete} />)
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function TraceBlock({ trace, sessionName }: { trace: ChatMessage; sessionName: string }) {
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
  const cacheKey = traceCacheKey(sessionName, trace.id, listEvents.length)
  const full = truncated ? fullTraceCache.get(cacheKey) : undefined
  const [loadState, setLoadState] = React.useState<{ key: string; failed: boolean } | null>(null)
  const events = full ?? listEvents
  const merged = React.useMemo(() => mergeToolTraceEvents(events), [events])
  const hasError = merged.some((event) => event.kind === "error")
  const open = userOpen ?? hasError
  const needFetch = open && truncated && !full

  React.useEffect(() => {
    if (!needFetch) return
    let cancelled = false
    apiGet(buildTraceUrl(sessionName, trace.id))
      .then((data) => {
        if (!Array.isArray(data.traceEvents)) throw new Error("bad trace")
        fullTraceCache.set(cacheKey, data.traceEvents as TraceEvent[])
        if (!cancelled) setLoadState({ key: cacheKey, failed: false })
      })
      .catch(() => {
        if (!cancelled) setLoadState({ key: cacheKey, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [needFetch, cacheKey, sessionName, trace.id])

  if (!merged.length) return null
  const rowKeys = merged.map((event, index) => traceRowKey(event, index))
  const rowOpen = (event: TraceEvent, key: string) => rowOverrides[key] ?? defaultRowOpen(event, mode)
  const expandableRows = merged.map((event, index) => ({ event, key: rowKeys[index] })).filter((row) => isExpandableEvent(row.event))
  const allOpen = expandableRows.length > 0 && expandableRows.every((row) => rowOpen(row.event, row.key))
  function toggleAll() {
    // 点一下整体切换，并清掉各行手动状态：“全部”就是全部
    setMode(allOpen ? "none" : "all")
    setRowOverrides({})
  }
  const summary = summarizeTraceFlow(merged, trace.pending === true)
  const complete = !truncated || full !== undefined
  const loadFailed = !complete && loadState?.key === cacheKey && loadState.failed

  // 过程很长时，滚动条要拖很久才能离开它：展开后右侧给两个按钮，
  // 把整个过程框直接对齐到聊天区的顶部 / 底部
  function alignInChat(edge: "top" | "bottom", behavior: ScrollBehavior = "smooth") {
    const el = wrapperRef.current
    const box = el?.closest<HTMLElement>("[data-chat-scroll]")
    if (!el || !box) return
    const rect = el.getBoundingClientRect()
    const boxRect = box.getBoundingClientRect()
    const delta = edge === "top" ? rect.top - boxRect.top : rect.bottom - boxRect.bottom
    box.scrollTo({ top: box.scrollTop + delta, behavior })
  }

  return (
    <div ref={wrapperRef} className="flex w-full max-w-full items-stretch gap-1 @3xl:max-w-[75%]">
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          // 在过程中间点吸顶的标题行收起时，先把这段过程的顶部贴回聊天窗口顶部再收起，
          // 否则收起后内容变短，视野会落到别的消息上
          if (!next) {
            const rect = wrapperRef.current?.getBoundingClientRect()
            const boxTop = wrapperRef.current?.closest<HTMLElement>("[data-chat-scroll]")?.getBoundingClientRect().top
            if (rect && boxTop !== undefined && rect.top < boxTop) alignInChat("top", "auto")
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
        <span className="flex-1">执行过程 · {summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col gap-0.5 rounded-lg border bg-muted/20 p-1.5">
        {!complete ? (
          <p className="px-1.5 text-xs text-muted-foreground">
            {loadFailed ? "完整内容加载失败，收起再展开可重试" : "正在加载完整内容…"}
          </p>
        ) : null}
        {merged.map((event, index) => (
          <TraceEventRow
            key={rowKeys[index]}
            event={event}
            complete={complete}
            open={rowOpen(event, rowKeys[index])}
            showDescription={mode !== "none"}
            onOpenChange={(next) => setRowOverrides((previous) => ({ ...previous, [rowKeys[index]]: next }))}
          />
        ))}
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
            title={allOpen ? "收起全部细节" : "展开全部细节"}
            aria-label={allOpen ? "收起全部细节" : "展开全部细节"}
            className="rounded-md border bg-muted/40 p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {allOpen ? <ChevronsDownUpIcon className="size-3.5" /> : <ChevronsUpDownIcon className="size-3.5" />}
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
