import * as React from "react"
import { CheckIcon, CopyIcon, EllipsisIcon, SendIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  apiGet,
  apiPost,
  apiStream,
  mergeTraceIntoReply,
  type ChatMessage,
  type SessionSummary,
  type TraceEvent,
} from "@/lib/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AgentTemplateDialog } from "@/components/agent-template-dialog"
import { Button } from "@/components/ui/button"
import { FilesPanel } from "@/components/files-panel"
import { MarkdownContent } from "@/components/markdown-content"
import { ModelDialog } from "@/components/model-dialog"
import { TerminalView } from "@/components/terminal-view"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Textarea } from "@/components/ui/textarea"
import { TraceBlock } from "@/components/trace-block"

type View = "activity" | "terminal" | "files" | "detail" | "config" | "check"

const VIEW_LABELS: Record<View, string> = {
  activity: "活动",
  terminal: "终端",
  files: "文件",
  detail: "详情",
  config: "配置",
  check: "检查",
}

const PERSISTENT_VIEWS: View[] = ["activity", "files"]

const OTHER_VIEWS = (Object.keys(VIEW_LABELS) as View[]).filter(
  (key) => !PERSISTENT_VIEWS.includes(key)
)

const STREAMING_MESSAGE_ID = "__streaming__"
const STREAMING_TRACE_ID = "__streaming_trace__"

const CHECK_ROWS: Array<[string, string]> = [
  ["容器运行时", "尚未接入（仍是占位数据）"],
  ["镜像版本", "尚未接入（仍是占位数据）"],
  ["端口占用", "尚未接入（仍是占位数据）"],
]

function formatTime(value: string): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function CopyMessageButton({ text }: { text: string }) {
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
      className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </button>
  )
}

