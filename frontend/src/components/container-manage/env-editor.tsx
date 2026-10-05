import * as React from "react"
import { EyeIcon, EyeOffIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  type EnvEntry,
  type EnvInvalid,
  isSensitiveKey,
  parseEnvText,
  serializeEnv,
} from "@/lib/container-manage"

// 环境变量编辑：默认是表格（名字含 KEY / TOKEN / SECRET… 的值遮罩，点眼睛显示），也可切到原始文本。
// 唯一数据源是 text（与容器里 /run/manyoyo/env 同一格式），表格每次编辑都回写成文本。
export function EnvEditor({
  value,
  onChange,
  invalid = [],
  idPrefix,
}: {
  value: string
  onChange: (text: string) => void
  invalid?: EnvInvalid[]
  idPrefix: string
}) {
  const [view, setView] = React.useState<"table" | "text">("table")
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set())
  // 表格行允许暂时是空名字（正在输入）：行状态自己持有，序列化后与外部 value 一致时不重置；
  // 外部 value 变了（重新加载、从文本视图改）才用解析结果覆盖
  const [entries, setEntries] = React.useState<EnvEntry[]>(() => parseEnvText(value).entries)
  const [emitted, setEmitted] = React.useState(value)
  if (value !== emitted && value !== serializeEnv(entries)) {
    setEmitted(value)
    setEntries(parseEnvText(value).entries)
  }

  function commit(next: EnvEntry[]) {
    const text = serializeEnv(next)
    setEntries(next)
    setEmitted(text)
    onChange(text)
  }

  function updateEntry(index: number, patch: Partial<EnvEntry>) {
    commit(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  }

  function removeEntry(index: number) {
    commit(entries.filter((_, i) => i !== index))
    setRevealed(new Set())
  }

  function toggleReveal(index: number) {
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        variant="outline"
        size="sm"
        value={[view]}
        onValueChange={(values) => {
          const next = values[0]
          if (next === "table" || next === "text") setView(next)
        }}
      >
        <ToggleGroupItem value="table">表格</ToggleGroupItem>
        <ToggleGroupItem value="text">文本</ToggleGroupItem>
      </ToggleGroup>

      {view === "text" ? (
        <Textarea
          id={`${idPrefix}-env-text`}
          aria-label="环境变量文本"
          className="min-h-32 font-mono text-xs"
          placeholder="KEY=value"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map((entry, index) => {
            const sensitive = isSensitiveKey(entry.key)
            const hidden = sensitive && !revealed.has(index)
            return (
              <div key={index} className="flex items-center gap-2">
                <Input
                  aria-label={`第 ${index + 1} 项名称`}
                  className="w-2/5 font-mono text-xs"
                  value={entry.key}
                  onChange={(event) => updateEntry(index, { key: event.target.value })}
                />
                <Input
                  aria-label={`第 ${index + 1} 项的值`}
                  className="flex-1 font-mono text-xs"
                  type={hidden ? "password" : "text"}
                  autoComplete="off"
                  value={entry.value}
                  onChange={(event) => updateEntry(index, { value: event.target.value })}
                />
                {sensitive ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={hidden ? "显示值" : "隐藏值"}
                    onClick={() => toggleReveal(index)}
                  >
                    {hidden ? <EyeIcon /> : <EyeOffIcon />}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="删除这一项"
                  onClick={() => removeEntry(index)}
                >
                  <Trash2Icon />
                </Button>
              </div>
            )
          })}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => commit([...entries, { key: "", value: "" }])}
            >
              <PlusIcon data-icon="inline-start" />
              添加变量
            </Button>
          </div>
          {entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有环境变量。</p>
          ) : null}
        </div>
      )}

      {invalid.length ? (
        <Alert variant="destructive">
          <AlertDescription>
            <p>下面这些行不是合法的 KEY=VALUE，容器里会被跳过（保存时需先修正）：</p>
            <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
              {invalid.map((item) => (
                <li key={item.line}>
                  第 {item.line} 行：{item.text}（{item.reason}）
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
