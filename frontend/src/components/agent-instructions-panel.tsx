import * as React from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { apiGet, apiPost } from "@/lib/api"

// 系统设置里的“Agent 环境说明”：上面是内置说明（只读），下面是用户追加的说明，
// 网页里每次执行 Agent 时一起交给它；改完下一轮对话就生效，不用重建容器
export function AgentInstructionsPanel({ onSaved }: { onSaved?: () => void } = {}) {
  const [builtin, setBuiltin] = React.useState("")
  const [custom, setCustom] = React.useState("")
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
      await apiPost("/api/agent-instructions", { custom })
      setMessage({ tone: "ok", text: "已保存，下一轮对话开始生效" })
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
        <FieldLabel>内置说明</FieldLabel>
        <FieldDescription>告诉 Agent 它在网页里、图片和文件怎么写才能显示。</FieldDescription>
        <pre className="rounded-md border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
          {builtin}
        </pre>
      </Field>
      <Field>
        <FieldLabel htmlFor="agent-instructions-custom">我的补充说明</FieldLabel>
        <FieldDescription>接在内置说明后面，例如“回答用中文”。运行配置里可以单独写 agentInstructions 覆盖。</FieldDescription>
        <Textarea
          id="agent-instructions-custom"
          className="min-h-28"
          value={custom}
          maxLength={4000}
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
