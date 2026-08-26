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
  | { type: "meta"; contextMode?: string; resumeAttempted?: boolean; resumeSucceeded?: boolean; agentProgram?: string }
  | { type: "trace"; text: string; traceEvent?: TraceEvent }
  | { type: "content_delta"; content: string }
  | { type: "result"; exitCode: number; output: string; interrupted?: boolean }
  | { type: "error"; error: string }

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
        onEvent(JSON.parse(text))
      } catch {
        continue
      }
    }
  }
  const rest = decoder.decode()
  const finalText = (pending + rest).trim()
  if (finalText) {
    try {
      onEvent(JSON.parse(finalText))
    } catch {
      // 忽略无法解析的收尾数据
    }
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
