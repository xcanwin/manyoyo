import * as React from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  CornerDownRightIcon,
  EllipsisIcon,
  Undo2Icon,
  ImagePlusIcon,
  ListEndIcon,
  MessageSquareIcon,
  SquareIcon,
  SquareTerminalIcon,
  XIcon,
  ZapIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  apiDelete,
  apiErrorData,
  apiGet,
  apiPost,
  apiStream,
  applyServerMessageIds,
  applyTraceEventUpdate,
  buildStreamMetaTraceEvents,
  formatComposerModeLabel,
  isStreamConnectionError,
  LOCAL_USER_MESSAGE_ID_PREFIX,
  mergeTraceIntoReply,
  messageRenderKey,
  removeLocalPendingPlaceholders,
  resolveComposerBlockReason,
  sessionDisplayTitle,
  shouldDismissRecoveryNotice,
  shouldDiscardMessagesResponse,
  STREAMING_MESSAGE_ID,
  STREAMING_TRACE_ID,
  toTraceEvent,
  type ChatMessage,
  type SessionDetail,
  type SessionSummary,
  type TraceEvent,
} from "@/lib/api"
import { useAgentRecoveryPoll } from "@/hooks/use-agent-recovery-poll"
import { useSessionSync } from "@/hooks/use-session-sync"
import { useSyncLoop } from "@/hooks/use-sync-loop"
import { useResumeIndicator } from "@/hooks/use-resume-indicator"
import { formatDateTime } from "@/lib/format"
import { anchoredScrollTop, computeScrollAnchor, computeScrollRestore, isFollowPaused, isOwnScroll, isScrollInput, getBubbleState, nextHasNewBelow, shouldLoadEarlier, type ScrollAnchor } from "@/lib/chat-behavior"
import {
  clearOutbox,
  createClientMessageId,
  decideOutboxRestore,
  getTabId,
  loadComposer,
  planRestore,
  purgeExpiredComposerData,
  saveDraft,
  type Outbox,
} from "@/lib/composer-store"
import {
  applyMessagesResponse,
  buildMessagesUrl,
  buildSyncQuery,
  firstServerMessageId,
  MESSAGES_PAGE_LIMIT,
  prependEarlierMessages,
  reconcileWithPage,
  shouldResetAfterSyncError,
  type MessagesQuery,
  type MessagesResponse,
} from "@/lib/message-sync"
import {
  beginSend,
  classifySendError,
  resolveFailedSend,
  type RestoredPrompt,
  type SendErrorKind,
} from "@/lib/send-flow"
import { markdownToPlainText } from "@/lib/markdown-text"
import {
  loadQueueWhen,
  parseQueue,
  QUEUE_WHEN_LABELS,
  QUEUE_WHEN_ORDER,
  saveQueueWhen,
  type QueueItem,
  type QueueWhen,
} from "@/lib/queue"
import { QueuedPrompts } from "@/components/queued-prompts"
import { ModelDeniedNotice } from "@/components/model-denied-notice"
import { ComposerImages } from "@/components/composer-images"
import { RewindDialog, type RewindResult } from "@/components/rewind-dialog"
import { useComposerImages, type ComposerImage } from "@/hooks/use-composer-images"
import { chatImageUrl, pickImageFiles } from "@/lib/chat-images"
import { findModelDenied } from "@/lib/model-denied"
import { buildRoundOptions } from "@/lib/rounds"
import { useIsMobile } from "@/hooks/use-mobile"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AgentTemplateDialog } from "@/components/agent-template-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { FilesPanel, type FilesEditorState } from "@/components/files-panel"
import { configLabel } from "@/lib/config-labels"
import { ChangesPanel } from "@/components/changes-panel"
import { useComposerSuggestions } from "@/components/composer-suggestions"
import { HtmlPreviewPanel, type HtmlPreviewState } from "@/components/html-preview-panel"
import { MarkdownContent } from "@/components/markdown-content"
import { ModelMenu } from "@/components/model-menu"
import { TerminalView } from "@/components/terminal-view"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { TRACE_ALIGN_EVENT, TraceBlock } from "@/components/trace-block"
import { ContainerManagePanel } from "@/components/container-manage/container-manage-panel"

import { Hint } from "@/components/hint"
type View = "activity" | "files" | "terminal" | "changes" | "container" | "config" | "detail"

const VIEW_LABELS: Record<View, string> = {
  activity: "聊天",
  files: "文件",
  terminal: "终端",
  changes: "改动",
  container: "设置容器",
  config: "容器详情",
  detail: "Agent详情",
}

// ⋯ 里按归属分两组：聊天属于 AGENT，文件、终端等属于它所在的容器
const AGENT_VIEWS: View[] = ["activity", "detail"]
const CONTAINER_VIEWS: View[] = ["files", "terminal", "changes", "container", "config"]

// visibilitychange 与 focus 几乎同时触发，窗口内只同步一次
const RESTORE_NOTICE_TEXT = "上次没发出去的内容已放回输入框"

