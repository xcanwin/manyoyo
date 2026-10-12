// 最近一次任务的汇总：各阶段结果与耗时，失败 / 中断的阶段排在最前提示
export type RunStage = { id: string; result: string; logFile: string; durationMs: number | null; detail: string }
export type LastRun = {
  dir: string
  at: string
  summary: { startedAt: string; finishedAt: string | null; result: string; error?: string; stages: RunStage[] }
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "-"
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`
}

const RESULT_LABEL: Record<string, string> = {
  done: "完成",
  skipped: "已跳过",
  unfinished: "未完成",
  failed: "失败",
  aborted: "已中断",
  running: "进行中",
  pending: "未开始",
  succeeded: "成功",
  cancelled: "已取消",
}

export const resultLabel = (result: string) => RESULT_LABEL[result] ?? result

// 排障先看哪一个阶段：第一个失败的，其次第一个中断的
export function firstProblem(stages: RunStage[]): RunStage | null {
  return stages.find((stage) => stage.result === "failed") ?? stages.find((stage) => stage.result === "aborted") ?? null
}
