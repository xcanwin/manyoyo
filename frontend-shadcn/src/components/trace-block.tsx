import * as React from "react"
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  MessageSquareIcon,
  OctagonAlertIcon,
  PlugIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
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

// 与旧版前端 createTraceEventCard 的 bodyParts 拼装逻辑对齐：按事件种类展示
// 命令/工具/参数/结果/错误等字段，参数与结果都是 JSON.stringify(value, null, 2) 后的原文
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
    push("工具", [event.server, event.toolName].filter(Boolean).join("."))
    push("参数摘要", event.argumentSummary)
    push("参数", event.arguments)
    push("结果", event.result)
    push("错误", event.error)
  }
  if (event.kind === "tool") {
    push("工具", event.toolName)
    push("参数摘要", event.argumentSummary)
    push("参数", event.arguments)
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
  const Icon = KIND_ICON[event.kind] || MessageSquareIcon
  const isNarration = event.kind === "agent_message"
  const bodyParts = React.useMemo(() => buildBodyParts(event), [event])
  const expandable = isNarration || bodyParts.length > 0

  if (!expandable) {
    return (
      <div className="flex items-start gap-1.5 px-1.5 py-1 text-sm">
        <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-foreground">{event.text}</span>
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
  const [open, setOpen] = React.useState(false)
  const merged = React.useMemo(
    () => mergeToolTraceEvents(trace.traceEvents || []),
    [trace.traceEvents]
  )
  if (!merged.length) return null
  const summary = summarizeTraceFlow(merged, trace.pending === true)

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="w-full max-w-[75%]"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted">
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
  )
}
