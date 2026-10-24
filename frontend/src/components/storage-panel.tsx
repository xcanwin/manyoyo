import * as React from "react"
import { RefreshCwIcon, Trash2Icon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"
import { apiDelete, apiGet } from "@/lib/api"
import { formatBytes, formatDateTime } from "@/lib/format"

type SessionState = "running" | "stopped" | "deleted"
type RowStatus = "in-use" | "history-only" | "unused"
type StorageRow = {
  path: string
  managed: boolean
  status: RowStatus
  sessions: { name: string; state: SessionState }[]
  mtimeMs: number
  deletable: boolean
}
type SizeState = { bytes?: number; timedOut?: boolean; error?: boolean } | "loading" | undefined

const STATUS_LABEL: Record<RowStatus, string> = {
  "in-use": "使用中",
  "history-only": "容器已删除",
  unused: "无人使用",
}
const SESSION_STATE_LABEL: Record<SessionState, string> = { running: "运行中", stopped: "已停止", deleted: "已删除" }
const SIZE_CONCURRENCY = 2

function sizeText(size: SizeState): string {
  if (size === "loading") return "计算中…"
  if (!size) return "—"
  if (size.timedOut) return "太大，超时"
  if (size.error || size.bytes === undefined) return "无法计算"
  return formatBytes(size.bytes)
}

// 宿主机目录占用：工作目录在容器删除后仍保留，这里按目录列出（同路径多个容器、同名容器换路径都不会混）。
// 只有 MANYOYO 自己建的工作目录、且没有容器在用，才能删除；你自己的项目目录只展示
export function StoragePanel() {
  const [rows, setRows] = React.useState<StorageRow[] | null>(null)
  const [error, setError] = React.useState("")
  const [sizes, setSizes] = React.useState<Record<string, SizeState>>({})
  const { confirm, dialog } = useConfirmDialog()
  const generation = React.useRef(0)

  const loadSize = React.useCallback(async (path: string, round: number) => {
    setSizes((current) => ({ ...current, [path]: "loading" }))
    let value: SizeState
    try {
      value = (await apiGet(`/api/storage/size?path=${encodeURIComponent(path)}`)) as SizeState
    } catch {
      value = { error: true }
    }
    if (round === generation.current) setSizes((current) => ({ ...current, [path]: value }))
  }, [])

  const load = React.useCallback(async () => {
    const round = ++generation.current
    setError("")
    try {
      const data = (await apiGet("/api/storage")) as { rows?: StorageRow[] }
      if (round !== generation.current) return
      const list = data.rows || []
      setRows(list)
      setSizes({})
      // 工作目录自动算体积（两个一组，du 很慢时不把磁盘打满）；你自己的项目目录点了再算
      const queue = list.filter((row) => row.managed).map((row) => row.path)
      const worker = async () => {
        for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
          if (round !== generation.current) return
          await loadSize(path, round)
        }
      }
      void Promise.all(Array.from({ length: SIZE_CONCURRENCY }, worker))
    } catch (err) {
      if (round !== generation.current) return
      setError(err instanceof Error ? err.message : "读取失败")
      setRows([])
    }
  }, [loadSize])

  React.useEffect(() => {
    queueMicrotask(() => void load())
    return () => {
      generation.current += 1
    }
  }, [load])

  async function remove(row: StorageRow) {
    const ok = await confirm({
      title: "删除这个工作目录？",
      message: `${row.path}\n里面的所有文件会被永久删除，无法恢复。`,
      confirmLabel: "删除",
    })
    if (!ok) return
    try {
      await apiDelete("/api/storage/dirs", { path: row.path })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败")
    }
  }

  if (rows === null) {
    return (
      <div className="flex justify-center py-6">
        <Spinner className="size-5" />
      </div>
    )
  }

  const known = Object.values(sizes).reduce((sum, size) => sum + (size && size !== "loading" && size.bytes ? size.bytes : 0), 0)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          删除容器不会删掉它的工作目录。下面按目录列出占用，容器已删除或无人使用的工作目录可以在这里清理；你自己的项目目录只展示，不会被删除。
        </p>
        <Button variant="outline" size="icon-sm" aria-label="刷新" title="刷新" onClick={() => void load()}>
          <RefreshCwIcon />
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {rows.length === 0 && !error ? <p className="text-sm text-muted-foreground">没有工作目录。</p> : null}
      {rows.length > 0 ? <p className="text-xs text-muted-foreground">{`${rows.length} 个目录，已算出的合计 ${formatBytes(known)}`}</p> : null}
      {rows.map((row) => (
        <div key={row.path} className="flex items-center gap-2 rounded-lg border p-2 text-sm" data-storage-row>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="min-w-0 truncate font-mono text-sm" title={row.path}>
                {row.path}
              </p>
              <Badge variant={row.status === "in-use" ? "default" : "secondary"} className="shrink-0">
                {STATUS_LABEL[row.status]}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {row.sessions.length
                ? row.sessions.map((session) => `${session.name}（${SESSION_STATE_LABEL[session.state]}）`).join("、")
                : "没有关联的会话"}
              {` · 修改于 ${formatDateTime(row.mtimeMs)}`}
              {row.managed ? "" : " · 非 MANYOYO 工作目录"}
            </p>
          </div>
          <div className="w-24 shrink-0 text-right text-sm tabular-nums">
            {sizes[row.path] === undefined && !row.managed ? (
              <Button variant="ghost" size="xs" onClick={() => void loadSize(row.path, generation.current)}>
                计算体积
              </Button>
            ) : (
              sizeText(sizes[row.path])
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`删除 ${row.path}`}
            title={row.deletable ? "删除" : row.managed ? "还有容器在用" : "不是 MANYOYO 创建的目录，不能删除"}
            disabled={!row.deletable}
            onClick={() => void remove(row)}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      {dialog}
    </div>
  )
}
