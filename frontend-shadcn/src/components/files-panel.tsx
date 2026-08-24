import * as React from "react"
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  Link2Icon,
  RefreshCwIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { apiGet, apiPost, apiPut, type FsEntry, type FsReadResult, type SessionSummary } from "@/lib/api"
import { sanitizeDisplayText } from "@/lib/sanitize"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"
import { useIsMobile } from "@/hooks/use-mobile"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { CodeMirrorEditor } from "@/components/code-mirror-editor"
import { Input } from "@/components/ui/input"
import { MarkdownContent } from "@/components/markdown-content"
import { PromptDialog } from "@/components/prompt-dialog"

// 与旧版前端 file-browser.js 的 FILE_EDIT_MAX_BYTES 对齐：>=2MB 的文件只提供只读全量预览
const FILE_EDIT_MAX_BYTES = 2 * 1024 * 1024

function joinPath(base: string, name: string): string {
  return `${base.replace(/\/$/, "")}/${name}`
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size)) return "未知大小"
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

// 与旧版前端 resolveMarkdownImageUrl 对齐：借一个假的 internal origin 把相对路径解析成
// 规范化的绝对路径，再拼到容器文件读取接口 fs/raw
function resolveMarkdownImageUrl(sessionName: string, basePath: string, relativeHref: string): string {
  try {
    const lastSlash = basePath.lastIndexOf("/")
    const baseDir = lastSlash >= 0 ? basePath.slice(0, lastSlash + 1) : "/"
    const resolvedPath = new URL(relativeHref, "http://manyoyo-internal" + baseDir).pathname
    return `/api/sessions/${encodeURIComponent(sessionName)}/fs/raw?path=${encodeURIComponent(resolvedPath)}`
  } catch {
    return ""
  }
}

