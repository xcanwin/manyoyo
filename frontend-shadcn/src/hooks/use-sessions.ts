import * as React from "react"

import { apiGet, groupSessionsByContainer, type SessionSummary } from "@/lib/api"

export function useSessions() {
  const [sessions, setSessions] = React.useState<SessionSummary[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")

  const refresh = React.useCallback(async () => {
    setError("")
    try {
      const data = await apiGet("/api/sessions")
      const nextSessions = Array.isArray(data.sessions) ? (data.sessions as SessionSummary[]) : []
      setSessions(nextSessions)
      return nextSessions
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载会话列表失败")
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  const containers = React.useMemo(() => groupSessionsByContainer(sessions), [sessions])

  return { sessions, containers, loading, error, refresh }
}
