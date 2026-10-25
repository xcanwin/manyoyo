import * as React from "react"
import { ArrowUpIcon, FolderIcon } from "lucide-react"
import { Hint } from "@/components/hint"

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

  // fallbackToHome：初始目录不存在（比如新建容器预填的工作目录还没建）时，不报错，直接回到用户主目录
  const load = React.useCallback((path: string, fallbackToHome = false) => {
    setLoading(true)
    setError("")
    const fetchDir = (target: string) => {
      const params = new URLSearchParams()
      if (target) params.set("path", target)
      return apiGet(`/api/fs/directories?${params.toString()}`)
    }
    fetchDir(path)
      .catch((err) => (fallbackToHome && path ? fetchDir("") : Promise.reject(err)))
      .then((data) => {
        setCurrentPath(String(data.currentPath || ""))
        setParentPath(
          typeof data.parentPath === "string" ? data.parentPath : ""
        )
        setEntries(
          Array.isArray(data.entries) ? (data.entries as DirectoryEntry[]) : []
        )
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
    queueMicrotask(() => load(initialPath, true))
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
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>选择目录</DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="上一级目录"
            title="上一级目录"
            disabled={!parentPath}
            onClick={() => load(parentPath)}
          >
            <ArrowUpIcon />
          </Button>
          <Input value={currentPath} readOnly className="font-mono" />
        </div>

        {error ? (
          <Alert variant="destructive" className="shrink-0">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {/* 固定高度而不是随目录/文件数量伸缩，避免弹窗跟着内容多少上下抖动 */}
        <div className="h-72 shrink-0 overflow-y-auto rounded-md border">
          <div className="flex flex-col gap-0.5 p-2">
            {loading ? <Hint className="px-2 py-1.5">加载中...</Hint> : null}
            {!loading && entries.length === 0 ? (
              <Hint className="px-2 py-1.5">空目录</Hint>
            ) : null}
            {entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => load(entry.path)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
              >
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
          </div>
        </div>

        <Hint className="shrink-0">
          尽量新建一个空白目录并选择它，避免容器看到过多的宿主机文件。
        </Hint>
        <div className="flex shrink-0 gap-2">
          <Input
            placeholder="新建目录名称"
            value={newDirName}
            onChange={(event) => setNewDirName(event.target.value)}
          />
          <Button type="button" variant="outline" onClick={handleCreateDir}>
            新建目录
          </Button>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
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
