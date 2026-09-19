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
import { useResizableWidth } from "@/hooks/use-resizable-width"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { CodeMirrorEditor } from "@/components/code-mirror-editor"
import { MarkdownContent } from "@/components/markdown-content"
import { PromptDialog } from "@/components/prompt-dialog"
import { ResizeHandle } from "@/components/resize-handle"
import { Spinner } from "@/components/ui/spinner"

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

// 单行只读路径展示：外观和 Input 一致（边框/圆角/背景），但用可滚动的 div 实现——
// 原生 input 在移动端对 readOnly 内容的横向触摸滑动支持并不可靠，div + overflow-x-auto
// 是标准的内容滚动，各平台表现一致；no-scrollbar 只是不露出滚动条，不影响滑动能力
function PathBar({ value, className }: { value: string; className?: string }) {
  return (
    <div
      className={cn(
        "no-scrollbar flex h-8 w-full min-w-0 items-center overflow-x-auto rounded-lg border border-input bg-transparent px-2.5 dark:bg-input/30",
        className
      )}
    >
      <span className="w-max shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground">
        {value}
      </span>
    </div>
  )
}

// 有未保存修改时暴露给外层守卫（切换 agent / 新建 agent / 切换顶部标签）：
// 文件名用于弹窗提示，save 触发真正的保存并返回是否成功
export type FilesEditorState = {
  fileName: string
  save: () => Promise<boolean>
}

