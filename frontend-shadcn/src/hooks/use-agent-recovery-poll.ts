import * as React from "react"

import type { ChatMessage, SessionSummary } from "@/lib/api"

const POLL_INTERVAL_MS = 1500

function hasPendingMessage(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.pending === true)
}

// 与旧版前端 scheduleAgentRecoveryPoll/recoverAgentRunFromServer 对齐：
// 刷新页面或切回某个会话时，如果后端仍在跑一次 Agent 回合（消息历史里还留着
// pending 记录，但本标签页并没有正在进行中的 stream），前端原本无从得知——
// 这里固定间隔轮询，直到 pending 状态消失
export function useAgentRecoveryPoll(
  session: SessionSummary | null,
  messages: ChatMessage[],
  onTick: () => Promise<unknown>
) {
  const messagesRef = React.useRef(messages)
  React.useEffect(() => {
    messagesRef.current = messages
  }, [messages])
  const onTickRef = React.useRef(onTick)
  React.useEffect(() => {
    onTickRef.current = onTick
  }, [onTick])

  const isPending = hasPendingMessage(messages)

  React.useEffect(() => {
    if (!session || !isPending) return
    let cancelled = false
    let timer = 0

    function scheduleNext() {
      if (cancelled || !hasPendingMessage(messagesRef.current)) return
      timer = window.setTimeout(async () => {
        if (cancelled) return
        try {
          await onTickRef.current()
        } catch {
          // 静默失败，等待下一轮轮询
        }
        if (!cancelled) scheduleNext()
      }, POLL_INTERVAL_MS)
    }

    scheduleNext()

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.name, isPending])
}
