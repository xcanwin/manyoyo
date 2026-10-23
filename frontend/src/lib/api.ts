export type SessionSummary = {
  name: string
  containerName: string
  agentId: string
  agentName: string
  agentRemark: string
  // Agent 自己生成的标题（目前只有 claude）与首条 Agent 消息，都是来自容器的不可信文本，只按纯文本显示
  agentTitle?: string
  firstPrompt?: string
  pinned?: boolean
  containerRemark: string
  status: string
  image: string
  createdAt: string | null
  updatedAt: string | null
  messageCount: number
  agentEnabled: boolean
  agentProgram: string
  resumeSupported: boolean
  model: string
  hostPath: string
  containerPath: string
  synthetic?: boolean
  archived?: boolean
  // 容器级运行锁的状态：containerBusy 表示这个容器里有 agent 任务在跑，
  // agentRunning 表示跑的就是这个 AGENT 自己
  containerBusy?: boolean
  agentRunning?: boolean
}

// 会话显示名的唯一规则：用户备注 > Agent 生成的标题 > 首条消息 > “AGENT N”
export function sessionDisplayTitle(
  session: Pick<SessionSummary, "agentName" | "agentRemark" | "agentTitle" | "firstPrompt"> | null | undefined
): string {
  if (!session) return ""
  for (const candidate of [session.agentRemark, session.agentTitle, session.firstPrompt]) {
    const text = String(candidate || "").trim()
    if (text) return text
  }
  return session.agentName || ""
}

export type ServeLogEntry = {
  ts: string
  pid: number
  level: string
  message: string
  extra: Record<string, unknown>
}

export type ServeLogPage = {
  date: string
  entries: ServeLogEntry[]
  nextEndOffset: number | null
  limit: number
}

// 日志级别对应的 Badge 变体：error 用 destructive，warn 用 outline 提示但不刺眼，
// 其余走 secondary。全部是语义色，亮色/暗色主题都自动跟随
export function logLevelBadgeVariant(level: string): "secondary" | "destructive" | "outline" {
  const normalized = String(level || "").toUpperCase()
  if (normalized === "ERROR") return "destructive"
  if (normalized === "WARN") return "outline"
  return "secondary"
}

// 日志行的结构化附加字段渲染成 "key=value" 列表，对象/数组用 JSON 兜底
export function formatLogExtra(extra: Record<string, unknown> | undefined): string[] {
  if (!extra || typeof extra !== "object") return []
  return Object.entries(extra).map(([key, value]) => {
    if (value === null || value === undefined) return `${key}=—`
    if (typeof value === "object") return `${key}=${JSON.stringify(value)}`
    return `${key}=${String(value)}`
  })
}

export type TraceEvent = {
  provider?: string
  // 结构化事件的 kind 来自服务端（tool / command / mcp / agent_message / status /
  // error ...）；"output" 是前端兜底合成的，见 toTraceEvent
  kind: string
  // 仅 kind="output" 有：这行原始输出来自 stdout 还是 stderr，决定显示成什么色
  stream?: "stdout" | "stderr"
  eventType?: string
  itemType?: string
  text: string
  toolId?: string
  toolName?: string
  server?: string
  command?: string
  argumentSummary?: string
  arguments?: unknown
  exitCode?: number
  result?: string
  error?: string
  phase?: string
  status?: string
  detail?: string
  // 子 Agent 里发生的事件：指向发起它的那次 Agent / Task 工具调用（kind="subagent" 的 toolId）
  parentToolId?: string
  subagentType?: string
  description?: string
  prompt?: string
}

export type AppliedConfig = {
  containerName: string
  hostPath: string
  containerPath: string
  imageName: string
  imageVersion: string
  containerMode: string
  shellPrefix: string
  shell: string
  shellSuffix: string
  defaultCommand: string
  agentEnabled: boolean
  agentProgram: string
  resumeSupported: boolean
  yolo: string
}

export type SessionDetail = SessionSummary & {
  latestRole: string
  latestTimestamp: string
  agentPromptCommand: string
  containerAgentPromptCommand: string
  agentPromptCommandOverride: string
  inferredAgentPromptCommand: string
  agentPromptSource: "agent" | "container" | "inferred" | "none" | string
  lastResumeAt: string | null
  lastResumeOk: boolean | null
  lastResumeError: string
  usageTotal: { inputTokens: number; outputTokens: number; costUsd: number | null } | null
  applied: AppliedConfig
}

