import * as React from "react"

import { DataTable, type DataColumn } from "@/components/data-table"
import { Hint } from "@/components/hint"
import { PageHeader } from "@/components/page-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  fetchDoctor,
  hasFixableIssue,
  runDoctorFix,
  STATUS_LABEL,
  type DoctorCheck,
  type DoctorReport,
} from "@/lib/doctor"

// 检查结果的状态色（STYLE.md 第 3 节）：通过 = success，警告 = warning，失败 = destructive
const STATUS_VARIANT = {
  ok: "success",
  warning: "warning",
  error: "destructive",
} as const

export function DoctorPanel() {
  const [report, setReport] = React.useState<DoctorReport | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [fixing, setFixing] = React.useState(false)
  const [error, setError] = React.useState("")

  const load = React.useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setReport(await fetchDoctor())
    } catch (err) {
      setError(err instanceof Error ? err.message : "环境检查失败")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    queueMicrotask(() => void load())
  }, [load])

  async function handleFix() {
    setFixing(true)
    setError("")
    try {
      setReport(await runDoctorFix())
    } catch (err) {
      setError(err instanceof Error ? err.message : "自动修复失败")
    } finally {
      setFixing(false)
    }
  }

  const busy = loading || fixing

  const columns: DataColumn<DoctorCheck>[] = [
    {
      key: "summary",
      header: "检查项",
      primary: true,
      render: (check) => check.summary,
    },
    {
      key: "status",
      header: "结果",
      render: (check) => (
        <Badge
          variant={STATUS_VARIANT[check.status]}
          data-status={check.status}
        >
          {STATUS_LABEL[check.status]}
        </Badge>
      ),
    },
    {
      key: "next",
      header: "下一步",
      render: (check) => (
        <span className="flex flex-col gap-1 whitespace-normal">
          {check.status !== "ok" && check.action ? (
            <span>下一步：{check.action}</span>
          ) : null}
          {check.status !== "ok" && check.detail ? (
            <Hint className="break-all">{check.detail}</Hint>
          ) : null}
          {check.fix?.attempted || check.fix?.message ? (
            <span
              className={
                check.fix.fixed ? "text-success" : "text-muted-foreground"
              }
            >
              {check.fix.fixed ? "已修复" : "未修复"}：{check.fix.message}
            </span>
          ) : null}
        </span>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-4" data-testid="doctor-panel">
      <PageHeader
        title="环境检查"
        description="检查容器环境、镜像与配置是否可用，并给出下一步。"
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => void load()}
              disabled={busy}
            >
              {loading ? <Spinner data-icon="inline-start" /> : null}
              重新检查
            </Button>
            {hasFixableIssue(report) ? (
              <Button
                type="button"
                onClick={() => void handleFix()}
                disabled={busy}
              >
                {fixing ? <Spinner data-icon="inline-start" /> : null}
                尝试自动修复
              </Button>
            ) : null}
          </>
        }
      />

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <DataTable
        label="环境检查"
        columns={columns}
        rows={report?.checks ?? []}
        loading={!report && loading}
        rowKey={(check) => check.code}
        rowTestId={(check) => `doctor-check-${check.code}`}
        empty={{ title: error ? "检查失败" : "还没有检查结果" }}
      />
    </div>
  )
}
