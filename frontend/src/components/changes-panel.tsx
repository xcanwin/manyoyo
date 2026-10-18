import * as React from "react"
import { RefreshCwIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { apiGet, type SessionSummary } from "@/lib/api"
import { diffLineClass } from "@/lib/diff-lines"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

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

// “改动”视图：工作目录所在 git 仓库的改动。只在打开视图和点刷新时请求，不轮询
export function ChangesPanel({
  session,
  onOpenFile,
}: {
  session: SessionSummary
  onOpenFile: (path: string) => void
}) {
  const [data, setData] = React.useState<ChangesData | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [selected, setSelected] = React.useState("")
  const [diff, setDiff] = React.useState<{ path: string; text: string; truncated: boolean } | null>(null)
  const [diffLoading, setDiffLoading] = React.useState(false)
  const base = `/api/sessions/${encodeURIComponent(session.name)}`

  const load = React.useCallback(() => {
    setLoading(true)
    setError("")
    apiGet(`${base}/git/changes`)
      .then((result) => setData(result as unknown as ChangesData))
      .catch((err) => setError(err instanceof Error ? err.message : "读取改动失败"))
      .finally(() => setLoading(false))
  }, [base])

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
    apiGet(`${base}/git/diff?path=${encodeURIComponent(file.path)}`)
      .then((result) =>
        setDiff({ path: file.path, text: String(result.diff || ""), truncated: result.truncated === true })
      )
      .catch((err) => setDiff({ path: file.path, text: err instanceof Error ? err.message : "读取 diff 失败", truncated: false }))
      .finally(() => setDiffLoading(false))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <span className="truncate text-sm text-muted-foreground">
          {data?.repo ? `${data.files.length} 个文件有改动${data.truncated ? "（只显示前 500 个）" : ""}` : "工作目录的 git 改动"}
        </span>
        <Button variant="ghost" size="icon-sm" title="刷新" aria-label="刷新" onClick={load} disabled={loading}>
          {loading ? <Spinner /> : <RefreshCwIcon />}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <p className="p-4 text-sm text-destructive">{error}</p> : null}
        {data && !data.repo ? <p className="p-4 text-sm text-muted-foreground">工作目录不是 git 仓库</p> : null}
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