export type ChatMessage = {
  id: string | number
  role: "user" | "assistant" | "system"
  content: string
  timestamp: string
  mode?: "agent" | "command"
  pending?: boolean
  interrupted?: boolean
  exitCode?: number
  // 这一轮因为 Agent 自己的模型地址被网络策略拦下而中止
  networkDenied?: { host: string; model?: boolean }
  streamTrace?: boolean
  traceEvents?: TraceEvent[]
  // 列表里 trace 的长字段被服务端截断过；展开时按需请求 /messages/<id>/trace 取完整内容
  traceTruncated?: boolean
  // 发送时前端生成的 id，服务端回显，用来确认“这条提示词已经发出去了”
  clientMessageId?: string
  // 只在前端：本轮执行过程的渲染 key（发送时生成）。占位 id 换成服务端 id、配上回复后都不变，
  // 执行过程因此不会被 React 重新挂载（重新挂载会丢掉展开状态、整段收起再出现）
  renderKey?: string
}

// hideBubble：执行中（执行过程与回复都还在进行）回复框不单独显示，正在输出的文字（liveText）交给执行过程——
// 每条新的 assistant 消息开始时回复框会被清空重来，单独显示会让视野上下抖，也容易被当成最终回复
export type DisplayMessage = ChatMessage & { pairedTrace?: ChatMessage; hideBubble?: boolean; liveText?: string }

// 消息列表里三类"本地乐观占位"的 id 约定：发送瞬间前端先用这些临时 id 渲染，
// 服务端 meta/result 事件会带回持久化消息的真实 id，前端收到后原地替换——
// 这样轮询对账（loadMessages 全量替换）时 React key 与服务端数据一致，
// 不会把整个消息列表 DOM 重建掉（重建会清零代码块横向滚动位置与文字选区）
export const LOCAL_USER_MESSAGE_ID_PREFIX = "local-"
export const STREAMING_TRACE_ID = "__streaming_trace__"
export const STREAMING_MESSAGE_ID = "__streaming__"

function isValidServerMessageId(value: unknown): value is string | number {
  return (typeof value === "string" && value !== "") || typeof value === "number"
}

// 把流式 meta/result 事件携带的服务端消息 id 应用到本地乐观占位上：
// - userMessageId（meta）：最后一条 local-* user 消息
// - traceMessageId（meta）：__streaming_trace__ 执行过程占位
// - replyMessageId（result）：__streaming__ 流式回复占位
// 找不到对应占位（如 409 冲突时 meta 未到达、或对账已先一步完成）时原样返回
export function applyServerMessageIds(
  messages: ChatMessage[],
  ids: {
    userMessageId?: string | number
    traceMessageId?: string | number
    replyMessageId?: string | number
  }
): ChatMessage[] {
  let result = messages
  const apply = (matches: (message: ChatMessage) => boolean, nextId: string | number) => {
    result = result.map((message) => (matches(message) ? { ...message, id: nextId } : message))
  }
  if (isValidServerMessageId(ids.userMessageId)) {
    // 从后往前找本轮刚 append 的 local user 占位（历史上可能残留更早的 local-*）
    let lastIndex = -1
    for (let i = result.length - 1; i >= 0; i--) {
      const id = result[i].id
      if (typeof id === "string" && id.startsWith(LOCAL_USER_MESSAGE_ID_PREFIX)) {
        lastIndex = i
        break
      }
    }
    if (lastIndex >= 0) {
      const next = result.slice()
      next[lastIndex] = { ...next[lastIndex], id: ids.userMessageId }
      result = next
    }
  }
  if (isValidServerMessageId(ids.traceMessageId)) {
    apply((message) => message.id === STREAMING_TRACE_ID, ids.traceMessageId)
  }
  if (isValidServerMessageId(ids.replyMessageId)) {
    apply((message) => message.id === STREAMING_MESSAGE_ID, ids.replyMessageId)
  }
  return result
}

// trace/result 事件到达时，用调用方传入的"当前有效 trace 消息 id"去匹配
// messages 数组——meta 事件会把这条本地占位的 id 从 STREAMING_TRACE_ID 换成
// 服务端持久化 id（见 applyServerMessageIds），调用方必须在 meta 到达后同步
// 更新自己持有的这个 id，再传给这里；如果继续硬编码 STREAMING_TRACE_ID，
// 换 id 之后收到的每一条 trace 事件都会匹配不到任何消息而静默丢失，
// traceEvents 永远停在初始空数组，"执行过程"折叠面板因此永远不会出现
// （TraceBlock 里 !merged.length 直接 return null）
export function applyTraceEventUpdate<T extends { id: string | number }>(
  messages: T[],
  currentTraceMessageId: string | number,
  patch: Partial<T>
): T[] {
  return messages.map((message) =>
    message.id === currentTraceMessageId ? { ...message, ...patch } : message
  )
}

