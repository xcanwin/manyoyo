import * as React from "react"

import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  CUSTOM_CHOICE,
  MIRROR_TOOLS,
  OFFICIAL_CHOICE,
  choiceFor,
  type MirrorPresets,
  type MirrorTool,
  type Mirrors,
} from "@/lib/mirrors"

const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"

// apt / npm / pip 各一行：下拉（官方默认 / 预设 / 自定义）+ 选自定义时出现的输入框。
// 预设来自服务端；不改动就是各工具原本的官方默认源。
export function MirrorSettings({
  mirrors,
  presets,
  onChange,
  idPrefix = "mirror",
}: {
  mirrors: Mirrors
  presets: MirrorPresets
  onChange: (next: Mirrors) => void
  idPrefix?: string
}) {
  // 选了“自定义”但还没填内容时，value 是空串，下拉需要记住用户的选择
  const [customOpen, setCustomOpen] = React.useState<Partial<Record<MirrorTool, boolean>>>({})

  function handleSelect(tool: MirrorTool, choice: string) {
    if (choice === CUSTOM_CHOICE) {
      setCustomOpen((prev) => ({ ...prev, [tool]: true }))
      const current = mirrors[tool]
      // 从预设切到自定义时保留当前地址方便微调
      onChange({ ...mirrors, [tool]: current })
      return
    }
    setCustomOpen((prev) => ({ ...prev, [tool]: false }))
    onChange({ ...mirrors, [tool]: choice })
  }

  return (
    <FieldGroup className="gap-3" data-testid="mirror-settings">
      {MIRROR_TOOLS.map((tool) => {
        const list = presets[tool.id] ?? []
        const choice = customOpen[tool.id] ? CUSTOM_CHOICE : choiceFor(mirrors[tool.id], list)
        return (
          <Field key={tool.id}>
            <FieldLabel htmlFor={`${idPrefix}-${tool.id}`}>{tool.label}</FieldLabel>
            <select
              id={`${idPrefix}-${tool.id}`}
              className={SELECT_CLASS}
              value={choice}
              onChange={(event) => handleSelect(tool.id, event.target.value)}
            >
              <option value={OFFICIAL_CHOICE}>官方默认</option>
              {list.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
              <option value={CUSTOM_CHOICE}>自定义…</option>
            </select>
            {choice === CUSTOM_CHOICE ? (
              <>
                <Input
                  id={`${idPrefix}-${tool.id}-custom`}
                  aria-label={`${tool.label} 自定义地址`}
                  placeholder={tool.hint}
                  value={mirrors[tool.id]}
                  onChange={(event) => onChange({ ...mirrors, [tool.id]: event.target.value })}
                />
                <FieldDescription>{tool.hint}</FieldDescription>
              </>
            ) : null}
          </Field>
        )
      })}
    </FieldGroup>
  )
}
