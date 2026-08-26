import * as React from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { apiGet, apiPost, type SessionSummary } from "@/lib/api"

const DEFAULT_VALUE = "__default__"
const CUSTOM_VALUE = "__custom__"

type ModelOption = { value: string; label: string; description?: string }

export function ModelDialog({
  open,
  onOpenChange,
  session,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  session: SessionSummary | null
  onSaved: () => void
}) {
  const [models, setModels] = React.useState<ModelOption[]>([])
  const [selected, setSelected] = React.useState(DEFAULT_VALUE)
  const [customModel, setCustomModel] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")

  // 渲染期间对比"当前应该加载哪个会话的模型列表"来重置 loading/error，而不是
  // 在 effect 里同步 setState；effect 只保留真正的异步拉取
  const openSignature = open && session ? session.name : null
  const [prevOpenSignature, setPrevOpenSignature] = React.useState(openSignature)
  if (openSignature !== prevOpenSignature) {
    setPrevOpenSignature(openSignature)
    if (openSignature !== null) {
      setLoading(true)
      setError("")
    }
  }

  React.useEffect(() => {
    if (!open || !session) return
    apiGet(`/api/sessions/${encodeURIComponent(session.name)}/models`)
      .then((data) => {
        const list = Array.isArray(data.models) ? (data.models as ModelOption[]) : []
        setModels(list)
        const current = session.model || ""
        if (!current) {
          setSelected(DEFAULT_VALUE)
          setCustomModel("")
        } else if (list.some((m) => m.value === current)) {
          setSelected(current)
        } else {
          setSelected(CUSTOM_VALUE)
          setCustomModel(current)
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "获取模型列表失败"))
      .finally(() => setLoading(false))
  }, [open, session])

  async function handleSave() {
    if (!session) return
    setSaving(true)
    setError("")
    try {
      const value =
        selected === DEFAULT_VALUE
          ? ""
          : selected === CUSTOM_VALUE
            ? customModel.trim()
            : selected
      await apiPost(`/api/sessions/${encodeURIComponent(session.name)}/model`, { model: value })
      onOpenChange(false)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>选择模型</DialogTitle>
        </DialogHeader>
        {loading ? (
          <p className="text-sm text-muted-foreground">正在获取模型列表...</p>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="model-select">模型</FieldLabel>
              <Select value={selected} onValueChange={(value) => setSelected(value ?? DEFAULT_VALUE)}>
                <SelectTrigger id="model-select" className="w-full">
                  {/* base-ui 的 Select.Value 在没有 items 属性时只会显示原始 value 字面量，
                      不会自动回填对应 SelectItem 的文案，这里用 children 函数手动映射 */}
                  <SelectValue>
                    {(value: string) => {
                      if (value === DEFAULT_VALUE) return "跟随默认（不传 --model）"
                      if (value === CUSTOM_VALUE) return "自定义..."
                      return models.find((model) => model.value === value)?.label || value
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={DEFAULT_VALUE}>跟随默认（不传 --model）</SelectItem>
                    {models.map((model) => (
                      <SelectItem key={model.value} value={model.value}>
                        {model.label}
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM_VALUE}>自定义...</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {selected === CUSTOM_VALUE ? (
              <Field>
                <FieldLabel htmlFor="model-custom">自定义模型名称</FieldLabel>
                <Input
                  id="model-custom"
                  placeholder="例如 gemini-2.5-pro"
                  value={customModel}
                  onChange={(event) => setCustomModel(event.target.value)}
                />
              </Field>
            ) : null}
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        )}
        <DialogFooter>
          <Button onClick={handleSave} disabled={loading || saving}>
            {saving ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