function ActivityView({
  session,
  messages,
}: {
  session: SessionSummary | null
  messages: ChatMessage[]
}) {
  const displayMessages = React.useMemo(() => mergeTraceIntoReply(messages), [messages])

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <p>请选择左侧的容器 / AGENT，或点击「新建容器」创建一个新会话。</p>
      </div>
    )
  }

  if (!displayMessages.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <p>还没有对话记录，在下方输入内容开始与 AGENT 交流。</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col gap-3 p-4">
        {displayMessages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "flex flex-col gap-1",
              message.role === "user" ? "items-end" : "items-start"
            )}
          >
            {message.pairedTrace ? <TraceBlock trace={message.pairedTrace} /> : null}
            <div
              className={cn(
                "max-w-[75%] rounded-xl px-3 py-2 text-sm",
                message.role === "user"
                  ? "bg-primary text-primary-foreground whitespace-pre-wrap"
                  : message.role === "system"
                    ? "bg-transparent whitespace-pre-wrap text-muted-foreground italic"
                    : "bg-muted text-foreground",
                message.pending && "opacity-70"
              )}
            >
              {message.role === "assistant" ? (
                <MarkdownContent content={message.content || (message.pending ? "…" : "")} />
              ) : (
                message.content || (message.pending ? "…" : "")
              )}
            </div>
            <span className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
              {formatTime(message.timestamp)}
              {message.interrupted ? " · 已停止" : ""}
              {message.content && !message.pending ? (
                <CopyMessageButton text={message.content} />
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function SummaryView({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex flex-col divide-y rounded-lg border">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
          >
            <span className="text-muted-foreground">{label}</span>
            <span className="truncate font-medium">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function DetailView({ session }: { session: SessionSummary | null }) {
  if (!session) {
    return <SummaryView rows={[["提示", "请先选择左侧的容器 / AGENT"]]} />
  }
  return (
    <SummaryView
      rows={[
        ["容器状态", session.status],
        ["镜像", session.image || "未知"],
        ["CLI", session.agentProgram || "（无）"],
        ["模型", session.model || "跟随默认"],
        ["工作目录", session.hostPath || "未配置"],
        ["容器内目录", session.containerPath || "未配置"],
        ["消息数", String(session.messageCount)],
        ["更新时间", formatTime(session.updatedAt || "")],
      ]}
    />
  )
}

function Composer({
  draft,
  onDraftChange,
  onSend,
  onStop,
  mode,
  onModeChange,
  disabled,
  sending,
  session,
  onOpenCliTemplate,
  onOpenModel,
}: {
  draft: string
  onDraftChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  mode: "agent" | "command"
  onModeChange: (mode: "agent" | "command") => void
  disabled: boolean
  sending: boolean
  session: SessionSummary | null
  onOpenCliTemplate: () => void
  onOpenModel: () => void
}) {
  return (
    <div className="border-t p-3">
      <Textarea
        placeholder={
          disabled
            ? "请先在左侧选择一个容器 / AGENT"
            : mode === "command"
              ? "输入容器命令，例如: ls -la"
              : "输入要发给 AGENT 的内容"
        }
        className="min-h-16 resize-none"
        value={draft}
        disabled={disabled}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            if (!sending) onSend()
          }
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <Popover>
          <PopoverTrigger render={<Button variant="outline" size="sm" disabled={disabled} />}>
            选项
          </PopoverTrigger>
          <PopoverContent align="start" className="w-44 p-1">
            <div className="flex flex-col gap-0.5">
              <Button
                variant={mode === "agent" ? "secondary" : "ghost"}
                size="sm"
                className="justify-start"
                onClick={() => onModeChange("agent")}
              >
                Agent对话
              </Button>
              <Button
                variant={mode === "command" ? "secondary" : "ghost"}
                size="sm"
                className="justify-start"
                onClick={() => onModeChange("command")}
              >
                系统命令
              </Button>
              <Separator className="my-1" />
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                disabled={!session}
                onClick={onOpenCliTemplate}
              >
                CLI · {session?.agentProgram || "未设置"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                disabled={!session}
                onClick={onOpenModel}
              >
                模型 · {session?.model || "跟随默认"}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        {sending ? (
          <Button size="sm" variant="destructive" onClick={onStop}>
            停止
          </Button>
        ) : (
          <Button size="sm" onClick={onSend} disabled={disabled}>
            <SendIcon data-icon="inline-start" />
            发送
          </Button>
        )}
      </div>
    </div>
  )
}

export function WorkspacePanel({
  activeSession,
  onAfterSend,
}: {
  activeSession: SessionSummary | null
  onAfterSend: () => void
}) {
  const [view, setView] = React.useState<View>("activity")
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [draft, setDraft] = React.useState("")
  const [mode, setMode] = React.useState<"agent" | "command">("agent")
  const [switcherOpen, setSwitcherOpen] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [loadError, setLoadError] = React.useState("")
  const [cliDialogOpen, setCliDialogOpen] = React.useState(false)
  const [modelDialogOpen, setModelDialogOpen] = React.useState(false)

  React.useEffect(() => {
    if (!activeSession) {
      setMessages([])
      return
    }
    let cancelled = false
    setLoadError("")
    apiGet(`/api/sessions/${encodeURIComponent(activeSession.name)}/messages`)
      .then((data) => {
        if (cancelled) return
        setMessages(Array.isArray(data.messages) ? (data.messages as ChatMessage[]) : [])
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "加载消息失败")
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeSession?.name])

  async function handleSend() {
    const text = draft.trim()
    if (!text || !activeSession || sending) return
    const name = activeSession.name
    setDraft("")
    setLoadError("")
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", content: text, timestamp: new Date().toISOString() },
    ])

    if (mode === "command") {
      setSending(true)
      try {
        const data = await apiPost(`/api/sessions/${encodeURIComponent(name)}/run`, { command: text })
        setMessages((prev) => [
          ...prev,
          {
            id: `result-${Date.now()}`,
            role: "system",
            content: String(data.output || ""),
            timestamp: new Date().toISOString(),
            mode: "command",
            exitCode: data.exitCode as number,
          },
        ])
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "命令执行失败")
      } finally {
        setSending(false)
        onAfterSend()
      }
      return
    }

    setSending(true)
    const traceEvents: TraceEvent[] = []
    setMessages((prev) => [
      ...prev,
      {
        id: STREAMING_TRACE_ID,
        role: "assistant",
        content: "[执行过程]",
        timestamp: new Date().toISOString(),
        streamTrace: true,
        traceEvents: [],
        pending: true,
      },
      { id: STREAMING_MESSAGE_ID, role: "assistant", content: "", timestamp: new Date().toISOString(), pending: true },
    ])
    try {
      await apiStream(`/api/sessions/${encodeURIComponent(name)}/agent/stream`, { prompt: text }, (event) => {
        if (event.type === "trace") {
          if (event.traceEvent) traceEvents.push(event.traceEvent)
          setMessages((prev) =>
            prev.map((message) =>
              message.id === STREAMING_TRACE_ID
                ? { ...message, traceEvents: traceEvents.slice() }
                : message
            )
          )
        } else if (event.type === "content_delta") {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === STREAMING_MESSAGE_ID ? { ...message, content: event.content } : message
            )
          )
        } else if (event.type === "result") {
          setMessages((prev) =>
            prev
              .map((message) =>
                message.id === STREAMING_TRACE_ID ? { ...message, pending: false } : message
              )
              .map((message) =>
                message.id === STREAMING_MESSAGE_ID
                  ? {
                      ...message,
                      content: event.output,
                      pending: false,
                      interrupted: event.interrupted,
                      exitCode: event.exitCode,
                    }
                  : message
              )
          )
        } else if (event.type === "error") {
          setLoadError(event.error)
          setMessages((prev) =>
            prev.filter(
              (message) => message.id !== STREAMING_MESSAGE_ID && message.id !== STREAMING_TRACE_ID
            )
          )
        }
      })
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "发送失败")
      setMessages((prev) =>
        prev.filter(
          (message) => message.id !== STREAMING_MESSAGE_ID && message.id !== STREAMING_TRACE_ID
        )
      )
    } finally {
      setSending(false)
      onAfterSend()
    }
  }

  async function handleStop() {
    if (!activeSession) return
    try {
      await apiPost(`/api/sessions/${encodeURIComponent(activeSession.name)}/agent/stop`, {})
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "停止失败")
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-4!" />
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant={view === "activity" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setView("activity")}
          >
            活动
          </Button>
          <Button
            variant={view === "files" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setView("files")}
          >
            文件
          </Button>
          <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
            <PopoverTrigger
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <EllipsisIcon />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-36 p-1">
              <div className="flex flex-col gap-0.5">
                {OTHER_VIEWS.map((key) => (
                  <Button
                    key={key}
                    variant={view === key ? "secondary" : "ghost"}
                    size="sm"
                    className="justify-start"
                    onClick={() => {
                      setView(key)
                      setSwitcherOpen(false)
                    }}
                  >
                    {VIEW_LABELS[key]}
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <Separator orientation="vertical" className="h-4! shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {activeSession
            ? `${activeSession.containerName} · ${activeSession.agentRemark || activeSession.agentName}`
            : "选择左侧的容器 / AGENT 开始"}
        </span>
      </header>

      <div className="min-h-0 flex-1">
        {view === "activity" ? (
          <ActivityView session={activeSession} messages={messages} />
        ) : null}
        {view === "terminal" ? <TerminalView session={activeSession} /> : null}
        {view === "files" ? <FilesPanel activeSession={activeSession} /> : null}
        {view === "detail" ? <DetailView session={activeSession} /> : null}
        {view === "config" ? <DetailView session={activeSession} /> : null}
        {view === "check" ? <SummaryView rows={CHECK_ROWS} /> : null}
      </div>

      {view === "activity" && loadError ? (
        <Alert variant="destructive" className="mx-3 mb-2">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      {view === "activity" ? (
        <Composer
          draft={draft}
          onDraftChange={setDraft}
          onSend={handleSend}
          onStop={handleStop}
          mode={mode}
          onModeChange={setMode}
          disabled={!activeSession}
          sending={sending}
          session={activeSession}
          onOpenCliTemplate={() => setCliDialogOpen(true)}
          onOpenModel={() => setModelDialogOpen(true)}
        />
      ) : null}

      <AgentTemplateDialog
        open={cliDialogOpen}
        onOpenChange={setCliDialogOpen}
        session={activeSession}
        onSaved={onAfterSend}
      />
      <ModelDialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
        session={activeSession}
        onSaved={onAfterSend}
      />
    </div>
  )
}
