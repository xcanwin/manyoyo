import * as React from "react"
import { DownloadIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Hint } from "@/components/hint"
import { useConfirmDialog } from "@/hooks/use-confirm-dialog"
import { formatBytes, formatDateTime } from "@/lib/format"
import {
  buildImportPlan,
  cancelJob,
  confirmFromChecked,
  deleteServerExport,
  friendlyError,
  inspectLocalFile,
  inspectServerFile,
  listServerExports,
  riskItems,
  startServerImport,
  startUploadImport,
  uploadImportFile,
  type ImportContainer,
  type ImportInspect,
  type ImportPlanEntry,
  type ServerExportFile,
} from "@/lib/transfer"

type Source = { kind: "local"; file: File } | { kind: "server"; name: string }

type Edit = { name: string; remark: string; hostPath: string; imageMode: "same" | "default"; checked: Set<string> }

const REMARK_MAX = 200

// 导入：选文件 → 只读开头看清单 → 改名 / 选目录 / 确认风险 → 开始。
// 开始后导入在后台跑，进度和结果交给进度弹窗；上传中取消或失败会自动撤销
export function ImportDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStarted: (jobId: string) => void
}) {
  const { confirm, dialog: confirmDialog } = useConfirmDialog()
  const [mode, setMode] = React.useState<"local" | "server">("local")
  const [source, setSource] = React.useState<Source | null>(null)
  const [serverFiles, setServerFiles] = React.useState<ServerExportFile[]>([])
  const [serverDir, setServerDir] = React.useState("~/.manyoyo/exports")
  const [manifest, setManifest] = React.useState<ImportInspect | null>(null)
  const [edits, setEdits] = React.useState<Record<number, Edit>>({})
  const [picked, setPicked] = React.useState<number[]>([])
  const [inspecting, setInspecting] = React.useState(false)
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState<{ loaded: number; total: number } | null>(null)
  const [error, setError] = React.useState("")
  const abortRef = React.useRef<(() => void) | null>(null)
  const uploadJobRef = React.useRef<string | null>(null)
  const [abortable, setAbortable] = React.useState(false)

  // 每次打开都从头开始（渲染期对比上一次的 open，不在 effect 里同步 setState）
  const [prevOpen, setPrevOpen] = React.useState(false)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setSource(null)
      setManifest(null)
      setEdits({})
      setPicked([])
      setError("")
      setProgress(null)
    }
  }

  const [listVersion, setListVersion] = React.useState(0)
  React.useEffect(() => {
    if (!open || mode !== "server") return
    let cancelled = false
    listServerExports()
      .then((data) => {
        if (cancelled) return
        setServerFiles(data.files)
        setServerDir(data.dir)
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "读取服务器上的文件失败"))
    return () => {
      cancelled = true
    }
  }, [open, mode, listVersion])

  async function removeServerFile(name: string) {
    const ok = await confirm({
      title: "删除这个导出文件？",
      message: `${name}\n删除后无法恢复。`,
      confirmLabel: "删除",
    })
    if (!ok) return
    try {
      await deleteServerExport(name)
      if (source?.kind === "server" && source.name === name) {
        setSource(null)
        setManifest(null)
      }
      toast.success("已删除")
      setListVersion((current) => current + 1)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    }
  }

  async function inspect(next: Source) {
    setSource(next)
    setError("")
    setManifest(null)
    setInspecting(true)
    try {
      const data = next.kind === "local" ? await inspectLocalFile(next.file) : await inspectServerFile(next.name)
      setManifest(data)
      const nextEdits: Record<number, Edit> = {}
      for (const container of data.containers) {
        nextEdits[container.idx] = {
          name: container.suggestedName,
          remark: container.remark,
          hostPath: container.suggestedHostPath,
          imageMode: "same",
          checked: new Set(),
        }
      }
      setEdits(nextEdits)
      setPicked(data.containers.map((container) => container.idx))
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取文件失败")
    } finally {
      setInspecting(false)
    }
  }

  function patchEdit(idx: number, patch: Partial<Edit>) {
    setEdits((current) => ({ ...current, [idx]: { ...current[idx], ...patch } }))
  }

  function toggleRisk(idx: number, key: string) {
    const checked = new Set(edits[idx].checked)
    if (checked.has(key)) checked.delete(key)
    else checked.add(key)
    patchEdit(idx, { checked })
  }

  async function submit() {
    if (!manifest || !source) return
    setError("")
    const entries: Record<number, ImportPlanEntry> = {}
    for (const container of manifest.containers) {
      if (!picked.includes(container.idx)) continue
      const edit = edits[container.idx]
      entries[container.idx] = {
        name: edit.name.trim(),
        remark: edit.remark.trim(),
        hostPath: container.work === null ? "" : edit.hostPath.trim(),
        imageMode: edit.imageMode,
        confirm: confirmFromChecked(container, edit.checked),
      }
    }
    const plan = buildImportPlan(entries)
    setRunning(true)
    setProgress(null)
    try {
      let jobId: string
      if (source.kind === "server") {
        jobId = (await startServerImport(source.name, plan)).jobId
      } else {
        // 第一步失败（名字重复、目录不为空等）立刻报错，不用等上传
        const reserved = await startUploadImport(plan)
        uploadJobRef.current = reserved.jobId
        const upload = uploadImportFile(source.file, reserved.uploadUrl, (loaded, total) => setProgress({ loaded, total }), reserved.jobId)
        abortRef.current = upload.abort
        setAbortable(true)
        jobId = (await upload.promise).jobId
      }
      onStarted(jobId)
      onOpenChange(false)
    } catch (err) {
      // 上传没成功：把已登记（预留了名字）的任务取消，不然 2 分钟内换文件重试会被“已经有一个导入在进行”挡住
      if (uploadJobRef.current) void cancelJob(uploadJobRef.current).catch(() => undefined)
      setError(friendlyError(err instanceof Error ? err.message : "", "导入失败"))
    } finally {
      abortRef.current = null
      uploadJobRef.current = null
      setAbortable(false)
      setRunning(false)
    }
  }

  function cancelUpload() {
    abortRef.current?.()
    if (uploadJobRef.current) void cancelJob(uploadJobRef.current).catch(() => undefined)
  }

  function renderContainer(container: ImportContainer) {
    const edit = edits[container.idx]
    if (!edit) return null
    const risks = riskItems(container)
    const on = picked.includes(container.idx)
    return (
      <div key={container.idx} className="flex flex-col gap-3 rounded-md border p-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={on}
            disabled={running}
            onChange={() =>
              setPicked((current) =>
                current.includes(container.idx) ? current.filter((item) => item !== container.idx) : [...current, container.idx]
              )
            }
          />
          <span className="min-w-0 flex-1 truncate">{container.remark || container.name}</span>
          <Hint mono className="truncate">{container.name}</Hint>
        </label>
        {on && (container.imageStatus === "missing" || container.imageStatus === "untrusted") ? (
          <Hint>本机没有原镜像，将用默认版本，系统层改动不会还原。</Hint>
        ) : null}
        {on ? (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`imp-name-${container.idx}`}>导入后的容器名</FieldLabel>
              <Input
                id={`imp-name-${container.idx}`}
                value={edit.name}
                disabled={running}
                onChange={(event) => patchEdit(container.idx, { name: event.target.value })}
              />
              {container.nameTaken && edit.name === container.suggestedName ? <FieldDescription>本机已有同名容器，已自动换了名字。</FieldDescription> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={`imp-remark-${container.idx}`}>导入后的容器备注<Hint>（可选）</Hint></FieldLabel>
              <Input
                id={`imp-remark-${container.idx}`}
                value={edit.remark}
                maxLength={REMARK_MAX}
                disabled={running}
                onChange={(event) => patchEdit(container.idx, { remark: event.target.value })}
              />
              <Hint className="self-end">{edit.remark.length}/{REMARK_MAX}</Hint>
            </Field>
            {container.work !== null ? (
              <Field>
                <FieldLabel htmlFor={`imp-path-${container.idx}`}>工作目录（本机）</FieldLabel>
                <Input
                  id={`imp-path-${container.idx}`}
                  className="font-mono"
                  value={edit.hostPath}
                  disabled={running}
                  onChange={(event) => patchEdit(container.idx, { hostPath: event.target.value })}
                />
                <FieldDescription>必须是还不存在或空的目录；容器里的路径不变（{container.containerPath}），Agent 才能接着聊。</FieldDescription>
              </Field>
            ) : null}
            <Field>
              <FieldLabel>镜像</FieldLabel>
              <ToggleGroup
                variant="outline"
                value={[edit.imageMode]}
                disabled={running}
                onValueChange={(values) => values[0] && patchEdit(container.idx, { imageMode: values[0] === "default" ? "default" : "same" })}
              >
                <ToggleGroupItem value="same">与原来相同</ToggleGroupItem>
                <ToggleGroupItem value="default">用本机默认版本</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                原来：{container.image || "未知"}。换成本机默认版本时，装的软件等系统层改动不会还原，用户数据照常带过去。
              </FieldDescription>
            </Field>
            {risks.length ? (
              <Alert variant="warning">
                <AlertDescription>
                  <span className="mb-1 block">归档里有这些高风险设置，勾选的才会生效，没勾的导入时会被去掉：</span>
                  <span className="flex flex-col gap-1">
                    {risks.map((risk) => (
                      <label key={risk.key} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={edit.checked.has(risk.key)}
                          disabled={running}
                          onChange={() => toggleRisk(container.idx, risk.key)}
                        />
                        <span className="min-w-0 break-all">{risk.label}</span>
                      </label>
                    ))}
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        ) : null}
      </div>
    )
  }

  const canStart = Boolean(manifest) && picked.length > 0 && !running && !inspecting
  const percent = progress && progress.total ? Math.round((progress.loaded / progress.total) * 100) : null

  return (
    <Dialog open={open} onOpenChange={(next) => (!running ? onOpenChange(next) : undefined)}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>导入容器</DialogTitle>
          <DialogDescription>选一个 manyoyo 导出的文件，先看里面有什么，确认后再导入。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <FieldGroup>
            <Field>
              <FieldLabel>文件来源</FieldLabel>
              <ToggleGroup
                variant="outline"
                value={[mode]}
                disabled={running}
                onValueChange={(values) => {
                  if (!values[0]) return
                  setMode(values[0] === "server" ? "server" : "local")
                  setSource(null)
                  setManifest(null)
                }}
              >
                <ToggleGroupItem value="local">本机文件</ToggleGroupItem>
                <ToggleGroupItem value="server">服务器上的文件</ToggleGroupItem>
              </ToggleGroup>
              {mode === "server" ? (
                <FieldDescription>文件很大时，先用 scp 放到服务器的 {serverDir}，避开反向代理的上传大小限制。</FieldDescription>
              ) : null}
            </Field>

            {mode === "local" ? (
              <Field>
                <FieldLabel htmlFor="imp-file">导出文件</FieldLabel>
                <Input
                  id="imp-file"
                  type="file"
                  accept=".zst,.gz,.tgz"
                  disabled={running}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void inspect({ kind: "local", file })
                  }}
                />
              </Field>
            ) : (
              <Field>
                <FieldLabel>服务器上的导出文件</FieldLabel>
                <div id="imp-server-file" className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border p-2">
                  {serverFiles.length ? (
                    serverFiles.map((file) => {
                      const selected = source?.kind === "server" && source.name === file.name
                      return (
                        <div key={file.name} className="flex min-h-8 items-center gap-2">
                          <Button
                            variant={selected ? "secondary" : "ghost"}
                            size="sm"
                            className="h-auto min-w-0 flex-1 justify-start py-1"
                            aria-pressed={selected}
                            disabled={running}
                            onClick={() => void inspect({ kind: "server", name: file.name })}
                          >
                            <span className="flex min-w-0 flex-col items-start">
                              <span className="w-full truncate font-mono">{file.name}</span>
                              <Hint>{formatBytes(file.size)} · {formatDateTime(file.mtime)}</Hint>
                            </span>
                          </Button>
                          <span className="flex shrink-0 gap-3">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="touch-hit"
                              title="下载"
                              aria-label={`下载 ${file.name}`}
                              render={<a href={`/api/exports/files/${encodeURIComponent(file.name)}`} download={file.name} target="_blank" rel="noreferrer" />}
                            >
                              <DownloadIcon />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="touch-hit"
                              title="删除"
                              aria-label={`删除 ${file.name}`}
                              disabled={running}
                              onClick={() => void removeServerFile(file.name)}
                            >
                              <Trash2Icon />
                            </Button>
                          </span>
                        </div>
                      )
                    })
                  ) : (
                    <Hint>目录里还没有导出文件</Hint>
                  )}
                </div>
              </Field>
            )}

            {inspecting ? (
              <div className="flex items-center gap-2">
                <Spinner />
                <Hint>正在读取文件里的内容…</Hint>
              </div>
            ) : null}

            {manifest ? (
              <>
                <Hint>
                  来自 manyoyo {manifest.manyoyoVersion || "未知版本"}，{formatDateTime(manifest.createdAt)}；
                  {manifest.includeSecrets ? "含密钥" : "不含密钥，导入后需要在“设置容器”里补 Key"}；本机默认镜像 {manifest.localImage}
                </Hint>
                <div className="flex flex-col gap-3">{manifest.containers.map(renderContainer)}</div>
              </>
            ) : null}
          </FieldGroup>

          {running ? (
            <Alert className="mt-4">
              <AlertDescription>
                {source?.kind === "local" && percent !== null && percent < 100
                  ? `正在上传并解包… ${percent}%（${formatBytes(progress?.loaded)} / ${formatBytes(progress?.total)}）。上传中断会自动撤销，不留下半个容器。`
                  : "正在提交导入…"}
              </AlertDescription>
            </Alert>
          ) : null}
        </DialogBody>
        {/* 错误放在滚动区外面：表单很长时，滚动区底部的提示用户看不到 */}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          {running && abortable ? (
            <Button variant="outline" onClick={cancelUpload}>
              取消导入
            </Button>
          ) : (
            <Button variant="outline" disabled={running} onClick={() => onOpenChange(false)}>
              取消
            </Button>
          )}
          <Button disabled={!canStart} onClick={() => void submit()}>
            {running ? <Spinner data-icon="inline-start" /> : null}
            开始导入
          </Button>
        </DialogFooter>
        {confirmDialog}
      </DialogContent>
    </Dialog>
  )
}