// loadMessages 响应回写前的守卫：请求发起后状态可能已经变化——
// - 用户已切换到别的会话：旧会话的响应写进去会把 A 的消息糊到 B 的界面上
// - 本标签页开始为该会话跑 stream：晚到的旧快照会把刚 append 的乐观 user
//   消息整体覆盖掉，用户表现为"发出去的提示词消失了"
// 两种情况都应丢弃这次响应
export function shouldDiscardMessagesResponse(
  requestedSessionName: string,
  activeSessionName: string | null,
  sessionSending: boolean
): boolean {
  if (activeSessionName !== requestedSessionName) return true
  return sessionSending
}

// 发送请求在服务端确认前失败（409 冲突 / 网络错误等）时清除本轮全部本地乐观
// 占位：最新一条 local-* user 消息 + 两个流式占位。服务端没收到这条消息，
// 不清除会留下一条"永远没有回复"的幽灵消息。meta 已把占位换成服务端 id 的
// 情况下（服务端已持久化），local-* 不存在，只会清掉残留占位，服务端消息不动
export function removeLocalPendingPlaceholders(messages: ChatMessage[]): ChatMessage[] {
  let lastLocalUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i].id
    if (typeof id === "string" && id.startsWith(LOCAL_USER_MESSAGE_ID_PREFIX)) {
      lastLocalUserIndex = i
      break
    }
  }
  return messages.filter(
    (message, index) =>
      index !== lastLocalUserIndex &&
      message.id !== STREAMING_MESSAGE_ID &&
      message.id !== STREAMING_TRACE_ID
  )
}

// 把"执行过程"消息（streamTrace: true）合并进紧随其后的正式回复，
// 供 UI 把执行过程渲染成回复气泡上方的可折叠块
export function mergeTraceIntoReply(messages: ChatMessage[]): DisplayMessage[] {
  const result: DisplayMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.streamTrace) {
      const next = messages[i + 1]
      if (next && next.role === "assistant" && !next.streamTrace) {
        const live = msg.pending === true && next.pending === true
        result.push(live
          ? { ...next, timestamp: msg.timestamp, pairedTrace: msg, hideBubble: true, liveText: next.content }
          : { ...next, timestamp: msg.timestamp, pairedTrace: msg })
        i++
        continue
      }
      result.push(msg)
      continue
    }
    result.push(msg)
  }
  return result
}

// 消息行的 React key：有执行过程的一行用执行过程的 key（renderKey 优先，其次 id），
// 这样单独的执行过程配上回复、回复换成服务端 id 时，这一行不会被重新挂载
export function messageRenderKey(message: DisplayMessage): string | number {
  const owner = message.pairedTrace ?? (message.streamTrace ? message : null)
  if (owner) return owner.renderKey ?? owner.id
  return message.renderKey ?? message.id
}

// 服务端的 trace 事件不保证带结构化 traceEvent：stderr 行（server.js 的
// emitStderrTraceLine）和解析不出 JSON 的 stdout 行都只有 text。这类行必须照样
// 展示——自定义 agentPromptCommand、四大 CLI 之外的 CLI、以及 CLI 报错时，
// 整轮执行过程可能全是这种裸行，丢掉等于界面上一个字都没有，这里合成一条
// kind="output" 的事件接住它。
// 合成事件刻意不用 kind="error"：stderr 里大量是无害告警，判成 error 会让
// summarizeTraceFlow 一直报"有错误"、面板每轮都自动展开
export function toTraceEvent(event: {
  text?: string
  stream?: string
  traceEvent?: TraceEvent
}): TraceEvent | null {
  if (event.traceEvent) return event.traceEvent
  const text = String(event.text || "").trim()
  if (!text) return null
  return { kind: "output", stream: event.stream === "stderr" ? "stderr" : "stdout", text }
}

// meta 事件里对用户有意义的两件事：这一轮用的是哪种上下文模式、resume 有没有成功。
// resume 失败时服务端会静默回退到"把历史重新注入 prompt"，上下文可能和 agent 自己
// 记的对不上——这条必须让用户看见，否则只会觉得 agent 莫名其妙失忆了
export function buildStreamMetaTraceEvents(meta: {
  contextMode?: string
  resumeAttempted?: boolean
  resumeSucceeded?: boolean
}): TraceEvent[] {
  const events: TraceEvent[] = []
  const contextMode = String(meta.contextMode || "").trim()
  if (contextMode) {
    events.push({ kind: "status", text: `[任务] 上下文模式: ${contextMode}` })
  }
  if (meta.resumeAttempted) {
    events.push({
      kind: "status",
      text: meta.resumeSucceeded
        ? "[任务] 会话恢复成功"
        : "[任务] 会话恢复失败，已回退到历史注入",
    })
  }
  return events
}

