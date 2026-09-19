import * as React from "react"
import { CheckIcon, CopyIcon, EllipsisIcon, SendIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  apiGet,
  apiPost,
  apiStream,
  applyServerMessageIds,
  applyTraceEventUpdate,
  formatComposerModeLabel,
  isStreamConnectionError,
  LOCAL_USER_MESSAGE_ID_PREFIX,
  mergeTraceIntoReply,
  removeLocalPendingPlaceholders,
  resolveComposerBlockReason,
  shouldDismissRecoveryNotice,
  shouldDiscardMessagesResponse,
  STREAMING_MESSAGE_ID,
  STREAMING_TRACE_ID,
  type ChatMessage,
  type SessionDetail,
  type SessionSummary,
  type TraceEvent,
} from "@/lib/api"
import { useAgentRecoveryPoll } from "@/hooks/use-agent-recovery-poll"
import { isNearBottom } from "@/lib/chat-behavior"
import { markdownToPlainText } from "@/lib/markdown-text"
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

// 页面可见时的多设备/多标签页同步轮询：间隔与空闲超时，见下方 reconcile 相关 effect
const SYNC_POLL_INTERVAL_MS = 6000
const SYNC_POLL_IDLE_TIMEOUT_MS = 10 * 60 * 1000

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

// markdown 为 undefined 时（用户输入 / 命令输出等非 markdown 消息）只提供一种
// 复制方式，跟旧版一致；assistant 的 markdown 回复额外提供"复制文本"/"复制
// Markdown"两个选项，对齐旧版 app.js 里 markdownNode.innerText 与 msg.content 的区分
function CopyMessageButton({ text, markdown }: { text: string; markdown?: string }) {
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板权限被拒绝时静默失败，不打断阅读
    }
    setOpen(false)
  }

  if (markdown === undefined) {
    return (
      <button
        type="button"
        onClick={() => copy(text)}
        title="复制"
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title="复制"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          />
        }
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-32 p-1">
        <div className="flex flex-col gap-1">
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => copy(text)}>
            复制文本
          </Button>
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => copy(markdown)}>
            复制 Markdown
          </Button>
        </div>
      </PopoverContent>
    </Popover>
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
    stickToBottomRef.current = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
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
                        : message.mode === "command"
                          // 命令模式的回复是原始命令输出，不是被动的系统提示——
                          // 走跟 assistant 一样的正常气泡，只是下面不做 markdown 渲染
                          ? "bg-muted/40 whitespace-pre-wrap text-foreground"
                          : message.role === "system"
                            ? "bg-transparent whitespace-pre-wrap text-muted-foreground italic"
                            : "bg-muted/40 text-foreground",
                      message.pending && "opacity-70"
                    )}
                  >
                    {message.role === "assistant" ? (
                      // 流式期间只展示纯文本，避免每个 token 到达都触发一次全量
                      // marked.parse + DOMPurify.sanitize（性能开销 + 未闭合代码块/
                      // 标签导致的渲染抖动）；流结束后再一次性走 markdown 渲染，
                      // 与旧版前端 shouldRenderMarkdown 的思路一致
                      message.pending ? (
                        <div className="whitespace-pre-wrap">{message.content || "…"}</div>
                      ) : (
                        <MarkdownContent
                          content={message.content || ""}
                          onPreviewHtml={(code) => onPreviewHtml("聊天中的 HTML 代码块", code)}
                        />
                      )
                    ) : (
                      message.content || (message.pending ? "…" : "")
                    )}
                  </div>
                  <span className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
                    {formatTime(message.timestamp)}
                    {message.interrupted ? " · 已停止" : ""}
                    {message.content && !message.pending ? (
                      message.role === "assistant" ? (
                        <CopyMessageButton
                          text={markdownToPlainText(message.content)}
                          markdown={message.content}
                        />
                      ) : (
                        <CopyMessageButton text={message.content} />
                      )
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
    // 子项必须 shrink-0：flex 子项默认可压缩，卡片会被压扁到刚好塞满容器，
    // 容器因此认为"没有溢出"而不出滚动条，卡片内部内容却被裁掉看不见
    // （移动端高度有限时尤其明显）
    <div className="flex h-full flex-col gap-3 overflow-auto p-4 [&>*]:shrink-0">
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
    // 子项必须 shrink-0：flex 子项默认可压缩，卡片会被压扁到刚好塞满容器，
    // 容器因此认为"没有溢出"而不出滚动条，卡片内部内容却被裁掉看不见
    // （移动端高度有限时尤其明显）
    <div className="flex h-full flex-col gap-3 overflow-auto p-4 [&>*]:shrink-0">
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
    // 子项必须 shrink-0：flex 子项默认可压缩，卡片会被压扁到刚好塞满容器，
    // 容器因此认为"没有溢出"而不出滚动条，卡片内部内容却被裁掉看不见
    // （移动端高度有限时尤其明显）
    <div className="flex h-full flex-col gap-3 overflow-auto p-4 [&>*]:shrink-0">
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
  // 拦截理由集中在 resolveComposerBlockReason 里算（含容器级运行锁：同容器别的
  // AGENT 在跑时这个 AGENT 也发不出去，提前禁用而不是点了才吃 409）
  const blockReason = session ? resolveComposerBlockReason(session, mode) : ""
  const archived = Boolean(session?.archived)
  const inputDisabled = disabled || blockReason !== ""
  // 空输入/纯空白时发送按钮直接置灰，而不是点了没反应
  const sendDisabled = inputDisabled || draft.trim() === ""

  return (
    <div className="border-t p-3">
      <Textarea
        placeholder={
          disabled
            ? "请先在左侧选择一个容器 / AGENT"
            : blockReason === "archived"
              ? "该 AGENT 已被删除，仅可查看历史消息"
              : blockReason === "container-busy"
                ? "同容器的另一个 AGENT 正在执行任务，请等它结束或先停止"
                : blockReason === "agent-unavailable"
                  ? "当前会话未配置 CLI，点「选项 → CLI」设置后即可对话"
                  : mode === "command"
                    ? "输入容器命令，例如: ls -la"
                    : "输入要发给 AGENT 的内容"
        }
        // Textarea 自带 field-sizing-content（跟着内容自动长高）但没有上限，
        // 粘进几十行就会把聊天内容整个顶出屏幕。加一个高度上限，超出后内部滚动
        className="max-h-[40vh] min-h-16 resize-none overflow-y-auto"
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
          {/* 模式必须常驻可见：只靠输入框 placeholder 提示的话，一打字就看不见了，
              很容易在"系统命令"模式下把整段话当 shell 命令发出去 */}
          <PopoverTrigger
            render={
              <Button
                variant={mode === "command" ? "secondary" : "outline"}
                className="px-4"
                disabled={disabled}
              />
            }
          >
            {formatComposerModeLabel(mode)}
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
          <Button className="px-4" onClick={onSend} disabled={sendDisabled}>
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
  const activeSessionName = activeSession?.name ?? null
  // 终端一旦打开就常驻：切到聊天/文件等标签只是隐藏，不卸载——卸载会关掉
  // WebSocket，容器里那个 shell 随之被回收，切回来只能是个全新的 shell，
  // 正在跑的命令和屏幕内容全没了。这个状态记的是"终端当前挂在哪个会话上"，
  // 离开终端标签后靠它判断该不该继续保活；换了会话就清空，免得回到原会话时
  // 在后台又悄悄开一个没人要的 shell（还会顺带把容器拉起来）
  const [terminalSessionName, setTerminalSessionName] = React.useState<string | null>(null)
  // 标签页与当前会话都由外部（props / 上层状态）驱动，只能在 effect 里对账；
  // 值没变时 setState 会被 React 直接短路，不会引起额外渲染
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTerminalSessionName((prev) => {
      if (view === "terminal") return activeSessionName
      return prev === activeSessionName ? prev : null
    })
  }, [view, activeSessionName])
  // 消息按会话名隔离，而不是单一全局数组：流式回调各自更新自己会话的 key，
  // 用户在 A 会话跑长任务时切到 B 再切回 A，A 的实时流式状态（用户消息、执行
  // 过程、增量回复）原样还在——单一数组在切换时会被加载响应覆盖，本地流式
  // 占位随之丢失，表现为"切回来界面空白，直到任务跑完才恢复"
  const [messagesBySession, setMessagesBySession] = React.useState<Record<string, ChatMessage[]>>({})
  const [messagesLoading, setMessagesLoading] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const [mode, setMode] = React.useState<"agent" | "command">("agent")
  const [switcherOpen, setSwitcherOpen] = React.useState(false)
  // 按会话名记录"本标签页正在为哪些会话跑 stream"，而不是单个全局布尔值——
  // 否则切到另一个 agent 时，输入框/发送按钮会继续显示上一个 agent 的状态
  const [sendingNames, setSendingNames] = React.useState<Set<string>>(() => new Set())
  const [loadError, setLoadError] = React.useState("")
  // 当前这条 loadError 是不是"连接断了但服务端还在跑"——是的话等 pending 消失
  // （useAgentRecoveryPoll 把这一轮收尾）就自动撤掉提示，不要一直挂在输入框上方
  const [loadErrorRecoverable, setLoadErrorRecoverable] = React.useState(false)
  const showLoadError = React.useCallback((message: string, recoverable = false) => {
    setLoadError(message)
    setLoadErrorRecoverable(message ? recoverable : false)
  }, [])
  // 每成功套用一次服务端消息快照就 +1。断线提示要等"断线之后至少对账过一次"
  // 才允许自动撤掉，否则本地占位刚被清掉、服务端快照还没回来的那一瞬间
  // pending 恰好是空的，提示会一闪而过
  const [messagesSyncTick, setMessagesSyncTick] = React.useState(0)
  const messagesSyncTickRef = React.useRef(0)
  const recoverableErrorSyncTickRef = React.useRef(-1)
  const [cliDialogOpen, setCliDialogOpen] = React.useState(false)
  const [modelDialogOpen, setModelDialogOpen] = React.useState(false)
  const [sessionDetail, setSessionDetail] = React.useState<SessionDetail | null>(null)
  const [htmlPreview, setHtmlPreview] = React.useState<HtmlPreviewState>(null)

  const activeSessionNameRef = React.useRef<string | null>(activeSession?.name ?? null)
  React.useEffect(() => {
    activeSessionNameRef.current = activeSession?.name ?? null
  }, [activeSession?.name])

  // sendingNames 变化很频繁（任意会话开始/结束发送都会触发），各个 effect 不想
  // 因此反复重建，统一通过这个 ref 读最新值；声明在 loadMessages 之前，供其
  // 响应回写时校验"请求期间状态是否已变化"
  const sendingNamesRef = React.useRef(sendingNames)
  React.useEffect(() => {
    sendingNamesRef.current = sendingNames
  }, [sendingNames])

  // 切换 AGENT 时清空未发送的草稿——否则在 A 会话里打的字会原样留在输入框，
  // 切到 B 会话后如果没注意到就直接点发送，会把 A 的草稿当成 B 的消息发出去。
  // 发送模式同理必须一起重置：在 A 里切到"系统命令"后切到 B，B 也会停在系统命令，
  // 用户以为在跟 agent 说话，实际整段文字被当 shell 命令丢进容器执行
  React.useEffect(() => {
    setDraft("")
    setMode("agent")
  }, [activeSession?.name])

  const activeSessionMessages = activeSession ? messagesBySession[activeSession.name] : undefined
  // 已有该会话的消息快照（哪怕是空数组）：切换回来时先立即显示缓存内容，
  // 后台刷新到位后无感更新——而不是先转一圈加载 Spinner 把界面闪空白
  const hasCachedMessages = activeSessionMessages !== undefined
  const messages = activeSessionMessages ?? []
  // 更新某个会话的消息：流式回调在会话切换后仍持续维护自己会话的状态，
  // 所以这里按 name 定位，而不是操作"当前活动会话"
  const setSessionMessages = React.useCallback(
    (name: string, updater: (prev: ChatMessage[]) => ChatMessage[]) => {
      setMessagesBySession((prev) => {
        const next = updater(prev[name] ?? [])
        if (next === prev[name]) return prev
        return { ...prev, [name]: next }
      })
    },
    []
  )

  const sending = activeSession ? sendingNames.has(activeSession.name) : false
  // 与旧版前端 hasPendingAgentMessagesForSession 对齐：composer 是否可用不能只看
  // 本标签页这一次 fetch 有没有结束——网络抖动/标签页节流可能让本地 stream 提前
  // 断开，但服务端那一轮 agent 任务（尤其是耗时更长的多 agent / 子 agent 任务）
  // 其实还在跑，这时消息列表里会留着一条 pending 的 agent 回复，据此继续禁用输入
  const activeAgentRunning =
    sending || messages.some((message) => message.mode === "agent" && message.pending === true)

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
        setMessagesLoading(false)
        return Promise.resolve()
      }
      if (!silent) {
        showLoadError("")
        setMessagesLoading(true)
      }
      return apiGet(`/api/sessions/${encodeURIComponent(activeSession.name)}/messages`)
        .then((data) => {
          // 请求发出后状态可能已变：切到了别的会话（防串台）、或本标签页开始了
          // 该会话的流式发送（晚到的旧快照会覆盖掉刚显示的乐观 user 消息，
          // 用户表现为"发出去的提示词不立刻出现/消失"）——这两种响应直接丢弃
          if (
            shouldDiscardMessagesResponse(
              activeSession.name,
              activeSessionNameRef.current,
              sendingNamesRef.current.has(activeSession.name)
            )
          ) {
            return
          }
          setSessionMessages(
            activeSession.name,
            () => (Array.isArray(data.messages) ? (data.messages as ChatMessage[]) : [])
          )
          messagesSyncTickRef.current += 1
          setMessagesSyncTick(messagesSyncTickRef.current)
        })
        .catch((err) => {
          if (!silent) showLoadError(err instanceof Error ? err.message : "加载消息失败")
        })
        .finally(() => {
          if (!silent) setMessagesLoading(false)
        })
    },
    // 依赖 activeSession?.name 而非整个对象：会话列表刷新会产生新的对象引用
    // （同一个会话名），依赖整个对象会导致这个 callback 频繁重建、进而让下面
    // 依赖它的 effect 反复重新加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSession?.name, setSessionMessages]
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.name])

  React.useEffect(() => {
    queueMicrotask(() => {
      loadMessages()
      loadDetail()
    })
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

  // "连接中断，正在重新同步"只在真的还没同步上的时候才有意义：一旦断线后成功
  // 跟服务端对上一次账（内容已经在正常刷新了），提示就该自己撤掉，不必等整轮
  // 任务跑完——长任务里那条红色告警会一直挂在输入框上方好几分钟
  React.useEffect(() => {
    if (
      !shouldDismissRecoveryNotice({
        recoverable: loadErrorRecoverable,
        sending,
        syncTick: messagesSyncTick,
        errorSyncTick: recoverableErrorSyncTickRef.current,
      })
    ) {
      return
    }
    showLoadError("")
  }, [loadErrorRecoverable, sending, messagesSyncTick, showLoadError])

  // 与旧版前端 visibilitychange/focus 触发的对账对齐，并补上多设备/多标签页
  // 同时打开同一会话的同步：只靠 visibilitychange/focus 事件只能覆盖"从隐藏切回
  // 可见"这一次状态跳变——如果手机和电脑两个窗口同时摆在眼前、都没有失去过
  // 焦点，双方都不会触发任何事件，一边发的消息不会自动出现在另一边，必须手动
  // 刷新或者随便发点内容才会重新拉取。这里在页面可见期间加一个轻量轮询，同时
  // 用 SYNC_POLL_IDLE_TIMEOUT_MS 做空闲退避——超过这个时长没有任何用户操作就
  // 暂停轮询，避免忘记关掉的标签页无限期空转消耗流量；有新操作、或重新可见/
  // 聚焦会立刻恢复。本标签页正在为当前会话跑 stream 时跳过 loadMessages/loadDetail，
  // 避免用半途的服务端快照覆盖实时状态；侧栏（onAfterSend）不受此限制。
  React.useEffect(() => {
    let lastActivityAt = Date.now()
    function markActivity() {
      lastActivityAt = Date.now()
    }
    function reconcile() {
      if (document.visibilityState !== "visible") return
      onAfterSend()
      if (!activeSessionNameRef.current) return
      if (sendingNamesRef.current.has(activeSessionNameRef.current)) return
      loadMessages(true)
      loadDetail()
    }
    function onVisibleOrFocus() {
      markActivity()
      reconcile()
    }
    const activityEvents: Array<keyof WindowEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "touchstart",
      "scroll",
    ]
    activityEvents.forEach((type) => window.addEventListener(type, markActivity, { passive: true }))
    document.addEventListener("visibilitychange", onVisibleOrFocus)
    window.addEventListener("focus", onVisibleOrFocus)
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return
      if (Date.now() - lastActivityAt > SYNC_POLL_IDLE_TIMEOUT_MS) return
      reconcile()
    }, SYNC_POLL_INTERVAL_MS)
    return () => {
      activityEvents.forEach((type) => window.removeEventListener(type, markActivity))
      document.removeEventListener("visibilitychange", onVisibleOrFocus)
      window.removeEventListener("focus", onVisibleOrFocus)
      window.clearInterval(timer)
    }
  }, [loadMessages, loadDetail, onAfterSend])

  async function handleSend() {
    const text = draft.trim()
    if (!text || !activeSession || sendingNames.has(activeSession.name)) return
    const name = activeSession.name
    // 流式回调是异步触发的，期间用户可能已经切换到别的 agent。消息状态按会话
    // 隔离（setSessionMessages 按 name 定位），切走后回调仍持续维护原会话的
    // 实时状态；只有 loadError 这类"只属于当前视图"的提示才需要 isStillActive
    const isStillActive = () => activeSessionNameRef.current === name
    setDraft("")
    showLoadError("")
    setSessionMessages(name, (prev) => [
      ...prev,
      {
        id: `${LOCAL_USER_MESSAGE_ID_PREFIX}${Date.now()}`,
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
        mode,
      },
    ])

    if (mode === "command") {
      setSendingFor(name, true)
      try {
        const data = await apiPost(`/api/sessions/${encodeURIComponent(name)}/run`, { command: text })
        setSessionMessages(name, (prev) => [
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
        if (isStillActive()) showLoadError(err instanceof Error ? err.message : "命令执行失败")
      } finally {
        setSendingFor(name, false)
        onAfterSend()
        if (isStillActive()) loadDetail()
      }
      return
    }

    setSendingFor(name, true)
    const traceEvents: TraceEvent[] = []
    // meta 事件到达后会把这条占位消息的 id 从 STREAMING_TRACE_ID 换成服务端
    // 持久化 id（见下面 meta 分支），后续 trace/result 事件必须按这个"当前
    // 有效 id"去匹配 messages，不能再硬编码 STREAMING_TRACE_ID——否则换 id
    // 之后收到的每条 trace 事件都会静默丢失，traceEvents 永远停在初始空数组，
    // "执行过程"折叠面板因此永远不会出现，pending 也永远清不掉（停止按钮
    // 完成后不会变回发送）
    let traceMessageId: string | number = STREAMING_TRACE_ID
    setSessionMessages(name, (prev) => [
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
        if (event.type === "meta") {
          // 服务端为本轮 user/trace 消息预生成了持久化 id：第一时间把本地乐观占位
          // 换成服务端 id，之后轮询对账时 React key 才能对上，消息列表 DOM 不会
          // 整体重建（否则移动端代码块的横向滚动位置/文字选区会被清零）
          if (event.userMessageId !== undefined || event.traceMessageId !== undefined) {
            setSessionMessages(name, (prev) =>
              applyServerMessageIds(prev, {
                userMessageId: event.userMessageId,
                traceMessageId: event.traceMessageId,
              })
            )
            if (event.traceMessageId !== undefined) {
              traceMessageId = event.traceMessageId
            }
          }
        } else if (event.type === "trace") {
          if (event.traceEvent) traceEvents.push(event.traceEvent)
          setSessionMessages(name, (prev) =>
            applyTraceEventUpdate(prev, traceMessageId, { traceEvents: traceEvents.slice() })
          )
        } else if (event.type === "content_delta") {
          setSessionMessages(name, (prev) =>
            prev.map((message) =>
              message.id === STREAMING_MESSAGE_ID ? { ...message, content: event.content } : message
            )
          )
        } else if (event.type === "content_chunk") {
          // token 级增量：只发新增片段，这里做追加。reset 表示换了一条 assistant
          // 消息，从空白重新开始（与服务端 content_delta 的整条覆盖语义一致）
          setSessionMessages(name, (prev) =>
            prev.map((message) =>
              message.id === STREAMING_MESSAGE_ID
                ? { ...message, content: event.reset ? "" : `${message.content}${event.text}` }
                : message
            )
          )
        } else if (event.type === "result") {
          setSessionMessages(name, (prev) =>
            // 先按占位 id 完成本地字段更新，最后再统一把占位 id 换成服务端 id——
            // 顺序反了的话第二步就找不到要更新的消息了
            applyServerMessageIds(
              applyTraceEventUpdate(prev, traceMessageId, { pending: false })
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
                ),
              { replyMessageId: event.replyMessageId }
            )
          )
        } else if (event.type === "error") {
          if (isStillActive()) showLoadError(event.error)
          setSessionMessages(name, (prev) => removeLocalPendingPlaceholders(prev))
        }
      })
    } catch (err) {
      // 连接层断开（代理空闲超时把流掐了、网络抖动）时服务端那一轮其实还在容器里
      // 跑完，直接把浏览器的裸错误（Chrome 的 "network error" 等）贴出来会让人
      // 以为任务失败了。这里换成"正在重新同步"，并在下面 pending 消失后自动撤掉
      const recoverable = isStreamConnectionError(err)
      recoverableErrorSyncTickRef.current = messagesSyncTickRef.current
      if (isStillActive()) {
        showLoadError(
          recoverable
            ? "与服务端的实时连接中断，任务仍在容器里继续执行，正在重新同步…"
            : err instanceof Error ? err.message : "发送失败",
          recoverable
        )
      }
      // 请求没能在服务端落地（409 冲突 / 网络失败）：清除本轮全部本地占位
      //（含乐观 user 消息），否则会留下一条永远没有回复的幽灵消息
      setSessionMessages(name, (prev) => removeLocalPendingPlaceholders(prev))
      // 本地 stream 中断不代表服务端那一轮真的停了（可能只是网络抖动/标签页
      // 被节流）；删掉本地占位后立刻跟服务端对一次账，服务端如果仍在跑，
      // 返回的消息会带着 pending 标记，交给 useAgentRecoveryPoll 接手轮询
      loadMessages(true)
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
      showLoadError(err instanceof Error ? err.message : "停止失败")
    } finally {
      // 无论成功失败都立即对一次账：成功时服务端 patch 可能晚于 stop 响应
      //（useAgentRecoveryPoll 轮询兜底收尾）；失败（如 serve 重启后的孤儿
      // 任务 404）时服务端已把残留 pending 标记为中断，对账后输入随之解锁
      loadMessages(true)
      loadDetail()
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
          // 首次进入该会话（无缓存）才用加载态占位；切换回来时直接显示缓存的
          // 消息，后台刷新到位后无感更新——先转圈再弹内容会把界面闪空白
          messagesLoading && !hasCachedMessages ? (
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
        {terminalSessionName && terminalSessionName === activeSessionName ? (
          <div className={cn("h-full", view !== "terminal" && "hidden")}>
            <TerminalView key={terminalSessionName} session={activeSession} />
          </div>
        ) : null}
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
        // Alert 自带 w-full，配 mx-3 会算成"父容器满宽再往右推 12px"，右边缘顶出屏幕；
        // w-auto 交回给 margin 控制，左右才对称。
        // 断线重连是能自愈的状态，用默认样式即可，destructive 的红色留给真正的失败
        <Alert
          variant={loadErrorRecoverable ? "default" : "destructive"}
          className="mx-3 mb-2 w-auto min-w-0"
        >
          <AlertDescription className="break-words">{loadError}</AlertDescription>
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
          disabled={!activeSession || (messagesLoading && !hasCachedMessages)}
          sending={activeAgentRunning}
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
