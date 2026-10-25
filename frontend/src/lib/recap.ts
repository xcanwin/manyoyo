import type { ChatMessage } from "@/lib/api"

// 回顾：隔了很久回来，消息流底部显示一行“回顾：……”。服务端再校验一遍条件，这里只决定“要不要问”和“显示不显示”。
export const RECAP_IDLE_MS = 30 * 60 * 1000

export type Recap = { forMessageId: string; text: string; createdAt: string | null }

// 最后一条（不算执行过程）如果是已经完成的最终回复就返回它
export function lastFinishedReply(messages: ChatMessage[]): ChatMessage | null {
  const list = messages.filter((item) => !item.streamTrace)
  const last = list[list.length - 1]
  if (
    last &&
    last.role === "assistant" &&
    last.mode === "agent" &&
    !last.pending &&
    !last.interrupted &&
    last.content.trim() !== ""
  ) {
    return last
  }
  return null
}

// 要不要向服务端要回顾：返回这条回复的 id；不用问返回 null
export function recapRequestFor(
  messages: ChatMessage[],
  recap: Recap | null | undefined,
  now: number,
  running: boolean
): string | null {
  if (running) return null
  const reply = lastFinishedReply(messages)
  if (!reply) return null
  const id = String(reply.id)
  if (recap && recap.forMessageId === id) return null
  const at = Date.parse(reply.timestamp)
  if (!Number.isFinite(at) || now - at < RECAP_IDLE_MS) return null
  return id
}

// 显示：回顾对应的正是现在最后一条最终回复，并且没被用户关掉
export function visibleRecap(
  messages: ChatMessage[],
  recap: Recap | null | undefined,
  dismissedFor: string
): Recap | null {
  if (!recap || !recap.text) return null
  const reply = lastFinishedReply(messages)
  if (!reply || String(reply.id) !== recap.forMessageId) return null
  return dismissedFor === recap.forMessageId ? null : recap
}
