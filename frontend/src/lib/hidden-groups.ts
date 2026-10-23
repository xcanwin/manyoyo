import type { ChatMessage } from "@/lib/api"

export type HiddenGroupInfo = {
  // 这一组的标识（第一条消息的 id）
  key: string
  // 这条消息是不是这一组显示出来的第一条（折叠行画在它前面）
  first: boolean
  // 这一组的用户消息（取消隐藏时用它的 id）
  userMessage?: ChatMessage
}

// 连续的 hidden 消息归成一组：服务端给“用户消息 + 执行过程 + 回复”都打了 hidden
export function groupHiddenMessages(messages: ChatMessage[]): Map<string, HiddenGroupInfo> {
  const map = new Map<string, HiddenGroupInfo>()
  let current: { key: string; userMessage?: ChatMessage } | null = null
  for (const message of messages) {
    if (!message.hidden) {
      current = null
      continue
    }
    if (!current || message.role === "user") {
      current = { key: String(message.id), userMessage: message.role === "user" ? message : undefined }
      map.set(String(message.id), { ...current, first: true })
      continue
    }
    map.set(String(message.id), { key: current.key, first: false, userMessage: current.userMessage })
  }
  return map
}
