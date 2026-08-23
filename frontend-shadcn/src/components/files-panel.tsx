import * as React from "react"
import {
  ArrowUpIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  RefreshCwIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { apiGet, apiPost, apiPut, type FsEntry, type FsReadResult, type SessionSummary } from "@/lib/api"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PromptDialog } from "@/components/prompt-dialog"
import { Textarea } from "@/components/ui/textarea"

function joinPath(base: string, name: string): string {
  return `${base.replace(/\/$/, "")}/${name}`
}

export function FilesPanel({ activeSession }: { activeSession: SessionSummary | null }) {
  const [currentPath, setCurrentPath] = React.useState("/")
  const [parentPath, setParentPath] = React.useState("")
  const [entries, setEntries] = React.useState<FsEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [listError, setListError] = React.useState("")
  const [selectedPath, setSelectedPath] = React.useState("")
  const [fileData, setFileData] = React.useState<FsReadResult | null>(null)
  const [fileLoading, setFileLoading] = React.useState(false)
  const [fileError, setFileError] = React.useState("")
  const [newDialog, setNewDialog] = React.useState<"file" | "folder" | null>(null)
  const [editing, setEditing] = React.useState(false)
  const [editContent, setEditContent] = React.useState("")
  const [saving, setSaving] = React.useState(false)

  const loadList = React.useCallback(
    (path: string) => {
      if (!activeSession) return
      setLoading(true)
      setListError("")
      apiGet(
        `/api/sessions/${encodeURIComponent(activeSession.name)}/fs/list?path=${encodeURIComponent(path)}`
      )
        .then((data) => {
          setCurrentPath(String(data.path || path))
          setParentPath(typeof data.parentPath === "string" ? data.parentPath : "")
          setEntries(Array.isArray(data.entries) ? (data.entries as FsEntry[]) : [])
        })
        .catch((err) => {
          setListError(err instanceof Error ? err.message : "加载目录失败")
        })
        .finally(() => setLoading(false))
    },
    [activeSession]
  )

  React.useEffect(() => {
    setSelectedPath("")
    setFileData(null)
    setFileError("")
    setEditing(false)
    if (!activeSession) {
      setEntries([])
      return
    }
    loadList(activeSession.containerPath || "/")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.name])

  function openEntry(entry: FsEntry) {
    if (entry.kind === "directory") {
      loadList(entry.path)
      return
    }
    if (!activeSession) return
    setSelectedPath(entry.path)
    setFileData(null)
    setEditing(false)
    setFileLoading(true)
    setFileError("")
    apiGet(
      `/api/sessions/${encodeURIComponent(activeSession.name)}/fs/read?path=${encodeURIComponent(entry.path)}&full=1`
    )
      .then((data) => setFileData(data as unknown as FsReadResult))
      .catch((err) => setFileError(err instanceof Error ? err.message : "读取文件失败"))
      .finally(() => setFileLoading(false))
  }

  function startEditing() {
    if (!fileData) return
    setEditContent(fileData.content || "")
    setEditing(true)
  }

  async function handleSaveFile() {
    if (!activeSession || !selectedPath) return
    setSaving(true)
    setFileError("")
    try {
      await apiPut(`/api/sessions/${encodeURIComponent(activeSession.name)}/fs/write`, {
        path: selectedPath,
        content: editContent,
      })
      setFileData((prev) => (prev ? { ...prev, content: editContent, size: editContent.length } : prev))
      setEditing(false)
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  async function handleCreateEntry(name: string) {
    if (!activeSession || !newDialog) return
    if (!name.trim()) {
      throw new Error("名称不能为空")
    }
    const target = joinPath(currentPath, name)
    const endpoint = newDialog === "file" ? "fs/create" : "fs/mkdir"
    await apiPost(`/api/sessions/${encodeURIComponent(activeSession.name)}/${endpoint}`, {
      path: target,
    })
    loadList(currentPath)
  }

  if (!activeSession) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        请先在左侧选择一个容器 / AGENT
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b p-2">
        <Button
          variant="outline"
          size="icon-sm"
          disabled={!parentPath}
          onClick={() => loadList(parentPath)}
        >
          <ArrowUpIcon />
        </Button>
        <Input value={currentPath} readOnly className="h-8 font-mono text-xs" />
        <Button variant="outline" size="icon-sm" onClick={() => loadList(currentPath)}>
          <RefreshCwIcon />
        </Button>
        <Button variant="outline" size="icon-sm" onClick={() => setNewDialog("file")} title="新建文件">
          <FilePlusIcon />
        </Button>
        <Button variant="outline" size="icon-sm" onClick={() => setNewDialog("folder")} title="新建文件夹">
          <FolderPlusIcon />
        </Button>
      </div>

      {listError ? (
        <Alert variant="destructive" className="m-2">
          <AlertDescription>{listError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="h-full w-64 shrink-0 overflow-y-auto border-r">
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
                onClick={() => openEntry(entry)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                  selectedPath === entry.path && "bg-muted"
                )}
              >
                {entry.kind === "directory" ? (
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {selectedPath && fileData?.kind === "text" && fileData.editable ? (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b p-2">
              <span className="truncate font-mono text-xs text-muted-foreground">{selectedPath}</span>
              {editing ? (
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditing(false)} disabled={saving}>
                    取消
                  </Button>
                  <Button size="sm" onClick={handleSaveFile} disabled={saving}>
                    {saving ? "保存中..." : "保存"}
                  </Button>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={startEditing}>
                  编辑
                </Button>
              )}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {!selectedPath ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                选择左侧的文件查看内容
              </p>
            ) : null}
            {fileLoading ? (
              <p className="p-6 text-center text-sm text-muted-foreground">加载中...</p>
            ) : null}
            {fileError ? (
              <Alert variant="destructive">
                <AlertDescription>{fileError}</AlertDescription>
              </Alert>
            ) : null}
            {fileData && !fileLoading ? (
              <>
                {fileData.kind === "image" ? (
                  <img
                    src={`/api/sessions/${encodeURIComponent(activeSession.name)}/fs/raw?path=${encodeURIComponent(selectedPath)}`}
                    alt={selectedPath}
                    className="max-w-full rounded-md border"
                  />
                ) : fileData.kind === "binary" ? (
                  <p className="text-sm text-muted-foreground">
                    二进制文件，无法预览（{fileData.size} 字节）
                  </p>
                ) : editing ? (
                  <Textarea
                    value={editContent}
                    onChange={(event) => setEditContent(event.target.value)}
                    className="h-full min-h-64 resize-none font-mono text-xs"
                  />
                ) : (
                  <pre className="overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
                    {fileData.content}
                  </pre>
                )}
                {fileData.truncated ? (
                  <p className="mt-2 text-xs text-muted-foreground">内容过大，已截断显示</p>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>

      <PromptDialog
        open={newDialog !== null}
        onOpenChange={(next) => {
          if (!next) setNewDialog(null)
        }}
        title={newDialog === "file" ? "新建文件" : "新建文件夹"}
        description={`将在 ${currentPath} 下创建。`}
        label="名称"
        initialValue=""
        onSubmit={handleCreateEntry}
      />
    </div>
  )
}
