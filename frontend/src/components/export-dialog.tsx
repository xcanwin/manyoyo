import * as React from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
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
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Hint } from "@/components/hint"
import { formatBytes } from "@/lib/format"
import {
  estimateTotal,
  fetchPreview,
  itemsOfTier,
  matchTier,
  startExport,
  type TransferPreview,
} from "@/lib/transfer"

export type ExportableContainer = { name: string; remark: string; status: string }

const statusLabel = (status: string) =>
  status === "history" ? "仅历史" : /^Up\b/.test(status) ? "运行中" : "已停止"

// 导出：选容器 → 选档位（可微调内容）→ 开始。直接下载由浏览器接收，进度看侧栏卡片
export function ExportDialog({
  open,
  onOpenChange,
  containers,
  initialSelected,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  containers: ExportableContainer[]
  initialSelected: string[]
  onStarted: (info: { jobId: string; output: "download" | "server"; file?: string }) => void
}) {
  const [selected, setSelected] = React.useState<string[]>(initialSelected)
  const [items, setItems] = React.useState<string[]>([])
  const [preview, setPreview] = React.useState<TransferPreview | null>(null)
  const [includeSecrets, setIncludeSecrets] = React.useState(true)
  const [compression, setCompression] = React.useState<"fast" | "small">("fast")
  const [output, setOutput] = React.useState<"download" | "server">("download")
  const [loading, setLoading] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState("")

  // 弹窗每次打开时按传入的容器重置（渲染期对比签名，不在 effect 里同步 setState）
  const signature = open ? initialSelected.join("\n") : null
  const [prevSignature, setPrevSignature] = React.useState<string | null>(null)
  if (signature !== prevSignature) {
    setPrevSignature(signature)
    if (signature !== null) {
      setSelected(initialSelected)
      setError("")
    }
  }

  const selectedKey = selected.join(",")
  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    fetchPreview(selectedKey ? selectedKey.split(",") : [])
      .then((data) => {
        if (cancelled) return
        setPreview(data)
        // 第一次拿到数据时默认“标准”（推荐档）
        setItems((current) => (current.length ? current : itemsOfTier(data.items, "standard")))
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
  }, [open, selectedKey])

  const tierId = preview ? matchTier(preview.items, preview.tiers, items) : "standard"
  const total = preview ? estimateTotal(preview.estimates, items) : { bytes: 0, unknown: false }
  const free = preview?.freeBytes ?? null
  const needFree = total.bytes * 1.1 + 1024 * 1024 * 1024
  const diskShort = output === "server" && free !== null && free < needFree

  function toggleContainer(name: string) {
    setSelected((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
    )
  }

  function toggleItem(id: string) {
    setItems((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  async function submit() {
    setError("")
    setSubmitting(true)
    try {
      const result = await startExport({
        containers: selected,
        items,
        includeSecrets,
        compression,
        output,
        estimate: total.bytes,
      })
      if (result.downloadUrl) {
        // 交给浏览器下载：服务端流式输出，不在服务器上落临时文件
        const link = document.createElement("a")
        link.href = result.downloadUrl
        link.download = ""
        document.body.appendChild(link)
        link.click()
        link.remove()
      }
      onStarted({ jobId: result.jobId, output, file: result.file })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "开始导出失败")
    } finally {
      setSubmitting(false)
    }
  }

  const disabled = submitting || !selected.length || !items.length || diskShort

  return (
    <Dialog open={open} onOpenChange={(next) => (!submitting ? onOpenChange(next) : undefined)}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>导出容器</DialogTitle>
          <DialogDescription>把容器的对话、设置和数据打成一个文件，可以在另一台机器上导入后接着聊。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <FieldGroup>
            <Field>
              <FieldLabel>要导出的容器</FieldLabel>
              <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border p-2">
                {containers.map((container) => (
                  <label key={container.name} className="flex min-h-8 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.includes(container.name)}
                      onChange={() => toggleContainer(container.name)}
                    />
                    <span className="min-w-0 flex-1 truncate">{container.remark || container.name}</span>
                    {container.remark ? <Hint mono className="truncate">{container.name}</Hint> : null}
                    <Badge variant={/^Up\b/.test(container.status) ? "success" : "outline"}>
                      {statusLabel(container.status)}
                    </Badge>
                  </label>
                ))}
              </div>
            </Field>

            <Field>
              <FieldLabel>导出档位</FieldLabel>
              <ToggleGroup
                variant="outline"
                value={[tierId]}
                onValueChange={(values) => {
                  const next = values[0]
                  if (next && preview && next !== "custom") setItems(itemsOfTier(preview.items, next))
                }}
              >
                {(preview?.tiers ?? []).map((tier) => (
                  <ToggleGroupItem key={tier.id} value={tier.id}>
                    {tier.label}
                    {tier.recommended ? "（推荐）" : ""}
                  </ToggleGroupItem>
                ))}
                {/* 自定义不是可点的档位：手动勾选内容后自动高亮，点它什么也不会发生 */}
                <ToggleGroupItem value="custom">自定义</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                标准档足够换机器或换镜像版本后接着用；完整档会把容器里装的软件也带上，只在对方镜像版本相同时还原。
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel>包含的内容</FieldLabel>
              <div className="flex flex-col gap-1 rounded-md border p-2">
                {(preview?.items ?? []).map((item) => {
                  const bytes = preview?.estimates[item.id]
                  return (
                    <label key={item.id} className="flex min-h-8 items-center gap-2">
                      <input type="checkbox" checked={items.includes(item.id)} onChange={() => toggleItem(item.id)} />
                      <span className="shrink-0">{item.label}</span>
                      {item.hint ? <Hint className="min-w-0 flex-1 truncate">{item.hint}</Hint> : <span className="flex-1" />}
                      <Hint className="shrink-0">{bytes === null || bytes === undefined ? "大小未知" : formatBytes(bytes)}</Hint>
                    </label>
                  )
                })}
              </div>
            </Field>

            <Field orientation="horizontal">
              <input
                id="export-secrets"
                type="checkbox"
                checked={includeSecrets}
                onChange={(event) => setIncludeSecrets(event.target.checked)}
              />
              <div className="flex min-w-0 flex-col gap-1">
                <FieldLabel htmlFor="export-secrets">包含密钥（API Key 等）</FieldLabel>
                <FieldDescription>
                  不带密钥就没法在新机器上直接对话。文件里有你的 API Key，请妥善保管；取消勾选后，API Key、令牌类变量和各 Agent 的登录凭据都不会进文件，导入后到“设置容器”里补 Key、重新登录。
                </FieldDescription>
              </div>
            </Field>

            <Field>
              <FieldLabel>压缩</FieldLabel>
              <ToggleGroup
                variant="outline"
                value={[compression]}
                onValueChange={(values) => values[0] && setCompression(values[0] === "small" ? "small" : "fast")}
              >
                <ToggleGroupItem value="fast">快速</ToggleGroupItem>
                <ToggleGroupItem value="small">更小</ToggleGroupItem>
              </ToggleGroup>
            </Field>

            <Field>
              <FieldLabel>保存方式</FieldLabel>
              <ToggleGroup
                variant="outline"
                value={[output]}
                onValueChange={(values) => values[0] && setOutput(values[0] === "server" ? "server" : "download")}
              >
                <ToggleGroupItem value="download">直接下载</ToggleGroupItem>
                <ToggleGroupItem value="server">保存到服务器</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                {output === "download"
                  ? "服务器不占磁盘，但要保持页面打开，直到浏览器开始接收。"
                  : "保存在服务器的 ~/.manyoyo/exports/，可以关掉页面；会占用服务器磁盘。"}
              </FieldDescription>
            </Field>
          </FieldGroup>

          {diskShort ? (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>
                服务器剩余空间 {formatBytes(free)}，不够放下约 {formatBytes(total.bytes)} 的导出文件。请改用“直接下载”或清理空间。
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
          <Hint className="mr-auto self-center">
            {loading ? "正在估算大小…" : `估算约 ${formatBytes(total.bytes)}${total.unknown ? "（容器内的数据大小未知，实际更大）" : ""}`}
            {output === "server" && free !== null ? `，服务器剩余 ${formatBytes(free)}` : ""}
          </Hint>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={disabled} onClick={() => void submit()}>
            {submitting ? <Spinner data-icon="inline-start" /> : null}
            开始导出
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
