import {
  LOCAL_USER_MESSAGE_ID_PREFIX,
  STREAMING_MESSAGE_ID,
  STREAMING_TRACE_ID,
  type ChatMessage,
} from "./api"

// /messages 增量同步的纯函数：page（最近一页）/ tail（anchor 之后）/ reset（整体替换）/ before（更早一页）

export const MESSAGES_PAGE_LIMIT = 60

export type MessagesResponse = {
  messages: ChatMessage[]
  epoch: string
  firstId: string | number | null
  hasMore: boolean
  mode: "page" | "tail" | "reset"
}

export type MessagesQuery = {
  limit?: number
  after?: string | number
  epoch?: string
  before?: string | number
}

export function buildMessagesUrl(sessionName: string, query: MessagesQuery): string {
  const params: string[] = []
  const add = (key: string, value: string | number | undefined) => {
    if (value !== undefined) params.push(`${key}=${encodeURIComponent(String(value))}`)
  }
  add("after", query.after)
  add("epoch", query.epoch)
  add("before", query.before)
  add("limit", query.limit)
  const qs = params.length ? `?${params.join("&")}` : ""
  return `/api/sessions/${encodeURIComponent(sessionName)}/messages${qs}`
}

export function buildTraceUrl(sessionName: string, messageId: string | number): string {
  return `/api/sessions/${encodeURIComponent(sessionName)}/messages/${encodeURIComponent(String(messageId))}/trace`
}

function isLocalPlaceholderId(id: string | number): boolean {
  if (typeof id !== "string") return false
  return (
    id.startsWith(LOCAL_USER_MESSAGE_ID_PREFIX) ||
    id.startsWith("result-") ||
    id === STREAMING_MESSAGE_ID ||
    id === STREAMING_TRACE_ID
  )
}

// 稳定前缀 = 从头到第一条 pending 之前；anchor = 前缀最后一条。
// 前缀里有本地占位 id（命令模式的 local-* / result-*，服务端 id 与之对不上）时返回 null，
// 让调用方改拉最近一页整体替换
export function getSyncAnchor(messages: ChatMessage[]): string | number | null {
  let anchor: string | number | null = null
  for (const message of messages) {
    if (message.pending === true) break
    if (isLocalPlaceholderId(message.id)) return null
    anchor = message.id
  }
  return anchor
}

// “加载更早”的游标：本地第一条服务端消息的 id
export function firstServerMessageId(messages: ChatMessage[]): string | number | null {
  const first = messages.find((message) => !isLocalPlaceholderId(message.id))
  return first ? first.id : null
}

export function buildSyncQuery(messages: ChatMessage[], epoch: string | null): MessagesQuery {
  const anchor = getSyncAnchor(messages)
  if (anchor !== null && epoch) return { after: anchor, epoch }
  return { limit: MESSAGES_PAGE_LIMIT }
}

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.content === b.content &&
    a.timestamp === b.timestamp &&
    a.mode === b.mode &&
    a.pending === b.pending &&
    a.interrupted === b.interrupted &&
    a.exitCode === b.exitCode &&
    a.streamTrace === b.streamTrace &&
    // 本地有完整 trace、服务端给的是同一条的截断版：算同一份，保留本地的（展开中的内容不回退成“…”）
    (a.traceTruncated === b.traceTruncated || (!a.traceTruncated && b.traceTruncated === true)) &&
    a.clientMessageId === b.clientMessageId &&
    (a.traceEvents?.length ?? 0) === (b.traceEvents?.length ?? 0)
  )
}

// 内容没变的消息复用旧对象：React 不重渲染，DOM 不重建（保住选区与代码块滚动位置）
function reuseUnchanged(prev: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string | number, ChatMessage>()
  for (const message of prev) byId.set(message.id, message)
  let changed = next.length !== prev.length
  const out = next.map((message, index) => {
    const old = byId.get(message.id)
    const result = old && sameMessage(old, message) ? old : message
    if (result !== prev[index]) changed = true
    return result
  })
  return changed ? out : prev
}

