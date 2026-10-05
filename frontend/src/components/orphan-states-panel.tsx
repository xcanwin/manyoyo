import * as React from "react"
import { Trash2Icon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"
import { apiDelete, apiGet } from "@/lib/api"
import { formatDateTime } from "@/lib/format"

type Orphan = { id: string; name: string; createdAt: string }

// 状态目录（~/.manyoyo/containers/<id>）里没有对应容器的残留：例如容器被运行时直接删掉、或切换过容器运行时。
// 不会自动删除（避免切换运行时时误删），在这里逐个确认后清理。
export function OrphanStatesPanel() {
  const [orphans, setOrphans] = React.useState<Orphan[] | null>(null)
  const [error, setError] = React.useState("")
  const { confirm, dialog } = useConfirmDialog()

  const load = React.useCallback(async () => {
    setError("")
    try {
      const data = await apiGet("/api/containers/orphans")
      setOrphans((data.orphans || []) as Orphan[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取失败")
      setOrphans([])
    }
  }, [])

  React.useEffect(() => {
    queueMicrotask(() => void load())
  }, [load])

  async function remove(orphan: Orphan) {
    const ok = await confirm({
      title: "删除残留状态目录？",
      message: `${orphan.name || orphan.id}\n里面的环境变量、自启动脚本和网络规则会被永久删除。`,
      confirmLabel: "删除",
    })
    if (!ok) return
    try {
      await apiDelete(`/api/containers/orphans/${orphan.id}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败")
    }
  }

  if (orphans === null) {
    return (
      <div className="flex justify-center py-6">
        <Spinner className="size-5" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        容器管理数据（环境变量、自启动、网络规则）按容器单独保存。下面是已经找不到对应容器的残留，确认不再需要后可以删除。
      </p>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {orphans.length === 0 && !error ? <p className="text-sm text-muted-foreground">没有残留。</p> : null}
      {orphans.map((orphan) => (
        <div key={orphan.id} className="flex items-center gap-2 rounded-lg border p-2 text-sm">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{orphan.name || "（未命名）"}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {orphan.id}
              {orphan.createdAt ? ` · 创建于 ${formatDateTime(orphan.createdAt)}` : ""}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label={`删除 ${orphan.name || orphan.id}`} onClick={() => void remove(orphan)}>
            <Trash2Icon />
          </Button>
        </div>
      ))}
      {dialog}
    </div>
  )
}
