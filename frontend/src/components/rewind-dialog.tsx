import * as React from "react"

import { apiPost, type ChatMessage } from "@/lib/api"
import { Hint } from "@/components/hint"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"

export type RewindScope = "both" | "conversation" | "files"
export type RewindResult = { prompt: string; images: string[]; scope: RewindScope; filesRestored: boolean }

type PreviewFile = { path: string; action: "modify" | "delete" | "restore" }
type PreviewFilesOk = { ok: true; total: number; modify: number; delete: number; restore: number; files: PreviewFile[] }
type Preview = {
  agentProgram: string
  // 这个 agent 能不能精确回退对话（目前只有 Claude）
  precise: boolean
  files: null | { ok: false; reason?: string } | PreviewFilesOk
}

const ACTION_LABELS: Record<PreviewFile["action"], string> = { modify: "改回去", delete: "删除", restore: "恢复" }

// “回退到这里”：先预览会动哪些文件，再选 恢复对话和文件 / 只恢复对话 / 只恢复文件（与 Claude 的 /rewind 一致）
export function RewindDialog({
  open,
  sessionName,
  message,
  onClose,
  onDone,
}: {
  open: boolean
  sessionName: string
  message: ChatMessage | null
  onClose: () => void
  onDone: (result: RewindResult) => void
}) {
  const [preview, setPreview] = React.useState<Preview | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState<RewindScope | null>(null)
  const [error, setError] = React.useState("")
  const base = `/api/sessions/${encodeURIComponent(sessionName)}`
  const messageId = message ? String(message.id) : ""

  React.useEffect(() => {
    if (!open || !messageId) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreview(null)
    setError("")
    setLoading(true)
    apiPost(`${base}/rewind/preview`, { messageId })
      .then((data) => {
        if (!cancelled) setPreview(data as unknown as Preview)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "读取预览失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, messageId, base])

  async function run(scope: RewindScope) {
    setBusy(scope)
    setError("")
    try {
      const data = await apiPost(`${base}/rewind`, { messageId, scope })
      onDone({
        prompt: String(data.prompt ?? ""),
        images: Array.isArray(data.images) ? (data.images as string[]) : [],
        scope,
        filesRestored: data.filesRestored === true,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "回退失败")
    } finally {
      setBusy(null)
    }
  }

  const files = preview?.files ?? null
  const okFiles: PreviewFilesOk | null = files !== null && files.ok === true ? files : null
  const filesOk = okFiles !== null
  const skippedTooLarge = message?.snapSkipped === "too-large"
  let filesText = ""
  if (preview) {
    if (filesOk) {
      filesText = okFiles.total === 0 ? "文件已经和那一轮开始前一样，不需要改动。" : `将改回 ${okFiles.modify} 个、删除 ${okFiles.delete} 个、恢复 ${okFiles.restore} 个文件。`
    } else if (skippedTooLarge) {
      filesText = "目录太大，这一轮没有拍文件快照，不能回退文件。"
    } else {
      filesText = "这一轮没有文件快照，不能回退文件。"
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <DialogContent size="md">
        <DialogTitle>回退到这里</DialogTitle>
        <DialogDescription>这条提示词会放回输入框，它和之后的内容会被撤销。</DialogDescription>
        {loading ? (
          <div className="flex justify-center py-2">
            <Spinner />
          </div>
        ) : null}
        {preview ? (
          <div className="flex flex-col gap-2">
            <p>{filesText}</p>
            {okFiles && okFiles.files.length > 0 ? (
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border bg-muted/30 p-2" data-rewind-files>
                {okFiles.files.map((file) => (
                  <li key={file.path} className="flex gap-2">
                    <Hint className="w-10 shrink-0">{ACTION_LABELS[file.action]}</Hint>
                    <Hint mono className="min-w-0 break-all">{file.path}</Hint>
                  </li>
                ))}
                {okFiles.total > 20 ? (
                  <li>
                    <Hint>…还有 {okFiles.total - 20} 个</Hint>
                  </li>
                ) : null}
              </ul>
            ) : null}
            {!preview.precise ? <p className="text-muted-foreground">这个 agent 不支持精确回退，对话会用剩下的聊天记录开新会话。</p> : null}
          </div>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter className="sm:flex-wrap">
          <Button variant="outline" disabled={busy !== null} onClick={onClose}>
            取消
          </Button>
          <Button variant="outline" disabled={!preview || busy !== null || !filesOk} onClick={() => void run("files")}>
            {busy === "files" ? <Spinner data-icon="inline-start" /> : null}
            只恢复文件
          </Button>
          <Button variant="outline" disabled={!preview || busy !== null} onClick={() => void run("conversation")}>
            {busy === "conversation" ? <Spinner data-icon="inline-start" /> : null}
            只恢复对话
          </Button>
          <Button disabled={!preview || busy !== null || !filesOk} onClick={() => void run("both")}>
            {busy === "both" ? <Spinner data-icon="inline-start" /> : null}
            恢复对话和文件
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