export type AppliedMessages = { messages: ChatMessage[]; epoch: string; hasMore: boolean }

// 套用 page / tail / reset 响应。返回 null 表示这次结果对不上本地状态（tail 的 anchor 已不在本地），
// 调用方应丢弃并重新同步
export function applyMessagesResponse(
  local: ChatMessage[],
  res: MessagesResponse,
  anchorId: string | number | null,
  prevHasMore: boolean
): AppliedMessages | null {
  if (res.mode !== "tail") {
    return { messages: reuseUnchanged(local, res.messages), epoch: res.epoch, hasMore: res.hasMore }
  }
  if (anchorId === null) return null
  const anchorIndex = local.findIndex((message) => message.id === anchorId)
  if (anchorIndex < 0) return null
  let merged = local.slice(0, anchorIndex + 1).concat(res.messages)
  if (res.firstId !== null && res.firstId !== undefined) {
    const firstIndex = merged.findIndex((message) => message.id === res.firstId)
    if (firstIndex > 0) merged = merged.slice(firstIndex)
  }
  return { messages: reuseUnchanged(local, merged), epoch: res.epoch, hasMore: prevHasMore }
}

export function prependEarlierMessages(
  local: ChatMessage[],
  res: MessagesResponse
): { messages: ChatMessage[]; hasMore: boolean } {
  const existing = new Set(local.map((message) => message.id))
  const older = res.messages.filter((message) => !existing.has(message.id))
  return { messages: older.length ? older.concat(local) : local, hasMore: res.hasMore }
}

// 按需加载的完整 trace 缓存键：事件数变了（任务还在跑）就是新的一份
export function traceCacheKey(sessionName: string, messageId: string | number, eventCount: number): string {
  return `${sessionName}\u0000${String(messageId)}\u0000${eventCount}`
}

// 用“最近一页”对账本地列表（流结束、停止、命令执行后）：
// 这一页的开头在本地能找到时，保留它之前更早加载的页，用这一页覆盖其后的部分；
// 找不到（本地占位、服务端裁掉了开头）或 reset 时整体替换
export function reconcileWithPage(
  local: ChatMessage[],
  res: MessagesResponse,
  prevHasMore: boolean,
  prevEpoch: string | null
): AppliedMessages {
  const first = res.messages[0]
  // 本地记录的 epoch 与服务端不同、或不知道本地的 epoch（首次、400 重置、切走期间流结束）：
  // 历史的稳定前缀可能被改动过（别的标签页删了消息），本地更早的页不可信
  const epochChanged = prevEpoch === null || prevEpoch !== res.epoch
  const index = res.mode === "reset" || epochChanged || !first ? -1 : local.findIndex((message) => message.id === first.id)
  if (index > 0) {
    return {
      messages: reuseUnchanged(local, local.slice(0, index).concat(res.messages)),
      epoch: res.epoch,
      hasMore: prevHasMore,
    }
  }
  return { messages: reuseUnchanged(local, res.messages), epoch: res.epoch, hasMore: res.hasMore }
}

export function createLruCache<T>(max: number) {
  const map = new Map<string, T>()
  return {
    get(key: string): T | undefined {
      const value = map.get(key)
      if (value === undefined) return undefined
      map.delete(key)
      map.set(key, value)
      return value
    },
    set(key: string, value: T) {
      map.delete(key)
      map.set(key, value)
      while (map.size > max) map.delete(map.keys().next().value as string)
    },
  }
}

// 带 after 的增量请求被服务端以 400 拒绝（anchor 不合法）：不重置的话每次轮询都带着同一个坏 anchor，永远同步不上
export function shouldResetAfterSyncError(error: unknown, query: MessagesQuery): boolean {
  const status = (error as { status?: unknown } | null)?.status
  return status === 400 && query.after !== undefined
}
