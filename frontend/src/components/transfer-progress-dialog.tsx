import * as React from "react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { Hint } from "@/components/hint"
import { formatBytes } from "@/lib/format"
import { cancelJob, fetchJob, type TransferJob } from "@/lib/transfer"

const FINISHED = new Set(["done", "failed", "cancelled", "interrupted"])

// 导出 / 导入进度：点侧栏上转圈的卡片打开。每秒读一次任务状态，结束时提示一句
export function TransferProgressDialog({
  jobId,
  onClose,
  onFinished,
}: {
  jobId: string | null
  onClose: () => void
  onFinished: () => void
}) {
  const [job, setJob] = React.useState<TransferJob | null>(null)
  const [speed, setSpeed] = React.useState(0)
  const [error, setError] = React.useState("")
  const lastSample = React.useRef<{ at: number; bytes: number } | null>(null)
  const finishedRef = React.useRef(false)

  React.useEffect(() => {
    if (!jobId) return
    let cancelled = false
    finishedRef.current = false
    lastSample.current = null
    async function tick() {
      try {
        const next = await fetchJob(jobId as string)
        if (cancelled) return
        setJob(next)
        setError("")
        const now = Date.now()
        const last = lastSample.current
        if (last && now > last.at) setSpeed(Math.max(0, ((next.bytes - last.bytes) * 1000) / (now - last.at)))
        lastSample.current = { at: now, bytes: next.bytes }
        if (FINISHED.has(next.status) && !finishedRef.current) {
          finishedRef.current = true
          if (next.status === "done") {
            const file = next.result && typeof next.result.file === "string" ? next.result.file : ""
            toast.success(next.type === "export" ? (file ? `已导出到服务器：${file}` : "导出完成") : "导入完成")
          } else if (next.status === "failed") {
            toast.error(next.error || (next.type === "export" ? "导出失败" : "导入失败"))
          } else if (next.status === "cancelled") {
            toast.message(next.type === "export" ? "导出已取消" : "导入已取消，已撤销")
          } else {
            toast.error("任务被中断（服务重启）")
          }
          onFinished()
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "读取进度失败")
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [jobId, onFinished])

  const running = job ? !FINISHED.has(job.status) : true
  const label = job?.type === "import" ? "导入" : "导出"
  const percent = job && job.estimate > 0 ? Math.min(99, Math.round((job.bytes / job.estimate) * 100)) : null

  return (
    <Dialog open={jobId !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>正在{label}</DialogTitle>
          <DialogDescription>
            {job ? job.containers.join("、") : "读取中…"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              {running ? <Spinner /> : null}
              <span>{job ? (running ? job.stage || "准备中" : job.status === "done" ? "已完成" : job.status === "cancelled" ? "已取消" : "已结束") : "读取中…"}</span>
              {job?.container ? <Hint mono className="truncate">{job.container}</Hint> : null}
            </div>
            {job ? (
              <Hint>
                已处理 {formatBytes(job.bytes)}
                {job.estimate > 0 ? ` / 约 ${formatBytes(job.estimate)}${percent !== null && running ? `（${percent}%）` : ""}` : ""}
                {running && speed > 0 ? `，${formatBytes(speed)}/秒` : ""}
              </Hint>
            ) : null}
            <Hint>期间这些容器的聊天、终端、文件、设置和删除都暂时不可用，完成后恢复。</Hint>
            {job && job.status === "failed" ? (
              <Alert variant="destructive">
                <AlertDescription>{job.error}</AlertDescription>
              </Alert>
            ) : null}
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {running ? "关闭（任务继续）" : "关闭"}
          </Button>
          {running && job ? (
            <Button
              variant="destructive"
              disabled={job.cancelRequested}
              onClick={() => void cancelJob(job.id)}
            >
              {job.cancelRequested ? "正在取消…" : `取消${label}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
