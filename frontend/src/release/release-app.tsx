import * as React from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"

import { api, subscribeEvents, type ReleaseEvent, type Stage, type Status } from "./api"
import { CommitDialog, ConfirmDialog, ReleaseDialog, RunAllDialog, VersionDialog } from "./dialogs"

type StageView = Stage & { commands?: string[] }
type Dialog =
  | { kind: "version" }
  | { kind: "commit" }
  | { kind: "release"; stage: StageView }
  | { kind: "confirm"; stage: StageView }
  | { kind: "runAll" }
  | null

const PUBLISH_STAGES = ["merge", "image", "packages", "release", "npm", "assets", "verify"]
const STATE_LABEL: Record<string, string> = { done: "已完成", todo: "待办", blocked: "被阻塞", warn: "需确认" }
const STATE_STYLE: Record<string, string> = {
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  todo: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  blocked: "bg-muted text-muted-foreground",
  warn: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
}

type LogLine = { seq: number; stage: string; line: string }

export function ReleaseApp() {
  const [status, setStatus] = React.useState<Status | null>(null)
  const [error, setError] = React.useState("")
  const [dialog, setDialog] = React.useState<Dialog>(null)
  const [logs, setLogs] = React.useState<LogLine[]>([])
  const [pending, setPending] = React.useState<{ stage: string; title: string; commands: string[] } | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const logEnd = React.useRef<HTMLDivElement>(null)

  const refresh = React.useCallback(async (force = false) => {
    try {
      setStatus(await api<Status>(`/api/status${force ? "?refresh=1" : ""}`))
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取状态失败")
    }
  }, [])

  React.useEffect(() => {
    const first = setTimeout(() => void refresh(false), 0)
    const timer = setInterval(() => void refresh(false), 5000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [refresh])

  React.useEffect(() => {
    return subscribeEvents((event: ReleaseEvent) => {
      if (event.type === "start") {
        setLogs([])
        setError("")
      } else if (event.type === "log") {
        setLogs((previous) => [...previous.slice(-1500), { seq: event.seq, stage: event.stage, line: event.line }])
      } else if (event.type === "confirm") {
        setPending({ stage: event.stage, title: event.title, commands: event.commands })
      } else if (event.type === "stage") {
        setPending(null)
        void refresh(false)
      } else if (event.type === "done") {
        setPending(null)
        if (event.status !== "succeeded" && event.error) setError(event.error)
        void refresh(true)
      }
    })
  }, [refresh])

  React.useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" })
  }, [logs])

  const running = status?.job?.status === "running"

  async function start(stages: string[], mode: "single" | "step" | "auto", params: Record<string, unknown> = {}, confirmed = false) {
    setError("")
    try {
      await api("/api/run", { stages, mode, params, confirmed })
      await refresh(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动失败")
    }
  }

  function openStage(stage: StageView) {
    if (stage.id === "version") setDialog({ kind: "version" })
    else if (stage.id === "commit") setDialog({ kind: "commit" })
    else if (stage.id === "release") setDialog({ kind: "release", stage })
    else if (stage.external) setDialog({ kind: "confirm", stage })
    else void start([stage.id], "single")
  }

  async function reload() {
    setRefreshing(true)
    await refresh(true)
    setRefreshing(false)
  }

  async function quit() {
    await api("/api/quit", {}).catch(() => undefined)
    window.close()
    setError("控制台已结束，可以关闭这个页面。")
  }

  async function toggleCheck(id: string, done: boolean) {
    await api("/api/checklist", { id, done })
    await refresh(false)
  }

  if (!status) {
    return <div className="p-8 text-muted-foreground">{error || "读取状态…"}</div>
  }

  const stages = status.stages as StageView[]
  const next = stages.find((stage) => stage.id === status.nextStage)

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">发布控制台</h1>
        <Badge variant="outline">v{status.version}</Badge>
        <Badge variant="outline">{status.branch || "(分离)"}</Badge>
        <span className="text-sm text-muted-foreground">最近发布 {status.latestTag ?? "无"}</span>
        {status.dryRun && <Badge>dry-run</Badge>}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" disabled={refreshing} onClick={reload}>
            {refreshing && <Spinner />}刷新
          </Button>
          <Button variant="outline" size="sm" onClick={quit}>
            结束
          </Button>
        </div>
      </header>

      {!status.gh && (
        <Alert variant="destructive">
          <AlertDescription>gh 未登录或授权失效：涉及 GitHub 的阶段会被阻塞。先运行 gh auth login。</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{next ? `下一步：${next.title}` : "全部完成"}</CardTitle>
          <CardDescription>{next ? next.detail : "所有阶段都已完成。"}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {next && next.id !== "manual" && (
            <Button disabled={running} onClick={() => openStage(next)}>
              执行「{next.title}」
            </Button>
          )}
          <Button variant="outline" disabled={running} onClick={() => setDialog({ kind: "runAll" })}>
            一键发布（合并 main → 验证）
          </Button>
          {running && (
            <Button variant="destructive" onClick={() => api("/api/cancel", {}).then(() => refresh(false))}>
              取消任务
            </Button>
          )}
        </CardContent>
      </Card>

      <ol className="space-y-2">
        {stages.map((stage, index) => (
          <li key={stage.id}>
            <Card size="sm">
              <CardContent className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-5 text-sm text-muted-foreground">{index + 1}</span>
                  <span className="font-medium">{stage.title}</span>
                  <span className={`rounded px-2 py-0.5 text-xs ${STATE_STYLE[stage.state]}`}>{STATE_LABEL[stage.state]}</span>
                  {stage.external && <Badge variant="outline">对外动作</Badge>}
                  {status.job?.currentStage === stage.id && running && <Spinner />}
                  {stage.id !== "manual" && (
                    <Button
                      className="ml-auto"
                      size="sm"
                      variant={stage.state === "todo" || stage.state === "warn" ? "default" : "outline"}
                      disabled={running || stage.state === "blocked"}
                      onClick={() => openStage(stage)}
                    >
                      {stage.state === "done" ? "重新执行" : "执行"}
                    </Button>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{stage.detail}</p>
                {stage.url && (
                  <a className="text-sm underline" href={stage.url} target="_blank" rel="noreferrer">
                    {stage.url}
                  </a>
                )}
                {stage.id === "manual" && (
                  <div className="space-y-2">
                    {status.checklist.map((item) => (
                      <label key={item.id} className="flex items-start gap-2 text-sm">
                        <input type="checkbox" className="mt-1" checked={item.done} onChange={(event) => void toggleCheck(item.id, event.target.checked)} />
                        <span>{item.title}</span>
                      </label>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">
            日志{status.job ? `（${status.job.status}${status.job.currentStage ? ` · ${status.job.currentStage}` : ""}）` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {logs.length === 0 ? "（还没有输出）" : logs.map((entry) => `[${entry.stage}] ${entry.line}`).join("\n")}
            <div ref={logEnd} />
          </pre>
        </CardContent>
      </Card>

      {dialog?.kind === "version" && (
        <VersionDialog
          current={status.version}
          imageVersion={status.imageVersion}
          suggestions={status.suggestions}
          onCancel={() => setDialog(null)}
          onSubmit={async (version, imageVersion) => {
            await api("/api/run", { stages: ["version"], mode: "single", params: { version: { version, imageVersion } }, confirmed: false })
            setDialog(null)
            await refresh(false)
          }}
        />
      )}
      {dialog?.kind === "commit" && (
        <CommitDialog
          files={status.dirty}
          ruleMessage={status.ruleMessage}
          onCancel={() => setDialog(null)}
          onSubmit={async (files, message) => {
            await api("/api/run", { stages: ["commit"], mode: "single", params: { commit: { files, message } }, confirmed: false })
            setDialog(null)
            await refresh(false)
          }}
        />
      )}
      {dialog?.kind === "release" && (
        <ReleaseDialog
          draft={status.notesDraft}
          commands={dialog.stage.commands ?? []}
          onCancel={() => setDialog(null)}
          onSubmit={(notes) => {
            setDialog(null)
            void start(["release"], "single", { release: { notes } }, true)
          }}
        />
      )}
      {dialog?.kind === "confirm" && (
        <ConfirmDialog
          title={dialog.stage.title}
          commands={dialog.stage.commands ?? []}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const id = dialog.stage.id
            setDialog(null)
            void start([id], "single", {}, true)
          }}
        />
      )}
      {dialog?.kind === "runAll" && (
        <RunAllDialog
          stages={stages.filter((stage) => PUBLISH_STAGES.includes(stage.id) && stage.state !== "done").map((stage) => stage.title)}
          onCancel={() => setDialog(null)}
          onStart={(mode) => {
            setDialog(null)
            // 一键发布里的 Release 说明用草稿；需要改说明请改用单步执行
            void start(PUBLISH_STAGES, mode, { release: { notes: status.notesDraft } }, mode === "auto")
          }}
        />
      )}
      {pending && (
        <ConfirmDialog
          title={pending.title}
          commands={pending.commands}
          onCancel={() => void api("/api/confirm", { approve: false })}
          onConfirm={() => void api("/api/confirm", { approve: true }).then(() => setPending(null))}
        />
      )}
    </div>
  )
}
