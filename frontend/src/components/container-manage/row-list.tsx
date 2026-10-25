import { PlusIcon, Trash2Icon } from "lucide-react"

import { Hint } from "@/components/hint"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

export type RowColumn<T> = {
  key: keyof T & string
  label: string
  placeholder?: string
  /** 宽度类；不写则 flex-1 */
  className?: string
  /** 有 options 时渲染成下拉 */
  options?: { value: string; label: string }[]
  inputMode?: "numeric"
}

// 环境变量、IP 规则、宿主机端口、端口暴露……所有“一行一项”的编辑统一成这个样子：
// 表头（列名 + 操作）→ 每行若干输入框 + 右侧删除按钮 → 下方「添加」按钮。保存按钮由所在卡片统一放在页脚。
export function RowList<T extends Record<string, string>>({
  rows,
  columns,
  onChange,
  newRow,
  addLabel,
  ariaPrefix,
  disableAdd = false,
  renderAction,
}: {
  rows: T[]
  columns: RowColumn<T>[]
  onChange: (rows: T[]) => void
  newRow: () => T
  addLabel: string
  ariaPrefix: string
  disableAdd?: boolean
  /** 放在「操作」列里、删除按钮左侧的额外操作（例如端口暴露的「访问」），宽度固定 */
  renderAction?: { width: string; render: (row: T, index: number) => React.ReactNode }
}) {
  const update = (index: number, patch: Partial<T>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  return (
    <div className="flex flex-col gap-2">
      {rows.length ? (
        <div className="flex items-center gap-2">
          {columns.map((column) => (
            <Hint key={column.key} className={cn("min-w-0 px-1 text-foreground", column.className ?? "flex-1")}>
              {column.label}
            </Hint>
          ))}
          <Hint className={cn("shrink-0 text-center text-foreground", renderAction ? "w-24" : "w-8")}>操作</Hint>
        </div>
      ) : null}
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          {columns.map((column) =>
            column.options ? (
              <Select
                key={column.key}
                value={row[column.key]}
                onValueChange={(value) => value && update(index, { [column.key]: value } as Partial<T>)}
              >
                <SelectTrigger aria-label={`${ariaPrefix}第 ${index + 1} 行${column.label}`} className={cn("min-w-0", column.className ?? "flex-1")}>
                  <SelectValue placeholder={column.placeholder} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {column.options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : (
              <Input
                key={column.key}
                aria-label={`${ariaPrefix}第 ${index + 1} 行${column.label}`}
                className={cn("min-w-0 font-mono", column.className ?? "flex-1")}
                placeholder={column.placeholder}
                inputMode={column.inputMode}
                value={row[column.key]}
                onChange={(event) => update(index, { [column.key]: event.target.value } as Partial<T>)}
              />
            )
          )}
          <div className={cn("flex shrink-0 items-center justify-end gap-1", renderAction ? "w-24" : "w-8")}>
            {renderAction ? (
              <span className={cn("flex items-center justify-center", renderAction.width)}>{renderAction.render(row, index)}</span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label={`删除${ariaPrefix}第 ${index + 1} 行`}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" disabled={disableAdd} onClick={() => onChange([...rows, newRow()])}>
          <PlusIcon data-icon="inline-start" />
          {addLabel}
        </Button>
      </div>
    </div>
  )
}