const MERGEABLE_TRACE_KINDS = new Set(["tool", "command", "mcp", "subagent"])

// 与 mergeToolTraceEvents 对齐：同一个工具调用的 started/completed 事件合并成一行
// 工具调用的参数展示：不再给“参数摘要”（它只是把同样的内容压成一行，纯属重复）。
// 有 command（如 Bash）就直接显示命令原文（真实换行、不带转义）和描述，
// 其余参数照常给 JSON；没有结构化参数时才退回摘要。
export function buildToolArgumentParts(event: Pick<TraceEvent, "arguments" | "argumentSummary">): Array<{ label: string; value: unknown }> {
  const args = event.arguments
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const { command, description, ...rest } = args as Record<string, unknown>
    const parts: Array<{ label: string; value: unknown }> = []
    const hasCommand = typeof command === "string" && command.trim() !== ""
    const hasDescription = typeof description === "string" && description.trim() !== ""
    if (hasCommand) parts.push({ label: "命令", value: command })
    else if (command !== undefined) (rest as Record<string, unknown>).command = command
    if (hasDescription) parts.push({ label: "描述", value: description })
    else if (description !== undefined) (rest as Record<string, unknown>).description = description
    if (Object.keys(rest).length > 0) {
      parts.push({ label: "工具参数", value: rest })
    }
    return parts
  }
  if (args !== undefined && args !== null && args !== "") return [{ label: "工具参数", value: args }]
  return event.argumentSummary ? [{ label: "参数摘要", value: event.argumentSummary }] : []
}

// 工具参数压成一行：键=值，值里的换行折成空格，嵌套值给单行 JSON（不缩进）；过长由界面截断
export function compactToolArguments(value: unknown): string {
  if (value === undefined || value === null || value === "") return ""
  if (typeof value === "string") return value.replace(/\s*\n\s*/g, " ")
  if (typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value) ?? ""
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => {
      const text = typeof item === "string" ? item.replace(/\s*\n\s*/g, " ") : JSON.stringify(item)
      return `${key}=${text}`
    })
    .join(" ")
}

// 工具行的标题：一行写清 工具名 + 结果（✅ 成功 / ❎ 失败，执行中不显示）+ 描述。
// 合并后的事件 text 是服务端的“[工具完成] Bash (success)”，信息量少，这里改由结构化字段拼出；
// 描述缺省时依次用参数摘要、命令。其他种类的事件照旧用 text
export function formatTraceRowTitle(event: TraceEvent, stepCount = 0): string {
  if (event.kind === "subagent") {
    const failed = event.status === "error" || Boolean(event.error)
    const done = event.phase === "completed" || event.status === "success" || event.status === "completed"
    const text = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "")
    const head = ["[子 Agent]", text(event.subagentType) || event.toolName || "Agent", failed ? "❎" : done ? "✅" : ""]
      .filter(Boolean)
      .join(" ")
    return stepCount > 0 ? `${head} · ${stepCount} 步` : head
  }
  if (isTaskListTool(event)) return `[任务清单] 更新 ${taskListUpdateCount(event)} 项`
  if (event.kind !== "tool") return event.text
  const failed = event.status === "error" || Boolean(event.error)
  const done = event.phase === "completed" || event.status === "success" || event.status === "completed"
  const icon = failed ? "❎" : done ? "✅" : ""
  return ["[工具]", event.toolName || "tool", icon].filter(Boolean).join(" ")
}

// 工具 / 子 Agent 行标题下面那一段描述（与 [说明] 正文同样式）：依次用 description、参数摘要、命令，原样保留换行
export function traceRowDescription(event: TraceEvent): string {
  const pick = (value: unknown) => (typeof value === "string" ? value.trim() : "")
  if (event.kind === "subagent") return pick(event.description)
  if (event.kind !== "tool" || isTaskListTool(event)) return ""
  const args = toArgs(event)
  return pick(args.description) || pick(event.argumentSummary) || pick(args.command)
}

const TASK_LIST_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"])

export function isTaskListTool(event: TraceEvent): boolean {
  return event.kind === "tool" && TASK_LIST_TOOLS.has(event.toolName || "")
}

function toArgs(event: TraceEvent): Record<string, unknown> {
  return event.arguments && typeof event.arguments === "object" && !Array.isArray(event.arguments)
    ? (event.arguments as Record<string, unknown>)
    : {}
}

function taskListUpdateCount(event: TraceEvent): number {
  const todos = toArgs(event).todos
  return Array.isArray(todos) ? todos.length : 1
}

