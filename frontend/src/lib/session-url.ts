import type { SessionSummary } from "@/lib/api"

// 浏览器地址栏用 #<会话名> 记住当前 AGENT，刷新或分享链接后能直接回到同一个聊天
export function parseSessionHash(hash: string): string | null {
  const raw = hash.replace(/^#/, "")
  if (!raw) return null
  try {
    return decodeURIComponent(raw) || null
  } catch {
    return null
  }
}

export function buildSessionHash(name: string | null): string {
  return name ? `#${encodeURIComponent(name)}` : ""
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
