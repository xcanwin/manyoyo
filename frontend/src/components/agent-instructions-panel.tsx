import * as React from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { apiGet, apiPost } from "@/lib/api"

// 系统设置里的“系统提示词”：默认系统提示词（只读）+ 补充系统提示词，各有开关（默认开）。
// 只决定之后新建容器的初始内容，已有容器不受影响（每个容器在自己的设置里改）
export function AgentInstructionsPanel({ onSaved }: { onSaved?: () => void } = {}) {
  const [builtin, setBuiltin] = React.useState("")
  const [custom, setCustom] = React.useState("")
  const [builtinEnabled, setBuiltinEnabled] = React.useState(true)
  const [customEnabled, setCustomEnabled] = React.useState(true)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState<{ tone: "ok" | "error"; text: string } | null>(null)

  React.useEffect(() => {
    let cancelled = false
    apiGet("/api/agent-instructions")
      .then((data) => {
        if (cancelled) return
        setBuiltin(String(data.builtin || ""))
        setCustom(String(data.custom || ""))
        setBuiltinEnabled(data.builtinEnabled !== false)
        setCustomEnabled(data.customEnabled !== false)
      })
      .catch((err) => {
        if (!cancelled) setMessage({ tone: "error", text: err instanceof Error ? err.message : "加载失败" })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSave() {
    setSaving(true)
    setMessage(null)
    try {
      await apiPost("/api/agent-instructions", { custom, builtinEnabled, customEnabled })
      setMessage({ tone: "ok", text: "已保存，之后新建的容器生效" })
      onSaved?.()
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error ? err.message : "保存失败" })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spinner />

  return (
    <FieldGroup>
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel>默认系统提示词</FieldLabel>
          <Switch aria-label="启用默认系统提示词" checked={builtinEnabled} onCheckedChange={setBuiltinEnabled} />
        </div>
        <FieldDescription>告诉 Agent 它的回复会显示在网页里、图片和文件怎么写才能显示。</FieldDescription>
        <pre className="rounded-md border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
          {builtin}
        </pre>
      </Field>
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor="agent-instructions-custom">补充系统提示词</FieldLabel>
          <Switch aria-label="启用补充系统提示词" checked={customEnabled} onCheckedChange={setCustomEnabled} />
        </div>
        <FieldDescription>接在默认系统提示词后面，例如“回答用中文”。只影响之后新建的容器，已有容器在各自的设置里改。</FieldDescription>
        <Textarea
          id="agent-instructions-custom"
          className="min-h-28"
          value={custom}
          maxLength={4000}
          disabled={!customEnabled}
          onChange={(event) => setCustom(event.target.value)}
        />
      </Field>
      {message ? (
        <Alert variant={message.tone === "error" ? "destructive" : undefined}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button type="button" onClick={() => void handleSave()} disabled={saving}>
          {saving ? <Spinner data-icon="inline-start" /> : null}
          保存
        </Button>
      </div>
    </FieldGroup>
  )
}