export type TaskItem = { id: string; subject: string; status: "pending" | "in_progress" | "completed" }

function normalizeTaskStatus(value: unknown, fallback: TaskItem["status"]): TaskItem["status"] {
  return value === "completed" || value === "in_progress" || value === "pending" ? value : fallback
}

// 把 TodoWrite（整份覆盖）/ TaskCreate / TaskUpdate（增量）按顺序折叠成最新的任务清单。
// TaskCreate 的编号取自结果里的 “#N”，缺省按创建顺序从 1 开始；TaskUpdate 的 status=deleted 表示删掉
export function buildTaskList(events: TraceEvent[]): TaskItem[] {
  let items: TaskItem[] = []
  for (const event of events) {
    if (!isTaskListTool(event) || event.parentToolId) continue
    const args = toArgs(event)
    if (event.toolName === "TodoWrite") {
      if (!Array.isArray(args.todos)) continue
      items = args.todos
        .filter((todo): todo is Record<string, unknown> => Boolean(todo) && typeof todo === "object")
        .map((todo, index) => ({
          id: String(index + 1),
          subject: String(todo.content ?? todo.subject ?? "").trim(),
          status: normalizeTaskStatus(todo.status, "pending"),
        }))
        .filter((item) => item.subject)
    } else if (event.toolName === "TaskCreate") {
      const subject = String(args.subject ?? "").trim()
      if (!subject) continue
      const numbered = /#(\d+)/.exec(event.result || "")
      items.push({ id: numbered ? numbered[1] : String(items.length + 1), subject, status: "pending" })
    } else if (event.toolName === "TaskUpdate") {
      const id = String(args.taskId ?? "")
      if (args.status === "deleted") {
        items = items.filter((item) => item.id !== id)
        continue
      }
      items = items.map((item) =>
        item.id === id
          ? {
              ...item,
              subject: typeof args.subject === "string" && args.subject.trim() ? args.subject.trim() : item.subject,
              status: normalizeTaskStatus(args.status, item.status),
            }
          : item
      )
    }
  }
  return items
}

export type TraceNode = {
  event: TraceEvent
  key: string
  // 嵌套深度，缩进最多按第 3 层显示
  depth: number
  children: TraceNode[]
  // 这个子 Agent 里（含更深层）一共有多少步
  stepCount: number
}

export const MAX_TRACE_INDENT_DEPTH = 3

export function traceRowKey(event: TraceEvent, index: number): string {
  return event.toolId ? `${event.kind}:${event.parentToolId || ""}:${event.toolId}` : `${event.kind}-${index}`
}

// 把合并后的平铺事件按 parentToolId 挂成树：子 Agent 里的事件挂在发起它的那一行下面；
// 找不到发起者（比如被截断）的事件当作顶层事件，不丢
export function buildTraceTree(events: TraceEvent[]): TraceNode[] {
  const roots: TraceNode[] = []
  const subagents = new Map<string, TraceNode>()
  events.forEach((event, index) => {
    const parent = event.parentToolId ? subagents.get(event.parentToolId) : undefined
    const node: TraceNode = {
      event,
      key: traceRowKey(event, index),
      depth: parent ? parent.depth + 1 : 0,
      children: [],
      stepCount: 0,
    }
    if (event.kind === "subagent" && event.toolId) subagents.set(event.toolId, node)
    if (parent) {
      parent.children.push(node)
      for (let up: TraceNode | undefined = parent; up; up = up.event.parentToolId ? subagents.get(up.event.parentToolId) : undefined) {
        up.stepCount += 1
      }
    } else {
      roots.push(node)
    }
  })
  return roots
}

export function mergeToolTraceEvents(events: TraceEvent[]): TraceEvent[] {
  const result: TraceEvent[] = []
  const indexByKey = new Map<string, number>()
  for (const event of events) {
    if (MERGEABLE_TRACE_KINDS.has(event.kind) && event.toolId) {
      const key = `${event.kind}:${event.parentToolId || ""}:${event.toolId}`
      const existingIndex = indexByKey.get(key)
      if (existingIndex !== undefined) {
        result[existingIndex] = { ...result[existingIndex], ...event }
        continue
      }
      indexByKey.set(key, result.length)
    }
    result.push(event)
  }
  return result
}

