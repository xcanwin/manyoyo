// 发送失败后的判断：什么时候该立刻把提示词放回输入框，什么时候要先问服务端“收到了没有”。
// 原则：不丢提示词，也不主动造成重复执行。

import { setOutbox, type Outbox, type StorageLike } from "./composer-store"

export type SendErrorKind = "rejected" | "duplicate" | "network"

// 应用层的明确拒绝：服务端看过请求并说“不行”，这条没有执行
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 409, 413, 422, 429])

// 409 且带 duplicate:true = 同一个 clientId 服务端已经收到过；
// 应用层状态码 = 明确拒绝；
// 其余（断网、连接被掐、超时，以及反向代理的 5xx / 408：请求往往已到服务端并在执行）= 不知道有没有收到
export function classifySendError(err: unknown): SendErrorKind {
  const e = err as { status?: unknown; data?: { duplicate?: unknown } } | null
  if (e && typeof e === "object" && e.status === 409 && e.data?.duplicate === true) return "duplicate"
  if (e && typeof e === "object" && typeof e.status === "number" && REJECTED_STATUSES.has(e.status)) return "rejected"
  return "network"
}

export type RestoredPrompt = { sessionName: string; clientId: string; text: string }

// 放回输入框的内容原样重发就沿用原 clientId（服务端按它去重，兜住“其实已经收到”的情况）；改动过就换新的
// 只在同一个会话里沿用：别的会话里输入同样的文字（如“继续”）不能拿到这个 id
export function pickClientId(
  sessionName: string,
  text: string,
  restored: RestoredPrompt | null,
  create: () => string
): string {
  return restored && restored.sessionName === sessionName && restored.text === text ? restored.clientId : create()
}

export type FailedSendOutcome =
  | { action: "restore" } // 确认没发出去：放回输入框
  | { action: "sent" } // 服务端已经有这条：清待发箱，什么都不放回
  | { action: "duplicate" } // 服务端说收到过了
  | { action: "wait" } // 还不能下结论（同一条还在 pending、或会话里有任务在跑）：保留待发箱，等下一次同步再判断
  | { action: "unknown" } // 对账也失败（仍然断网）：保留待发箱，等恢复联网

export async function resolveFailedSend(params: {
  kind: SendErrorKind
  clientId: string
  // 向服务端取最近一页消息（不写进界面状态）
  reconcile: () => Promise<{ messages: Array<{ clientMessageId?: string; pending?: boolean; mode?: string }> }>
  // 对账最长等多久：超时按“无法确认”处理（此时输入框已经解锁，不能让对账一直挂着）
  timeoutMs?: number
}): Promise<FailedSendOutcome> {
  if (params.kind === "rejected") return { action: "restore" }
  if (params.kind === "duplicate") return { action: "duplicate" }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("reconcile timeout")), params.timeoutMs ?? 8000)
    })
    const { messages } = await Promise.race([params.reconcile(), timeout])
    const found = messages.find((message) => message.clientMessageId === params.clientId)
    // 服务端还在准备阶段时就存着这条 pending 消息，准备失败会把它删掉：还在 pending 不能算已发出
    if (found) return found.pending === true ? { action: "wait" } : { action: "sent" }
    if (messages.some((message) => message.mode === "agent" && message.pending === true)) return { action: "wait" }
    return { action: "restore" }
  } catch {
    return { action: "unknown" }
  } finally {
    clearTimeout(timer)
  }
}

// 点发送的第一步：同步写入待发箱（同时清空草稿）。请求发出之前就落了盘，
// 此刻刷新页面、关浏览器、断网都不会丢提示词
export function beginSend(params: {
  sessionName: string
  text: string
  mode: "agent" | "command"
  restored: RestoredPrompt | null
  createId: () => string
  tabId: string
  now: number
  storage?: StorageLike | null
}): { clientId: string; outbox: Outbox } {
  const clientId = pickClientId(params.sessionName, params.text, params.restored, params.createId)
  const outbox: Outbox = {
    clientId,
    text: params.text,
    mode: params.mode,
    createdAt: params.now,
    tabId: params.tabId,
  }
  if (params.storage === undefined) setOutbox(params.sessionName, outbox)
  else setOutbox(params.sessionName, outbox, params.storage)
  return { clientId, outbox }
}
