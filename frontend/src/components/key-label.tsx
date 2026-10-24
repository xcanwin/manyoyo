import { configLabel } from "@/lib/config-labels"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/hint"
import { FieldLabel } from "@/components/ui/field"

// 字段标签：中文名 + 灰色 12px 等宽的配置键，对照 JSON 视图时能一眼对上（STYLE.md 第 5 节）。
// k 是顶层配置键；嵌套的键传 path。hint 是标签后面的辅助说明，例如“（可选）”。
export function KeyLabel({
  k,
  path,
  htmlFor,
  hint,
}: {
  k?: string
  path?: string[]
  htmlFor?: string
  hint?: string
}) {
  const label = configLabel(path ?? [k ?? ""])
  return (
    <FieldLabel htmlFor={htmlFor} className="items-baseline gap-2">
      <span className={cn(label.mono && "font-mono")}>{label.title}</span>
      {!label.mono ? <Hint mono>{label.key}</Hint> : null}
      {hint ? <Hint>{hint}</Hint> : null}
    </FieldLabel>
  )
}
