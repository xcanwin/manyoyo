import * as React from "react"

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
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Hint } from "@/components/hint"
import { formatBytes } from "@/lib/format"
import {
  buildImportPlan,
  confirmFromChecked,
  inspectLocalFile,
  inspectServerFile,
  listServerExports,
  riskItems,
  startServerImport,
  uploadImport,
  type ImportContainer,
  type ImportInspect,
  type ImportPlanEntry,
  type ServerExportFile,
} from "@/lib/transfer"

type Source = { kind: "local"; file: File } | { kind: "server"; name: string }

type Edit = { name: string; hostPath: string; imageMode: "same" | "default"; checked: Set<string> }

// 导入：选文件 → 只读开头看清单 → 改名 / 选目录 / 确认风险 → 开始。边上传边解包，失败自动撤销
export function ImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (containers: string[]) => void
}) {
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
  }, [open, mode])

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
        hostPath: container.work === null ? "" : edit.hostPath.trim(),
        imageMode: edit.imageMode,
        confirm: confirmFromChecked(container, edit.checked),
      }
    }
    const plan = buildImportPlan(entries)
    setRunning(true)
    setProgress(null)
    try {
      let result: { containers: string[] }
      if (source.kind === "server") {
        result = await startServerImport(source.name, plan)
      } else {
        const upload = uploadImport(source.file, plan, (loaded, total) => setProgress({ loaded, total }))
        abortRef.current = upload.abort
        setAbortable(true)
        result = await upload.promise
      }
      onImported(result.containers)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败")
    } finally {
      abortRef.current = null
      setAbortable(false)
      setRunning(false)
    }
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
                <FieldLabel htmlFor="imp-server-file">服务器上的导出文件</FieldLabel>
                <NativeSelect
                  className="w-full"
                  id="imp-server-file"
                  value={source?.kind === "server" ? source.name : ""}
                  disabled={running}
                  onChange={(event) => event.target.value && void inspect({ kind: "server", name: event.target.value })}
                >
                  <NativeSelectOption value="">{serverFiles.length ? "请选择" : "目录里还没有导出文件"}</NativeSelectOption>
                  {serverFiles.map((file) => (
                    <NativeSelectOption key={file.name} value={file.name}>
                      {file.name}（{formatBytes(file.size)}）
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
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
                  来自 manyoyo {manifest.manyoyoVersion || "未知版本"}，{manifest.createdAt ? new Date(manifest.createdAt).toLocaleString() : ""}；
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
                  : "正在导入，完成前请不要关闭页面…"}
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {running && abortable ? (
            <Button variant="outline" onClick={() => abortRef.current?.()}>
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
      </DialogContent>
    </Dialog>
  )
}
