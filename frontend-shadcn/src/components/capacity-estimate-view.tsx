import * as React from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { apiGet } from "@/lib/api"

type CapacityReport = {
  runtimeCommand: string
  image: { reference: string; sizeBytes: number | null }
  container: { averageWritableBytes: number; sampledCount: number }
  disk: { path: string; availableBytes: number | null }
  estimatedAdditionalContainers: number | null
  notes: string[]
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "未知"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes
  let unitIndex = -1
  do {
    value /= 1024
    unitIndex += 1
  } while (value >= 1024 && unitIndex < units.length - 1)
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

export function CapacityEstimateView() {
  const [report, setReport] = React.useState<CapacityReport | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")

  const load = React.useCallback(() => {
    setLoading(true)
    setError("")
    apiGet("/api/system/capacity")
      .then((data) => setReport(data as unknown as CapacityReport))
      .catch((err) => setError(err instanceof Error ? err.message : "加载容量预估失败"))
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">基于当前镜像与宿主机磁盘剩余空间的粗略估算，仅供参考。</p>
        <Button type="button" variant="outline" size="sm" onClick={load} disabled={loading}>
          刷新
        </Button>
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : report ? (
        <>
          <div className="rounded-lg border p-4 text-center">
            <p className="text-xs text-muted-foreground">预计还能新建容器数</p>
            <p className="text-4xl font-semibold tracking-tight">
              {report.estimatedAdditionalContainers === null ? "未知" : report.estimatedAdditionalContainers}
            </p>
          </div>

          <div className="rounded-lg border px-4">
            <StatRow label="镜像" value={report.image.reference} />
            <StatRow label="镜像体积" value={formatBytes(report.image.sizeBytes)} />
            <StatRow
              label="单容器平均可写层体积"
              value={`${formatBytes(report.container.averageWritableBytes)}${report.container.sampledCount > 0 ? `（取样 ${report.container.sampledCount} 个容器）` : "（无历史数据，按保守假设）"}`}
            />
            <StatRow label="宿主机磁盘剩余空间" value={formatBytes(report.disk.availableBytes)} />
            <StatRow label="检测路径" value={report.disk.path} />
          </div>

          {report.notes.length > 0 ? (
            <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              {report.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