// pending 直接取自 trace 消息本身（服务端在轮次结束时会把它置为 false），
// 不用去猜各 traceEvent 的 phase/status —— thread/turn 等一次性事件只有
// "started"，永远不会有配对的"completed"，用它们推断进行中会永远误判
export function summarizeTraceFlow(events: TraceEvent[], pending: boolean): string {
  const hasError = events.some((event) => event.kind === "error")
  const label = hasError ? "有错误" : pending ? "进行中" : "已完成"
  // 只数顶层步数，子 Agent 里的步数写在它自己那一行
  return `${buildTraceTree(events).length} 步 · ${label}`
}

export type FsEntry = {
  name: string
  path: string
  kind: "directory" | "file" | "symlink" | "other"
  size: number
  mtimeMs: number
  symlinkTarget?: string
  symlinkTargetKind?: string
}

export type FsReadResult = {
  path: string
  kind: "text" | "binary" | "image"
  size: number
  truncated: boolean
  content?: string
  language?: string
  editable?: boolean
  // 内容的版本号（sha256）：保存时带回去，容器里的文件被改过就能发现，不会悄悄覆盖
  etag?: string
}

export type DirectoryEntry = {
  name: string
  path: string
}

export type ContainerGroup = {
  containerName: string
  containerRemark: string
  status: string
  image: string
  hostPath: string
  updatedAt: string
  sessions: SessionSummary[]
  // 容器里有置顶的 AGENT（排序与图标用）
  pinned?: boolean
}

async function request(url: string, options: RequestInit = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...(options.headers || {}),
    },
  })
  if (response.status === 401) {
    window.location.href = "/auth/login"
    throw new Error("未登录或登录已过期")
  }
  let data: Record<string, unknown>
  try {
    data = await response.json()
  } catch {
    data = {}
  }
  if (!response.ok) {
    const error = typeof data.error === "string" ? data.error : "请求失败"
    const detail = typeof data.detail === "string" ? data.detail : ""
    throw Object.assign(new Error(detail ? `${error}: ${detail}` : error), { status: response.status, data })
  }
  return data
}

// request 抛出的错误带 status 与服务端返回体（409 冲突要用最新内容、400 needsConfirm 要读 risks）
export function apiErrorData(error: unknown): { status: number; data: Record<string, unknown> } {
  const e = error as { status?: number; data?: Record<string, unknown> } | null
  return { status: e?.status ?? 0, data: e?.data ?? {} }
}

export const apiGet = (url: string, signal?: AbortSignal) => request(url, signal ? { signal } : {})
export const apiPost = (url: string, body?: unknown) =>
  request(url, { method: "POST", body: body === undefined ? "{}" : JSON.stringify(body) })
export const apiPut = (url: string, body?: unknown, headers?: Record<string, string>) =>
  request(url, { method: "PUT", body: body === undefined ? "{}" : JSON.stringify(body), headers })
export const apiDelete = (url: string, body?: unknown) =>
  request(url, { method: "DELETE", body: body === undefined ? "{}" : JSON.stringify(body) })

export type StreamEvent =
  | {
      type: "meta"
      contextMode?: string
      resumeAttempted?: boolean
      resumeSucceeded?: boolean
      agentProgram?: string
      // 服务端为本轮消息预先生成的持久化 id，见 applyServerMessageIds
      userMessageId?: string
      traceMessageId?: string
    }
  // traceEvent 只在服务端能把这一行解析成结构化事件时才有；其余（stderr、
  // 非 JSON 的 stdout）只有 text + stream，交给 toTraceEvent 兜底
  | { type: "trace"; text: string; stream?: "stdout" | "stderr"; traceEvent?: TraceEvent }
  // content_delta 是权威全文（每条 assistant 消息落地时下发一次），
  // content_chunk 是 token 级增量片段：追加到当前流式回复上，reset 表示
  // 换了一条 assistant 消息、从空白重新开始
  | { type: "content_delta"; content: string }
  | { type: "content_chunk"; text: string; reset?: boolean }
  // 服务端保活心跳，仅用于喂饱反向代理的空闲读超时，前端忽略即可
  | { type: "ping" }
  // 这一轮结束后服务端接着发排队的下一条：本条流到此为止，前端改为跟随下一轮
  | { type: "queue_next" }
  // 被网络策略拦下的域名；model=true 表示是 Agent 自己的模型地址，服务端随后会中止本轮
  | { type: "network_denied"; host: string; model?: boolean }
  | {
      type: "result"
      exitCode: number
      output: string
      interrupted?: boolean
      replyMessageId?: string
      networkDenied?: { host: string; model?: boolean }
    }
  | { type: "error"; error: string }

