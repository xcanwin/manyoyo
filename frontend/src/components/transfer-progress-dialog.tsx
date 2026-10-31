import * as React from "react"
import { DownloadIcon } from "lucide-react"
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
import {
  cancelJob,
  fetchJob,
  friendlyError,
  importDropLines,
  autoDownloadOnce,
  triggerDownload,
  type TransferJob,
} from "@/lib/transfer"

const FINISHED = new Set(["done", "failed", "cancelled", "interrupted"])
const POLL_FAIL_LIMIT = 3

function statusText(job: TransferJob | null, running: boolean) {
  if (!job) return "读取中…"
  if (!running) {
    if (job.status === "done") return "已完成"
    if (job.status === "cancelled") return "已取消"
    return "已结束"
  }
  if (job.status === "preparing") return "正在准备（读取容器改动）…"
  if (job.status === "ready") return "准备好了"
  if (job.status === "waiting") return "等待上传…"
  return job.stage || "处理中"
}

function jobWarnings(job: TransferJob | null): string[] {
  if (!job) return []
  const fromResult = job.result && Array.isArray(job.result.warnings) ? (job.result.warnings as unknown[]).map(String) : []
  return [...new Set([...(job.warnings || []), ...fromResult])]
}

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
  const failuresRef = React.useRef(0)
  // onFinished 常是内联函数（每次渲染都变）：放进 ref，不让它重启轮询，否则完成提示会反复弹出
  const onFinishedRef = React.useRef(onFinished)
  React.useEffect(() => {
    onFinishedRef.current = onFinished
  })

  React.useEffect(() => {
    if (!jobId) return
    let cancelled = false
    finishedRef.current = false
    failuresRef.current = 0
    lastSample.current = null
    async function tick() {
      try {
        const next = await fetchJob(jobId as string)
        if (cancelled) return
        setJob(next)
        setError("")
        failuresRef.current = 0
        // 浏览器可能拦截非用户手势的下载，所以自动触发一次，界面上另有手动按钮
        if (next.status === "ready" && next.downloadUrl) autoDownloadOnce(next.id, next.downloadUrl)
        const now = Date.now()
        const last = lastSample.current
        if (last && now > last.at) setSpeed(Math.max(0, ((next.bytes - last.bytes) * 1000) / (now - last.at)))
        lastSample.current = { at: now, bytes: next.bytes }
        if (FINISHED.has(next.status) && !finishedRef.current) {
          finishedRef.current = true
          if (next.status === "done") {
            const file = next.result && typeof next.result.file === "string" ? next.result.file : ""
            const names = next.result && Array.isArray(next.result.containers) ? (next.result.containers as string[]) : next.containers
            // 导入有没能还原的内容时，详情写在弹窗里，不弹一句“已导入”了事
            if (next.type === "import" && importDropLines(next.result).length === 0)
              toast.success(`已导入 ${names.join("、")}`)
            else if (next.type === "export")
              toast.success(file ? `已导出到服务器：${file}` : "导出完成")
          } else if (next.status === "failed") {
            toast.error(friendlyError(next.error, next.type === "export" ? "导出失败" : "导入失败"))
          } else if (next.status === "cancelled") {
            toast.message(next.type === "export" ? "导出已取消" : "已取消，导入已撤销")
          } else {
            toast.error("任务被中断（服务重启）")
          }
          onFinishedRef.current()
        }
      } catch {
        if (cancelled) return
        failuresRef.current += 1
        if (failuresRef.current >= POLL_FAIL_LIMIT) setError("连不上服务器，任务可能仍在进行")
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [jobId])

  const running = job ? !FINISHED.has(job.status) : true
  const dropLines = job && job.type === "import" && job.status === "done" ? importDropLines(job.result) : []
  const warnings = jobWarnings(job)
  const downloadInterrupted = job?.type === "export" && job.output === "download" && job.status === "cancelled" && /连接中断/.test(job.error || "")
  const label = job?.type === "import" ? "导入" : "导出"
  const showPercent = Boolean(job && job.estimateComplete && job.estimate > 0)
  const percent = job && showPercent ? Math.min(99, Math.round((job.bytes / job.estimate) * 100)) : null

  return (
    <Dialog open={jobId !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{running ? `正在${label}` : label}</DialogTitle>
          <DialogDescription>
            {job ? job.containers.join("、") : "读取中…"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              {running ? <Spinner /> : null}
              <span>{statusText(job, running)}</span>
              {job?.container ? <Hint mono className="truncate">{job.container}</Hint> : null}
            </div>
            {job ? (
              <Hint>
                已处理 {formatBytes(job.bytes)}
                {showPercent ? ` / 约 ${formatBytes(job.estimate)}${percent !== null && running ? `（${percent}%）` : ""}` : ""}
                {running && speed > 0 ? `，${formatBytes(speed)}/秒` : ""}
              </Hint>
            ) : null}
            <Hint>{label === "导入" ? "导入期间，这些容器的聊天、终端、文件、设置和删除暂时不可用，完成后恢复。" : "准备和下载等待期间，这些容器的聊天、终端、文件、设置和删除暂时不可用；只有读取容器内数据的那一小段会暂停容器。"}</Hint>
            {job && job.status === "ready" && job.downloadUrl ? (
              <Button className="self-start" onClick={() => triggerDownload(job.downloadUrl)}>
                <DownloadIcon data-icon="inline-start" />
                准备好了，点这里下载
              </Button>
            ) : null}
            {job && job.status === "failed" ? (
              <Alert variant="destructive">
                <AlertDescription>{friendlyError(job.error, "任务失败了，请重试")}</AlertDescription>
              </Alert>
            ) : null}
            {downloadInterrupted ? (
              <Alert variant="destructive">
                <AlertDescription>下载中断了，需要重新导出（下载不能续传）。</AlertDescription>
              </Alert>
            ) : null}
            {dropLines.length ? (
              <Alert variant="warning">
                <AlertDescription>
                  <span className="mb-1 block">已导入，但有内容没有还原：</span>
                  <span className="flex flex-col gap-1">
                    {dropLines.map((line) => (
                      <span key={line} className="break-all">{line}</span>
                    ))}
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}
            {warnings.length ? (
              <Alert variant="warning">
                <AlertDescription>
                  <span className="flex flex-col gap-1">
                    {warnings.map((line) => (
                      <span key={line} className="break-all">{line}</span>
                    ))}
                  </span>
                </AlertDescription>
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
