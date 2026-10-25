import * as React from "react"

import { KeyValueList } from "@/components/key-value-list"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import {
  contextPercentText,
  contextReadout,
  usageRows,
  type ContextUsage,
} from "@/lib/context-usage"

// 模型菜单旁边的小读数（仅 claude，没数据不显示）：点开看上下文占用、缓存命中和空闲提示
export function ContextMeter({
  usage,
  compact = false,
}: {
  usage: ContextUsage | null | undefined
  // 手机上只显示百分比（如 “58%”），完整读数在点开的浮层里
  compact?: boolean
}) {
  const [now, setNow] = React.useState(() => Date.now())
  if (!usage) return null
  const label = contextReadout(usage)
  return (
    <Popover onOpenChange={(open) => open && setNow(Date.now())}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="touch-hit shrink-0 font-mono leading-none"
            title={`上下文占用：${label}`}
            aria-label={`上下文占用：${label}`}
          />
        }
      >
        {compact ? contextPercentText(usage) : label}
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72">
        <KeyValueList className="md:grid-cols-1" items={usageRows(usage, now).map((row) => ({ label: row.label, value: row.value, detail: row.note }))} />
      </PopoverContent>
    </Popover>
  )
}
