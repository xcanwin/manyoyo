import * as React from "react"
import { RefreshCwIcon, Trash2Icon } from "lucide-react"

import { apiDelete, apiGet, apiPost, apiPut, type SessionSummary } from "@/lib/api"
import { formatBytes, formatDateTime } from "@/lib/format"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { DataTable, type DataColumn } from "@/components/data-table"
import { Hint } from "@/components/hint"
import { PageHeader } from "@/components/page-header"

type CoverageReason = "proxied" | "auditOff" | "noDomainRules" | "unrestricted" | "unsupported"

type TrafficRecord = {
  id: string
  ts: string
  host: string
  port: number
  decision: "allow" | "deny"
  proto: "http" | "https" | "tcp"
  method: string
  status: number
  bytesIn: number
  bytesOut: number
  durationMs: number
  count?: number
}

type TrafficData = {
  records: TrafficRecord[]
  summary: { allowed: number; denied: number; hosts: number; bytesIn: number; bytesOut: number }
  coverage: { proxied: boolean; auditHttp: boolean; reason: CoverageReason }
}

type NetworkPolicyLike = { auditHttp?: boolean; [key: string]: unknown }

const COVERAGE_TEXT: Record<CoverageReason, string> = {
  proxied: "这里只记录经过过滤代理的 HTTP(S)；直连 IP、非 HTTP 协议和 nft 层直接拒绝的访问不在记录里。",
  auditOff: "这个容器现在不走过滤代理，所以没有放行记录；打开下方「记录 HTTP(S)」的开关后，经过代理的请求会出现在这里。",
  noDomainRules: "这个容器没有域名规则，HTTP(S) 是直连的，代理看不到；打开下方「记录 HTTP(S)」的开关后即可记录代理可见的请求。",
  unrestricted: "这个容器不限制出站，HTTP(S) 不经过过滤代理，没有放行记录。",
  unsupported: "当前网络模式下无法记录 HTTP(S)。",
}

