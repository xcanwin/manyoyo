import * as React from "react"
import { ArrowUpIcon, FolderIcon } from "lucide-react"

import { apiGet, apiPost, type DirectoryEntry } from "@/lib/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

export function DirectoryPickerDialog({
  open,
  onOpenChange,
  initialPath,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPath: string
  onSelect: (path: string) => void
}) {
  const [currentPath, setCurrentPath] = React.useState("")
  const [parentPath, setParentPath] = React.useState("")
  const [entries, setEntries] = React.useState<DirectoryEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [newDirName, setNewDirName] = React.useState("")

  const load = React.useCallback((path: string) => {
    setLoading(true)
    setError("")
    const params = new URLSearchParams()
    if (path) params.set("path", path)
    apiGet(`/api/fs/directories?${params.toString()}`)
      .then((data) => {
        setCurrentPath(String(data.currentPath || ""))
        setParentPath(typeof data.parentPath === "string" ? data.parentPath : "")
        setEntries(Array.isArray(data.entries) ? (data.entries as DirectoryEntry[]) : [])
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "加载目录失败")
      })
      .finally(() => setLoading(false))
  }, [])

  // 渲染期间对比 open 变化来清空新建目录名输入框，而不是在 effect 里同步
  // setState；实际目录加载放进 queueMicrotask，避免 effect 直接同步触达
  // load() 内部的 setLoading/setError
  const [prevOpen, setPrevOpen] = React.useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) setNewDirName("")
  }

  React.useEffect(() => {
    if (!open) return
    queueMicrotask(() => load(initialPath))
  }, [open, initialPath, load])

  async function handleCreateDir() {
    const name = newDirName.trim()
    if (!name || !currentPath) return
    setError("")
    try {
      const target = `${currentPath.replace(/\/$/, "")}/${name}`
      await apiPost("/api/fs/directories/mkdir", { path: target })
      setNewDirName("")
      load(target)
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建目录失败")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>选择目录</DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={!parentPath}
            onClick={() => load(parentPath)}
          >
            <ArrowUpIcon />
          </Button>
          <Input value={currentPath} readOnly className="h-8 font-mono text-xs" />
        </div>

        {error ? (
          <Alert variant="destructive" className="shrink-0">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {/* 固定高度而不是随目录/文件数量伸缩，避免弹窗跟着内容多少上下抖动 */}
        <div className="h-72 shrink-0 overflow-y-auto rounded-md border">
          <div className="flex flex-col gap-0.5 p-2">
            {loading ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">加载中...</div>
            ) : null}
            {!loading && entries.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">空目录</div>
            ) : null}
            {entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => load(entry.path)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          <Input
            placeholder="新建目录名称"
            value={newDirName}
            onChange={(event) => setNewDirName(event.target.value)}
            className="h-8"
          />
          <Button type="button" variant="outline" size="sm" onClick={handleCreateDir}>
            新建目录
          </Button>
        </div>

        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            onClick={() => {
              onSelect(currentPath)
              onOpenChange(false)
            }}
          >
            使用当前目录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
