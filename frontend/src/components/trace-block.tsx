import * as React from "react"
import {
  CheckIcon,
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  ChevronRightIcon,
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
  buildToolArgumentParts,
  mergeToolTraceEvents,
  summarizeTraceFlow,
  type ChatMessage,
  type TraceEvent,
} from "@/lib/api"
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

type BodyPart = { label: string; value: string }

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
  if (event.kind === "mcp") {
    // 描述放最前：紧跟在命令后面会被误当成命令的输出
    const argParts = buildToolArgumentParts(event)
    argParts.filter((part) => part.label === "描述").forEach((part) => push(part.label, part.value))
    push("工具", [event.server, event.toolName].filter(Boolean).join("."))
    argParts.filter((part) => part.label !== "描述").forEach((part) => push(part.label, part.value))
    push("结果", event.result)
    push("错误", event.error)
  }
  if (event.kind === "tool") {
    const argParts = buildToolArgumentParts(event)
    argParts.filter((part) => part.label === "描述").forEach((part) => push(part.label, part.value))
    push("工具", event.toolName)
    argParts.filter((part) => part.label !== "描述").forEach((part) => push(part.label, part.value))
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
function TraceBodySection({ part }: { part: BodyPart }) {
  const isResult = part.label === "结果"
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{part.label}</span>
        {isResult ? <CopyBodyButton text={part.value} /> : null}
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-foreground">
        {part.value}
      </pre>
    </div>
  )
}

function TraceEventRow({ event }: { event: TraceEvent }) {
  const [open, setOpen] = React.useState(false)
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

  if (!expandable) {
    return (
      // 原始输出行（stdout/stderr 兜底）用等宽字体照原样展示，stderr 标红；
      // 行可能很长，截断后把全文放进 title 方便悬浮查看
      <div className="flex items-start gap-1.5 px-1.5 py-1 text-sm">
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
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted">
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
      <CollapsibleContent className="flex flex-col gap-2 px-1.5 pt-1 pb-1.5 pl-6">
        {isNarration && !bodyParts.length ? (
          <p className="text-sm whitespace-pre-wrap text-foreground">{event.detail || event.text}</p>
        ) : (
          bodyParts.map((part) => <TraceBodySection key={part.label} part={part} />)
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function TraceBlock({ trace }: { trace: ChatMessage }) {
  // null = 用户还没手动开合过，此时跟随"有错误就自动展开"：出错的那一轮
  // 不该把错误藏在折叠面板里。用户手动点过之后以用户的选择为准，
  // 不会因为后续又来一条 error 事件把面板重新掰开
  const [userOpen, setUserOpen] = React.useState<boolean | null>(null)
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const merged = React.useMemo(
    () => mergeToolTraceEvents(trace.traceEvents || []),
    [trace.traceEvents]
  )
  if (!merged.length) return null
  const summary = summarizeTraceFlow(merged, trace.pending === true)
  const hasError = merged.some((event) => event.kind === "error")
  const open = userOpen ?? hasError

  // 过程很长时，滚动条要拖很久才能离开它：展开后右侧给两个按钮，
  // 把整个过程框直接对齐到聊天区的顶部 / 底部
  function alignInChat(edge: "top" | "bottom") {
    const el = wrapperRef.current
    const box = el?.closest<HTMLElement>("[data-chat-scroll]")
    if (!el || !box) return
    const rect = el.getBoundingClientRect()
    const boxRect = box.getBoundingClientRect()
    const delta = edge === "top" ? rect.top - boxRect.top : rect.bottom - boxRect.bottom
    box.scrollTo({ top: box.scrollTop + delta, behavior: "smooth" })
  }

  return (
    <div ref={wrapperRef} className="flex w-full max-w-full items-stretch gap-1 @3xl:max-w-[75%]">
      <Collapsible open={open} onOpenChange={setUserOpen} className="min-w-0 flex-1">
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
        {merged.map((event, index) => (
          <TraceEventRow key={`${event.kind}-${index}`} event={event} />
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
