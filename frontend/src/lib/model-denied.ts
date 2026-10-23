import type { ChatMessage } from "@/lib/api"

export type ModelDenied = { host: string; prompt: string }

// 最近一轮是不是因为模型地址被网络策略拦下而中止：最后一条回复带 networkDenied，且之后没有新的用户消息。
// prompt 是这一轮的提示词，供“允许并重试”原样重发
export function findModelDenied(messages: ChatMessage[]): ModelDenied | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === "user") return null
    if (message.role !== "assistant" || message.streamTrace) continue
    if (message.pending || !message.networkDenied?.host) return null
    for (let j = i - 1; j >= 0; j -= 1) {
      if (messages[j].role === "user") return { host: message.networkDenied.host, prompt: messages[j].content }
    }
    return null
  }
  return null
}
