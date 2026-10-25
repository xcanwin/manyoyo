import * as React from "react"
import { RefreshCwIcon } from "lucide-react"

import { DataTable, type DataColumn } from "@/components/data-table"
import { Hint } from "@/components/hint"
import { PageHeader } from "@/components/page-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldLegend, FieldSet } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { apiGet, type SessionSummary } from "@/lib/api"

type Skill = { name: string; source: string; description: string }
type Mcp = { name: string; detail: string; status: string; tone: "success" | "warning" | "error" }
type AgentExtensions = { program: string; label: string; skills: Skill[]; mcp: Mcp[] }

const SOURCE_LABELS: Record<string, string> = {
  user: "用户",
  project: "项目",
  plugin: "插件",
  builtin: "自带",
}

const SKILL_COLUMNS: DataColumn<Skill>[] = [
  { key: "name", header: "名称", mono: true, primary: true, render: (s) => s.name },
  { key: "source", header: "来源", render: (s) => SOURCE_LABELS[s.source] ?? s.source },
  { key: "description", header: "说明", className: "min-w-64 whitespace-normal", render: (s) => s.description || "—" },
]

const MCP_COLUMNS: DataColumn<Mcp>[] = [
  { key: "name", header: "名称", mono: true, primary: true, render: (m) => m.name },
  {
    key: "status",
    header: "状态",
    render: (m) => <Badge variant={m.tone === "success" ? "success" : m.tone === "warning" ? "warning" : "destructive"}>{m.status}</Badge>,
  },
  { key: "detail", header: "命令 / 地址", mono: true, mobile: "hidden", render: (m) => m.detail || "—" },
]

// “技能与 MCP”视图（只读）：容器里装了哪个 Agent 就列哪个。claude 的 MCP 会真实连接服务器，可能要等几秒
export function ExtensionsPanel({ session }: { session: SessionSummary }) {
  const [agents, setAgents] = React.useState<AgentExtensions[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")

  const load = React.useCallback(() => {
    setLoading(true)
    setError("")
    apiGet(`/api/sessions/${encodeURIComponent(session.name)}/extensions`)
      .then((data) => setAgents(Array.isArray(data.agents) ? (data.agents as AgentExtensions[]) : []))
      .catch((err) => setError(err instanceof Error ? err.message : "读取失败"))
      .finally(() => setLoading(false))
  }, [session.name])

  React.useEffect(() => {
    queueMicrotask(load)
  }, [load])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        compact
        title="技能与 MCP"
        actions={
          <Button variant="ghost" size="icon-sm" title="刷新" aria-label="刷新" onClick={load} disabled={loading}>
            {loading ? <Spinner /> : <RefreshCwIcon />}
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-3 md:p-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {agents === null && !error ? <DataTable<Skill> label="加载中" columns={SKILL_COLUMNS} rows={[]} rowKey={(s) => s.name} loading /> : null}
        {agents !== null && agents.length === 0 ? <Hint>容器里没有找到 Claude Code 或 Codex CLI。</Hint> : null}
        {(agents ?? []).map((agent) => (
          <FieldSet key={agent.program} aria-label={agent.label}>
            <FieldLegend variant="label">{agent.label}</FieldLegend>
            <DataTable<Skill>
              label={`${agent.label} 技能`}
              columns={SKILL_COLUMNS}
              rows={agent.skills}
              rowKey={(s) => s.name}
              empty={{ title: "没有技能" }}
            />
            <DataTable<Mcp>
              label={`${agent.label} MCP`}
              columns={MCP_COLUMNS}
              rows={agent.mcp}
              rowKey={(m) => m.name}
              empty={{ title: "没有 MCP 服务器" }}
            />
          </FieldSet>
        ))}
        <Hint>
          容器里看不到宿主机的 skill：把项目目录挂进容器（项目里的 .claude/skills 会自动生效），或复制到容器的 ~/.claude/skills/。
        </Hint>
      </div>
    </div>
  )
}
