import * as React from "react"

import { fetchSetupAgents } from "@/lib/setup"

// 镜像里没装的 Agent CLI（与向导共用 /api/setup/agents 的 available 字段）；未知时都当作可用
export function useAgentAvailability(enabled: boolean): (id: string) => boolean {
  const [unavailable, setUnavailable] = React.useState<ReadonlySet<string>>(new Set())
  React.useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetchSetupAgents()
      .then((list) => {
        if (!cancelled) setUnavailable(new Set(list.filter((item) => item.available === false).map((item) => item.id)))
      })
      .catch(() => {
        // 拿不到就都可选
      })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return React.useCallback((id: string) => !unavailable.has(id), [unavailable])
}
