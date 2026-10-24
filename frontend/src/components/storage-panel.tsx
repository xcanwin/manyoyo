import * as React from "react"
import { ArrowRightIcon, FolderOpenIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { StorageBrowserDialog } from "@/components/storage-browser-dialog"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"
import { apiDelete, apiGet } from "@/lib/api"
import { formatBytes, formatDateTime } from "@/lib/format"

type SessionState = "running" | "stopped" | "deleted"
type RowStatus = "in-use" | "history-only" | "unused"
type StorageRow = {
  empty: boolean
  path: string
  managed: boolean
  status: RowStatus
  sessions: { name: string; state: SessionState }[]
  mtimeMs: number
  deletable: boolean
}
type DeletedHistory = { name: string; bytes: number; updatedAt: string }
type SizeState = { bytes?: number; timedOut?: boolean; error?: boolean } | "loading" | undefined

const SESSION_STATE_LABEL: Record<SessionState, string> = { running: "运行中", stopped: "已停止", deleted: "已删除" }
const SIZE_CONCURRENCY = 2
type Filter = "all" | "empty"
const isCleanableEmpty = (row: StorageRow) => row.deletable && row.empty && row.sessions.length === 0

function sizeText(size: SizeState): string {
  if (size === "loading") return "计算中…"
  if (!size) return "—"
  if (size.timedOut) return "太大，超时"
  if (size.error || size.bytes === undefined) return "无法计算"
  return formatBytes(size.bytes)
}

// 宿主机目录占用：工作目录在容器删除后仍保留，这里按目录列出（同路径多个容器、同名容器换路径都不会混）。
// 只有 MANYOYO 自己建的工作目录、且没有容器在用，才能删除；你自己的项目目录只展示
type StoragePanelProps = {
  /** 当前页面所属的容器：在它出现的地方加“当前容器”标签 */
  currentContainer?: string
  /** 侧栏里有的容器（才能跳过去） */
  openableContainers?: string[]
  onOpenContainer?: (name: string) => void
}

export function StoragePanel({ currentContainer = "", openableContainers = [], onOpenContainer }: StoragePanelProps) {
  const [rows, setRows] = React.useState<StorageRow[] | null>(null)
  const [histories, setHistories] = React.useState<DeletedHistory[]>([])
  const [browsing, setBrowsing] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState<Filter>("all")
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

  const load = React.useCallback(async (keepError = false) => {
    const round = ++generation.current
    if (!keepError) setError("")
    try {
      const data = (await apiGet("/api/storage")) as { rows?: StorageRow[]; deletedHistories?: DeletedHistory[] }
      if (round !== generation.current) return
      const list = data.rows || []
      setRows(list)
      setHistories(data.deletedHistories || [])
      setSizes({})
      // 工作目录自动算体积（两个一组，du 很慢时不把磁盘打满）；你自己的项目目录点了再算
      const queue = list.filter((row) => row.managed && !row.empty).map((row) => row.path)
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
      await load(true)
    }
  }

  async function removeAllEmpty(targets: StorageRow[]) {
    const ok = await confirm({
      title: "删除空目录？",
      message: `共 ${targets.length} 个没有关联容器的空目录会被删除（只删空目录，里面有任何文件的不会动）。`,
      confirmLabel: "删除空目录",
    })
    if (!ok) return
    let failed = 0
    for (const row of targets) {
      try {
        await apiDelete("/api/storage/dirs", { path: row.path, emptyOnly: true })
      } catch {
        failed += 1
      }
    }
    if (failed) setError(`有 ${failed} 个目录没能删除（可能刚被使用或已不是空的）`)
    await load(failed > 0)
  }

  async function removeHistories(targets: DeletedHistory[], title: string, message: string) {
    if (!(await confirm({ title, message, confirmLabel: "清理" }))) return
    try {
      for (const item of targets) await apiDelete("/api/storage/histories", { name: item.name })
    } catch (err) {
      setError(err instanceof Error ? err.message : "清理失败")
      await load(true)
      return
    }
    await load()
  }

  if (rows === null) {
    return (
      <div className="flex justify-center py-6">
        <Spinner className="size-5" />
      </div>
    )
  }

  const historyTotal = histories.reduce((sum, item) => sum + item.bytes, 0)
  const known = Object.values(sizes).reduce((sum, size) => sum + (size && size !== "loading" && size.bytes ? size.bytes : 0), 0)
  const emptyRows = rows.filter(isCleanableEmpty)
  const shown = filter === "empty" ? emptyRows : rows
  const openable = new Set(openableContainers)
  // 容器名后面：当前容器标签 + 进入该容器的按钮（侧栏里没有这个容器时不显示按钮）
  const containerTags = (name: string) => (
    <>
      {name === currentContainer ? <Badge className="ml-2">当前容器</Badge> : null}
      {onOpenContainer && openable.has(name) ? (
        <Button variant="ghost" size="icon-xs" className="ml-1 align-middle" aria-label={`进入 ${name}`} title="进入该容器" onClick={() => onOpenContainer(name)}>
          <ArrowRightIcon />
        </Button>
      ) : null}
    </>
  )
  const TH = "px-3 py-2 text-left text-xs font-normal text-muted-foreground whitespace-nowrap"
  const TD = "px-3 py-2 align-top"

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
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={filter === "all" ? "secondary" : "outline"} size="sm" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          {`全部有${rows.length}个`}
        </Button>
        <Button variant={filter === "empty" ? "secondary" : "outline"} size="sm" aria-pressed={filter === "empty"} onClick={() => setFilter("empty")}>
          {`无关联容器且为空有${emptyRows.length}个`}
        </Button>
        {filter === "empty" && emptyRows.length > 0 ? (
          <Button variant="outline" size="sm" onClick={() => void removeAllEmpty(emptyRows)}>
            删除空目录
          </Button>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">{`已算出的占用合计 ${formatBytes(known)}`}</span>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[48rem] border-collapse text-sm">
          <thead className="border-b bg-muted/50">
            <tr>
              <th className={TH}>宿主机目录</th>
              <th className={TH}>关联容器</th>
              <th className={TH}>修改时间</th>
              <th className={`${TH} text-right`}>占用</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td className={`${TD} text-muted-foreground`} colSpan={4}>
                  {error ? "" : filter === "empty" ? "没有符合条件的目录。" : "没有工作目录。"}
                </td>
              </tr>
            ) : null}
            {shown.map((row) => (
              <tr key={row.path} className="border-b last:border-b-0 hover:bg-muted/40" data-storage-row>
                <td className={TD}>
                  <span className="font-mono break-all">{row.path}</span>
                  {row.managed ? "" : <span className="ml-2 text-xs text-muted-foreground">非 MANYOYO 工作目录</span>}
                  <span className="ml-2 whitespace-nowrap align-middle">
                    <Button variant="ghost" size="icon-xs" aria-label={`查看 ${row.path}`} title="查看宿主机目录" onClick={() => setBrowsing(row.path)}>
                      <FolderOpenIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`删除 ${row.path}`}
                      title={row.deletable ? "删除宿主机目录" : row.managed ? "还有容器在用" : "不是 MANYOYO 创建的目录，不能删除"}
                      disabled={!row.deletable}
                      onClick={() => void remove(row)}
                    >
                      <Trash2Icon />
                    </Button>
                  </span>
                </td>
                <td className={TD}>
                  {row.sessions.length
                    ? row.sessions.map((session) => (
                        <div key={session.name}>
                          {`${session.name}（${SESSION_STATE_LABEL[session.state]}）`}
                          {containerTags(session.name)}
                        </div>
                      ))
                    : null}
                </td>
                <td className={`${TD} whitespace-nowrap text-muted-foreground`}>{formatDateTime(row.mtimeMs)}</td>
                <td className={`${TD} text-right whitespace-nowrap tabular-nums`}>
                  {row.empty ? (
                    <span className="text-muted-foreground">空目录</span>
                  ) : sizes[row.path] === undefined && !row.managed ? (
                    <Button variant="ghost" size="xs" onClick={() => void loadSize(row.path, generation.current)}>
                      计算体积
                    </Button>
                  ) : (
                    sizeText(sizes[row.path])
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2 border-t pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">已删除容器的对话历史</p>
          {histories.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void removeHistories(histories, "清理全部已删除容器的历史？", `共 ${histories.length} 份（${formatBytes(historyTotal)}），对话记录会被永久删除。`)}
            >
              清理全部
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">容器删掉后，网页里的对话记录还在。确认不再需要的可以清理；容器还在的不会出现在这里。</p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full border-collapse text-sm">
            <thead className="border-b bg-muted/50">
              <tr>
                <th className={TH}>容器</th>
                <th className={TH}>最后更新</th>
                <th className={`${TH} text-right`}>占用</th>
                <th className={`${TH} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {histories.length === 0 ? (
                <tr>
                  <td className={`${TD} text-muted-foreground`} colSpan={4}>
                    没有。
                  </td>
                </tr>
              ) : null}
              {histories.map((item) => (
                <tr key={item.name} className="border-b last:border-b-0 hover:bg-muted/40" data-storage-history>
                  <td className={`${TD} break-all`}>
                    {item.name}
                    {containerTags(item.name)}
                  </td>
                  <td className={`${TD} whitespace-nowrap text-muted-foreground`}>{formatDateTime(item.updatedAt)}</td>
                  <td className={`${TD} text-right whitespace-nowrap tabular-nums`}>{formatBytes(item.bytes)}</td>
                  <td className={`${TD} text-right`}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`清理 ${item.name}`}
                      onClick={() => void removeHistories([item], "清理这份历史？", `${item.name}\n对话记录会被永久删除。`)}
                    >
                      <Trash2Icon />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <StorageBrowserDialog root={browsing} onClose={() => setBrowsing(null)} />
      {dialog}
    </div>
  )
}