type RestoreNotice =
  | { kind: "info" }
  | { kind: "text"; text: string }
  | { kind: "banner"; outbox: Outbox }
  // 断网后还不知道服务端有没有收到：保留待发箱，恢复联网后自动核对
  | { kind: "unknown"; outbox: Outbox }

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
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col divide-y">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {configLabel([row.label]).mono ? row.label : configLabel([row.label]).title}
                {configLabel([row.label]).mono ? null : <span className="ml-1.5 font-mono text-xs">{row.label}</span>}
              </span>
              {row.tone ? (
                <Badge variant={TONE_BADGE_VARIANT[row.tone]}>{row.value}</Badge>
              ) : (
                <span className="truncate text-sm font-medium">{row.value}</span>
              )}
            </div>
            {row.detail ? <Hint className="block">{row.detail}</Hint> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function formatTime(value: string): string {
  return formatDateTime(value)
}

// markdown 为 undefined 时（用户输入 / 命令输出等非 markdown 消息）只提供一种
// 复制方式；assistant 的 markdown 回复额外提供"复制文本"/"复制 Markdown"两个
// 选项，前者是渲染后的纯文本，后者是原始 markdown
function CopyMessageButton({ text, markdown }: { text: string; markdown?: string }) {
  const [copied, setCopied] = React.useState(false)

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板权限被拒绝时静默失败，不打断阅读
    }
  }

  if (markdown === undefined) {
    return (
      <button
        type="button"
        onClick={() => copy(text)}
        title="复制"
        aria-label="复制"
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title="复制"
            aria-label="复制"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          />
        }
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-36">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => copy(text)}>复制文本</DropdownMenuItem>
          <DropdownMenuItem onClick={() => copy(markdown)}>复制 Markdown</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ActivityView({
  session,
  messages,
  mode,
  onPreviewHtml,
  hasMore,
  loadingEarlier,
  onLoadEarlier,
  followSignal,
  tail,
  onOpenPath,
  onRewind,
}: {
  // 用户消息的操作：回退到这里；不传就没有这个按钮
  onRewind?: (message: ChatMessage) => void
  session: SessionSummary | null
  messages: ChatMessage[]
  mode: "agent" | "command"
  onPreviewHtml: (title: string, code: string) => void
  // 回复里的容器内路径被点击：交给文件面板打开
  onOpenPath: (path: string) => void
  hasMore: boolean
  loadingEarlier: boolean
  onLoadEarlier: () => void
  // 用户发送消息时加 1：发出去的消息和随后的回复一律跟到底部
  followSignal: number
  // 消息流底部的额外内容（排队中的提示词）
  tail?: React.ReactNode
}) {
  const displayMessages = React.useMemo(() => mergeTraceIntoReply(messages), [messages])
  const scrollRef = React.useRef<HTMLDivElement>(null)
  // 内容变化时贴着哪里（规则见 computeScrollAnchor）：默认固定不动，只往下追加；
  // 视野贴着内容底部或最新执行过程的底部时才跟随。只在滚动事件里重新判断——内容增长不改 scrollTop，
  // 所以“上一次滚动停下时贴着哪里”就是用户的意图
  const anchorRef = React.useRef<ScrollAnchor>("bottom")
  // 锚点是 "trace" 时贴的是哪一段执行过程（data-trace-key）：点“对齐到底部”的那一段，
  // 或滚动停下时视野底部贴着的那一段；找不到时按最新一段已展开的
  const pinnedTraceRef = React.useRef<string | null>(null)
  // 上次自己补滚动设置的位置：它引起的滚动事件不重新判断贴着哪里（见 isOwnScroll）
  const ownScrollTopRef = React.useRef<number | null>(null)
  // 用户正在滚动（滚轮 / 触摸 / 按键 / 拖滚动条）时（最近 1.5 秒内），内容变化不能把视野拉走；点击不算（见 isScrollInput）
  const lastScrollInputRef = React.useRef(0)

  // 加载更早的消息会在列表前面插入内容：记下插入前的内容高度，插入后把滚动位置补上
  // 新增的高度，视野停在原来的内容上不跳动。高度由 ResizeObserver 持续记录
  // （它在布局之后才回调，所以 layout effect 里读到的仍是插入前的值）
  const contentRef = React.useRef<HTMLDivElement>(null)
  const hasContent = displayMessages.length > 0
  const lastHeightRef = React.useRef(0)
  const firstIdRef = React.useRef<string | number | null>(null)
  const earlierRequestedRef = React.useRef(false)
  // 视野不在底部时内容又变长了：显示“↓ 有新输出”，点一下贴底（见 nextHasNewBelow）
  const [hasNewBelow, setHasNewBelow] = React.useState(false)
  // 只有任务在跑时内容变长才算“新输出”；用户点开执行过程等操作引起的变长不提示
  const runningRef = React.useRef(false)
  const running = displayMessages.some((message) => message.pending)
  React.useEffect(() => {
    runningRef.current = running
  }, [running])

  function jumpToBottom() {
    anchorRef.current = "bottom"
    pinnedTraceRef.current = null
    applyAnchor(true)
    setHasNewBelow(false)
  }

  function markScrollInput(type: "wheel" | "touch" | "key" | "pointer", onScroller = false) {
    if (isScrollInput(type, onScroller)) lastScrollInputRef.current = Date.now()
  }

  function traceBlockBottom(el: HTMLDivElement, block: HTMLElement): number {
    return block.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop
  }

  function latestOpenTrace(el: HTMLDivElement): HTMLElement | null {
    const blocks = el.querySelectorAll<HTMLElement>("[data-trace-block][data-open='true']")
    return blocks[blocks.length - 1] ?? null
  }

  // 被贴住的那一段执行过程（已展开）；没有指定就是最新一段已展开的。
  // 指定的那一段被收起或不在了就不再跟随（返回 null），不改去贴另一段
  function pinnedTrace(el: HTMLDivElement): HTMLElement | null {
    const key = pinnedTraceRef.current
    if (key === null) return latestOpenTrace(el)
    return Array.from(el.querySelectorAll<HTMLElement>("[data-trace-block][data-open='true']")).find((node) => node.dataset.traceKey === key) ?? null
  }

  // 只在用户滚动引起的滚动事件里调用：按停下的位置判断贴着哪里
  function measureAnchor(el: HTMLDivElement) {
    const latest = latestOpenTrace(el)
    anchorRef.current = computeScrollAnchor({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      traceBottom: latest ? traceBlockBottom(el, latest) : null,
    })
    pinnedTraceRef.current = anchorRef.current === "trace" && latest ? latest.dataset.traceKey ?? null : null
  }

  // 内容或视野尺寸变了：按贴着的位置补滚动。用户正在滚动或选中了文字时暂停（不补、也不改锚点），
  // 锚点只在滚动事件里重新判断——内容变化时重新判断会把“贴着”误判成“不贴着”，从此不再跟随
  function applyAnchor(force = false) {
    const el = scrollRef.current
    if (!el) return
    const selection = typeof window !== "undefined" ? window.getSelection() : null
    const hasSelection = Boolean(selection && !selection.isCollapsed && selection.anchorNode && el.contains(selection.anchorNode))
    if (!force && isFollowPaused({ now: Date.now(), lastScrollInputAt: lastScrollInputRef.current, hasSelection })) return
    const pinned = anchorRef.current === "trace" ? pinnedTrace(el) : null
    const target = anchoredScrollTop(anchorRef.current, {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      traceBottom: pinned ? traceBlockBottom(el, pinned) : null,
    })
    if (target !== null && Math.abs(el.scrollTop - target) >= 1) {
      el.scrollTop = target
      ownScrollTopRef.current = el.scrollTop
    }
  }

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    if (!isOwnScroll(el.scrollTop, ownScrollTopRef.current)) {
      ownScrollTopRef.current = null
      measureAnchor(el)
    }
    setHasNewBelow((prev) =>
      nextHasNewBelow(prev, { prevHeight: el.scrollHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight })
    )
    if (shouldLoadEarlier({ scrollTop: el.scrollTop, hasMore, loading: loadingEarlier })) {
      earlierRequestedRef.current = true
      onLoadEarlier()
    }
  }

  React.useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const firstId = displayMessages[0]?.id ?? null
    const prepended =
      earlierRequestedRef.current && firstIdRef.current !== null && firstId !== null && firstId !== firstIdRef.current
    firstIdRef.current = firstId
    if (prepended) {
      earlierRequestedRef.current = false
      el.scrollTop = computeScrollRestore({
        prevScrollHeight: lastHeightRef.current,
        nextScrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      })
      lastHeightRef.current = el.scrollHeight
      return
    }
    applyAnchor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayMessages])

  // 执行过程的“对齐到顶部 / 底部”按钮（见 trace-block 的 TRACE_ALIGN_EVENT）：
  // 底部 → 贴住这一段，之后它怎么变长都贴着；顶部 → 不再跟随，这一段的顶部停在窗口顶部
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onAlign = (event: Event) => {
      const { edge, key } = (event as CustomEvent<{ edge: "top" | "bottom"; key: string }>).detail
      const block = Array.from(el.querySelectorAll<HTMLElement>("[data-trace-block]")).find((node) => node.dataset.traceKey === key)
      if (!block) return
      if (edge === "bottom") {
        anchorRef.current = "trace"
        pinnedTraceRef.current = key
        applyAnchor(true)
        return
      }
      anchorRef.current = "none"
      pinnedTraceRef.current = null
      el.scrollTop += block.getBoundingClientRect().top - el.getBoundingClientRect().top
      ownScrollTopRef.current = el.scrollTop
    }
    el.addEventListener(TRACE_ALIGN_EVENT, onAlign)
    return () => el.removeEventListener(TRACE_ALIGN_EVENT, onAlign)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.name, hasContent])

  // 用户发送了消息：贴底并滚过去（发出去的消息、随后的执行过程和回复都要看得见）
  React.useLayoutEffect(() => {
    if (!followSignal) return
    anchorRef.current = "bottom"
    pinnedTraceRef.current = null
    applyAnchor(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followSignal])

  React.useEffect(() => {
    const content = contentRef.current
    const el = scrollRef.current
    if (!content || !el || typeof ResizeObserver === "undefined") return
    lastHeightRef.current = el.scrollHeight
    // 内容变高（执行过程补全、点开某一行、流式增长）和视野变矮（输入框变高、软键盘弹出）都要按贴着的位置补滚动，
    // 否则贴底时底部内容会被输入框挡住
    let lastWidth = el.clientWidth
    const observer = new ResizeObserver(() => {
      const prevHeight = lastHeightRef.current
      applyAnchor()
      lastHeightRef.current = el.scrollHeight
      // 宽度变了（转屏、拖侧栏）是重新排版变高，不是新输出：只按新位置判断要不要收起浮钮
      const widthChanged = el.clientWidth !== lastWidth
      lastWidth = el.clientWidth
      setHasNewBelow((prev) =>
        nextHasNewBelow(prev, {
          prevHeight: widthChanged || !runningRef.current ? el.scrollHeight : prevHeight,
          scrollHeight: el.scrollHeight,
          scrollTop: el.scrollTop,
          clientHeight: el.clientHeight,
        })
      )
    })
    observer.observe(content)
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.name, hasContent])

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
    <div className="relative h-full">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={() => markScrollInput("wheel")}
        onTouchStart={() => markScrollInput("touch")}
        onTouchMove={() => markScrollInput("touch")}
        onPointerDown={(event) => markScrollInput("pointer", event.target === event.currentTarget)}
        onKeyDown={() => markScrollInput("key")}
        data-chat-scroll
        className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain"
      >
        {/* 按聊天区自身宽度（而不是屏幕宽度）切档：侧栏占掉一部分宽度后，稍窄时气泡应接近铺满，只有宽屏才收成 75% */}
        <div ref={contentRef} className="@container flex flex-col gap-3 p-4">
          {hasMore ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={loadingEarlier}
                onClick={() => {
                  earlierRequestedRef.current = true
                  onLoadEarlier()
                }}
              >
                {loadingEarlier ? "加载中…" : "加载更早的消息"}
              </Button>
            </div>
          ) : null}
          {displayMessages.map((message) => {
            const bubble = getBubbleState(message)
            // 切换发送模式时，历史里"另一种模式"产生的消息整体变淡，突出当前模式的上下文
            const origin = message.mode === "agent" || message.mode === "command" ? message.mode : ""
            const dimmed = origin !== "" && origin !== mode
            // 正式回复还没抵达（比如切回一个仍在跑的会话）时，trace 消息会暂时
            // 落单、配对不上下一条回复——这时也要走结构化执行过程展示，不能把
            // 它当成一条普通回复，把裸的多行 content 直接当文本糊出来
            const standaloneTrace = message.streamTrace === true && !message.pairedTrace
            // 执行过程固定渲染在同一个位置、同一个 key 下（messageRenderKey）：配上回复、换成服务端 id 时不重新挂载
            const trace = message.pairedTrace ?? (standaloneTrace ? message : null)
            return (
              <React.Fragment key={messageRenderKey(message)}>
              <div
                className={cn(
                  "flex flex-col gap-1 transition-opacity",
                  message.role === "user" ? "items-end" : "items-start",
                  dimmed && "opacity-25"
                )}
              >
                {trace ? <TraceBlock trace={trace} sessionName={session.name} liveText={message.liveText} /> : null}
                {standaloneTrace || message.hideBubble ? null : (
                  <>
                    <div
                      data-reply={message.role === "assistant" ? "" : undefined}
                      className={cn(
                        // [overflow-wrap:anywhere]：超长无空格内容（长链接、哈希、一整行 W）在气泡里换行，
                        // 而不是把气泡撑出屏幕；流式输出期间的纯文本同样靠它。
                        // 行高 1.75 与 markdown 正文（.chat-markdown）一致：用户气泡、流式纯文本、
                        // 渲染后的回复同一种行距，流结束切到 markdown 时不跳动
                        "max-w-full rounded-xl px-3 py-2 text-sm leading-[1.75] [overflow-wrap:anywhere] @3xl:max-w-[75%]",
                        message.role === "user"
                          ? "max-w-[88%] bg-muted/80 text-foreground whitespace-pre-wrap @3xl:max-w-[75%]"
                          : message.mode === "command"
                            // 命令模式的回复是原始命令输出，不是被动的系统提示——
                            // 走跟 assistant 一样的正常气泡，只是下面不做 markdown 渲染；
                            // 等宽字体保证 ls -al 这类按列对齐的输出不错位
                            ? "bg-muted/40 font-mono text-[13px] leading-[1.6] whitespace-pre-wrap text-foreground"
                            : message.role === "system"
                              ? "bg-transparent whitespace-pre-wrap text-muted-foreground italic"
                              // AGENT 回复不加底色，只用浅色圆角边框圈出范围；用户气泡保留底色作区分
                              : "border bg-transparent px-4 py-3 text-foreground",
                        // AGENT 回复固定占满可用宽度（与上面的执行过程框等宽），
                        // 不随内容长短忽宽忽窄
                        message.role === "assistant" && "w-full",
                        bubble.faded && "opacity-70"
                      )}
                    >
                      {message.role === "assistant" ? (
                        // 流式期间只展示纯文本，避免每个 token 到达都触发一次全量
                        // marked.parse + DOMPurify.sanitize（性能开销 + 未闭合代码块/
                        // 标签导致的渲染抖动）；流结束后再一次性走 markdown 渲染，
                        message.pending ? (
                          <div className="whitespace-pre-wrap">{message.content || "…"}</div>
                        ) : (
                          <MarkdownContent
                            content={message.content || ""}
                            onPreviewHtml={(code) => onPreviewHtml("聊天中的 HTML 代码块", code)}
                            sessionName={session?.name}
                            baseDir={session?.containerPath || "/"}
                            onOpenPath={onOpenPath}
                          />
                        )
                      ) : (
                        <>
                          {message.images?.length ? (
                            <div className="mb-1 flex flex-wrap justify-end gap-1.5">
                              {message.images.map((path) => (
                                <a key={path} href={chatImageUrl(session.name, path)} target="_blank" rel="noopener noreferrer">
                                  <img src={chatImageUrl(session.name, path)} alt="附图" className="max-h-40 max-w-full rounded-lg border object-cover" loading="lazy" />
                                </a>
                              ))}
                            </div>
                          ) : null}
                          {message.content || (message.pending ? "…" : "")}
                        </>
                      )}
                    </div>
                    <span className={cn("flex items-center gap-1 px-1 text-xs text-muted-foreground", message.role === "user" && message.mode === "agent" && "min-h-6")}>
                      {formatTime(message.timestamp)}
                      {message.interrupted ? " · 已停止" : ""}
                      {bubble.copyable ? (
                        message.role === "assistant" ? (
                          <CopyMessageButton
                            text={markdownToPlainText(message.content)}
                            markdown={message.content}
                          />
                        ) : (
                          <CopyMessageButton text={message.content} />
                        )
                      ) : null}
                      {message.role === "user" && message.mode === "agent" && !message.pending && !running && onRewind && typeof message.id === "string" && !message.id.startsWith(LOCAL_USER_MESSAGE_ID_PREFIX) ? (
                        <Button variant="ghost" size="icon-xs" aria-label="回退到这里" title="回退到这里" onClick={() => onRewind(message)}>
                          <Undo2Icon />
                        </Button>
                      ) : null}
                    </span>
                  </>
                )}
              </div>
              </React.Fragment>
            )
          })}
          {tail}
        </div>
      </div>
      {hasNewBelow ? (
        <Button
          variant="outline"
          size="sm"
          className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-background shadow-md"
          onClick={jumpToBottom}
        >
          <ArrowDownIcon data-icon="inline-start" />
          有新输出
        </Button>
      ) : null}
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

