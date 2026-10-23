import type { ChatMessage } from "@/lib/api"

export type RoundOption = {
  id: string
  // 这一轮开始前 / 结束后的快照（40 位提交号）
  before: string
  after: string
  label: string
}

const SNAP = /^[0-9a-f]{40}$/

// 有前后两张快照的轮次（从旧到新）。快照是每轮对话前后在容器里拍的（服务端 lib/web/snapshots.js）
export function buildRoundOptions(messages: ChatMessage[]): RoundOption[] {
  const rounds: RoundOption[] = []
  let index = 0
  for (const message of messages) {
    if (message.role !== "user" || message.mode === "command") continue
    index += 1
    if (!message.snapBefore || !message.snapAfter || !SNAP.test(message.snapBefore) || !SNAP.test(message.snapAfter)) continue
    const text = message.content.replace(/\s+/g, " ").trim()
    rounds.push({
      id: String(message.id),
      before: message.snapBefore,
      after: message.snapAfter,
      label: `第 ${index} 轮 · ${text.length > 24 ? `${text.slice(0, 24)}…` : text}`,
    })
  }
  return rounds
}
