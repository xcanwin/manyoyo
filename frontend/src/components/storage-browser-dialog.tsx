import * as React from "react"
import { FileIcon, FolderIcon, LinkIcon } from "lucide-react"

import { DataTable, type DataColumn } from "@/components/data-table"
import { Hint } from "@/components/hint"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { apiGet } from "@/lib/api"
import { formatBytes, formatDateTime } from "@/lib/format"

type Entry = {
  name: string
  type: "dir" | "file" | "link"
  size: number | null
  mtimeMs: number | null
}
type Listing = { entries: Entry[]; truncated: boolean }

// 只读查看磁盘占用页里某个目录的内容（宿主机上的目录，容器已删除也能看）；只能在这个目录里往下走
export function StorageBrowserDialog({
  root,
  onClose,
}: {
  root: string | null
  onClose: () => void
}) {
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
    apiGet(
      `/api/storage/files?path=${encodeURIComponent(root)}&sub=${encodeURIComponent(sub)}`
    )
      .then((data) => !cancelled && setListing(data as Listing))
      .catch(
        (err) =>
          !cancelled &&
          setError(err instanceof Error ? err.message : "读取失败")
      )
    return () => {
      cancelled = true
    }
  }, [root, sub])

  function close() {
    setSub("")
    onClose()
  }

  const parts = sub ? sub.split("/") : []
  const columns: DataColumn<Entry>[] = [
    {
      key: "name",
      header: "名称",
      primary: true,
      render: (entry) => {
        const Icon =
          entry.type === "dir"
            ? FolderIcon
            : entry.type === "link"
              ? LinkIcon
              : FileIcon
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            {entry.type === "dir" ? (
              <button
                type="button"
                className="min-w-0 truncate text-left hover:underline"
                onClick={() =>
                  setSub(sub ? `${sub}/${entry.name}` : entry.name)
                }
              >
                {entry.name}
              </button>
            ) : (
              <span className="min-w-0 truncate">{entry.name}</span>
            )}
          </span>
        )
      },
    },
    {
      key: "size",
      header: "大小",
      render: (entry) => <Hint>{formatBytes(entry.size, "")}</Hint>,
    },
    {
      key: "mtime",
      header: "修改时间",
      render: (entry) => <Hint>{formatDateTime(entry.mtimeMs)}</Hint>,
    },
  ]

  return (
    <Dialog open={root !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>查看目录内容</DialogTitle>
          <DialogDescription className="truncate font-mono" title={root || ""}>
            {root}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setSub("")}>
              根目录
            </Button>
            {parts.map((part, index) => (
              <React.Fragment key={index}>
                <span className="text-muted-foreground">/</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSub(parts.slice(0, index + 1).join("/"))}
                >
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
          {error ? null : (
            <DataTable
              label="目录内容"
              columns={columns}
              rows={listing?.entries ?? []}
              loading={listing === null}
              rowKey={(entry) => entry.name}
              rowTestId={(entry) => `storage-entry-${entry.name}`}
              empty={{ title: "空目录" }}
            />
          )}
          {listing?.truncated ? <Hint>内容太多，只显示前 500 项。</Hint> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