// "容器详情"标签页：基础信息 / 路径
function ConfigView({ detail }: { detail: SessionDetail | null }) {
  if (!detail) return <EmptyPane text="请先选择左侧的容器 / AGENT" />

  const applied = detail.applied
  const status = statusInfo(detail.status)
  const workdirConfigured = Boolean(applied.hostPath && applied.containerPath)

  return (
    // 子项必须 shrink-0：flex 子项默认可压缩，卡片会被压扁到刚好塞满容器，
    // 容器因此认为"没有溢出"而不出滚动条，卡片内部内容却被裁掉看不见
    // （移动端高度有限时尤其明显）
    <div className="flex h-full flex-col gap-3 overflow-auto p-4 [&>*]:shrink-0">
      <InfoCard
        title="基础信息"
        rows={[
          { label: "containerName", value: applied.containerName || detail.containerName || "—" },
          {
            label: "状态",
            value: status.label,
            tone: status.tone,
            detail: status.tone === "ok" ? undefined : "当前不是活跃运行态，部分功能可能受限。",
          },
          { label: "imageName", value: applied.imageName || detail.image || "—" },
          { label: "imageVersion", value: applied.imageVersion || "—" },
          { label: "containerMode", value: applied.containerMode || "default" },
        ]}
      />
      <InfoCard
        title="路径"
        rows={[
          { label: "hostPath", value: applied.hostPath || "—" },
          { label: "containerPath", value: applied.containerPath || "—" },
          ...(workdirConfigured
            ? []
            : [
                {
                  label: "工作目录映射",
                  value: "缺失",
                  tone: "danger" as const,
                  detail: "hostPath / containerPath 是容器会话最关键的上下文。",
                },
              ]),
        ]}
      />
    </div>
  )
}