export function FilesPanel({
  activeSession,
  editorStateRef,
  confirmLeaveIfDirty,
  onPreviewHtml,
}: {
  activeSession: SessionSummary | null
  editorStateRef?: React.RefObject<FilesEditorState | null>
  confirmLeaveIfDirty: () => Promise<boolean>
  onPreviewHtml?: (title: string, code: string) => void
}) {
  const historyOnly = activeSession?.status === "history"
  const { confirm, dialog: confirmDialog } = useConfirmDialog()
  const isMobile = useIsMobile()
  // 与旧版前端的移动端主从视图对齐：先看目录列表，点开文件后再切到内容页
  const [mobilePane, setMobilePane] = React.useState<"list" | "detail">("list")
  const { width: listWidth, dragging: listDragging, onHandlePointerDown } = useResizableWidth({
    storageKey: "manyoyo:files-list-width",
    defaultWidth: 256,
    min: 180,
    max: 480,
  })

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
  // 只有"编辑/预览"两种模式：预览对纯文本文件是只读展示，对 md 是渲染视图，
  // 对 html 是触发右侧沙箱面板（内容区本身还是展示只读源码）
  const [mode, setMode] = React.useState<"edit" | "preview">("preview")
  // null 表示还没进入过编辑态、没有草稿；一旦进入编辑就固定是 string，取消编辑清回 null
  const [editContent, setEditContent] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [previewReadOnly, setPreviewReadOnly] = React.useState(false)

  const isDirty = editContent !== null && fileData !== null && editContent !== (fileData.content || "")

  const handleSaveFileRef = React.useRef<() => Promise<boolean>>(() => Promise.resolve(false))
  // 用稳定的函数引用委托给 handleSaveFileRef.current，这样外层守卫触发保存时
  // 总能拿到当次渲染最新的 selectedPath / editContent，而不是 effect 创建时的旧闭包
  const saveCurrentFile = React.useCallback(() => handleSaveFileRef.current(), [])

  // 把"编辑器有未保存修改"同步给外层 ref，供新建/切换 AGENT、切换顶部标签页时读取，
  // 避免不小心一键跳走丢内容
  React.useEffect(() => {
    if (!editorStateRef) return
    editorStateRef.current = isDirty
      ? { fileName: selectedPath.split("/").pop() || selectedPath, save: saveCurrentFile }
      : null
    return () => {
      editorStateRef.current = null
    }
  }, [isDirty, selectedPath, editorStateRef, saveCurrentFile])
  React.useEffect(() => {
    if (mode !== "edit") return
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        handleSaveFileRef.current()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [mode])

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

  // 渲染期间对比"当前会话签名"来重置文件面板本地状态，而不是在 effect 里
  // 同步 setState；真正的目录加载放进下面的 effect（经 queueMicrotask 转发）
  const filesSignature = `${activeSession?.name ?? ""}:${historyOnly}`
  const [prevFilesSignature, setPrevFilesSignature] = React.useState(filesSignature)
  if (filesSignature !== prevFilesSignature) {
    setPrevFilesSignature(filesSignature)
    setSelectedPath("")
    setFileData(null)
    setFileError("")
    setEditContent(null)
    setMode("preview")
    setMobilePane("list")
    if (!activeSession || historyOnly) setEntries([])
  }

  React.useEffect(() => {
    if (!activeSession || historyOnly) return
    queueMicrotask(() => loadList(activeSession.containerPath || "/"))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.name, historyOnly])

  // forceEdit：新建出来的文件即使是 md/html 也直接进编辑态——刚建的是空文件，
  // 预览一个空白页没有意义，用户的意图就是要写内容
  async function fetchFile(path: string, readOnly: boolean, forceEdit = false) {
    if (!activeSession) return
    if (!(await confirmLeaveIfDirty())) return
    setMobilePane("detail")
    setSelectedPath(path)
    setFileData(null)
    setEditContent(null)
    setMode("preview")
    setPreviewReadOnly(readOnly)
    setFileLoading(true)
    setFileError("")
    try {
      const data = (await apiGet(
        `/api/sessions/${encodeURIComponent(activeSession.name)}/fs/read?path=${encodeURIComponent(path)}&full=1`
      )) as unknown as FsReadResult
      setFileData(data)
      const editable = Boolean(data.kind === "text" && data.editable && !readOnly)
      const isMd = data.kind === "text" && data.language === "markdown"
      const isHtmlFile = data.kind === "text" && data.language === "html"
      if (editable && (forceEdit || (!isMd && !isHtmlFile))) {
        // 纯文本文件打开即可编辑，不用先点一次"编辑"
        setEditContent(data.content || "")
        setMode("edit")
      } else {
        setMode("preview")
        if (isHtmlFile && onPreviewHtml) {
          onPreviewHtml(path.split("/").pop() || path, data.content || "")
        }
      }
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

  function enterEditMode() {
    if (!fileData || !isEditable) return
    setEditContent((prev) => (prev === null ? fileData.content || "" : prev))
    setMode("edit")
  }

  function enterPreviewMode() {
    setMode("preview")
    if (isHtml && onPreviewHtml) {
      onPreviewHtml(selectedPath.split("/").pop() || selectedPath, editContent ?? fileData?.content ?? "")
    }
  }

  async function handleSaveFile(): Promise<boolean> {
    if (!activeSession || !selectedPath || saving || editContent === null) return false
    setSaving(true)
    setFileError("")
    try {
      await apiPut(`/api/sessions/${encodeURIComponent(activeSession.name)}/fs/write`, {
        path: selectedPath,
        content: editContent,
      })
      // 保存后继续停留在编辑态：CodeMirrorEditor 的 value 没变（就是刚保存的 editContent），
      // 内容同步 effect 会因为 doc 已经等于 value 而直接跳过，光标/选区不受影响
      const savedContent = editContent
      setFileData((prev) => (prev ? { ...prev, content: savedContent, size: savedContent.length } : prev))
      return true
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "保存失败")
      return false
    } finally {
      setSaving(false)
    }
  }
  React.useEffect(() => {
    handleSaveFileRef.current = handleSaveFile
  })

  function handleCancelEdit() {
    setEditContent(null)
    setMode("preview")
    if (isHtml && onPreviewHtml) {
      onPreviewHtml(selectedPath.split("/").pop() || selectedPath, fileData?.content || "")
    }
  }

  async function handleMobileBackToList() {
    if (!(await confirmLeaveIfDirty())) return
    setMobilePane("list")
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
    // 新建文件的意图就是要往里写东西：直接打开并进入编辑态，
    // 省掉"回列表里再找一遍刚建的文件、点开、再点编辑"这三步
    if (newDialog === "file") {
      await fetchFile(target, false, true)
    }
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
  const isHtml = fileData?.kind === "text" && fileData.language === "html"
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
            title="返回上一层目录"
          >
            <ArrowUpIcon />
          </Button>
          <PathBar value={sanitizeDisplayText(currentPath)} />
          <Button variant="outline" size="icon-sm" onClick={() => loadList(currentPath)} title="刷新">
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
        <div
          style={isMobile ? undefined : { width: listWidth }}
          className={cn("h-full shrink-0 overflow-y-auto border-r", isMobile && "w-full", !showListPane && "hidden")}
        >
          <div className="flex flex-col gap-0.5 p-2">
            {loading ? (
              <div className="flex h-32 items-center justify-center">
                <Spinner className="size-5" />
              </div>
            ) : (
              <>
                {entries.length === 0 ? (
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
              </>
            )}
          </div>
        </div>

        {isMobile ? null : (
          <ResizeHandle onPointerDown={onHandlePointerDown} dragging={listDragging} />
        )}

        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !showDetailPane && "hidden")}>
          {selectedPath ? (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b p-2">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                {isMobile ? (
                  <Button variant="ghost" size="icon-sm" onClick={handleMobileBackToList} title="返回列表">
                    <ArrowLeftIcon />
                  </Button>
                ) : null}
                <PathBar value={sanitizeDisplayText(selectedPath)} />
              </div>
              {fileData?.kind === "text" ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant={mode === "edit" ? "secondary" : "outline"}
                    size="sm"
                    disabled={!isEditable}
                    onClick={enterEditMode}
                  >
                    编辑
                  </Button>
                  <Button
                    variant={mode === "preview" ? "secondary" : "outline"}
                    size="sm"
                    onClick={enterPreviewMode}
                  >
                    预览
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCancelEdit}
                    disabled={!(mode === "edit" && isDirty) || saving}
                  >
                    取消
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSaveFile}
                    disabled={!(mode === "edit" && isDirty) || saving}
                  >
                    {saving ? "保存中..." : "保存"}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {!selectedPath ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                选择左侧的文件查看内容
              </p>
            ) : null}
            {fileLoading ? (
              <div className="flex h-32 items-center justify-center">
                <Spinner className="size-5" />
              </div>
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
                ) : mode === "edit" ? (
                  <CodeMirrorEditor
                    value={editContent ?? fileData.content ?? ""}
                    language={fileData.language || "text"}
                    readOnly={false}
                    onChange={setEditContent}
                  />
                ) : isMarkdown ? (
                  <MarkdownContent
                    content={rewriteRelativeImageLinks(editContent ?? fileData.content ?? "", (href) =>
                      resolveMarkdownImageUrl(activeSession.name, selectedPath, href)
                    )}
                  />
                ) : (
                  <CodeMirrorEditor
                    value={editContent ?? fileData.content ?? ""}
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