export function NetworkPanel({
  session,
  onManageRules,
}: {
  session: SessionSummary
  onManageRules: () => void
}) {
  const base = `/api/containers/${encodeURIComponent(session.containerName)}/network`
  const [data, setData] = React.useState<TrafficData | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [decision, setDecision] = React.useState<"all" | "allow" | "deny">("all")
  const [toggling, setToggling] = React.useState(false)
  const { confirm, dialog } = useConfirmDialog()
  const seqRef = React.useRef(0)

  const load = React.useCallback(
    async (quiet = false) => {
      const seq = ++seqRef.current
      if (!quiet) setLoading(true)
      try {
        const query = decision === "all" ? "" : `?decision=${decision}`
        const payload = (await apiGet(`${base}/traffic${query}`)) as unknown as TrafficData
        if (seq !== seqRef.current) return
        setData(payload)
        setError("")
      } catch (err) {
        if (seq !== seqRef.current) return
        setError(err instanceof Error ? err.message : "读取网络记录失败")
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    },
    [base, decision]
  )

  // 打开视图、切筛选时加载；可见时每 5 秒刷新一次（setTimeout 链），页面隐藏时停
  React.useEffect(() => {
    if (!session.containerName) return
    queueMicrotask(() => void load())
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (document.visibilityState === "visible") void load(true)
        schedule()
      }, 5000)
    }
    schedule()
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [load, session.containerName])

  async function toggleAudit(next: boolean) {
    setToggling(true)
    try {
      const network = (await apiGet(base)) as unknown as { policy: NetworkPolicyLike }
      const policy = { ...network.policy, auditHttp: next }
      await apiPut(base, { policy })
      await load(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setToggling(false)
    }
  }

  async function allowHost(record: TrafficRecord) {
    try {
      await apiPost(`${base}/allow`, { domain: record.host, confirmRisk: true })
      await load(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "放行失败")
    }
  }

  async function clearRecords() {
    const ok = await confirm({
      title: "清空网络记录？",
      message: "只清空这个容器经过代理的放行记录，被拒绝的记录仍在「设置容器」里单独清空。",
      confirmLabel: "清空",
    })
    if (!ok) return
    try {
      await apiDelete(`${base}/traffic`)
      await load(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "清空失败")
    }
  }

  const columns: DataColumn<TrafficRecord>[] = [
    {
      key: "ts",
      header: "时间",
      render: (row) => (row.ts ? formatDateTime(row.ts) : "—"),
    },
    {
      key: "action",
      header: "动作",
      render: (row) =>
        row.decision === "allow" ? (
          <Badge variant="success">允许</Badge>
        ) : (
          <span className="flex items-center gap-2">
            <Badge variant="destructive">拒绝</Badge>
            {row.count ? <Hint>{row.count} 次</Hint> : null}
          </span>
        ),
    },
    {
      key: "host",
      header: "目标",
      mono: true,
      primary: true,
      render: (row) => <span title={row.host}>{row.host}</span>,
    },
    { key: "port", header: "端口", render: (row) => String(row.port) },
    {
      key: "method",
      header: "方法 / 状态",
      mobile: "hidden",
      render: (row) => (row.method ? `${row.method}${row.status ? ` ${row.status}` : ""}` : "—"),
    },
    {
      key: "bytes",
      header: "上下行",
      mobile: "hidden",
      render: (row) =>
        row.decision === "allow" ? `${formatBytes(row.bytesIn)} / ${formatBytes(row.bytesOut)}` : "—",
    },
    {
      key: "duration",
      header: "耗时",
      mobile: "hidden",
      render: (row) => (row.decision === "allow" ? `${row.durationMs} ms` : "—"),
    },
  ]

  const metrics: Array<[string, string]> = data
    ? [
        ["允许", String(data.summary.allowed)],
        ["拒绝", String(data.summary.denied)],
        ["不同目标", String(data.summary.hosts)],
        ["上下行", `${formatBytes(data.summary.bytesIn)} / ${formatBytes(data.summary.bytesOut)}`],
      ]
    : []

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 md:p-4">
        <PageHeader
          title="网络"
          description="查看经过过滤代理的 HTTP(S) 记录，切换记录开关不需要重建容器。"
          actions={
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="刷新"
                title="刷新"
                onClick={() => void load()}
                disabled={loading}
              >
                {loading ? <Spinner /> : <RefreshCwIcon />}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="清空"
                title="清空"
                onClick={() => void clearRecords()}
                disabled={!data?.records.length}
              >
                <Trash2Icon />
              </Button>
            </>
          }
        />
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>最近记录</CardTitle>
            <CardDescription>经过过滤代理的 HTTP(S)，按时间倒序；汇总基于全部记录。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {metrics.map(([label, value]) => (
                <div key={label} className="flex flex-col gap-1">
                  <Hint>{label}</Hint>
                  <span className="font-mono">{value}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <ToggleGroup
                variant="outline"
                value={[decision]}
                onValueChange={(values) => {
                  const next = values[0] as "all" | "allow" | "deny" | undefined
                  if (next) setDecision(next)
                }}
              >
                <ToggleGroupItem value="all">全部</ToggleGroupItem>
                <ToggleGroupItem value="allow">允许</ToggleGroupItem>
                <ToggleGroupItem value="deny">拒绝</ToggleGroupItem>
              </ToggleGroup>
              <Button variant="outline" size="sm" onClick={onManageRules}>
                管理规则
              </Button>
            </div>
          </CardContent>
        </Card>

        {data ? (
          <Alert variant={data.coverage.reason === "proxied" ? "default" : "warning"}>
            <AlertDescription>{COVERAGE_TEXT[data.coverage.reason]}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>记录 HTTP(S)</CardTitle>
            <CardDescription>只影响经过代理的 HTTP(S)，不含直连和非 HTTP 协议；不会放宽任何网络规则。</CardDescription>
            <CardAction>
              <Switch
                aria-label="记录 HTTP(S)"
                checked={data?.coverage.auditHttp === true}
                disabled={toggling || !data}
                onCheckedChange={(checked) => void toggleAudit(checked)}
              />
            </CardAction>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>记录</CardTitle>
            <CardDescription>只记录 host、端口、方法、状态、字节、耗时；不记录 URL path/query、正文、Cookie、Proxy-Authorization。</CardDescription>
          </CardHeader>
          <CardContent>
            {loading && !data ? (
              <Skeleton className="h-40 w-full" />
            ) : data && data.records.length ? (
              <DataTable
                columns={columns}
                rows={data.records}
                rowKey={(row) => row.id}
                label="网络记录"
                actions={(row) =>
                  row.decision === "deny" ? (
                    <Button variant="outline" size="sm" onClick={() => void allowHost(row)}>
                      允许
                    </Button>
                  ) : null
                }
              />
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>还没有网络记录</EmptyTitle>
                  <EmptyDescription>
                    这里会显示经过过滤代理的 HTTP(S)；被拒绝的访问也会列出来。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>
      {dialog}
    </div>
  )
}