// 流被"连接层"打断（而不是服务端明确报错）的判定。典型触发：agent 静默时间超过
// 反向代理的空闲读超时，nginx 把这条 h2 流 RST 掉，浏览器侧 fetch/reader 抛出各家
// 自己的原话。这种情况下服务端那一轮任务其实还在容器里跑，界面应提示"正在重新
// 同步"并交给 useAgentRecoveryPoll 兜底，而不是把裸错误当成失败贴给用户
const STREAM_CONNECTION_ERROR_PATTERNS = [
  "network error",
  "failed to fetch",
  "load failed",
  "networkerror",
  "connection closed",
  "agent 流式响应未返回结果",
]

export function isStreamConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return STREAM_CONNECTION_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
}

// AGENT 名里的创建序号：default 记为 1，agent-N 记为 N，其余（含删容器时传进来的
// 空 agentId）记 0，rank 为 0 表示"没有序号可比"，直接走按创建时间的兜底
function agentCreationRank(session: { agentId?: string }): number {
  const agentId = String(session.agentId || "")
  if (!agentId) return 0
  if (agentId === "default") return 1
  const matched = agentId.match(/^agent-(\d+)$/)
  return matched ? Number(matched[1]) || 0 : 0
}

function newestFirst(a: SessionSummary, b: SessionSummary): number {
  return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
}

// 删掉当前正在看的会话之后该接管到哪一个：优先同容器里"上一个"AGENT（创建序号
// 更小的里最大的那个），没有就取序号更大的里最小的，再不行退回同容器最新创建的；
// 整个容器都没了才跨容器取最新的一个。
//
// 不要图省事直接 onSelectSession(null)：删完一个 AGENT 就把工作台清空、还得自己
// 再点一次，删多个时尤其难受。synthetic 占位不在侧边栏里显示，也不能选中它。
export function pickSessionAfterRemoval(
  sessions: SessionSummary[],
  removed: { name: string; containerName: string; agentId?: string }
): SessionSummary | null {
  const candidates = sessions.filter((s) => s.name !== removed.name && s.synthetic !== true)
  const sameContainer = candidates.filter((s) => s.containerName === removed.containerName)
  if (sameContainer.length) {
    const removedRank = agentCreationRank(removed)
    if (removedRank > 0) {
      const lower = sameContainer
        .filter((s) => agentCreationRank(s) < removedRank)
        .sort((a, b) => agentCreationRank(b) - agentCreationRank(a))
      if (lower.length) return lower[0]
      const higher = sameContainer
        .filter((s) => agentCreationRank(s) > removedRank)
        .sort((a, b) => agentCreationRank(a) - agentCreationRank(b))
      if (higher.length) return higher[0]
    }
    return sameContainer.slice().sort(newestFirst)[0]
  }
  if (!candidates.length) return null
  return candidates.slice().sort(newestFirst)[0]
}

// 会话名是 `containerName` 或 `containerName~agentId`。必须带上分隔符判断，
// 否则 `foo-copy1~default`.startsWith('foo') 也成立——克隆出来的容器正好叫
// `<name>-copy1`，删掉 foo 会误伤正在 foo-copy1 里进行的会话
export function isSessionOfContainer(
  sessionName: string | null | undefined,
  containerName: string
): boolean {
  if (!sessionName || !containerName) return false
  return sessionName === containerName || sessionName.startsWith(`${containerName}~`)
}

export type ComposerMode = "agent" | "command"

export function formatComposerModeLabel(mode: ComposerMode): string {
  return mode === "command" ? "系统命令" : "Agent对话"
}

export type ComposerBlockReason = "" | "archived" | "container-busy" | "agent-unavailable"

// 输入框该不该拦、拦的理由是什么。container-busy 这条来自服务端的容器级运行锁：
// 同容器里别的 AGENT 在跑任务时这个 AGENT 也发不出去，提前拦住比点了才吃 409 好
export function resolveComposerBlockReason(
  session: {
    agentEnabled?: boolean
    archived?: boolean
    containerBusy?: boolean
    agentRunning?: boolean
  },
  mode: ComposerMode
): ComposerBlockReason {
  if (session.archived === true) return "archived"
  if (session.containerBusy === true && session.agentRunning !== true) return "container-busy"
  if (mode === "agent" && session.agentEnabled === false) return "agent-unavailable"
  return ""
}

// 恢复轮询的间隔：前两轮保持 1.5s 灵敏，之后逐步退避到 15s 封顶。
// 正常任务几轮内就收尾了；真正需要退避的是 serve 重启留下的孤儿 pending——
// 它永远等不到收尾，固定 1.5s 会一直高频打 /messages + /detail
const RECOVERY_POLL_BASE_MS = 1500
const RECOVERY_POLL_MAX_MS = 15000

export function nextRecoveryPollDelay(attempt: number): number {
  const steps = Math.max(0, attempt - 1)
  return Math.min(RECOVERY_POLL_BASE_MS * 2 ** steps, RECOVERY_POLL_MAX_MS)
}

