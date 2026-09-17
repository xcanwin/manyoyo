export type SessionSummary = {
  name: string
  containerName: string
  agentId: string
  agentName: string
  agentRemark: string
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
}

export type TraceEvent = {
  provider?: string
  kind: string
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
  envCount: number
  volumeCount: number
  portCount: number
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
  streamTrace?: boolean
  traceEvents?: TraceEvent[]
}

export type DisplayMessage = ChatMessage & { pairedTrace?: ChatMessage }

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

// 与 lib/web/frontend/chat-behavior.js 的 mergeTraceIntoReply 对齐：
// 把"执行过程"消息（streamTrace: true）合并进紧随其后的正式回复，
// 供 UI 把执行过程渲染成回复气泡上方的可折叠块
export function mergeTraceIntoReply(messages: ChatMessage[]): DisplayMessage[] {
  const result: DisplayMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.streamTrace) {
      const next = messages[i + 1]
      if (next && next.role === "assistant" && !next.streamTrace) {
        result.push({ ...next, timestamp: msg.timestamp, pairedTrace: msg })
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

const MERGEABLE_TRACE_KINDS = new Set(["tool", "command", "mcp"])

// 与 mergeToolTraceEvents 对齐：同一个工具调用的 started/completed 事件合并成一行
export function mergeToolTraceEvents(events: TraceEvent[]): TraceEvent[] {
  const result: TraceEvent[] = []
  const indexByKey = new Map<string, number>()
  for (const event of events) {
    if (MERGEABLE_TRACE_KINDS.has(event.kind) && event.toolId) {
      const key = `${event.kind}:${event.toolId}`
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
  return `${events.length} 步 · ${label}`
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
    window.location.href = "/shadcn/auth/login"
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
    throw new Error(detail ? `${error}: ${detail}` : error)
  }
  return data
}

export const apiGet = (url: string) => request(url)
export const apiPost = (url: string, body?: unknown) =>
  request(url, { method: "POST", body: body === undefined ? "{}" : JSON.stringify(body) })
export const apiPut = (url: string, body?: unknown) =>
  request(url, { method: "PUT", body: body === undefined ? "{}" : JSON.stringify(body) })

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
  | { type: "trace"; text: string; traceEvent?: TraceEvent }
  // content_delta 是权威全文（每条 assistant 消息落地时下发一次），
  // content_chunk 是 token 级增量片段：追加到当前流式回复上，reset 表示
  // 换了一条 assistant 消息、从空白重新开始
  | { type: "content_delta"; content: string }
  | { type: "content_chunk"; text: string; reset?: boolean }
  // 服务端保活心跳，仅用于喂饱反向代理的空闲读超时，前端忽略即可
  | { type: "ping" }
  | { type: "result"; exitCode: number; output: string; interrupted?: boolean; replyMessageId?: string }
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
    window.location.href = "/shadcn/auth/login"
    throw new Error("未登录或登录已过期")
  }
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}))
    throw new Error((data as { error?: string }).error || "请求失败")
  }

  // result/error 是后端真正跑完（成功或明确失败）才会发的终态事件；HTTP 流
  // 本身读完（done）不代表 agent 任务真的结束——网络抖动、代理/浏览器空闲超时、
  // 后台标签页被节流都可能让连接提前断开，而服务端那一轮任务（尤其是耗时更长的
  // 多 agent / 子 agent 任务）其实还在跑。没见过终态事件就把流当成功处理，会让
  // 调用方误以为任务已结束。与旧版前端 app.js 的 finalResult 校验对齐
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
  return Array.from(groups.values()).sort(
    (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
  )
}