// "Agent详情"标签页：会话概览 / Agent 运行 / 命令与 Agent / 用量统计 / 最近活动
function DetailView({ detail }: { detail: SessionDetail | null }) {
  if (!detail) return <EmptyPane text="请先选择左侧的容器 / AGENT" />

  const applied = detail.applied
  const resume = resumeStatus(detail)
  const templateSourceLabel = TEMPLATE_SOURCE_LABELS[detail.agentPromptSource] || "未配置"
  const latestRoleLabel = ROLE_LABELS[detail.latestRole] || "暂无"
  const latestTimestampText = detail.latestTimestamp ? formatTime(detail.latestTimestamp) : "暂无"
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
  commandRows.push({ label: "yolo", value: applied.yolo || "—" })

  return (
    // 子项必须 shrink-0：flex 子项默认可压缩，卡片会被压扁到刚好塞满容器，
    // 容器因此认为"没有溢出"而不出滚动条，卡片内部内容却被裁掉看不见
    // （移动端高度有限时尤其明显）
    <div className="flex h-full flex-col gap-3 overflow-auto p-4 [&>*]:shrink-0">
      <InfoCard
        title="会话概览"
        rows={[
          { label: "AGENT", value: detail.agentName || detail.name },
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
      <InfoCard title="命令与 Agent" rows={commandRows} />
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
      {detail.lastResumeError ? (
        <InfoCard
          title="最近问题"
          rows={[{ label: "Resume 错误", value: "有错误输出", tone: "danger", detail: detail.lastResumeError }]}
        />
      ) : null}
    </div>
  )
}

// 空会话里的常用任务：点一下填进输入框，用户可以改完再发
const STARTER_PROMPTS = ["介绍一下这个项目", "运行测试并修复失败的用例", "检查最近的改动有没有问题"]

// 插入时机按钮的图标随当前选择变化：不点开也能看出追加的内容会怎么发
const QUEUE_WHEN_ICONS: Record<QueueWhen, typeof ZapIcon> = {
  now: ZapIcon,
  step: CornerDownRightIcon,
  turn: ListEndIcon,
}

export function Composer({
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
  onModelChanged,
  queueWhen,
  onQueueWhenChange,
  centered = false,
  images = [],
  onAddImages,
  onRemoveImage,
}: {
  // 待发送的图片（选中 / 粘贴 / 拖进来就上传）；不传就没有图片功能
  images?: ComposerImage[]
  onAddImages?: (files: File[]) => void
  onRemoveImage?: (id: string) => void
  // 空会话时输入区放在页面中间：不要顶部分割线，也不用避让底部安全区
  centered?: boolean
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
  onModelChanged: () => void
  queueWhen: QueueWhen
  onQueueWhenChange: (value: QueueWhen) => void
}) {
  const isMobile = useIsMobile()
  // 拦截理由集中在 resolveComposerBlockReason 里算（含容器级运行锁：同容器别的
  // AGENT 在跑时这个 AGENT 也发不出去，提前禁用而不是点了才吃 409）
  const blockReason = session ? resolveComposerBlockReason(session, mode) : ""
  const archived = Boolean(session?.archived)
  const inputDisabled = disabled || blockReason !== ""
  // 空输入/纯空白时发送按钮直接置灰，而不是点了没反应
  // 任务进行中输入框仍可用：agent 对话可以追加提示词（选插入时机）；系统命令不支持追加
  const hasImages = images.some((item) => item.status === "done")
  // 上传失败的图片也拦住发送：否则文字会悄悄不带图发出去，要用户先删掉或重选
  const uploadingImages = images.some((item) => item.status !== "done")
  const sendDisabled = inputDisabled || (draft.trim() === "" && !hasImages) || uploadingImages || (sending && mode === "command")

  // 执行中有内容时才显示“插入时机”（只对 Agent 对话有意义）；执行中没内容时只留“停止”
  const hasDraft = draft.trim() !== "" || hasImages
  const showQueueWhen = sending && mode === "agent" && hasDraft
  const showSend = !sending || hasDraft || mode === "command"
  // 手机上按钮点击区域不小于 40px，桌面 36px
  const iconSize = isMobile ? "icon-xl" : "icon-lg"
  const QueueWhenIcon = QUEUE_WHEN_ICONS[queueWhen]
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const imagesEnabled = Boolean(onAddImages) && mode === "agent" && !inputDisabled
  // 开头打 / 列斜杠命令、打 @ 列工作目录里的文件（只在 Agent 对话模式下）
  const suggestions = useComposerSuggestions({
    session,
    enabled: mode === "agent" && !inputDisabled,
    draft,
    onDraftChange,
    textareaRef,
  })

  // 底部内边距按安全区取大值：加到主屏幕全屏运行时，iOS 的 home 指示条会压在
  // 输入框上；桌面端 env() 取值为 0，等价于原来的 p-3
  return (
    <div className={centered ? "px-3" : "border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"}>
      {/* 输入框和按钮放在同一个圆角框里：按钮只显示图标，悬停看 title，读屏读 aria-label */}
      <div
        className={cn(
          "relative rounded-xl border bg-background pt-1 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          inputDisabled && "opacity-70"
        )}
      >
        {suggestions.popup}
        <ComposerImages images={images} onRemove={(id) => onRemoveImage?.(id)} />
        <Textarea
          ref={textareaRef}
          {...suggestions.textareaProps}
          placeholder={
            disabled
              ? "请先在左侧选择一个容器 / AGENT"
              : blockReason === "archived"
                ? "该 AGENT 已被删除，仅可查看历史消息"
                : blockReason === "container-busy"
                  ? "同容器的另一个 AGENT 正在执行任务，请等它结束或先停止"
                  : blockReason === "agent-unavailable"
                    ? "当前会话未配置 CLI，点「模式 → CLI」设置后即可对话"
                    : mode === "command"
                      ? sending
                        ? "任务执行中，系统命令要等它结束"
                        : "输入容器命令，例如: ls -la"
                      : sending
                        ? `追加要求（${QUEUE_WHEN_LABELS[queueWhen]}）`
                        : "输入要发给 AGENT 的内容"
          }
          // Textarea 自带 field-sizing-content（跟着内容自动长高）但没有上限，
          // 粘进几十行就会把聊天内容整个顶出屏幕。加一个高度上限，超出后内部滚动。
          // 系统命令模式下换等宽字体：敲的是 shell 命令，路径/引号/空格数量要对得齐。
          // 边框和聚焦描边交给外面的圆角框
          className={cn(
            "max-h-[40vh] min-h-10 resize-none overflow-y-auto border-0 bg-transparent shadow-none focus-visible:ring-0 sm:min-h-16 dark:bg-transparent",
            mode === "command" && "font-mono"
          )}
          value={draft}
          disabled={inputDisabled}
          onChange={(event) => {
            onDraftChange(event.target.value)
            suggestions.handleInput(event.target.selectionStart ?? event.target.value.length)
          }}
          onPaste={(event) => {
            const files = imagesEnabled ? pickImageFiles(event.clipboardData) : []
            if (files.length === 0) return
            event.preventDefault()
            onAddImages?.(files)
          }}
          onDragOver={(event) => {
            if (imagesEnabled && Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault()
          }}
          onDrop={(event) => {
            const files = imagesEnabled ? pickImageFiles(event.dataTransfer) : []
            if (files.length === 0) return
            event.preventDefault()
            onAddImages?.(files)
          }}
          onKeyDown={(event) => {
            // 补全弹层打开时，↑↓ / Enter / Tab / Esc 交给它
            if (suggestions.handleKeyDown(event)) return
            // 输入法组词期间的 Enter（选字确认）不应触发发送
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return
            // 窄屏：Enter 始终换行，发送需点击发送按钮
            if (isMobile) return
            // Shift+Enter / Alt+Enter 换行，其余 Enter 发送
            if (event.shiftKey || event.altKey) return
            event.preventDefault()
            if (!sendDisabled) onSend()
          }}
        />
        <div className="flex items-center justify-between gap-1 px-1.5 pb-1.5">
          <div className="flex min-w-0 items-center gap-1">
            <DropdownMenu>
              {/* 模式必须常驻可见：只靠输入框 placeholder 提示的话，一打字就看不见了，
                  很容易在"系统命令"模式下把整段话当 shell 命令发出去。所以图标随模式变，
                  系统命令模式下按钮带底色，输入框也换成等宽字体 */}
              <DropdownMenuTrigger
                render={
                  <Button
                    variant={mode === "command" ? "secondary" : "ghost"}
                    size={iconSize}
                    disabled={disabled}
                    aria-label="切换模式"
                    title={`模式：${formatComposerModeLabel(mode)}`}
                  />
                }
              >
                {mode === "command" ? <SquareTerminalIcon /> : <MessageSquareIcon />}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-44">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    className={mode === "agent" ? "bg-accent" : undefined}
                    onClick={() => onModeChange("agent")}
                  >
                    <MessageSquareIcon />
                    Agent对话
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={mode === "command" ? "bg-accent" : undefined}
                    onClick={() => onModeChange("command")}
                  >
                    <SquareTerminalIcon />
                    系统命令
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator className="mx-1 bg-border/50" />
                <DropdownMenuGroup>
                  <DropdownMenuItem disabled={!session || archived} onClick={() => onOpenCliTemplate()}>
                    CLI · {session?.agentProgram || "未设置"}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {onAddImages && mode === "agent" ? (
              <>
                {/* 手机上会调起系统相册 / 相机，是手机端发图的主入口 */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(event) => {
                    onAddImages(Array.from(event.target.files ?? []))
                    event.target.value = ""
                  }}
                />
                <Button
                  variant="ghost"
                  size={iconSize}
                  disabled={!imagesEnabled}
                  aria-label="添加图片"
                  title="添加图片"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImagePlusIcon />
                </Button>
              </>
            ) : null}
            {/* 系统命令模式不涉及模型，直接隐藏 */}
            {mode === "agent" ? (
              <ModelMenu
                session={session}
                disabled={disabled || archived || !session}
                onChanged={onModelChanged}
                compact={isMobile}
                size={iconSize}
              />
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {showQueueWhen ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size={iconSize}
                      className="rounded-full"
                      aria-label="插入时机"
                      title={`插入时机：${QUEUE_WHEN_LABELS[queueWhen]}`}
                      disabled={inputDisabled}
                    />
                  }
                >
                  <QueueWhenIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className="w-60">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>追加的内容什么时候交给 AGENT</DropdownMenuLabel>
                    {QUEUE_WHEN_ORDER.map((when) => {
                      const Icon = QUEUE_WHEN_ICONS[when]
                      return (
                        <DropdownMenuItem key={when} onClick={() => onQueueWhenChange(when)}>
                          <Icon />
                          {QUEUE_WHEN_LABELS[when]}
                          {when === queueWhen ? <CheckIcon className="ml-auto" /> : null}
                        </DropdownMenuItem>
                      )
                    })}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {sending ? (
              <Button variant="destructive" size={iconSize} className="rounded-full" onClick={onStop} aria-label="停止" title="停止">
                <SquareIcon className="fill-current" />
              </Button>
            ) : null}
            {showSend ? (
              <Button
                size={iconSize}
                className="rounded-full"
                onClick={onSend}
                disabled={sendDisabled}
                aria-label="发送"
                title={sending && mode === "agent" ? `追加（${QUEUE_WHEN_LABELS[queueWhen]}）` : "发送"}
              >
                <ArrowUpIcon />
              </Button>
            ) : null}
          </div>
        </div>
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
  onRunFinished,
}: {
  activeSession: SessionSummary | null
  onAfterSend: () => void | Promise<unknown>
  // 当前会话的任务从“执行中”变成结束：用于标签页角标与通知
  onRunFinished?: (sessionName: string) => void
  filesEditorRef: React.RefObject<FilesEditorState | null>
  confirmLeaveIfDirty: () => Promise<boolean>
  creatingAgent: boolean
}) {
  const [view, setView] = React.useState<View>("activity")
  const isMobile = useIsMobile()
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
  // 文件 / 设置容器标签打开过就常驻（隐藏而不卸载）：它们自带刷新按钮，
  // 切回来不该每次重新加载，也不该丢掉没保存的编辑
  const [filesMounted, setFilesMounted] = React.useState(false)
  const [containerMounted, setContainerMounted] = React.useState(false)
  if (view === "files" && !filesMounted) setFilesMounted(true)
  if (view === "container" && !containerMounted) setContainerMounted(true)
  // 消息按会话名隔离，而不是单一全局数组：流式回调各自更新自己会话的 key，
  // 用户在 A 会话跑长任务时切到 B 再切回 A，A 的实时流式状态（用户消息、执行
  // 过程、增量回复）原样还在——单一数组在切换时会被加载响应覆盖，本地流式
  // 占位随之丢失，表现为"切回来界面空白，直到任务跑完才恢复"
  const [messagesBySession, setMessagesBySession] = React.useState<Record<string, ChatMessage[]>>({})
  const messagesBySessionRef = React.useRef<Record<string, ChatMessage[]>>({})
  // 每个会话的增量同步状态：epoch（服务端换了就整体重拉）与是否还有更早的消息
  const syncMetaRef = React.useRef<Record<string, { epoch: string | null; hasMore: boolean }>>({})
  const [hasMoreBySession, setHasMoreBySession] = React.useState<Record<string, boolean>>({})
  const [loadingEarlier, setLoadingEarlier] = React.useState(false)
  const loadingEarlierRef = React.useRef(false)
  const [messagesLoading, setMessagesLoading] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const composerImages = useComposerImages(activeSession?.name ?? null)
  // 每发送一次加 1，通知消息流贴底（见 ActivityView 的 followSignal）
  const [sendTick, setSendTick] = React.useState(0)
  const draftRef = React.useRef("")
  const [restoreNotice, setRestoreNotice] = React.useState<RestoreNotice | null>(null)
  // 刚放回输入框的内容和它原来的 clientId：原样重发就沿用，服务端按 clientId 去重
  const restoredRef = React.useRef<RestoredPrompt | null>(null)
  const [mode, setMode] = React.useState<"agent" | "command">("agent")
  // 按会话名记录"本标签页正在为哪些会话跑 stream"，而不是单个全局布尔值——
  // 否则切到另一个 agent 时，输入框/发送按钮会继续显示上一个 agent 的状态
  const [sendingNames, setSendingNames] = React.useState<Set<string>>(() => new Set())
  // 任务进行中追加的提示词（来自服务端 /messages 的 queue，按会话）与上次选的插入时机
  const [queueBySession, setQueueBySession] = React.useState<Record<string, QueueItem[]>>({})
  const [queueWhen, setQueueWhen] = React.useState<QueueWhen>(() => loadQueueWhen())
  const setQueueFor = React.useCallback((name: string, items: QueueItem[]) => {
    setQueueBySession((prev) => {
      const old = prev[name] ?? []
      if (old.length === items.length && old.every((item, index) => item.id === items[index].id && item.when === items[index].when)) return prev
      return { ...prev, [name]: items }
    })
  }, [])
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

  // 草稿按会话隔离保存在浏览器本地：切换 AGENT 时加载目标会话自己的草稿（而不是沿用输入框里
  // 上一个会话的字——否则会把 A 的草稿当成 B 的消息发出去）。
  // 发送模式同理必须一起重置：在 A 里切到"系统命令"后切到 B，B 也会停在系统命令，
  // 用户以为在跟 agent 说话，实际整段文字被当 shell 命令丢进容器执行
  const pendingSaveRef = React.useRef<{ name: string; value: string; timer: number } | null>(null)
  const flushDraftSave = React.useCallback(() => {
    const pending = pendingSaveRef.current
    if (!pending) return
    window.clearTimeout(pending.timer)
    pendingSaveRef.current = null
    saveDraft(pending.name, pending.value)
  }, [])
  const updateDraft = React.useCallback(
    (value: string) => {
      draftRef.current = value
      setDraft(value)
      const name = activeSessionNameRef.current
      if (!name) return
      if (pendingSaveRef.current && pendingSaveRef.current.name !== name) flushDraftSave()
      if (pendingSaveRef.current) window.clearTimeout(pendingSaveRef.current.timer)
      const timer = window.setTimeout(flushDraftSave, 300)
      pendingSaveRef.current = { name, value, timer }
    },
    [flushDraftSave]
  )
  React.useEffect(() => {
    purgeExpiredComposerData()
    window.addEventListener("pagehide", flushDraftSave)
    return () => {
      window.removeEventListener("pagehide", flushDraftSave)
      flushDraftSave()
    }
  }, [flushDraftSave])
  React.useEffect(() => {
    flushDraftSave()
    const saved = activeSession ? loadComposer(activeSession.name).draft : ""
    draftRef.current = saved
    setDraft(saved)
    setRestoreNotice(null)
    restoredRef.current = null
    setMode("agent")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.name])

  const activeSessionMessages = activeSession ? messagesBySession[activeSession.name] : undefined
  // 已有该会话的消息快照（哪怕是空数组）：切换回来时先立即显示缓存内容，
  // 后台刷新到位后无感更新——而不是先转一圈加载 Spinner 把界面闪空白
  const hasCachedMessages = activeSessionMessages !== undefined
  const messages = activeSessionMessages ?? []
  const rounds = React.useMemo(() => buildRoundOptions(activeSessionMessages ?? []), [activeSessionMessages])
  const modelDenied = React.useMemo(() => findModelDenied(activeSessionMessages ?? []), [activeSessionMessages])
  // 更新某个会话的消息：流式回调在会话切换后仍持续维护自己会话的状态，
  // 所以这里按 name 定位，而不是操作"当前活动会话"
  const setSessionMessages = React.useCallback(
    (name: string, updater: (prev: ChatMessage[]) => ChatMessage[]) => {
      const prev = messagesBySessionRef.current
      const next = updater(prev[name] ?? [])
      if (next === prev[name]) return
      messagesBySessionRef.current = { ...prev, [name]: next }
      setMessagesBySession(messagesBySessionRef.current)
    },
    []
  )

  const sending = activeSession ? sendingNames.has(activeSession.name) : false
  // composer 是否可用不能只看
  // 本标签页这一次 fetch 有没有结束——网络抖动/标签页节流可能让本地 stream 提前
  // 断开，但服务端那一轮 agent 任务（尤其是耗时更长的多 agent / 子 agent 任务）
  // 其实还在跑，这时消息列表里会留着一条 pending 的 agent 回复，据此继续禁用输入
  const activeAgentRunning =
    sending || messages.some((message) => message.mode === "agent" && message.pending === true)

  // 同一个会话里 activeAgentRunning 从 true 变成 false 才算“结束”；切换会话不算
  const runWatchRef = React.useRef<{ name: string | null; running: boolean }>({ name: null, running: false })
  React.useEffect(() => {
    const prev = runWatchRef.current
    if (prev.name === activeSessionName && prev.running && !activeAgentRunning && activeSessionName) {
      onRunFinished?.(activeSessionName)
    }
    runWatchRef.current = { name: activeSessionName, running: activeAgentRunning }
  }, [activeAgentRunning, activeSessionName, onRunFinished])

  // 文件编辑器有未保存修改时，切走顶部标签会直接丢弃 FilesPanel 的编辑状态
  // （非 files 视图不渲染 FilesPanel），所以要在真正 setView 之前先拦一次
  async function changeView(next: View) {
    if (view === next) return
    if (view === "files" && !(await confirmLeaveIfDirty())) return
    setView(next)
  }

  // 聊天里点了路径：切到文件页并让 FilesPanel 打开它（nonce 让同一路径可以重复打开）
  const [filesOpenRequest, setFilesOpenRequest] = React.useState<{ path: string; nonce: number } | null>(null)
  function openPathInFiles(path: string) {
    setFilesOpenRequest((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }))
    void changeView("files")
  }

  function setSendingFor(name: string, value: boolean) {
    setSendingNames((prev) => {
      const next = new Set(prev)
      if (value) next.add(name)
      else next.delete(name)
      return next
    })
  }

  // 发送到服务端之前的草稿检查：已发出（同步结果里有同一个 clientId）就清掉；
  // 没发出去而且没有任务在跑，就放回输入框。别的标签页刚写入的先等下一轮
  const checkOutbox = React.useCallback(
    (name: string, messages: ChatMessage[]) => {
      const outbox = loadComposer(name).outbox
      const decision = decideOutboxRestore({
        outbox,
        messages,
        sessionRunning:
          sendingNamesRef.current.has(name) ||
          messages.some((message) => message.mode === "agent" && message.pending === true),
        currentTabId: getTabId(),
        now: Date.now(),
      })
      if (!outbox || decision === "none" || decision === "wait") return
      if (decision === "clear") {
        clearOutbox(name, outbox.clientId)
        setRestoreNotice((prev) =>
          prev && (prev.kind === "unknown" || prev.kind === "banner") && prev.outbox.clientId === outbox.clientId ? null : prev
        )
        return
      }
      const plan = planRestore(draftRef.current, outbox)
      if (plan.kind === "fill") {
        clearOutbox(name, outbox.clientId)
        restoredRef.current = { sessionName: name, clientId: outbox.clientId, text: plan.text }
        updateDraft(plan.text)
        setMode(outbox.mode)
        setRestoreNotice({ kind: "info" })
      } else {
        setRestoreNotice((prev) =>
          prev?.kind === "banner" && prev.outbox.clientId === outbox.clientId ? prev : { kind: "banner", outbox }
        )
      }
    },
    [updateDraft]
  )

  const setHasMore = React.useCallback((name: string, hasMore: boolean) => {
    const meta = syncMetaRef.current[name] ?? { epoch: null, hasMore: false }
    syncMetaRef.current[name] = { ...meta, hasMore }
    setHasMoreBySession((prev) => (prev[name] === hasMore ? prev : { ...prev, [name]: hasMore }))
  }, [])

  // 增量同步一次：有本地 anchor 和 epoch 就只拉 anchor 之后的部分（没变化时是几百字节的 304），
  // 否则拉最近一页。forcePage 用于流结束、停止、命令执行后的对账：拉最近一页覆盖本地
  const loadMessages = React.useCallback(
    async (name: string, options: { silent: boolean; signal?: AbortSignal; forcePage?: boolean }) => {
      const { silent, signal, forcePage } = options
      if (!silent) {
        showLoadError("")
        setMessagesLoading(true)
      }
      let usedQuery: MessagesQuery | null = null
      try {
        const local = messagesBySessionRef.current[name]
        const meta = syncMetaRef.current[name]
        const query =
          local && !forcePage
            ? buildSyncQuery(local, meta?.epoch ?? null)
            : { limit: MESSAGES_PAGE_LIMIT }
        usedQuery = query
        const anchor = query.after ?? null
        const data = await apiGet(buildMessagesUrl(name, query), signal)
        if (signal?.aborted) return
        // 请求发出后状态可能已变：切到了别的会话（防串台）、或本标签页开始了
        // 该会话的流式发送（晚到的旧快照会覆盖掉刚显示的乐观 user 消息，
        // 用户表现为"发出去的提示词不立刻出现/消失"）——这两种响应直接丢弃
        if (
          shouldDiscardMessagesResponse(name, activeSessionNameRef.current, sendingNamesRef.current.has(name))
        ) {
          return
        }
        if (!Array.isArray(data.messages)) return
        const res = data as unknown as MessagesResponse
        const localNow = messagesBySessionRef.current[name] ?? []
        const prevHasMore = syncMetaRef.current[name]?.hasMore ?? false
        const applied =
          res.mode === "tail"
            ? applyMessagesResponse(localNow, res, anchor, prevHasMore)
            : reconcileWithPage(localNow, res, prevHasMore, meta?.epoch ?? null)
        if (!applied) {
          // 本地 anchor 在请求期间被改动：下一次改拉最近一页
          syncMetaRef.current[name] = { epoch: null, hasMore: prevHasMore }
          return
        }
        syncMetaRef.current[name] = { epoch: applied.epoch, hasMore: applied.hasMore }
        setHasMoreBySession((prev) => (prev[name] === applied.hasMore ? prev : { ...prev, [name]: applied.hasMore }))
        setSessionMessages(name, () => applied.messages)
        setQueueFor(name, parseQueue((data as { queue?: unknown }).queue) ?? [])
        messagesSyncTickRef.current += 1
        setMessagesSyncTick(messagesSyncTickRef.current)
        checkOutbox(name, applied.messages)
      } catch (err) {
        if (signal?.aborted) return
        if (usedQuery && shouldResetAfterSyncError(err, usedQuery)) {
          syncMetaRef.current[name] = { epoch: null, hasMore: syncMetaRef.current[name]?.hasMore ?? false }
        }
        if (!silent) showLoadError(err instanceof Error ? err.message : "加载消息失败")
      } finally {
        if (!silent && activeSessionNameRef.current === name) setMessagesLoading(false)
      }
    },
    [setSessionMessages, setQueueFor, showLoadError, checkOutbox]
  )

  const loadDetailFor = React.useCallback((name: string, signal?: AbortSignal) => {
    return apiGet(`/api/sessions/${encodeURIComponent(name)}/detail`, signal)
      .then((data) => {
        if (signal?.aborted || activeSessionNameRef.current !== name) return
        setSessionDetail((data.detail as SessionDetail) || null)
      })
      .catch(() => {
        // 静默失败：检查/配置/详情页保留上一次成功加载的数据
      })
  }, [])

  const loadDetail = React.useCallback(() => {
    const name = activeSessionNameRef.current
    if (!name) {
      setSessionDetail(null)
      return Promise.resolve()
    }
    return loadDetailFor(name)
  }, [loadDetailFor])

  // 同步请求的单飞、主动触发补跑、切会话 abort 见 useSessionSync
  const requestSync = useSessionSync(
    activeSession?.name ?? null,
    React.useCallback(
      async (name: string, signal: AbortSignal, forcePage: boolean) => {
        // 已有缓存就静默刷新；首次进入该会话才用加载态占位
        const silent = messagesBySessionRef.current[name] !== undefined
        await Promise.all([loadMessages(name, { silent, signal, forcePage }), loadDetailFor(name, signal)])
      },
      [loadMessages, loadDetailFor]
    ),
    React.useCallback(() => {
      setMessagesLoading(false)
      setSessionDetail(null)
    }, [])
  )

  // 往上翻：加载更早的一页，接到列表前面
  const loadEarlier = React.useCallback(async () => {
    const name = activeSessionNameRef.current
    if (!name || loadingEarlierRef.current) return
    const local = messagesBySessionRef.current[name] ?? []
    const firstId = firstServerMessageId(local)
    if (firstId === null) return
    loadingEarlierRef.current = true
    setLoadingEarlier(true)
    try {
      const data = await apiGet(buildMessagesUrl(name, { before: firstId, limit: MESSAGES_PAGE_LIMIT }))
      if (activeSessionNameRef.current !== name || !Array.isArray(data.messages)) return
      const res = data as unknown as MessagesResponse
      const meta = syncMetaRef.current[name]
      if (meta?.epoch && res.epoch && res.epoch !== meta.epoch) {
        // 期间服务端重排过历史：丢弃这一页，改拉最近一页对账
        syncMetaRef.current[name] = { epoch: null, hasMore: meta.hasMore }
        void requestSync(true, true)
        return
      }
      const out = prependEarlierMessages(messagesBySessionRef.current[name] ?? [], res)
      setSessionMessages(name, () => out.messages)
      setHasMore(name, out.hasMore)
    } catch (err) {
      showLoadError(err instanceof Error ? err.message : "加载更早的消息失败")
    } finally {
      loadingEarlierRef.current = false
      setLoadingEarlier(false)
    }
  }, [requestSync, setSessionMessages, setHasMore, showLoadError])

  // 刷新页面/切回会话后，如果后端
  // 仍在跑一次 Agent 回合（消息里还留着 pending 记录），持续轮询直到它结束；
  // 但如果本标签页自己正在为这个会话跑 stream，则不需要（也不应该）叠加轮询
  useAgentRecoveryPoll(
    activeSession,
    messages,
    React.useCallback(async () => {
      await requestSync(false)
    }, [requestSync]),
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

  // 本标签页正在为当前会话跑 stream 时跳过 /messages 与 /detail，避免用半途的服务端快照覆盖实时状态；
  // 侧栏（onAfterSend）不受此限制。定时与事件调度见 useSyncLoop
  // 离开一阵子再回来 / 网络恢复时，顶栏下方显示同步进度，成功后标题旁闪一下“已同步”
  const resumeIndicator = useResumeIndicator()
  const trackResume = resumeIndicator.track
  useSyncLoop(
    React.useCallback(
      async (manual: boolean) => {
        if (document.visibilityState !== "visible") return
        const sidebar = Promise.resolve(onAfterSend()).catch(() => {})
        const name = activeSessionNameRef.current
        if (name && !sendingNamesRef.current.has(name)) {
          await requestSync(manual)
        }
        await sidebar
      },
      [requestSync, onAfterSend]
    ),
    {
      onResumeSync: (sync) => {
        const tickBefore = messagesSyncTickRef.current
        trackResume(sync, () => messagesSyncTickRef.current > tickBefore)
      },
    }
  )

  // ---- 回退（用户消息上的按钮）----
  const [rewindTarget, setRewindTarget] = React.useState<ChatMessage | null>(null)

  // 回退后：本地先砍掉那条及之后的消息（服务端换了 epoch，随后对账会整页重置）
  function cutMessagesFrom(name: string, messageId: string | number) {
    setSessionMessages(name, (prev) => {
      const index = prev.findIndex((item) => item.id === messageId)
      return index === -1 ? prev : prev.slice(0, index)
    })
    syncMetaRef.current[name] = { epoch: null, hasMore: syncMetaRef.current[name]?.hasMore ?? false }
    void requestSync(true, true)
  }

  function handleRewindDone(result: RewindResult) {
    const target = rewindTarget
    setRewindTarget(null)
    if (!target || !activeSession) return
    const name = activeSession.name
    if (result.scope !== "files") cutMessagesFrom(name, target.id)
    // 提示词和图片放回输入框，用户改完可以直接再发
    // 只恢复文件时对话没变，提示词还在聊天里，不放回输入框（否则再发一次就重复了）
    if (result.scope !== "files") {
      const current = draftRef.current
      updateDraft(current.trim() ? `${result.prompt}\n\n${current}` : result.prompt)
      if (result.images.length) composerImages.restore(result.images)
    }
    if (result.scope === "files") void requestSync(true, true)
  }

  // overrideText：不经输入框直接发送一条（“允许并重试”重发被中止的提示词，连图片一起），输入框里正在写的内容不动
  async function handleSend(overrideText?: string, overrideImages?: string[]) {
    const fromDraft = overrideText === undefined
    const sendImages = fromDraft ? composerImages.paths : (overrideImages ?? [])
    // 只发图片没写字：给一句默认的话（服务端要求提示词非空）
    const text = (fromDraft ? draft : overrideText).trim() || (sendImages.length ? "请看附图。" : "")
    if (!text || !activeSession) return
    if (fromDraft && composerImages.images.some((item) => item.status !== "done")) return
    const name = activeSession.name
    // 任务进行中只有 agent 对话能追加提示词；系统命令仍要等上一条跑完
    if ((sendingNames.has(name) || activeAgentRunning) && mode === "command") return
    // 流式回调是异步触发的，期间用户可能已经切换到别的 agent。消息状态按会话
    // 隔离（setSessionMessages 按 name 定位），切走后回调仍持续维护原会话的
    // 实时状态；只有 loadError 这类"只属于当前视图"的提示才需要 isStillActive
    const isStillActive = () => activeSessionNameRef.current === name
    // 先把提示词同步写进待发箱再清空输入框：请求没发出去（400、409、断网、刷新、关浏览器）
    // 也不会丢，见 checkOutbox / handleUnsent。放回的内容原样重发就沿用原 clientId
    if (pendingSaveRef.current) {
      window.clearTimeout(pendingSaveRef.current.timer)
      pendingSaveRef.current = null
    }
    const bannerOutbox = restoreNotice?.kind === "banner" || restoreNotice?.kind === "unknown" ? restoreNotice.outbox : null
    const { clientId, outbox } = beginSend({
      sessionName: name,
      text,
      mode,
      restored: restoredRef.current,
      createId: createClientMessageId,
      tabId: getTabId(),
      now: Date.now(),
    })
    restoredRef.current = null
    // 输入框上方还挂着上一次没发出去的内容：待发箱被新的覆盖前，先把它放回现在已清空的输入框
    if (fromDraft) {
      updateDraft(bannerOutbox ? bannerOutbox.text : "")
      composerImages.clear()
    }
    setRestoreNotice(bannerOutbox ? { kind: "info" } : null)
    showLoadError("")
    // 没发出去：输入框为空就直接放回，不为空不覆盖，保留待发箱并给出“恢复”入口
    const putBack = () => {
      const plan = planRestore(draftRef.current, outbox)
      if (plan.kind === "fill") {
        clearOutbox(name, clientId)
        restoredRef.current = { sessionName: name, clientId, text: plan.text }
        updateDraft(plan.text)
        if (sendImages.length && isStillActive()) composerImages.restore(sendImages)
        setMode(outbox.mode)
        setRestoreNotice({ kind: "info" })
      } else {
        setRestoreNotice({ kind: "banner", outbox })
      }
    }
    // 发送失败后先判断服务端有没有收到：明确拒绝（有 HTTP 状态码）立刻放回；
    // 网络中断就先向服务端对账，找到同一个 clientId 说明其实已经发出，不放回、不重复执行
    const handleUnsent = async (kind: SendErrorKind) => {
      const outcome = await resolveFailedSend({
        kind,
        clientId,
        reconcile: async () => {
          const data = await apiGet(buildMessagesUrl(name, { limit: MESSAGES_PAGE_LIMIT }))
          if (!Array.isArray(data.messages)) throw new Error("bad messages")
          return { messages: data.messages as ChatMessage[] }
        },
      })
      // 对账期间可能已被同步里的 checkOutbox 处理掉（待发箱已清或换成别的），这里不再重复处理
      if (loadComposer(name).outbox?.clientId !== clientId) return
      if (outcome.action === "sent") {
        clearOutbox(name, clientId)
        return
      }
      if (outcome.action === "duplicate") {
        clearOutbox(name, clientId)
        if (isStillActive()) setRestoreNotice({ kind: "text", text: "这条消息已经发出过" })
        return
      }
      if (!isStillActive()) return
      if (outcome.action === "restore") putBack()
      else if (outcome.action === "unknown") setRestoreNotice({ kind: "unknown", outbox })
    }
    // 任务进行中：不开新的流，把提示词交给服务端排队，按所选时机插入
    if (mode === "agent" && (sendingNames.has(name) || activeAgentRunning)) {
      setSendTick((value) => value + 1)
      try {
        const data = await apiPost(`/api/sessions/${encodeURIComponent(name)}/agent/queue`, {
          prompt: text,
          ...(sendImages.length ? { images: sendImages } : {}),
          when: queueWhen,
          clientMessageId: clientId,
        })
        clearOutbox(name, clientId)
        setQueueFor(name, parseQueue(data.queue) ?? [])
      } catch (err) {
        if (isStillActive()) showLoadError(err instanceof Error ? err.message : "追加失败")
        await handleUnsent(classifySendError(err))
      }
      // 服务端可能刚好空闲、已经直接开跑：对一次账，让新一轮的 pending 交给恢复轮询
      if (isStillActive()) void requestSync(true, true)
      return
    }
    setSessionMessages(name, (prev) => [
      ...prev,
      {
        id: `${LOCAL_USER_MESSAGE_ID_PREFIX}${Date.now()}`,
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
        mode,
        clientMessageId: clientId,
        ...(sendImages.length ? { images: sendImages } : {}),
      },
    ])
    setSendTick((value) => value + 1)

    if (mode === "command") {
      setSendingFor(name, true)
      try {
        const data = await apiPost(`/api/sessions/${encodeURIComponent(name)}/run`, { command: text, clientMessageId: clientId })
        clearOutbox(name, clientId)
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
        // 命令没有执行（被拒绝）或不确定是否执行（网络中断）：见 handleUnsent
        setSessionMessages(name, (prev) => removeLocalPendingPlaceholders(prev))
        await handleUnsent(classifySendError(err))
      } finally {
        setSendingFor(name, false)
        onAfterSend()
        // 用服务端的最近一页对账（本地的命令结果是临时 id）
        if (isStillActive()) void requestSync(true, true)
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
    // 收到 meta 说明服务端已经存下了 user 消息：待发箱的使命完成。meta 之前失败才需要放回输入框
    let metaReceived = false
    let sawQueueNext = false
    setSessionMessages(name, (prev) => [
      ...prev,
      {
        id: STREAMING_TRACE_ID,
        // 本轮执行过程的渲染 key：占位 id 换成服务端 id、配上回复后都不变（见 messageRenderKey）
        renderKey: `trace-${clientId}`,
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
      await apiStream(`/api/sessions/${encodeURIComponent(name)}/agent/stream`, { prompt: text, ...(sendImages.length ? { images: sendImages } : {}), clientMessageId: clientId }, (event) => {
        if (event.type === "meta") {
          metaReceived = true
          clearOutbox(name, clientId)
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
          // meta 只在开跑时来一次，把上下文模式和 resume 结果落进执行过程里：
          // resume 失败会静默回退成"历史注入"（上下文可能对不齐），不说一声的话
          // 用户只会觉得 agent 突然失忆。一次性事件，不影响流式吞吐
          const metaLines = buildStreamMetaTraceEvents(event)
          if (metaLines.length) {
            traceEvents.push(...metaLines)
            setSessionMessages(name, (prev) =>
              applyTraceEventUpdate(prev, traceMessageId, { traceEvents: traceEvents.slice() })
            )
          }
        } else if (event.type === "trace") {
          // 结构化事件优先，没有就兜底成一条 output 事件——不能只认 traceEvent，
          // 否则 stderr / 非 JSON stdout 这类原始行会被静默丢掉（见 toTraceEvent）
          const traceEvent = toTraceEvent(event)
          if (traceEvent) traceEvents.push(traceEvent)
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
                        networkDenied: event.networkDenied,
                      }
                    : message
                ),
              { replyMessageId: event.replyMessageId }
            )
          )
        } else if (event.type === "queue_next") {
          // 服务端接着发排队的下一条：这条流到此为止，后面由恢复轮询跟随下一轮
          sawQueueNext = true
        } else if (event.type === "error") {
          if (isStillActive()) showLoadError(event.error)
          setSessionMessages(name, (prev) => removeLocalPendingPlaceholders(prev))
          if (!metaReceived) void handleUnsent("rejected")
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
      // 对账期间保持发送锁（输入框不解锁），避免对账没回来用户又发一条把待发箱覆盖掉
      if (!metaReceived) await handleUnsent(classifySendError(err))
      // 本地 stream 中断不代表服务端那一轮真的停了（可能只是网络抖动/标签页
      // 被节流）；删掉本地占位后立刻跟服务端对一次账，服务端如果仍在跑，
      // 返回的消息会带着 pending 标记，交给 useAgentRecoveryPoll 接手轮询
    } finally {
      setSendingFor(name, false)
      onAfterSend()
      // 流结束（成功或中断）后立刻用服务端的最近一页对账，主动触发不能被在途请求吞掉
      if (isStillActive()) {
        void requestSync(true, true)
        // 下一轮由服务端稍后才开跑：隔一会儿再对一次账，让它的 pending 交给恢复轮询
        if (sawQueueNext) {
          for (const delay of [700, 2000]) window.setTimeout(() => void requestSync(true, true), delay)
        }
      } else {
        // 流结束时用户已切到别的会话：本地留的是流式拼出来的内容，下次回来先按最近一页对账
        syncMetaRef.current[name] = { epoch: null, hasMore: syncMetaRef.current[name]?.hasMore ?? false }
      }
    }
  }

  // 取消一条排队中的提示词；edit=true 时把它放回输入框（编辑 = 取消后放回）
  async function handleCancelQueued(item: QueueItem, edit: boolean) {
    if (!activeSession) return
    const name = activeSession.name
    try {
      const data = await apiDelete(`/api/sessions/${encodeURIComponent(name)}/agent/queue/${encodeURIComponent(item.id)}`)
      setQueueFor(name, parseQueue(data.queue) ?? [])
      if (edit) {
        const current = draftRef.current
        updateDraft(current.trim() ? `${item.text}\n\n${current}` : item.text)
      }
    } catch (err) {
      if (apiErrorData(err).status === 404) {
        showLoadError("这条提示词已经发出或已取消")
        void requestSync(true, true)
      } else {
        showLoadError(err instanceof Error ? err.message : "取消失败")
      }
    }
  }

  async function handleContinueQueued() {
    if (!activeSession) return
    try {
      await apiPost(`/api/sessions/${encodeURIComponent(activeSession.name)}/agent/queue/continue`, {})
    } catch (err) {
      showLoadError(err instanceof Error ? err.message : "继续发送失败")
    }
    void requestSync(true, true)
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
      void requestSync(true, true)
    }
  }

  // 空会话（Agent 对话模式、没有消息也没有排队）时输入区放在中间
  const emptyConversation =
    view === "activity" &&
    Boolean(activeSession) &&
    !creatingAgent &&
    !(messagesLoading && !hasCachedMessages) &&
    messages.length === 0 &&
    (activeSession ? (queueBySession[activeSession.name] ?? []).length === 0 : true) &&
    mode === "agent" &&
    !activeAgentRunning &&
    !activeSession?.archived
  const composerNode = (
    <Composer
      centered={emptyConversation}
      draft={draft}
      onDraftChange={updateDraft}
      onSend={() => void handleSend()}
      onStop={handleStop}
      mode={mode}
      onModeChange={setMode}
      disabled={!activeSession || (messagesLoading && !hasCachedMessages)}
      sending={activeAgentRunning}
      session={activeSession}
      onOpenCliTemplate={() => setCliDialogOpen(true)}
      queueWhen={queueWhen}
      onQueueWhenChange={(value) => {
        setQueueWhen(value)
        saveQueueWhen(value)
      }}
      onModelChanged={() => {
        onAfterSend()
        loadDetail()
      }}
      images={composerImages.images}
      onAddImages={composerImages.addFiles}
      onRemoveImage={composerImages.remove}
    />
  )

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* 顶栏从左到右：侧栏按钮、会话标题、⋯（按 AGENT / 容器分组的各个视图） */}
      <header className="relative flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-4! self-center" />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium">
          {activeSession ? (
            <span className="min-w-0 truncate px-1 py-0.5">{sessionDisplayTitle(activeSession)}</span>
          ) : (
            <span className="truncate">选择左侧的容器 / AGENT 开始</span>
          )}
          {activeSession && view !== "activity" ? (
            // 不在聊天时显示当前视图名，点它回到聊天（顶栏没有常驻的“聊天”按钮）
            <button
              type="button"
              className="flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
              title="回到聊天"
              aria-label={`${VIEW_LABELS[view]}，回到聊天`}
              onClick={() => changeView("activity")}
            >
              · {VIEW_LABELS[view]}
              <XIcon className="size-3.5" />
            </button>
          ) : null}
          {activeSession?.archived ? (
            <Badge variant="outline" className="shrink-0">
              已停止
            </Badge>
          ) : null}
          {resumeIndicator.phase === "synced" ? (
            <span role="status" className="shrink-0 text-xs font-normal text-muted-foreground">
              已同步
            </span>
          ) : null}
        </div>
        {resumeIndicator.phase === "syncing" ? (
          <div role="status" aria-label="正在同步" className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
            <div className="sync-progress-bar h-full w-1/3 bg-primary/70" />
          </div>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" title="更多" aria-label="更多" className="shrink-0" />}
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {[
              { title: "AGENT", views: AGENT_VIEWS },
              {
                title: activeSession
                  ? `容器 · ${activeSession.containerRemark || activeSession.containerName}`
                  : "容器",
                views: CONTAINER_VIEWS,
              },
            ].map((group, index) => (
              <React.Fragment key={group.views[0]}>
                {/* 这里分隔的是“作用对象”（AGENT / 容器），比侧栏菜单里按功能分类的分割线颜色更深 */}
                {index > 0 ? <DropdownMenuSeparator className="mx-1" /> : null}
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="truncate">{group.title}</DropdownMenuLabel>
                  {group.views.map((key) => (
                    <DropdownMenuItem key={key} aria-current={view === key} onClick={() => changeView(key)}>
                      {VIEW_LABELS[key]}
                      {view === key ? <CheckIcon className="ml-auto" /> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </React.Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
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
          ) : emptyConversation ? (
            // 空会话：输入区放在中间，下面给几个常用任务（点一下只是填进输入框，不直接发送）；
            // 发出第一条后回到正常布局，输入区在底部
            <div className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto px-1 py-6">
              <p className="text-base font-medium">想让 AGENT 做什么？</p>
              <div className="w-full max-w-2xl">{composerNode}</div>
              <div className="flex max-w-2xl flex-wrap justify-center gap-2 px-3">
                {STARTER_PROMPTS.map((text) => (
                  <Button key={text} variant="outline" size={isMobile ? "lg" : "sm"} onClick={() => updateDraft(text)}>
                    {text}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <ActivityView
              key={activeSession?.name ?? "none"}
              session={activeSession}
              messages={messages}
              mode={mode}
              onPreviewHtml={(title, code) => setHtmlPreview({ title, code })}
              hasMore={activeSession ? hasMoreBySession[activeSession.name] === true : false}
              loadingEarlier={loadingEarlier}
              onLoadEarlier={() => void loadEarlier()}
              followSignal={sendTick}
              onOpenPath={openPathInFiles}
              onRewind={(message) => setRewindTarget(message)}
              tail={
                <QueuedPrompts
                  items={activeSession ? queueBySession[activeSession.name] ?? [] : []}
                  idle={!activeAgentRunning}
                  onCancel={(item) => void handleCancelQueued(item, false)}
                  onEdit={(item) => void handleCancelQueued(item, true)}
                  onContinue={() => void handleContinueQueued()}
                />
              }
            />
          )
        ) : null}
        {terminalSessionName && terminalSessionName === activeSessionName ? (
          <div className={cn("h-full overflow-hidden", view !== "terminal" && "hidden")}>
            <TerminalView key={terminalSessionName} session={activeSession} />
          </div>
        ) : null}
        {filesMounted ? (
          <div className={cn("h-full", view !== "files" && "hidden")}>
            <FilesPanel
              activeSession={activeSession}
              editorStateRef={filesEditorRef}
              confirmLeaveIfDirty={confirmLeaveIfDirty}
              onPreviewHtml={(title, code) => setHtmlPreview({ title, code })}
              openRequest={filesOpenRequest}
              visible={view === "files"}
            />
          </div>
        ) : null}
        {containerMounted ? (
          <div className={cn("h-full", view !== "container" && "hidden")}>
            {activeSession ? (
              <ContainerManagePanel key={activeSession.containerName} containerName={activeSession.containerName} />
            ) : (
              <EmptyPane text="请先选择左侧的容器 / AGENT" />
            )}
          </div>
        ) : null}
        {view === "changes" ? (
          activeSession ? (
            <ChangesPanel key={activeSession.name} session={activeSession} onOpenFile={openPathInFiles} rounds={rounds} />
          ) : (
            <EmptyPane text="请先选择左侧的容器 / AGENT" />
          )
        ) : null}
        {view === "detail" ? <DetailView detail={sessionDetail} /> : null}
        {view === "config" ? <ConfigView detail={sessionDetail} /> : null}
      </div>

      {/* “暂时无法确认是否已发出”已经说明了断网，不再叠一条“连接中断”的提示 */}
      {view === "activity" && loadError && !(loadErrorRecoverable && restoreNotice?.kind === "unknown") ? (
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

      {view === "activity" && restoreNotice ? (
        <Alert className="mx-3 mb-2 w-auto min-w-0">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 break-words">
            <span>
              {restoreNotice.kind === "banner"
                ? "上次没发出去的内容还在，点“恢复”接到输入框末尾"
                : restoreNotice.kind === "unknown"
                  ? "网络断开，暂时无法确认是否已发出，恢复联网后自动核对"
                  : restoreNotice.kind === "text"
                    ? restoreNotice.text
                    : RESTORE_NOTICE_TEXT}
            </span>
            {restoreNotice.kind === "banner" || restoreNotice.kind === "unknown" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const { text, clientId } = restoreNotice.outbox
                  const current = draftRef.current
                  if (!current.trim() && activeSession) restoredRef.current = { sessionName: activeSession.name, clientId, text }
                  updateDraft(current.trim() ? `${current}\n\n${text}` : text)
                  if (activeSession) clearOutbox(activeSession.name, clientId)
                  setRestoreNotice({ kind: "info" })
                }}
              >
                恢复
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {view === "activity" && modelDenied && activeSession && !activeAgentRunning && !sendingNames.has(activeSession.name) ? (
        <ModelDeniedNotice
          containerName={activeSession.containerName}
          denied={modelDenied}
          onRetry={(prompt, images) => void handleSend(prompt, images)}
        />
      ) : null}

      {view === "activity" && !emptyConversation ? composerNode : null}

      <RewindDialog
        open={rewindTarget !== null}
        sessionName={activeSession?.name ?? ""}
        message={rewindTarget}
        onClose={() => setRewindTarget(null)}
        onDone={handleRewindDone}
      />
      <AgentTemplateDialog
        open={cliDialogOpen}
        onOpenChange={setCliDialogOpen}
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
