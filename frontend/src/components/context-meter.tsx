import * as React from "react"
import { GaugeIcon } from "lucide-react"

import { Hint } from "@/components/hint"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import {
  cacheHitPercent,
  contextReadout,
  formatTokens,
  idleHint,
  type ContextUsage,
} from "@/lib/context-usage"

// 模型菜单旁边的小读数（仅 claude，没数据不显示）：点开看上下文占用、缓存命中和空闲提示
export function ContextMeter({
  usage,
  compact = false,
  size = "icon-lg",
}: {
  usage: ContextUsage | null | undefined
  // 手机上一行放不下读数文字：只显示一个图标，读数在点开的浮层里
  compact?: boolean
  size?: "icon-lg" | "icon-xl"
}) {
  const [now, setNow] = React.useState(() => Date.now())
  if (!usage) return null
  const hit = cacheHitPercent(usage)
  const idle = idleHint(usage.updatedAt, now)
  const label = contextReadout(usage)
  return (
    <Popover onOpenChange={(open) => open && setNow(Date.now())}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size={compact ? size : "sm"}
            className={compact ? "shrink-0" : "touch-hit shrink-0 font-mono"}
            title={`上下文占用：${label}`}
            aria-label={`上下文占用：${label}`}
          />
        }
      >
        {compact ? <GaugeIcon /> : label}
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72">
        <div className="flex flex-col gap-2">
          <span>
            {compact ? `${label}，` : ""}上下文 {formatTokens(usage.usedTokens)}
            {usage.window ? ` / ${formatTokens(usage.window)}` : ""}
          </span>
          {hit !== null ? <Hint>上一次请求里 {hit}% 的输入来自缓存</Hint> : null}
          {idle ? <Hint>{idle}</Hint> : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
