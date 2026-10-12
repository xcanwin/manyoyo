import * as React from "react"

import { Button } from "@/components/ui/button"

import { api } from "./api"
import { firstProblem, formatDuration, resultLabel, type LastRun } from "./last-run"

// 最近一次任务：先看各阶段结果，需要时再展开某一个阶段的日志（不会一次读完所有日志）
export function LastRunPanel({ lastRun }: { lastRun: LastRun }) {
  const [open, setOpen] = React.useState<string | null>(null)
  const [lines, setLines] = React.useState<string[]>([])
  const [message, setMessage] = React.useState("")
  const problem = firstProblem(lastRun.summary.stages)

  async function toggle(stageId: string) {
    if (open === stageId) {
      setOpen(null)
      return
    }
    setOpen(stageId)
    setLines([])
    setMessage("读取中…")
    try {
      const log = await api<{ lines: string[]; truncated: boolean }>(`/api/stage-log?run=${encodeURIComponent(lastRun.dir)}&stage=${encodeURIComponent(stageId)}`)
      setLines(log.lines)
      setMessage(log.lines.length === 0 ? "（这个阶段没有输出）" : log.truncated ? "只显示最后一部分" : "")
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "读取失败")
    }
  }

  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">
        上次任务（{new Date(lastRun.at).toLocaleString("zh-CN", { hour12: false })}）：{resultLabel(lastRun.summary.result)}
        {lastRun.summary.error ? `，${lastRun.summary.error}` : ""}
        {problem ? `。先看「${problem.id}」的日志` : ""}
      </p>
      <ul className="space-y-1">
        {lastRun.summary.stages.map((stage) => (
          <li key={stage.id} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{stage.id}</span>
              <span className={stage.result === "failed" || stage.result === "aborted" ? "text-destructive" : "text-muted-foreground"}>{resultLabel(stage.result)}</span>
              <span className="text-muted-foreground">{formatDuration(stage.durationMs)}</span>
              <Button size="xs" variant="outline" className="ml-auto" onClick={() => void toggle(stage.id)}>
                {open === stage.id ? "收起日志" : "查看日志"}
              </Button>
            </div>
            {stage.detail && <p className="text-xs break-all text-muted-foreground">{stage.detail}</p>}
            {open === stage.id && (
              <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap">{lines.length > 0 ? lines.join("\n") : message}</pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
