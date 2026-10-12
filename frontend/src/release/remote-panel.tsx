import * as React from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

import { api, type RemoteStatus } from "./api"
import { formatDuration, resultLabel } from "./last-run"

const POLL_ACTIVE_MS = 10000
const POLL_IDLE_MS = 60000

// 远端流水线的进度：运行中每 10 秒刷新一次；关掉页面不影响流水线
export function RemotePanel({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = React.useState<RemoteStatus | null>(null)
  const [error, setError] = React.useState("")
  const running = data?.run != null && data.run.status !== "completed"

  React.useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    async function tick() {
      try {
        const next = await api<RemoteStatus>("/api/remote/status")
        if (stopped) return
        setData(next)
        setError("")
        timer = setTimeout(() => void tick(), next.run && next.run.status !== "completed" ? POLL_ACTIVE_MS : POLL_IDLE_MS)
      } catch (err) {
        if (stopped) return
        setError(err instanceof Error ? err.message : "读取失败")
        timer = setTimeout(() => void tick(), POLL_IDLE_MS)
      }
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [refreshKey])

  if (!data?.run) return error ? <p className="text-sm text-muted-foreground">{error}</p> : null
  const { run, report } = data
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">
          远端流水线 #{run.runId}（{run.status === "completed" ? resultLabel(run.conclusion === "success" ? "succeeded" : run.conclusion) : "进行中"}）
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <a className="underline" href={run.url} target="_blank" rel="noreferrer">
          {run.url}
        </a>
        <ul className="space-y-0.5">
          {run.stages.map((stage) => (
            <li key={stage.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{stage.id}</span>
              <span className={stage.result === "failure" ? "text-destructive" : "text-muted-foreground"}>{stage.result}</span>
              <span className="text-muted-foreground">{formatDuration(stage.durationSec * 1000)}</span>
            </li>
          ))}
        </ul>
        {running && <p className="text-muted-foreground">关掉页面也不影响，GitHub 会自己跑完。</p>}
        {report && report.failedLogs.length > 0 && <p className="break-all text-destructive">失败阶段的日志在：{report.failedLogs.join("、")}</p>}
      </CardContent>
    </Card>
  )
}
