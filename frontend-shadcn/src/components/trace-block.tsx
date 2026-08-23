import * as React from "react"
import {
  ChevronRightIcon,
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

function getExpandableDetail(event: TraceEvent): string {
  const parts: string[] = []
  if (event.detail && event.detail !== event.text) parts.push(event.detail)
  if (event.command) parts.push(`命令: ${event.command}`)
  if (event.argumentSummary) parts.push(`参数: ${event.argumentSummary}`)
  if (event.result) parts.push(`结果: ${event.result}`)
  if (event.error) parts.push(`错误: ${event.error}`)
  return parts.join("\n")
}

function TraceEventRow({ event }: { event: TraceEvent }) {
  const [open, setOpen] = React.useState(false)
  const Icon = KIND_ICON[event.kind] || MessageSquareIcon
  const isNarration = event.kind === "agent_message"
  const extra = getExpandableDetail(event)
  const expandable = isNarration || Boolean(extra)

  if (!expandable) {
    return (
      <div className="flex items-start gap-1.5 px-1.5 py-1 text-xs">
        <Icon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-muted-foreground">{event.text}</span>
      </div>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted">
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-muted-foreground">
          {isNarration ? "说明" : event.text}
        </span>
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1.5 pb-1.5 pl-6 text-xs whitespace-pre-wrap text-muted-foreground">
        {isNarration ? event.detail || event.text : extra}
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
