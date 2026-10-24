import * as React from "react"

import { Hint } from "@/components/hint"
import { KeyValueList } from "@/components/key-value-list"
import { PageHeader } from "@/components/page-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { apiGet } from "@/lib/api"
import { formatBytes } from "@/lib/format"

type CapacityReport = {
  runtimeCommand: string
  image: { reference: string; sizeBytes: number | null }
  container: { averageWritableBytes: number; sampledCount: number }
  disk: { path: string; availableBytes: number | null }
  estimatedAdditionalContainers: number | null
  notes: string[]
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
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载容量预估失败")
      )
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    queueMicrotask(() => load())
  }, [load])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="容量预估"
        description="基于当前镜像与宿主机磁盘剩余空间的粗略估算，仅供参考。"
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={load}
            disabled={loading}
          >
            刷新
          </Button>
        }
      />

      {loading ? (
        <div className="flex flex-col gap-2" role="status" aria-label="加载中">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : report ? (
        <>
          <Card>
            <CardContent>
              <KeyValueList
                items={[
                  {
                    label: "预计还能新建容器数",
                    value:
                      report.estimatedAdditionalContainers === null
                        ? "未知"
                        : report.estimatedAdditionalContainers,
                  },
                  {
                    label: "镜像",
                    value: (
                      <span className="font-mono">
                        {report.image.reference}
                      </span>
                    ),
                  },
                  {
                    label: "镜像体积",
                    value: formatBytes(report.image.sizeBytes),
                  },
                  {
                    label: "单容器平均可写层体积",
                    value: `${formatBytes(report.container.averageWritableBytes)}${report.container.sampledCount > 0 ? `（取样 ${report.container.sampledCount} 个容器）` : "（无历史数据，按保守假设）"}`,
                  },
                  {
                    label: "宿主机磁盘剩余空间",
                    value: formatBytes(report.disk.availableBytes),
                  },
                  {
                    label: "检测路径",
                    value: (
                      <span className="font-mono">{report.disk.path}</span>
                    ),
                  },
                ]}
              />
            </CardContent>
          </Card>

          {report.notes.length > 0 ? (
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {report.notes.map((note, index) => (
                <li key={index}>
                  <Hint>{note}</Hint>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
