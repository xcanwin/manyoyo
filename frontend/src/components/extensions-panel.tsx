import * as React from "react"
import { PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"

import { apiDelete, apiGet, apiPost, apiPut, type SessionSummary } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"
import { DataTable, type DataColumn } from "@/components/data-table"
import { Hint } from "@/components/hint"
import { PageHeader } from "@/components/page-header"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

type Skill = { name: string; source: string; description: string }
type Mcp = { name: string; detail: string; status: string; tone: "success" | "warning" | "error" }
type AgentExtensions = { program: string; label: string; skills: Skill[]; mcp: Mcp[] }

type SharedSkill = { agent: "common" | "claude" | "codex"; name: string; description: string; updatedAt: string; nameMismatch?: boolean }
type SharedMcp = { id: string; name: string; agents: string[]; transport: string; enabled: boolean; hasEnv?: boolean; hasHeaders?: boolean }
type SharedStatus = {
  mode: string
  pending: boolean
  skills: { claude: string[]; codex: string[] }
  mcp: { claude: string[]; codex: string[] }
  conflicts: Array<{ type: string; agent: string; name: string }>
}

const SOURCE_LABELS: Record<string, string> = {
  user: "用户",
  project: "项目",
  plugin: "插件",
  builtin: "自带",
  shared: "共享库",
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

type SecretRow = { key: string; value: string }

type McpForm = {
  name: string
  agents: string[]
  transport: "stdio" | "http" | "sse"
  command: string
  args: string
  url: string
  bearerTokenEnvVar: string
  env: SecretRow[]
  headers: SecretRow[]
  enabled: boolean
}

const emptyMcpForm = (): McpForm => ({
  name: "",
  agents: ["claude"],
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  bearerTokenEnvVar: "",
  env: [],
  headers: [],
  enabled: true,
})

// “技能与 MCP”视图：上面是宿主级共享库（可增删改、同步到容器），下面是容器里 Agent 自己报告的现状。
// 共享技能是代码、共享 MCP 的密钥对所有容器可见——界面上如实写明，不假装隔离。
export function ExtensionsPanel({ session }: { session: SessionSummary }) {
  const [agents, setAgents] = React.useState<AgentExtensions[] | null>(null)
  const [shared, setShared] = React.useState<SharedStatus | null>(null)
  const [library, setLibrary] = React.useState<{ skills: SharedSkill[]; mcp: SharedMcp[] }>({ skills: [], mcp: [] })
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [busy, setBusy] = React.useState("")
  const [skillDialog, setSkillDialog] = React.useState<{ agent: SharedSkill["agent"]; name: string } | null>(null)
  const [skillForm, setSkillForm] = React.useState({ agent: "common" as SharedSkill["agent"], name: "", content: "" })
  const [mcpDialog, setMcpDialog] = React.useState<{ id: string } | null>(null)
  const [mcpForm, setMcpForm] = React.useState<McpForm>(emptyMcpForm)
  const { confirm, dialog: confirmDialog } = useConfirmDialog()
  const base = `/api/sessions/${encodeURIComponent(session.name)}/extensions`

  const load = React.useCallback(() => {
    setLoading(true)
    setError("")
    Promise.all([
      apiGet(base),
      apiGet("/api/extensions"),
    ])
      .then(([sessionData, libraryData]) => {
        setAgents(Array.isArray(sessionData.agents) ? (sessionData.agents as AgentExtensions[]) : [])
        setShared((sessionData.shared as SharedStatus | undefined) ?? null)
        setLibrary({
          skills: Array.isArray(libraryData.skills) ? (libraryData.skills as SharedSkill[]) : [],
          mcp: Array.isArray(libraryData.mcp) ? (libraryData.mcp as SharedMcp[]) : [],
        })
      })
      .catch((err) => setError(err instanceof Error ? err.message : "读取失败"))
      .finally(() => setLoading(false))
  }, [base])

  React.useEffect(() => {
    queueMicrotask(load)
  }, [load])

  async function syncCurrent() {
    setBusy("sync")
    setNotice("")
    try {
      const result = await apiPost(`${base}/apply`, {})
      const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : []
      const conflicts = Array.isArray(result.conflicts) ? result.conflicts : []
      setNotice(`已同步${conflicts.length ? `，${conflicts.length} 项冲突未覆盖` : ""}${warnings.length ? `，${warnings.length} 条警告` : ""}`)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "同步失败")
    } finally {
      setBusy("")
    }
  }

  async function testMcp(name: string, agent: string) {
    setBusy(`test:${name}`)
    setNotice("")
    try {
      const result = await apiPost(`${base}/test`, { kind: "mcp", agent, name })
      setNotice(`${name}：${String(result.detail || result.status)}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "测试失败")
    } finally {
      setBusy("")
    }
  }

  async function openSkillEditor(agent: SharedSkill["agent"], name: string) {
    try {
      const data = await apiGet(`/api/extensions/skills/${encodeURIComponent(agent)}/${encodeURIComponent(name)}`)
      setSkillForm({ agent, name, content: String(data.content || "") })
      setSkillDialog({ agent, name })
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取技能失败")
    }
  }

  async function saveSkill() {
    setBusy("skill")
    try {
      if (skillDialog && skillDialog.name) {
        await apiPut(`/api/extensions/skills/${encodeURIComponent(skillDialog.agent)}/${encodeURIComponent(skillDialog.name)}`, { content: skillForm.content })
      } else {
        await apiPost("/api/extensions/skills", { agent: skillForm.agent, name: skillForm.name.trim(), content: skillForm.content })
      }
      setSkillDialog(null)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存技能失败")
    } finally {
      setBusy("")
    }
  }

  async function removeSkill(agent: SharedSkill["agent"], name: string) {
    const ok = await confirm({ title: "删除共享技能？", message: `所有容器下次同步后都不再能看到 ${name}。`, confirmLabel: "删除" })
    if (!ok) return
    try {
      await apiDelete(`/api/extensions/skills/${encodeURIComponent(agent)}/${encodeURIComponent(name)}`)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败")
    }
  }

  async function openMcpEditor(id?: string) {
    if (!id) {
      setMcpForm(emptyMcpForm())
      setMcpDialog({ id: "" })
      return
    }
    try {
      const data = await apiGet(`/api/extensions/mcp/${encodeURIComponent(id)}`)
      const env = Array.isArray(data.env) ? (data.env as Array<{ key: string; masked: string }>) : []
      const headers = Array.isArray(data.headers) ? (data.headers as Array<{ key: string; masked: string }>) : []
      setMcpForm({
        name: String(data.name || ""),
        agents: Array.isArray(data.agents) ? (data.agents as string[]) : ["claude"],
        transport: (["stdio", "http", "sse"].includes(String(data.transport)) ? data.transport : "stdio") as McpForm["transport"],
        command: String(data.command || ""),
        args: (Array.isArray(data.args) ? data.args : []).join("\n"),
        url: String(data.url || ""),
        bearerTokenEnvVar: String(data.bearerTokenEnvVar || ""),
        env: env.map((item) => ({ key: item.key, value: "" })),
        headers: headers.map((item) => ({ key: item.key, value: "" })),
        enabled: data.enabled !== false,
      })
      setMcpDialog({ id })
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取 MCP 失败")
    }
  }

  async function saveMcp() {
    setBusy("mcp")
    try {
      const payload = {
        name: mcpForm.name.trim(),
        agents: mcpForm.agents,
        transport: mcpForm.transport,
        command: mcpForm.command,
        args: mcpForm.args.split("\n").map((line) => line.trim()).filter(Boolean),
        url: mcpForm.url,
        bearerTokenEnvVar: mcpForm.bearerTokenEnvVar,
        env: mcpForm.env.filter((row) => row.key.trim()).map((row) => (row.value ? { key: row.key.trim(), value: row.value } : { key: row.key.trim() })),
        headers: mcpForm.headers.filter((row) => row.key.trim()).map((row) => (row.value ? { key: row.key.trim(), value: row.value } : { key: row.key.trim() })),
        enabled: mcpForm.enabled,
      }
      if (mcpDialog && mcpDialog.id) await apiPut(`/api/extensions/mcp/${encodeURIComponent(mcpDialog.id)}`, payload)
      else await apiPost("/api/extensions/mcp", payload)
      setMcpDialog(null)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存 MCP 失败")
    } finally {
      setBusy("")
    }
  }

  async function removeMcp(id: string, name: string) {
    const ok = await confirm({ title: "删除共享 MCP？", message: `所有容器下次同步后都不再配置 ${name}；容器里手动添加的同名条目不会被删。`, confirmLabel: "删除" })
    if (!ok) return
    try {
      await apiDelete(`/api/extensions/mcp/${encodeURIComponent(id)}`)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败")
    }
  }

  const skillColumns: DataColumn<SharedSkill>[] = [
    { key: "name", header: "名称", mono: true, primary: true, render: (s) => s.name },
    {
      key: "agent",
      header: "适用",
      render: (s) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant="secondary">{s.agent === "common" ? "全部" : s.agent}</Badge>
          {s.nameMismatch ? <Badge variant="warning">目录名与 name 不一致</Badge> : null}
        </span>
      ),
    },
    { key: "description", header: "说明", className: "min-w-64 whitespace-normal", render: (s) => s.description || "—" },
    { key: "updatedAt", header: "更新时间", mobile: "hidden", render: (s) => formatDateTime(s.updatedAt) },
  ]

  const sharedMcpColumns: DataColumn<SharedMcp>[] = [
    { key: "name", header: "名称", mono: true, primary: true, render: (m) => m.name },
    { key: "agents", header: "适用", render: (m) => m.agents.join(" / ") },
    { key: "transport", header: "传输", render: (m) => m.transport },
    {
      key: "enabled",
      header: "启用",
      render: (m) => <Badge variant={m.enabled ? "success" : "secondary"}>{m.enabled ? "启用" : "已禁用"}</Badge>,
    },
  ]

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
        {notice ? (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>共享库</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Hint className="block">
              共享技能是代码：它会挂进每个新容器并被 Agent 读到，添加前请确认内容可信。共享 MCP 的密钥会出现在所有使用该条目的容器里。
            </Hint>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => { setSkillForm({ agent: "common", name: "", content: "---\nname: \ndescription: \n---\n" }); setSkillDialog({ agent: "common", name: "" }) }}>
                <PlusIcon data-icon="inline-start" />
                新增技能
              </Button>
              <Button size="sm" variant="outline" onClick={() => void openMcpEditor()}>
                <PlusIcon data-icon="inline-start" />
                新增 MCP
              </Button>
              <Button size="sm" variant="outline" onClick={() => void syncCurrent()} disabled={busy === "sync"}>
                {busy === "sync" ? <Spinner /> : null}
                同步到当前容器
              </Button>
              <Hint>
                {shared ? (shared.mode === "mount" ? "当前容器：只读挂载 + 受管链接" : shared.mode ? "当前容器：复制模式" : "当前容器还没有同步过") : ""}
                {shared?.pending ? " · 共享库有更新，需要同步" : ""}
              </Hint>
            </div>
            <DataTable<SharedSkill>
              label="共享技能"
              columns={skillColumns}
              rows={library.skills}
              rowKey={(s) => `${s.agent}/${s.name}`}
              empty={{ title: "还没有共享技能" }}
              actions={(s) => (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="icon-sm" aria-label="编辑" title="编辑" onClick={() => void openSkillEditor(s.agent, s.name)}>
                    <PencilIcon />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="删除" title="删除" onClick={() => void removeSkill(s.agent, s.name)}>
                    <Trash2Icon />
                  </Button>
                </div>
              )}
            />
            <DataTable<SharedMcp>
              label="共享 MCP"
              columns={sharedMcpColumns}
              rows={library.mcp}
              rowKey={(m) => m.id}
              empty={{ title: "还没有共享 MCP" }}
              actions={(m) => (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="icon-sm" aria-label="测试" title="测试连接" onClick={() => void testMcp(m.name, "claude")} disabled={busy === `test:${m.name}`}>
                    {busy === `test:${m.name}` ? <Spinner /> : null}
                    测试
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="编辑" title="编辑" onClick={() => void openMcpEditor(m.id)}>
                    <PencilIcon />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="删除" title="删除" onClick={() => void removeMcp(m.id, m.name)}>
                    <Trash2Icon />
                  </Button>
                </div>
              )}
            />
            {shared?.conflicts?.length ? (
              <Alert variant="warning">
                <AlertDescription>
                  有 {shared.conflicts.length} 项同名内容没有被覆盖（容器里的真实目录 / 用户自己加的 MCP /
                  项目里的同名技能）。共享库只管理自己下发的条目。
                </AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>

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
            {agent.mcp.some((item) => item.detail === "project" || item.status === "待确认") ? (
              <Alert variant="warning">
                <AlertDescription>标记为「项目提供」的配置来自工作目录，可能不可信；需要你在容器里确认后才会生效。</AlertDescription>
              </Alert>
            ) : null}
          </FieldSet>
        ))}
        <Hint>
          共享技能在新建容器时通过只读挂载生效；已有容器用「同步到当前容器」复制。删除容器不会删除共享库。
        </Hint>
      </div>

      <Dialog open={skillDialog !== null} onOpenChange={(open) => { if (!open) setSkillDialog(null) }}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{skillDialog?.name ? "编辑技能" : "新增技能"}</DialogTitle>
            <DialogDescription>SKILL.md 的内容会挂进容器；共享技能是代码，请确认来源可信。</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FieldGroup>
              <Field>
                <FieldLabel>适用 Agent</FieldLabel>
                <Select value={skillForm.agent} onValueChange={(value) => value && setSkillForm((prev) => ({ ...prev, agent: value as SharedSkill["agent"] }))} disabled={Boolean(skillDialog?.name)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="common">全部（Claude + Codex）</SelectItem>
                      <SelectItem value="claude">仅 Claude</SelectItem>
                      <SelectItem value="codex">仅 Codex</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-name">技能名称</FieldLabel>
                <Input
                  id="skill-name"
                  placeholder="例如 code-review"
                  value={skillForm.name}
                  disabled={Boolean(skillDialog?.name)}
                  onChange={(event) => setSkillForm((prev) => ({ ...prev, name: event.target.value }))}
                />
                <FieldDescription>只能包含字母、数字、下划线和短横线；目录名要与 SKILL.md 里的 name 一致。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-content">SKILL.md</FieldLabel>
                <Textarea
                  id="skill-content"
                  className="min-h-48 font-mono"
                  value={skillForm.content}
                  onChange={(event) => setSkillForm((prev) => ({ ...prev, content: event.target.value }))}
                />
              </Field>
            </FieldGroup>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSkillDialog(null)}>取消</Button>
            <Button onClick={() => void saveSkill()} disabled={busy === "skill" || !skillForm.content.trim() || (!skillDialog?.name && !skillForm.name.trim())}>
              {busy === "skill" ? <Spinner /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mcpDialog !== null} onOpenChange={(open) => { if (!open) setMcpDialog(null) }}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{mcpDialog?.id ? "编辑 MCP" : "新增 MCP"}</DialogTitle>
            <DialogDescription>
              共享 MCP 会下发到每个使用它的容器；密钥会出现在这些容器里。MCP 的命令受容器的网络策略约束。
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="mcp-name">名称</FieldLabel>
                <Input id="mcp-name" value={mcpForm.name} onChange={(event) => setMcpForm((prev) => ({ ...prev, name: event.target.value }))} />
              </Field>
              <Field>
                <FieldLabel>适用 Agent</FieldLabel>
                <div className="flex items-center gap-4">
                  {["claude", "codex"].map((agent) => (
                    <label key={agent} className="flex items-center gap-2">
                      <Checkbox
                        checked={mcpForm.agents.includes(agent)}
                        onCheckedChange={(checked) =>
                          setMcpForm((prev) => ({ ...prev, agents: checked ? [...new Set([...prev.agents, agent])] : prev.agents.filter((item) => item !== agent) }))
                        }
                      />
                      <span>{agent}</span>
                    </label>
                  ))}
                </div>
              </Field>
              <Field>
                <FieldLabel>传输方式</FieldLabel>
                <Select value={mcpForm.transport} onValueChange={(value) => value && setMcpForm((prev) => ({ ...prev, transport: value as McpForm["transport"] }))}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="stdio">stdio（本地命令）</SelectItem>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="sse">SSE（仅 Claude）</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {mcpForm.transport === "stdio" ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="mcp-command">命令</FieldLabel>
                    <Input id="mcp-command" placeholder="例如 npx" value={mcpForm.command} onChange={(event) => setMcpForm((prev) => ({ ...prev, command: event.target.value }))} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="mcp-args">参数（每行一个）</FieldLabel>
                    <Textarea id="mcp-args" className="min-h-20 font-mono" value={mcpForm.args} onChange={(event) => setMcpForm((prev) => ({ ...prev, args: event.target.value }))} />
                  </Field>
                </>
              ) : (
                <>
                  <Field>
                    <FieldLabel htmlFor="mcp-url">URL</FieldLabel>
                    <Input id="mcp-url" placeholder="留空 = 保留原地址" value={mcpForm.url} onChange={(event) => setMcpForm((prev) => ({ ...prev, url: event.target.value }))} />
                    <FieldDescription>不要把令牌放进 URL；用下面的环境变量或 headers。</FieldDescription>
                  </Field>
                  {mcpForm.transport === "http" ? (
                    <Field>
                      <FieldLabel htmlFor="mcp-bearer">Bearer 令牌所在的环境变量（Codex）</FieldLabel>
                      <Input id="mcp-bearer" placeholder="例如 MCP_TOKEN" value={mcpForm.bearerTokenEnvVar} onChange={(event) => setMcpForm((prev) => ({ ...prev, bearerTokenEnvVar: event.target.value }))} />
                    </Field>
                  ) : null}
                </>
              )}
              <SecretEditor
                label={mcpForm.transport === "stdio" ? "环境变量（值留空 = 保留原值）" : "Headers（值留空 = 保留原值）"}
                rows={mcpForm.transport === "stdio" ? mcpForm.env : mcpForm.headers}
                onChange={(rows) => setMcpForm((prev) => (prev.transport === "stdio" ? { ...prev, env: rows } : { ...prev, headers: rows }))}
              />
              <Field orientation="horizontal" className="justify-between">
                <FieldLabel htmlFor="mcp-enabled">启用</FieldLabel>
                <Switch id="mcp-enabled" checked={mcpForm.enabled} onCheckedChange={(checked) => setMcpForm((prev) => ({ ...prev, enabled: checked }))} />
              </Field>
            </FieldGroup>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMcpDialog(null)}>取消</Button>
            <Button onClick={() => void saveMcp()} disabled={busy === "mcp" || !mcpForm.name.trim()}>
              {busy === "mcp" ? <Spinner /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {confirmDialog}
    </div>
  )
}

function SecretEditor({ label, rows, onChange }: { label: string; rows: SecretRow[]; onChange: (rows: SecretRow[]) => void }) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              aria-label={`第 ${index + 1} 行 key`}
              placeholder="KEY"
              className="font-mono"
              value={row.key}
              onChange={(event) => onChange(rows.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)))}
            />
            <Input
              aria-label={`第 ${index + 1} 行值`}
              type="password"
              placeholder="值（留空 = 保留原值）"
              value={row.value}
              onChange={(event) => onChange(rows.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))}
            />
            <Button type="button" variant="ghost" size="icon-sm" aria-label="删除" title="删除" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
              <Trash2Icon />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, { key: "", value: "" }])}>
          <PlusIcon data-icon="inline-start" />
          添加一行
        </Button>
      </div>
    </Field>
  )
}