// 只处理最常见的行内图片写法 ![alt](href "title")，引用式图片不在预览场景考虑范围内
function rewriteRelativeImageLinks(markdownText: string, resolver: (href: string) => string): string {
  return markdownText.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g,
    (match, alt: string, href: string, titlePart = "") => {
      if (/^(?:https?:|data:|#)/i.test(href)) return match
      const resolved = resolver(href)
      return resolved ? `![${alt}](${resolved}${titlePart})` : match
    }
  )
}

export function FilesPanel({ activeSession }: { activeSession: SessionSummary | null }) {
  const historyOnly = activeSession?.status === "history"
  const { confirm, dialog: confirmDialog } = useConfirmDialog()
  const isMobile = useIsMobile()
  // 与旧版前端的移动端主从视图对齐：先看目录列表，点开文件后再切到内容页
  const [mobilePane, setMobilePane] = React.useState<"list" | "detail">("list")

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
  const [markdownViewMode, setMarkdownViewMode] = React.useState<"source" | "rendered">("rendered")
  const [previewReadOnly, setPreviewReadOnly] = React.useState(false)

  const loadList = React.useCallback(
    (path: string) => {
      if (!activeSession || historyOnly) return
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
    [activeSession, historyOnly]
  )

  React.useEffect(() => {
    setSelectedPath("")
    setFileData(null)
    setFileError("")
    setEditing(false)
    setMobilePane("list")
    if (!activeSession || historyOnly) {
      setEntries([])
      return
    }
    loadList(activeSession.containerPath || "/")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.name, historyOnly])

  async function fetchFile(path: string, readOnly: boolean) {
    if (!activeSession) return
    setMobilePane("detail")
    setSelectedPath(path)
    setFileData(null)
    setEditing(false)
    setMarkdownViewMode("rendered")
    setPreviewReadOnly(readOnly)
    setFileLoading(true)
    setFileError("")
    try {
      const data = (await apiGet(
        `/api/sessions/${encodeURIComponent(activeSession.name)}/fs/read?path=${encodeURIComponent(path)}&full=1`
      )) as unknown as FsReadResult
      setFileData(data)
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "读取文件失败")
    } finally {
      setFileLoading(false)
    }
  }

  async function openRegularFile(entry: FsEntry) {
    const size = Number(entry.size)
    let readOnly = false
    if (Number.isFinite(size) && size >= FILE_EDIT_MAX_BYTES) {
      const proceed = await confirm({
        title: "大文件确认",
        message: `文件较大（${formatBytes(size)}），继续后将以只读方式全量预览，无法保存。是否继续？`,
        confirmLabel: "继续预览",
      })
      if (!proceed) return
      readOnly = true
    }
    await fetchFile(entry.path, readOnly)
  }

  async function openEntry(entry: FsEntry) {
    if (entry.kind === "symlink") {
      const safeName = sanitizeDisplayText(entry.name)
      const message = entry.symlinkTarget
        ? `"${safeName}" 是符号链接，实际指向：\n${sanitizeDisplayText(entry.symlinkTarget)}\n\n是否继续访问？`
        : `"${safeName}" 是一个无法解析的符号链接（可能已损坏），是否仍要尝试访问？`
      const proceed = await confirm({ title: "符号链接确认", message, confirmLabel: "继续访问" })
      if (!proceed) return
      if (entry.symlinkTargetKind === "directory") {
        loadList(entry.path)
        return
      }
      await openRegularFile(entry)
      return
    }
    if (entry.kind === "directory") {
      loadList(entry.path)
      return
    }
    await openRegularFile(entry)
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

  if (historyOnly) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-sm text-muted-foreground">
        <p className="font-medium text-foreground">容器不可用</p>
        <p>当前会话只有历史记录，没有可访问的运行中容器。</p>
      </div>
    )
  }

  const isMarkdown = fileData?.kind === "text" && fileData.language === "markdown"
  const isEditable = Boolean(fileData?.kind === "text" && fileData.editable && !previewReadOnly)

  const showListPane = !isMobile || mobilePane === "list"
  const showDetailPane = !isMobile || mobilePane === "detail"

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {showListPane ? (
        <div className="flex shrink-0 items-center gap-2 border-b p-2">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={!parentPath}
            onClick={() => loadList(parentPath)}
          >
            <ArrowUpIcon />
          </Button>
          <Input value={sanitizeDisplayText(currentPath)} readOnly className="h-8 font-mono text-xs" />
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
      ) : null}

      {listError && showListPane ? (
        <Alert variant="destructive" className="m-2">
          <AlertDescription>{listError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className={cn("h-full w-64 shrink-0 overflow-y-auto border-r", isMobile && "w-full", !showListPane && "hidden")}>
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
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-foreground/8",
                  selectedPath === entry.path && "bg-foreground/12 font-medium"
                )}
                title={
                  entry.kind === "symlink" && entry.symlinkTarget
                    ? `符号链接 → ${sanitizeDisplayText(entry.symlinkTarget)}`
                    : sanitizeDisplayText(entry.name)
                }
              >
                {entry.kind === "directory" ? (
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : entry.kind === "symlink" ? (
                  <Link2Icon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{sanitizeDisplayText(entry.name)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !showDetailPane && "hidden")}>
          {selectedPath ? (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b p-2">
              <div className="flex min-w-0 items-center gap-1.5">
                {isMobile ? (
                  <Button variant="ghost" size="icon-sm" onClick={() => setMobilePane("list")}>
                    <ArrowLeftIcon />
                  </Button>
                ) : null}
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {sanitizeDisplayText(selectedPath)}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isMarkdown && !editing ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setMarkdownViewMode((mode) => (mode === "source" ? "rendered" : "source"))
                    }
                  >
                    {markdownViewMode === "source" ? "查看渲染" : "查看源码"}
                  </Button>
                ) : null}
                {isEditable ? (
                  editing ? (
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
                  )
                ) : null}
              </div>
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
                  <CodeMirrorEditor
                    value={editContent}
                    language={fileData.language || "text"}
                    readOnly={false}
                    onChange={setEditContent}
                  />
                ) : isMarkdown && markdownViewMode === "rendered" ? (
                  <MarkdownContent
                    content={rewriteRelativeImageLinks(fileData.content || "", (href) =>
                      resolveMarkdownImageUrl(activeSession.name, selectedPath, href)
                    )}
                  />
                ) : (
                  <CodeMirrorEditor
                    value={fileData.content || ""}
                    language={fileData.language || "text"}
                    readOnly
                  />
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
        description={`将在 ${sanitizeDisplayText(currentPath)} 下创建。`}
        label="名称"
        initialValue=""
        onSubmit={handleCreateEntry}
      />
      {confirmDialog}
    </div>
  )
}
