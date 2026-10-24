import * as React from "react"
import { FileIcon, FolderIcon, LinkIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { apiGet } from "@/lib/api"
import { formatBytes, formatDateTime } from "@/lib/format"

type Entry = { name: string; type: "dir" | "file" | "link"; size: number | null; mtimeMs: number | null }
type Listing = { entries: Entry[]; truncated: boolean }

// 只读查看磁盘占用页里某个目录的内容（宿主机上的目录，容器已删除也能看）；只能在这个目录里往下走
export function StorageBrowserDialog({ root, onClose }: { root: string | null; onClose: () => void }) {
  const [sub, setSub] = React.useState("")
  const [listing, setListing] = React.useState<Listing | null>(null)
  const [error, setError] = React.useState("")

  React.useEffect(() => {
    if (!root) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setListing(null)
      setError("")
    })
    apiGet(`/api/storage/files?path=${encodeURIComponent(root)}&sub=${encodeURIComponent(sub)}`)
      .then((data) => !cancelled && setListing(data as Listing))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "读取失败"))
    return () => {
      cancelled = true
    }
  }, [root, sub])

  function close() {
    setSub("")
    onClose()
  }

  const parts = sub ? sub.split("/") : []
  return (
    <Dialog open={root !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>查看目录内容</DialogTitle>
        </DialogHeader>
        <p className="truncate font-mono text-xs text-muted-foreground" title={root || ""}>
          {root}
        </p>
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <Button variant="ghost" size="xs" onClick={() => setSub("")}>
            根目录
          </Button>
          {parts.map((part, index) => (
            <React.Fragment key={index}>
              <span className="text-muted-foreground">/</span>
              <Button variant="ghost" size="xs" onClick={() => setSub(parts.slice(0, index + 1).join("/"))}>
                {part}
              </Button>
            </React.Fragment>
          ))}
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="min-h-24 overflow-y-auto rounded-lg border">
          {listing === null && !error ? (
            <div className="flex justify-center py-6">
              <Spinner className="size-5" />
            </div>
          ) : null}
          {listing && listing.entries.length === 0 ? <p className="p-3 text-sm text-muted-foreground">空目录。</p> : null}
          {listing?.entries.map((entry) => {
            const Icon = entry.type === "dir" ? FolderIcon : entry.type === "link" ? LinkIcon : FileIcon
            return (
              <div key={entry.name} className="flex items-center gap-2 border-b px-3 py-1.5 text-sm last:border-b-0" data-storage-entry>
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                {entry.type === "dir" ? (
                  <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => setSub(sub ? `${sub}/${entry.name}` : entry.name)}>
                    {entry.name}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                )}
                <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{formatBytes(entry.size, "")}</span>
                <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">{formatDateTime(entry.mtimeMs)}</span>
              </div>
            )
          })}
          {listing?.truncated ? <p className="p-3 text-xs text-muted-foreground">内容太多，只显示前 500 项。</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
