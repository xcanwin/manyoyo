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
// "继承容器默认"这个空值选项：选中后按 getInheritedContainerTemplateText 的优先级回填预览文本，
// 但保存时如果仍停留在这个选项，要显式清空覆盖字段，让它真正走继承
const INHERIT_CLI = "__inherit__"

function getInheritedTemplateText(detail: Record<string, unknown>): string {
  const containerText = String(detail.containerAgentPromptCommand || "").trim()
  if (containerText) return containerText
  return String(detail.agentPromptCommand || "").trim()
}

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
  const detailRef = React.useRef<Record<string, unknown>>({})

  // 渲染期间对比"当前应该加载哪个会话的模板"来重置 loading/error，而不是
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
    apiGet(`/api/sessions/${encodeURIComponent(session.name)}/detail`)
      .then((data) => {
        const detail = (data.detail || {}) as Record<string, unknown>
        detailRef.current = detail
        const value = isDefaultAgent
          ? String(detail.containerAgentPromptCommand || "")
          : String(detail.agentPromptCommandOverride || "")
        setTemplate(value)
        if (!isDefaultAgent && !value) {
          setCli(INHERIT_CLI)
          return
        }
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
    if (next === INHERIT_CLI) {
      setTemplate(getInheritedTemplateText(detailRef.current))
      return
    }
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
        : { agentPromptCommandOverride: cli === INHERIT_CLI ? "" : template }
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
                  {/* base-ui 的 Select.Value 不会自动回填对应 SelectItem 的文案，
                      只会显示原始 value 字面量，这里跟 model-dialog.tsx 一样用 children 函数手动映射 */}
                  <SelectValue>
                    {(value: string) => {
                      if (value === INHERIT_CLI) return "继承容器默认"
                      if (value === CUSTOM_CLI) return "自定义"
                      return value
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {!isDefaultAgent ? (
                      <SelectItem value={INHERIT_CLI}>继承容器默认</SelectItem>
                    ) : null}
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
