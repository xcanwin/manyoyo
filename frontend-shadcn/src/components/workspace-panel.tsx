import * as React from "react"
import { CheckIcon, CopyIcon, EllipsisIcon, SendIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  apiGet,
  apiPost,
  apiStream,
  mergeTraceIntoReply,
  type ChatMessage,
  type SessionDetail,
  type SessionSummary,
  type TraceEvent,
} from "@/lib/api"
import { useAgentRecoveryPoll } from "@/hooks/use-agent-recovery-poll"
import { useIsMobile } from "@/hooks/use-mobile"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AgentTemplateDialog } from "@/components/agent-template-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { FilesPanel, type FilesEditorState } from "@/components/files-panel"
import { HtmlPreviewPanel, type HtmlPreviewState } from "@/components/html-preview-panel"
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
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { TraceBlock } from "@/components/trace-block"

type View = "activity" | "terminal" | "files" | "detail" | "config" | "check"

const VIEW_LABELS: Record<View, string> = {
  activity: "聊天",
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

const IMAGE_VERSION_TAG_PATTERN = /^(\d+\.\d+\.\d+)-([A-Za-z0-9][A-Za-z0-9_.-]*)$/

type Tone = "ok" | "warn" | "danger" | "info"

const TONE_BADGE_VARIANT: Record<Tone, "default" | "secondary" | "destructive" | "outline"> = {
  ok: "secondary",
  warn: "outline",
  danger: "destructive",
  info: "outline",
}

const TEMPLATE_SOURCE_LABELS: Record<string, string> = {
  agent: "当前 AGENT 覆盖",
  container: "容器默认模板",
  inferred: "从启动命令推导",
  none: "未配置",
}

const ROLE_LABELS: Record<string, string> = {
  user: "用户",
  assistant: "AGENT",
  system: "系统",
}

function statusInfo(status: string): { label: string; tone: Tone } {
  if (status === "history") return { label: "仅历史", tone: "warn" }
  if (status.toLowerCase().includes("up")) return { label: "运行中", tone: "ok" }
  return { label: "已停止", tone: "danger" }
}

function resumeStatus(detail: SessionDetail): { value: string; tone: Tone; detail: string } {
  const lastResumeText = detail.lastResumeAt ? formatTime(detail.lastResumeAt) : "暂无记录"
  if (detail.lastResumeOk === true) {
    return { value: "最近成功", tone: "ok", detail: `最近一次 resume 成功，时间：${lastResumeText}。` }
  }
  if (detail.lastResumeOk === false) {
    return {
      value: "最近失败",
      tone: "danger",
      detail: detail.lastResumeError
        ? `最近一次 resume 失败：${detail.lastResumeError}`
        : `最近一次 resume 失败，时间：${lastResumeText}。`,
    }
  }
  if (!detail.resumeSupported) {
    return { value: "不支持", tone: "warn", detail: "当前 Agent 程序或模板不支持 resume。" }
  }
  return { value: "未执行", tone: "warn", detail: "支持 resume，但当前会话还没有最近一次执行记录。" }
}

type InfoRow = { label: string; value: string; tone?: Tone; detail?: string }

function InfoCard({ title, rows }: { title: string; rows: InfoRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col divide-y">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">{row.label}</span>
              {row.tone ? (
                <Badge variant={TONE_BADGE_VARIANT[row.tone]}>{row.value}</Badge>
              ) : (
                <span className="truncate text-sm font-medium">{row.value}</span>
              )}
            </div>
            {row.detail ? <p className="text-xs text-muted-foreground">{row.detail}</p> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

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
  mode,
  onPreviewHtml,
}: {
  session: SessionSummary | null
  messages: ChatMessage[]
  mode: "agent" | "command"
  onPreviewHtml: (title: string, code: string) => void
}) {
  const displayMessages = React.useMemo(() => mergeTraceIntoReply(messages), [messages])
  const scrollRef = React.useRef<HTMLDivElement>(null)
  // 只有用户本来就停留在底部时，新消息/流式增量才会带着滚动条一起走；
  // 一旦用户往上翻看历史，这里会记为 false，后续更新不再打断阅读
  const stickToBottomRef = React.useRef(true)

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [displayMessages])

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
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain"
    >
      <div className="flex flex-col gap-3 p-4">
        {displayMessages.map((message) => {
          // 与旧版前端 body.agent-mode/.command-mode + msg.origin-* 对齐：
          // 切换发送模式时，历史里"另一种模式"产生的消息整体变淡，突出当前模式的上下文
          const origin = message.mode === "agent" || message.mode === "command" ? message.mode : ""
          const dimmed = origin !== "" && origin !== mode
          // 正式回复还没抵达（比如切回一个仍在跑的会话）时，trace 消息会暂时
          // 落单、配对不上下一条回复——这时也要走结构化执行过程展示，不能把
          // 它当成一条普通回复，把裸的多行 content 直接当文本糊出来
          const standaloneTrace = message.streamTrace === true && !message.pairedTrace
          return (
            <div
              key={message.id}
              className={cn(
                "flex flex-col gap-1 transition-opacity",
                message.role === "user" ? "items-end" : "items-start",
                dimmed && "opacity-25"
              )}
            >
              {message.pairedTrace ? <TraceBlock trace={message.pairedTrace} /> : null}
              {standaloneTrace ? (
                <TraceBlock trace={message} />
              ) : (
                <>
                  <div
                    className={cn(
                      "max-w-full rounded-xl px-3 py-2 text-sm sm:max-w-[75%]",
                      message.role === "user"
                        ? "max-w-[88%] bg-muted/80 text-foreground whitespace-pre-wrap sm:max-w-[75%]"
                        : message.role === "system"
                          ? "bg-transparent whitespace-pre-wrap text-muted-foreground italic"
                          : "bg-muted/40 text-foreground",
                      message.pending && "opacity-70"
                    )}
                  >
                    {message.role === "assistant" ? (
                      <MarkdownContent
                        content={message.content || (message.pending ? "…" : "")}
                        onPreviewHtml={(code) => onPreviewHtml("聊天中的 HTML 代码块", code)}
                      />
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
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function EmptyPane({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}

// 与旧版前端"检查"标签页的 renderCheckCard 对齐：容器状态 / Agent 输入 /
// Resume 健康 / 镜像版本 / 工作目录映射 + 最近问题（仅在有 resume 错误时展示）
function CheckView({ detail }: { detail: SessionDetail | null }) {
  if (!detail) return <EmptyPane text="请先选择左侧的容器 / AGENT" />

  const status = statusInfo(detail.status)
  const resume = resumeStatus(detail)
  const imageVersionValid = IMAGE_VERSION_TAG_PATTERN.test(detail.applied.imageVersion || "")
  const workdirConfigured = Boolean(detail.applied.hostPath && detail.applied.containerPath)

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      <InfoCard
        title="运行检查"
        rows={[
          {
            label: "容器状态",
            value: status.label,
            tone: status.tone,
            detail:
              status.tone === "ok" ? "容器处于可交互状态。" : "当前不是活跃运行态，部分功能可能受限。",
          },
          {
            label: "Agent 输入",
            value: detail.agentEnabled ? "已配置" : "未配置",
            tone: detail.agentEnabled ? "ok" : "warn",
            detail: detail.agentEnabled ? "活动页可直接发送 Agent 提示词。" : "当前会话不支持 Agent 模式。",
          },
          { label: "Resume 健康", value: resume.value, tone: resume.tone, detail: resume.detail },
          {
            label: "镜像版本",
            value: imageVersionValid ? "格式正常" : "格式异常",
            tone: imageVersionValid ? "ok" : "danger",
            detail: detail.applied.imageVersion
              ? `当前值：${detail.applied.imageVersion}。建议保持 x.y.z-后缀 格式，便于 manyoyo 的版本校验。`
              : "缺少 imageVersion，manyoyo 的版本校验会失效。",
          },
          {
            label: "工作目录映射",
            value: workdirConfigured ? "已配置" : "缺失",
            tone: workdirConfigured ? "ok" : "danger",
            detail: workdirConfigured
              ? "宿主目录与容器目录都已配置。"
              : "hostPath / containerPath 是容器会话最关键的上下文。",
          },
        ]}
      />
      {detail.lastResumeError ? (
        <InfoCard
          title="最近问题"
          rows={[{ label: "Resume 错误", value: "有错误输出", tone: "danger", detail: detail.lastResumeError }]}
        />
      ) : null}
    </div>
  )
}

// 与旧版前端"配置"标签页对齐：基础配置 / 路径与资源 / 命令与 Agent
function ConfigView({ detail }: { detail: SessionDetail | null }) {
  if (!detail) return <EmptyPane text="请先选择左侧的容器 / AGENT" />

  const applied = detail.applied
  const templateSourceLabel = TEMPLATE_SOURCE_LABELS[detail.agentPromptSource] || "未配置"
  const commandRows: InfoRow[] = []
  if (applied.shellPrefix) commandRows.push({ label: "shellPrefix", value: applied.shellPrefix })
  if (applied.shell) commandRows.push({ label: "shell", value: applied.shell })
  if (applied.shellSuffix) commandRows.push({ label: "shellSuffix", value: applied.shellSuffix })
  if (applied.defaultCommand && applied.defaultCommand !== applied.shell) {
    commandRows.push({ label: "启动命令", value: applied.defaultCommand })
  } else if (!applied.shell) {
    commandRows.push({ label: "启动命令", value: applied.defaultCommand || "—" })
  }
  commandRows.push({ label: "Agent 模板", value: detail.agentPromptCommand || "—" })
  commandRows.push({ label: "模板来源", value: templateSourceLabel })
  commandRows.push({ label: "yolo", value: applied.yolo || "—" })

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      <InfoCard
        title="基础配置"
        rows={[
          { label: "AGENT", value: detail.agentName || detail.name || "—" },
          { label: "containerName", value: applied.containerName || detail.containerName || "—" },
          { label: "imageName", value: applied.imageName || detail.image || "—" },
          { label: "imageVersion", value: applied.imageVersion || "—" },
          { label: "containerMode", value: applied.containerMode || "default" },
        ]}
      />
      <InfoCard
        title="路径与资源"
        rows={[
          { label: "hostPath", value: applied.hostPath || "—" },
          { label: "containerPath", value: applied.containerPath || "—" },
          { label: "env 数量", value: String(applied.envCount || 0) },
          { label: "volume 数量", value: String(applied.volumeCount || 0) },
          { label: "port 数量", value: String(applied.portCount || 0) },
        ]}
      />
      <InfoCard title="命令与 Agent" rows={commandRows} />
    </div>
  )
}

// 与旧版前端"详情"标签页对齐：会话概览 / Agent 运行 / 用量统计 / 最近活动
function DetailView({ detail }: { detail: SessionDetail | null }) {
  if (!detail) return <EmptyPane text="请先选择左侧的容器 / AGENT" />

  const status = statusInfo(detail.status)
  const resume = resumeStatus(detail)
  const templateSourceLabel = TEMPLATE_SOURCE_LABELS[detail.agentPromptSource] || "未配置"
  const latestRoleLabel = ROLE_LABELS[detail.latestRole] || "暂无"
  const latestTimestampText = detail.latestTimestamp ? formatTime(detail.latestTimestamp) : "暂无"

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      <InfoCard
        title="会话概览"
        rows={[
          { label: "AGENT", value: detail.agentName || detail.name },
          { label: "容器", value: detail.containerName || "—" },
          { label: "状态", value: status.label, tone: status.tone },
          { label: "镜像", value: detail.image || detail.applied.imageName || "—" },
          { label: "最近更新", value: detail.updatedAt ? formatTime(detail.updatedAt) : "—" },
          { label: "消息数", value: String(detail.messageCount || 0) },
        ]}
      />
      <InfoCard
        title="Agent 运行"
        rows={[
          { label: "已启用", value: detail.agentEnabled ? "是" : "否", tone: detail.agentEnabled ? "ok" : "warn" },
          { label: "程序", value: detail.agentProgram || "—" },
          { label: "模板来源", value: templateSourceLabel },
          {
            label: "支持 resume",
            value: detail.resumeSupported ? "是" : "否",
            tone: detail.resumeSupported ? "ok" : "warn",
          },
          { label: "最近 resume", value: detail.lastResumeAt ? formatTime(detail.lastResumeAt) : "暂无" },
          {
            label: "最近结果",
            value: detail.lastResumeOk == null ? "暂无" : detail.lastResumeOk ? "成功" : "失败",
            tone: detail.lastResumeOk == null ? "info" : detail.lastResumeOk ? "ok" : "danger",
          },
        ]}
      />
      <InfoCard
        title="用量统计"
        rows={
          detail.usageTotal
            ? [
                { label: "累计输入 tokens", value: String(detail.usageTotal.inputTokens) },
                { label: "累计输出 tokens", value: String(detail.usageTotal.outputTokens) },
                {
                  label: "累计花费",
                  value:
                    typeof detail.usageTotal.costUsd === "number"
                      ? `$${detail.usageTotal.costUsd.toFixed(4)}`
                      : "暂不支持",
                },
              ]
            : [
                {
                  label: "状态",
                  value: "暂无数据",
                  tone: "info",
                  detail: "当前 Agent 程序不支持用量统计，或还未执行过对话。",
                },
              ]
        }
      />
      <InfoCard
        title="最近活动"
        rows={[
          { label: "最近角色", value: latestRoleLabel },
          { label: "最近时间", value: latestTimestampText },
          { label: "resume 状态", value: resume.value, tone: resume.tone },
        ]}
      />
    </div>
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
  const isMobile = useIsMobile()
  const [optionsOpen, setOptionsOpen] = React.useState(false)
  // 与旧版前端一致：Agent 模式下，如果当前会话本身不支持 Agent 输入，禁用发送
  const agentUnavailable = mode === "agent" && Boolean(session) && !session?.agentEnabled
  const archived = Boolean(session?.archived)
  const inputDisabled = disabled || agentUnavailable || archived

  return (
    <div className="border-t p-3">
      <Textarea
        placeholder={
          disabled
            ? "请先在左侧选择一个容器 / AGENT"
            : archived
              ? "该 AGENT 已被删除，仅可查看历史消息"
              : agentUnavailable
              ? "当前会话不支持 Agent 模式"
              : mode === "command"
                ? "输入容器命令，例如: ls -la"
                : "输入要发给 AGENT 的内容"
        }
        className="min-h-16 resize-none"
        value={draft}
        disabled={inputDisabled}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          // 输入法组词期间的 Enter（选字确认）不应触发发送
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return
          // 窄屏：Enter 始终换行，发送需点击发送按钮
          if (isMobile) return
          // Shift+Enter / Alt+Enter 换行，其余 Enter 发送
          if (event.shiftKey || event.altKey) return
          event.preventDefault()
          if (!sending && !inputDisabled) onSend()
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <Popover open={optionsOpen} onOpenChange={setOptionsOpen}>
          <PopoverTrigger render={<Button variant="outline" className="px-4" disabled={disabled} />}>
            选项
          </PopoverTrigger>
          <PopoverContent align="start" className="w-44 p-1">
            <div className="flex flex-col gap-1">
              <Button
                variant={mode === "agent" ? "secondary" : "ghost"}
                size="sm"
                className="justify-start"
                onClick={() => {
                  onModeChange("agent")
                  setOptionsOpen(false)
                }}
              >
                Agent对话
              </Button>
              <Button
                variant={mode === "command" ? "secondary" : "ghost"}
                size="sm"
                className="justify-start"
                onClick={() => {
                  onModeChange("command")
                  setOptionsOpen(false)
                }}
              >
                系统命令
              </Button>
              <Separator className="my-1" />
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                disabled={!session || archived}
                onClick={() => {
                  onOpenCliTemplate()
                  setOptionsOpen(false)
                }}
              >
                CLI · {session?.agentProgram || "未设置"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="justify-start"
                disabled={!session || archived}
                onClick={() => {
                  onOpenModel()
                  setOptionsOpen(false)
                }}
              >
                模型 · {session?.model || "跟随默认"}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        {sending ? (
          <Button variant="destructive" className="px-4" onClick={onStop}>
            停止
          </Button>
        ) : (
          <Button className="px-4" onClick={onSend} disabled={inputDisabled}>
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
  filesEditorRef,
  confirmLeaveIfDirty,
  creatingAgent,
}: {
  activeSession: SessionSummary | null
  onAfterSend: () => void
  filesEditorRef: React.RefObject<FilesEditorState | null>
  confirmLeaveIfDirty: () => Promise<boolean>
  creatingAgent: boolean
}) {
  const [view, setView] = React.useState<View>("activity")
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [messagesLoading, setMessagesLoading] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const [mode, setMode] = React.useState<"agent" | "command">("agent")
  const [switcherOpen, setSwitcherOpen] = React.useState(false)
  // 按会话名记录"本标签页正在为哪些会话跑 stream"，而不是单个全局布尔值——
  // 否则切到另一个 agent 时，输入框/发送按钮会继续显示上一个 agent 的状态
  const [sendingNames, setSendingNames] = React.useState<Set<string>>(() => new Set())
  const [loadError, setLoadError] = React.useState("")
  const [cliDialogOpen, setCliDialogOpen] = React.useState(false)
  const [modelDialogOpen, setModelDialogOpen] = React.useState(false)
  const [sessionDetail, setSessionDetail] = React.useState<SessionDetail | null>(null)
  const [htmlPreview, setHtmlPreview] = React.useState<HtmlPreviewState>(null)

  const activeSessionNameRef = React.useRef<string | null>(activeSession?.name ?? null)
  React.useEffect(() => {
    activeSessionNameRef.current = activeSession?.name ?? null
  }, [activeSession?.name])

  const sending = activeSession ? sendingNames.has(activeSession.name) : false

  // 文件编辑器有未保存修改时，切走顶部标签会直接丢弃 FilesPanel 的编辑状态
  // （非 files 视图不渲染 FilesPanel），所以要在真正 setView 之前先拦一次
  async function changeView(next: View) {
    if (view === next) return
    if (view === "files" && !(await confirmLeaveIfDirty())) return
    setView(next)
  }

  function setSendingFor(name: string, value: boolean) {
    setSendingNames((prev) => {
      const next = new Set(prev)
      if (value) next.add(name)
      else next.delete(name)
      return next
    })
  }

  const loadMessages = React.useCallback(
    (silent?: boolean) => {
      if (!activeSession) {
        setMessages([])
        setMessagesLoading(false)
        return Promise.resolve()
      }
      if (!silent) {
        setLoadError("")
        setMessagesLoading(true)
      }
      return apiGet(`/api/sessions/${encodeURIComponent(activeSession.name)}/messages`)
        .then((data) => {
          setMessages(Array.isArray(data.messages) ? (data.messages as ChatMessage[]) : [])
        })
        .catch((err) => {
          if (!silent) setLoadError(err instanceof Error ? err.message : "加载消息失败")
        })
        .finally(() => {
          if (!silent) setMessagesLoading(false)
        })
    },
    [activeSession?.name]
  )

  const loadDetail = React.useCallback(() => {
    if (!activeSession) {
      setSessionDetail(null)
      return Promise.resolve()
    }
    return apiGet(`/api/sessions/${encodeURIComponent(activeSession.name)}/detail`)
      .then((data) => setSessionDetail((data.detail as SessionDetail) || null))
      .catch(() => {
        // 静默失败：检查/配置/详情页保留上一次成功加载的数据
      })
  }, [activeSession?.name])

  React.useEffect(() => {
    loadMessages()
    loadDetail()
  }, [loadMessages, loadDetail])

  // 与旧版前端 scheduleAgentRecoveryPoll 对齐：刷新页面/切回会话后，如果后端
  // 仍在跑一次 Agent 回合（消息里还留着 pending 记录），持续轮询直到它结束；
  // 但如果本标签页自己正在为这个会话跑 stream，则不需要（也不应该）叠加轮询
  useAgentRecoveryPoll(
    activeSession,
    messages,
    React.useCallback(async () => {
      await Promise.all([loadMessages(true), loadDetail()])
    }, [loadMessages, loadDetail]),
    sending
  )

  async function handleSend() {
    const text = draft.trim()
    if (!text || !activeSession || sendingNames.has(activeSession.name)) return
    const name = activeSession.name
    // 流式回调是异步触发的，期间用户可能已经切换到别的 agent——
    // 用这个判断把消息更新限制在"仍然是当前活动会话"的情况下，避免串台
    const isStillActive = () => activeSessionNameRef.current === name
    setDraft("")
    setLoadError("")
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", content: text, timestamp: new Date().toISOString(), mode },
    ])

    if (mode === "command") {
      setSendingFor(name, true)
      try {
        const data = await apiPost(`/api/sessions/${encodeURIComponent(name)}/run`, { command: text })
        if (isStillActive()) {
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
        }
      } catch (err) {
        if (isStillActive()) setLoadError(err instanceof Error ? err.message : "命令执行失败")
      } finally {
        setSendingFor(name, false)
        onAfterSend()
        if (isStillActive()) loadDetail()
      }
      return
    }

    setSendingFor(name, true)
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
        mode: "agent",
      },
      {
        id: STREAMING_MESSAGE_ID,
        role: "assistant",
        content: "",
        timestamp: new Date().toISOString(),
        pending: true,
        mode: "agent",
      },
    ])
    try {
      await apiStream(`/api/sessions/${encodeURIComponent(name)}/agent/stream`, { prompt: text }, (event) => {
        if (!isStillActive()) return
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
      if (isStillActive()) {
        setLoadError(err instanceof Error ? err.message : "发送失败")
        setMessages((prev) =>
          prev.filter(
            (message) => message.id !== STREAMING_MESSAGE_ID && message.id !== STREAMING_TRACE_ID
          )
        )
      }
    } finally {
      setSendingFor(name, false)
      onAfterSend()
      if (isStillActive()) loadDetail()
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
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-4!" />
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant={view === "activity" ? "secondary" : "ghost"}
            size="sm"
            aria-current={view === "activity"}
            onClick={() => changeView("activity")}
          >
            聊天
          </Button>
          <Button
            variant={view === "files" ? "secondary" : "ghost"}
            size="sm"
            aria-current={view === "files"}
            onClick={() => changeView("files")}
          >
            文件
          </Button>
          <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
            <PopoverTrigger
              render={<Button variant="ghost" size="icon-sm" title="更多标签页" />}
            >
              <EllipsisIcon />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-36 p-1">
              <div className="flex flex-col gap-1">
                {OTHER_VIEWS.map((key) => (
                  <Button
                    key={key}
                    variant={view === key ? "secondary" : "ghost"}
                    size="sm"
                    className="justify-start"
                    aria-current={view === key}
                    onClick={() => {
                      changeView(key)
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
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-medium">
          <span className="truncate">
            {activeSession
              ? `${activeSession.containerRemark || activeSession.containerName} · ${activeSession.agentRemark || activeSession.agentName}`
              : "选择左侧的容器 / AGENT 开始"}
          </span>
          {activeSession?.archived ? (
            <Badge variant="outline" className="shrink-0">
              已停止
            </Badge>
          ) : null}
        </span>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden">
        {creatingAgent ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <Spinner className="size-6" />
            <p className="text-sm text-muted-foreground">正在创建 AGENT...</p>
          </div>
        ) : view === "activity" ? (
          messagesLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-6" />
            </div>
          ) : (
            <ActivityView
              key={activeSession?.name ?? "none"}
              session={activeSession}
              messages={messages}
              mode={mode}
              onPreviewHtml={(title, code) => setHtmlPreview({ title, code })}
            />
          )
        ) : null}
        {view === "terminal" ? <TerminalView session={activeSession} /> : null}
        {view === "files" ? (
          <FilesPanel
            activeSession={activeSession}
            editorStateRef={filesEditorRef}
            confirmLeaveIfDirty={confirmLeaveIfDirty}
            onPreviewHtml={(title, code) => setHtmlPreview({ title, code })}
          />
        ) : null}
        {view === "detail" ? <DetailView detail={sessionDetail} /> : null}
        {view === "config" ? <ConfigView detail={sessionDetail} /> : null}
        {view === "check" ? <CheckView detail={sessionDetail} /> : null}
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
          disabled={!activeSession || messagesLoading}
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
        onSaved={() => {
          onAfterSend()
          loadDetail()
        }}
      />
      <ModelDialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
        session={activeSession}
        onSaved={() => {
          onAfterSend()
          loadDetail()
        }}
      />
      <HtmlPreviewPanel
        state={htmlPreview}
        onOpenChange={(open) => {
          if (!open) setHtmlPreview(null)
        }}
      />
    </div>
  )
}
