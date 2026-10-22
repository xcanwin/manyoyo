import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

// 容器的系统提示词：开关关闭后这个容器里的 Agent 不再收到它。创建时定下，之后只改这个容器。
export function SystemPromptEditor({
  text,
  onTextChange,
  enabled,
  onEnabledChange,
  idPrefix,
}: {
  text: string
  onTextChange: (text: string) => void
  enabled: boolean
  onEnabledChange: (value: boolean) => void
  idPrefix: string
}) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={`${idPrefix}-system-prompt`}>系统提示词</FieldLabel>
        <Switch
          aria-label="启用系统提示词"
          checked={enabled}
          onCheckedChange={onEnabledChange}
        />
      </div>
      <Textarea
        id={`${idPrefix}-system-prompt`}
        className="min-h-40"
        value={text}
        maxLength={8000}
        disabled={!enabled}
        onChange={(event) => onTextChange(event.target.value)}
      />
      <FieldDescription>每轮对话开始时交给这个容器里的 Agent。修改只影响这个容器，不改系统设置。</FieldDescription>
    </Field>
  )
}
