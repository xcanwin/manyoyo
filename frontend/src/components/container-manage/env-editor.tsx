import * as React from "react"
import { EyeIcon, EyeOffIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { envLabel } from "@/lib/config-labels"
import { useIsMobile } from "@/hooks/use-mobile"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { RowList } from "@/components/container-manage/row-list"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import {
  type EnvEntry,
  type EnvFileStatus,
  type EnvInvalid,
  isSensitiveKey,
  parseEnvText,
  serializeEnv,
} from "@/lib/container-manage"

import { ColumnHeader } from "@/components/column-header"
import { Hint } from "@/components/hint"
// 环境变量编辑：默认是表格（名字含 KEY / TOKEN / SECRET… 的值遮罩，点眼睛显示），也可切到原始文本。
// 唯一数据源是 text（与容器里 /run/manyoyo/env 同一格式），表格每次编辑都回写成文本。
type FileRow = { path: string }

export function EnvEditor({
  value,
  onChange,
  invalid = [],
  idPrefix,
  files,
  onFilesChange,
  fileStatus,
}: {
  value: string
  onChange: (text: string) => void
  invalid?: EnvInvalid[]
  idPrefix: string
  /** 环境变量文件（宿主机上的绝对路径）；不传则不显示这一块 */
  files?: string[]
  onFilesChange?: (files: string[]) => void
  /** 服务端读取这些文件的结果（路径、变量个数、被跳过的行） */
  fileStatus?: EnvFileStatus[]
}) {
  const mobile = useIsMobile()
  const [fileRows, setFileRows] = React.useState<FileRow[]>(() => (files ?? []).map((path) => ({ path })))
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
    <div className="flex flex-col gap-4">
      {files && onFilesChange ? (
        <Field>
          <FieldLabel>环境变量文件</FieldLabel>
          <RowList
            ariaPrefix="环境变量文件"
            rows={fileRows}
            columns={[{ key: "path", label: "文件路径（宿主机上的绝对路径）", placeholder: "例如 /path/to/project/.env" }]}
            newRow={() => ({ path: "" })}
            addLabel="添加环境变量文件"
            onChange={(next) => {
              setFileRows(next)
              onFilesChange(next.map((row) => row.path.trim()).filter(Boolean))
            }}
          />
          {fileStatus?.length ? (
            <ul className="flex flex-col gap-1">
              {fileStatus.map((file) => (
                <li key={file.path}>
                  <Hint className={file.error ? "text-destructive" : undefined}>
                    {file.path}：{file.error || `${file.count} 个变量`}
                    {file.invalid.length ? `，${file.invalid.length} 行被跳过（第 ${file.invalid.map((item) => item.line).join("、")} 行）` : ""}
                  </Hint>
                </li>
              ))}
            </ul>
          ) : null}
          <FieldDescription>
            按顺序读取，后面的覆盖前面的；下面的「环境变量」优先于文件。文件每次执行命令时重新读取，改了文件下一条命令就生效；语法与下面的文本相同。
          </FieldDescription>
        </Field>
      ) : null}

      <Field>
      <FieldLabel>直接填写的变量</FieldLabel>
      <ToggleGroup
        variant="outline"
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
          className="min-h-32 font-mono"
          placeholder="例如 KEY=value，每行一项"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {entries.length && !mobile ? (
            <div className="flex items-center gap-2">
              <ColumnHeader className="w-2/5 px-1">变量名</ColumnHeader>
              <ColumnHeader className="min-w-0 flex-1 px-1">变量值</ColumnHeader>
              <ColumnHeader className="w-[4.5rem] shrink-0 text-center">操作</ColumnHeader>
            </div>
          ) : null}
          {entries.map((entry, index) => {
            const sensitive = isSensitiveKey(entry.key)
            const hidden = sensitive && !revealed.has(index)
            const title = envLabel(entry.key.trim())
            const nameInput = (
              <div className={cn("flex min-w-0 flex-col gap-1", mobile ? "w-full" : "w-2/5")}>
                <Input
                  aria-label={`第 ${index + 1} 项名称`}
                  className="font-mono"
                  value={entry.key}
                  onChange={(event) => updateEntry(index, { key: event.target.value })}
                />
                {title ? <Hint className="px-1">{title}</Hint> : null}
              </div>
            )
            const valueInput = (
              <Input
                aria-label={`第 ${index + 1} 项的值`}
                className={cn("min-w-0 flex-1 font-mono", hidden && "[-webkit-text-security:disc]")}
                // 不用 type=password：浏览器会把它当登录表单，回车后弹“要保存密码吗”
                type="text"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                value={entry.value}
                onChange={(event) => updateEntry(index, { value: event.target.value })}
              />
            )
            const actions = (
              <>
                {sensitive ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={hidden ? "显示值" : "隐藏值"}
                    onClick={() => toggleReveal(index)}
                  >
                    {hidden ? <EyeIcon /> : <EyeOffIcon />}
                  </Button>
                ) : mobile ? null : (
                  <span className="size-8 shrink-0" aria-hidden />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="删除这一项"
                  onClick={() => removeEntry(index)}
                >
                  <Trash2Icon />
                </Button>
              </>
            )
            // 手机上变量名占一行，值和操作按钮在下面一行（窄屏并排会把变量名截断）
            return mobile ? (
              <div key={index} data-slot="env-row" data-layout="stacked" className="flex flex-col gap-2">
                {nameInput}
                <div className="flex items-center gap-2">
                  {valueInput}
                  {actions}
                </div>
              </div>
            ) : (
              <div key={index} data-slot="env-row" data-layout="inline" className="flex items-start gap-2">
                {nameInput}
                {valueInput}
                {actions}
              </div>
            )
          })}
          <div>
            <Button type="button" variant="outline" onClick={() => commit([...entries, { key: "", value: "" }])}>
              <PlusIcon data-icon="inline-start" />
              添加变量
            </Button>
          </div>
          {entries.length === 0 ? (
            <Hint className="block">还没有环境变量。</Hint>
          ) : null}
        </div>
      )}

      {invalid.length ? (
        <Alert variant="destructive">
          <AlertDescription>
            <p>下面这些行不是合法的 KEY=VALUE，容器里会被跳过（保存时需先修正）：</p>
            <ul className="mt-2 flex flex-col gap-1 font-mono">
              {invalid.map((item) => (
                <li key={item.line}>
                  第 {item.line} 行：{item.text}（{item.reason}）
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      </Field>
    </div>
  )
}