// 搜索框的匹配规则。cmdk 默认是子序列模糊打分，而 manyoyo 的容器名基本都是
// `my-easy-<时间戳>` 这种高度相似的串，模糊匹配会把一堆无关容器排进结果里
//（输 20260917 连 20260915-092716 都能匹配上）。这里换成大小写不敏感的子串匹配
export function scoreSearchCandidate(value: string, search: string): number {
  const keyword = search.trim().toLowerCase()
  if (!keyword) return 1
  return value.toLowerCase().includes(keyword) ? 1 : 0
}

// 断线提示（"正在重新同步…"）什么时候该自己撤掉。
// 判据是"断线之后有没有成功跟服务端对上一次账"，而不是"整轮任务跑没跑完"——
// 恢复轮询通常一两秒就把内容同步回来了，界面肉眼可见在正常更新，这时候还挂着
// 一条红色告警纯属吓人；反过来，对账一次都没成功前不能撤，否则本地占位刚被
// 清掉、服务端快照还没回来的那一瞬间 pending 恰好为空，提示会一闪而过
export function shouldDismissRecoveryNotice(params: {
  recoverable: boolean
  sending: boolean
  syncTick: number
  errorSyncTick: number
}): boolean {
  if (!params.recoverable) return false
  if (params.sending) return false
  return params.syncTick > params.errorSyncTick
}

export async function apiStream(
  url: string,
  body: unknown,
  onEvent: (event: StreamEvent) => void
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify(body),
  })
  if (response.status === 401) {
    window.location.href = "/auth/login"
    throw new Error("未登录或登录已过期")
  }
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}))
    // 带上 status 和返回体：调用方要区分“服务端明确拒绝”和“网络中断，不知道收到没有”
    throw Object.assign(new Error((data as { error?: string }).error || "请求失败"), {
      status: response.status,
      data,
    })
  }

  // result/error 是后端真正跑完（成功或明确失败）才会发的终态事件；HTTP 流
  // 本身读完（done）不代表 agent 任务真的结束——网络抖动、代理/浏览器空闲超时、
  // 后台标签页被节流都可能让连接提前断开，而服务端那一轮任务（尤其是耗时更长的
  // 多 agent / 子 agent 任务）其实还在跑。没见过终态事件就把流当成功处理，会让
  // 调用方误以为任务已结束
  let sawTerminalEvent = false
  function dispatch(event: StreamEvent) {
    if (event.type === "result" || event.type === "error") sawTerminalEvent = true
    onEvent(event)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    const lines = pending.split("\n")
    pending = lines.pop() || ""
    for (const line of lines) {
      const text = line.trim()
      if (!text) continue
      // 单行 NDJSON 解析失败不应打断整条流：跳过畸形/截断行，继续读取后续事件
      try {
        dispatch(JSON.parse(text))
      } catch {
        continue
      }
    }
  }
  const rest = decoder.decode()
  const finalText = (pending + rest).trim()
  if (finalText) {
    try {
      dispatch(JSON.parse(finalText))
    } catch {
      // 忽略无法解析的收尾数据
    }
  }

  if (!sawTerminalEvent) {
    throw new Error("Agent 流式响应未返回结果")
  }
}

export function groupSessionsByContainer(sessions: SessionSummary[]): ContainerGroup[] {
  const groups = new Map<string, ContainerGroup>()
  for (const session of sessions) {
    const containerName = session.containerName
    if (!containerName) continue
    if (!groups.has(containerName)) {
      groups.set(containerName, {
        containerName,
        containerRemark: session.containerRemark || "",
        status: session.status || "history",
        image: session.image || "",
        hostPath: session.hostPath || "未配置目录",
        updatedAt: session.updatedAt || "",
        sessions: [],
      })
    }
    const group = groups.get(containerName)!
    group.sessions.push(session)
    if (
      session.updatedAt &&
      (!group.updatedAt || new Date(session.updatedAt) > new Date(group.updatedAt))
    ) {
      group.updatedAt = session.updatedAt
    }
  }
  // 置顶：容器内置顶的 AGENT 排最前（其余保持原顺序）；含置顶 AGENT 的容器排在容器列表最前
  for (const group of groups.values()) {
    group.pinned = group.sessions.some((session) => session.pinned === true)
    group.sessions = [
      ...group.sessions.filter((session) => session.pinned === true),
      ...group.sessions.filter((session) => session.pinned !== true),
    ]
  }
  return Array.from(groups.values()).sort(
    (a, b) =>
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
      new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
  )
}
