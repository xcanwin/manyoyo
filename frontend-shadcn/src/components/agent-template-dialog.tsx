import * as React from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { apiGet, apiPut, type SessionSummary } from "@/lib/api"
import { CLI_PROMPT_TEMPLATES } from "@/lib/agent-templates"

const CUSTOM_CLI = "custom"

export function AgentTemplateDialog({
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
  const isDefaultAgent = session?.agentId === "default"
  const [cli, setCli] = React.useState(CUSTOM_CLI)
  const [template, setTemplate] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")

  React.useEffect(() => {
    if (!open || !session) return
    setLoading(true)
    setError("")
    apiGet(`/api/sessions/${encodeURIComponent(session.name)}/detail`)
      .then((data) => {
        const detail = (data.detail || {}) as Record<string, unknown>
        const value = isDefaultAgent
          ? String(detail.containerAgentPromptCommand || "")
          : String(detail.agentPromptCommandOverride || "")
        setTemplate(value)
        const matchedCli = Object.entries(CLI_PROMPT_TEMPLATES).find(
          ([, tpl]) => tpl === value
        )?.[0]
        setCli(matchedCli || CUSTOM_CLI)
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载模板失败"))
      .finally(() => setLoading(false))
  }, [open, session, isDefaultAgent])

  function handleCliChange(value: string | null) {
    const next = value ?? CUSTOM_CLI
    setCli(next)
    if (next !== CUSTOM_CLI) {
      setTemplate(CLI_PROMPT_TEMPLATES[next])
    }
  }

  async function handleSave() {
    if (!session) return
    setSaving(true)
    setError("")
    try {
      const body = isDefaultAgent
        ? { containerAgentPromptCommand: template }
        : { agentPromptCommandOverride: template }
      await apiPut(`/api/sessions/${encodeURIComponent(session.name)}/agent-template`, body)
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>设置 CLI / Agent 模板</DialogTitle>
          <DialogDescription>
            {isDefaultAgent
              ? "对该容器下所有未单独覆盖的 AGENT 生效。"
              : "仅对当前 AGENT 生效，覆盖容器级模板；留空则继承容器默认模板。"}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="text-sm text-muted-foreground">加载中...</p>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="agent-template-cli">CLI</FieldLabel>
              <Select value={cli} onValueChange={handleCliChange}>
                <SelectTrigger id="agent-template-cli" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={CUSTOM_CLI}>自定义</SelectItem>
                    <SelectItem value="claude">claude</SelectItem>
                    <SelectItem value="codex">codex</SelectItem>
                    <SelectItem value="gemini">gemini</SelectItem>
                    <SelectItem value="opencode">opencode</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-template-command">
                {isDefaultAgent ? "容器级 agentPromptCommand" : "当前 AGENT 覆盖"}
              </FieldLabel>
              <Textarea
                id="agent-template-command"
                className="min-h-20 font-mono text-xs"
                placeholder={
                  isDefaultAgent
                    ? "例如 codex exec --skip-git-repo-check {prompt}"
                    : "留空则继承容器默认模板"
                }
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
              />
              <FieldDescription>模板需包含 {"{prompt}"} 占位符。</FieldDescription>
            </Field>
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
