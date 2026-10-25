import * as React from "react"

import { apiGet, type SessionSummary } from "@/lib/api"
import { loadEffortCache, saveEffortCache } from "@/lib/effort-cache"

// 当前会话 / 模型能选的推理强度（来自 GET .../effort，服务端从 Agent 的模型目录取）。
// 先用本地缓存，服务端结果回来后再对账；没有选项（或不知道）时 levels 是空数组。
export function useEffortOptions(session: SessionSummary | null) {
  const sessionName = session?.name ?? null
  const model = session?.model ?? ""
  const programOk = session?.agentProgram === "claude" || session?.agentProgram === "codex"
  // 换会话或换模型就重新取：新模型可能不支持当前强度
  const key = `${sessionName ?? ""}\u0000${model}`
  const [fetched, setFetched] = React.useState<{ key: string; levels: string[]; envDefault: string }>({
    key: "",
    levels: [],
    envDefault: "",
  })

  React.useEffect(() => {
    if (!sessionName || !programOk) return
    let cancelled = false
    apiGet(`/api/sessions/${encodeURIComponent(sessionName)}/effort`)
      .then((data) => {
        if (cancelled) return
        const next = {
          levels: Array.isArray(data.levels) ? (data.levels as string[]) : [],
          envDefault: typeof data.envDefault === "string" ? data.envDefault : "",
        }
        saveEffortCache(key, next)
        setFetched({ key, ...next })
      })
      .catch(() => {
        if (!cancelled) setFetched({ key, levels: [], envDefault: "" })
      })
    return () => {
      cancelled = true
    }
  }, [key, sessionName, programOk])

  const known = !programOk ? null : fetched.key === key ? fetched : loadEffortCache(key)
  const levels = known ? known.levels : []
  const current = session?.effort ?? ""
  return {
    levels,
    envDefault: known?.envDefault ?? "",
    // 当前强度不在选项里（换了模型等）按默认处理
    current: levels.includes(current) ? current : "",
  }
}
