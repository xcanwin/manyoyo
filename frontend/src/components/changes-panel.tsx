import * as React from "react"
import { RefreshCwIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { apiGet, type SessionSummary } from "@/lib/api"
import type { RoundOption } from "@/lib/rounds"
import { diffLineClass } from "@/lib/diff-lines"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type ChangedFile = {
  path: string
  status: "modified" | "added" | "deleted" | "untracked" | "conflicted"
  added: number | null
  deleted: number | null
}

type ChangesData = { repo: boolean; root: string; files: ChangedFile[]; truncated: boolean }

const STATUS_LABELS: Record<ChangedFile["status"], string> = {
  modified: "修改",
  added: "新增",
  deleted: "删除",
  untracked: "新文件",
  conflicted: "冲突",
}

// “改动”视图：默认是工作目录所在 git 仓库的改动；也可以按“轮”看（每轮对话前后各有一张快照，不依赖 git 仓库）。
// 只在打开视图、点刷新、以及新的一轮结束时请求，不轮询
export function ChangesPanel({
  session,
  onOpenFile,
  rounds = [],
}: {
  session: SessionSummary
  onOpenFile: (path: string) => void
  // 有快照的轮次（从旧到新）；它们的数量变化说明又结束了一轮，打开着的话自动刷新
  rounds?: RoundOption[]
}) {
  const [data, setData] = React.useState<ChangesData | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [selected, setSelected] = React.useState("")
  const [diff, setDiff] = React.useState<{ path: string; text: string; truncated: boolean } | null>(null)
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [mode, setMode] = React.useState<"head" | "round">("head")
  const [roundId, setRoundId] = React.useState("")
  const base = `/api/sessions/${encodeURIComponent(session.name)}`
  const round = rounds.find((item) => item.id === roundId) ?? rounds[rounds.length - 1] ?? null
  const roundKey = round ? `${round.before}..${round.after}` : ""

  const load = React.useCallback(() => {
    setLoading(true)
    setError("")
    setSelected("")
    const url =
      mode === "round" && roundKey
        ? `${base}/git/rounds/changes?from=${roundKey.split("..")[0]}&to=${roundKey.split("..")[1]}`
        : `${base}/git/changes`
    apiGet(url)
      .then((result) => {
        const next = result as unknown as ChangesData & { ok?: boolean }
        // 轮次接口没有 repo 字段：ok 代表读到了
        setData(mode === "round" ? { repo: next.ok === true, root: "", files: next.files ?? [], truncated: next.truncated === true } : next)
        // 工作目录不是 git 仓库：默认改成按轮看（快捷对话的目录就是这样）
        if (mode === "head" && !(next as ChangesData).repo && rounds.length > 0) setMode("round")
      })
      .catch((err) => setError(err instanceof Error ? err.message : "读取改动失败"))
      .finally(() => setLoading(false))
  }, [base, mode, roundKey, rounds.length])

  React.useEffect(() => {
    queueMicrotask(load)
  }, [load])

  function openDiff(file: ChangedFile) {
    if (file.status === "untracked") {
      onOpenFile(`${(data?.root || "").replace(/\/$/, "")}/${file.path}`)
      return
    }
    if (selected === file.path) {
      setSelected("")
      return
    }
    setSelected(file.path)
    setDiff(null)
    setDiffLoading(true)
    apiGet(
      mode === "round" && roundKey
        ? `${base}/git/rounds/diff?from=${roundKey.split("..")[0]}&to=${roundKey.split("..")[1]}&path=${encodeURIComponent(file.path)}`
        : `${base}/git/diff?path=${encodeURIComponent(file.path)}`
    )
      .then((result) =>
        setDiff({ path: file.path, text: String(result.diff || ""), truncated: result.truncated === true })
      )
      .catch((err) => setDiff({ path: file.path, text: err instanceof Error ? err.message : "读取 diff 失败", truncated: false }))
      .finally(() => setDiffLoading(false))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {rounds.length > 0 ? (
            <div className="flex shrink-0 gap-1" role="group" aria-label="改动范围">
              <Button size="xs" variant={mode === "round" ? "default" : "outline"} onClick={() => setMode("round")}>
                按轮
              </Button>
              <Button size="xs" variant={mode === "head" ? "default" : "outline"} onClick={() => setMode("head")}>
                与 HEAD 比较
              </Button>
            </div>
          ) : null}
          {mode === "round" && rounds.length > 0 && round ? (
            <Select value={round.id} onValueChange={(value) => setRoundId(String(value))}>
              <SelectTrigger className="min-w-0 max-w-64" aria-label="选择一轮">
                <SelectValue>{() => round.label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {[...rounds].reverse().map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : (
            <span className="truncate text-sm text-muted-foreground">
              {data?.repo ? `${data.files.length} 个文件有改动${data.truncated ? "（只显示前 500 个）" : ""}` : "工作目录的 git 改动"}
            </span>
          )}
        </div>
        <Button variant="ghost" size="icon-sm" title="刷新" aria-label="刷新" onClick={load} disabled={loading}>
          {loading ? <Spinner /> : <RefreshCwIcon />}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <p className="p-4 text-sm text-destructive">{error}</p> : null}
        {data && !data.repo ? <p className="p-4 text-sm text-muted-foreground">{mode === "round" ? "这一轮没有可比较的快照" : "工作目录不是 git 仓库"}</p> : null}
        {data?.repo && data.files.length === 0 ? <p className="p-4 text-sm text-muted-foreground">没有改动</p> : null}
        {data?.repo
          ? data.files.map((file) => (
              <div key={file.path} className="border-b">
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted",
                    selected === file.path && "bg-muted"
                  )}
                  onClick={() => openDiff(file)}
                >
                  <Badge variant="outline" className="w-14 shrink-0 justify-center">
                    {STATUS_LABELS[file.status] || file.status}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{file.path}</span>
                  {file.added !== null || file.deleted !== null ? (
                    <span className="shrink-0 font-mono text-xs">
                      <span className="text-emerald-600 dark:text-emerald-400">+{file.added ?? 0}</span>{" "}
                      <span className="text-red-600 dark:text-red-400">-{file.deleted ?? 0}</span>
                    </span>
                  ) : null}
                </button>
                {selected === file.path ? (
                  <div className="overflow-x-auto bg-muted/30 py-2">
                    {diffLoading ? (
                      <div className="px-3 py-2">
                        <Spinner />
                      </div>
                    ) : diff && diff.path === file.path ? (
                      <>
                        <pre className="min-w-max font-mono text-[12px] leading-[1.55]">
                          {diff.text.split("\n").map((line, index) => (
                            <div key={index} className={cn("px-3", diffLineClass(line))}>
                              {line || " "}
                            </div>
                          ))}
                        </pre>
                        {diff.truncated ? <p className="px-3 pt-1 text-xs text-muted-foreground">内容过大，已截断显示</p> : null}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))
          : null}
      </div>
    </div>
  )
}
