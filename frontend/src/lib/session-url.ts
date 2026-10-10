import type { SessionSummary } from "@/lib/api"

// 浏览器地址栏用 #<容器>~agent-N 记住当前 AGENT（默认 AGENT 写成 ~agent-1，与其它 AGENT 格式统一），
// 刷新或分享链接后能直接回到同一个聊天
const HASH_SEPARATOR = "~"
const DEFAULT_AGENT_ID = "default"
const DEFAULT_AGENT_URL_ID = "agent-1"

// 返回会话名（与 SessionSummary.name 一致：默认 AGENT 就是容器名）
export function parseSessionHash(hash: string): string | null {
  const raw = hash.replace(/^#/, "")
  if (!raw) return null
  let text: string
  try {
    text = decodeURIComponent(raw)
  } catch {
    return null
  }
  const index = text.indexOf(HASH_SEPARATOR)
  if (index < 0) return text || null
  const container = text.slice(0, index)
  const agentId = text.slice(index + 1)
  if (!container) return null
  return !agentId || agentId === DEFAULT_AGENT_ID || agentId === DEFAULT_AGENT_URL_ID ? container : text
}

export function buildSessionHash(session: Pick<SessionSummary, "containerName" | "agentId"> | null): string {
  if (!session) return ""
  const agentId = !session.agentId || session.agentId === DEFAULT_AGENT_ID ? DEFAULT_AGENT_URL_ID : session.agentId
  return `#${encodeURIComponent(`${session.containerName}${HASH_SEPARATOR}${agentId}`)}`
}

// 最近一次有更新的真实 AGENT；占位用的 synthetic 和已停止的排在后面
export function pickMostRecentSession(sessions: SessionSummary[]): SessionSummary | null {
  const rank = (s: SessionSummary) => (s.synthetic ? 0 : 2) + (s.archived ? 0 : 1)
  let best: SessionSummary | null = null
  for (const s of sessions) {
    if (!best) {
      best = s
      continue
    }
    const diff = rank(s) - rank(best)
    if (diff > 0 || (diff === 0 && Date.parse(s.updatedAt || "") > Date.parse(best.updatedAt || "") )) {
      best = s
    }
  }
  return best
}
