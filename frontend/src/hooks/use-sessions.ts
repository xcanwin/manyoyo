import * as React from "react"

import { apiGet, groupSessionsByContainer, type SessionSummary } from "@/lib/api"
import { createSingleFlight } from "@/lib/sync-scheduler"

export function useSessions() {
  const [sessions, setSessions] = React.useState<SessionSummary[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")

  // 同一时间最多一个 /api/sessions 在路上：慢网下定时刷新不会堆积；
  // 在途时又来了刷新请求（发送结束、增删 AGENT 之后）会在结束后补跑一次，不会丢
  const [{ flight, latest }] = React.useState(() => {
    const latest = { sessions: [] as SessionSummary[] }
    const flight = createSingleFlight(async (signal) => {
      setError("")
      try {
        const data = await apiGet("/api/sessions", signal)
        latest.sessions = Array.isArray(data.sessions) ? (data.sessions as SessionSummary[]) : []
        setSessions(latest.sessions)
      } catch (err) {
        latest.sessions = []
        setError(err instanceof Error ? err.message : "加载会话列表失败")
      } finally {
        setLoading(false)
      }
    })
    return { flight, latest }
  })

  const refresh = React.useCallback(async () => {
    await flight.run(true)
    return latest.sessions
  }, [flight, latest])

  React.useEffect(() => {
    queueMicrotask(() => refresh())
  }, [refresh])

  const containers = React.useMemo(() => groupSessionsByContainer(sessions), [sessions])

  return { sessions, containers, loading, error, refresh }
}
