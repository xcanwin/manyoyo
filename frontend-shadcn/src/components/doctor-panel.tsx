import * as React from "react"
import { CheckIcon, CircleAlertIcon, TriangleAlertIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { fetchDoctor, hasFixableIssue, runDoctorFix, STATUS_LABEL, type DoctorCheck, type DoctorReport } from "@/lib/doctor"

function StatusIcon({ status }: { status: DoctorCheck["status"] }) {
  if (status === "ok") return <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
  if (status === "warning") return <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
  return <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
}

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

  return (
    <div className="flex flex-col gap-4" data-testid="doctor-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">检查容器环境、镜像与配置是否可用，并给出下一步。</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
            {loading ? <Spinner data-icon="inline-start" /> : null}
            重新检查
          </Button>
          {hasFixableIssue(report) ? (
            <Button type="button" size="sm" onClick={() => void handleFix()} disabled={busy}>
              {fixing ? <Spinner data-icon="inline-start" /> : null}
              尝试自动修复
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {report ? (
        <ul className="flex flex-col divide-y rounded-lg border">
          {report.checks.map((check) => (
            <li key={check.code} className="flex gap-2 p-3 text-sm" data-status={check.status}>
              <StatusIcon status={check.status} />
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-medium">
                  {check.summary}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{STATUS_LABEL[check.status]}</span>
                </span>
                {check.status !== "ok" && check.action ? (
                  <span className="text-muted-foreground">下一步：{check.action}</span>
                ) : null}
                {check.status !== "ok" && check.detail ? (
                  <span className="break-all text-xs text-muted-foreground">{check.detail}</span>
                ) : null}
                {check.fix?.attempted || check.fix?.message ? (
                  <span className={check.fix.fixed ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}>
                    {check.fix.fixed ? "已修复" : "未修复"}：{check.fix.message}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : loading ? (
        <div className="flex h-24 items-center justify-center">
          <Spinner />
        </div>
      ) : null}
    </div>
  )
}
