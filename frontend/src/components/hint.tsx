import * as React from "react"

import { cn } from "@/lib/utils"

// 辅助档文字（STYLE.md 第 2 节）：12px 灰色。配置键、路径、时间戳、计数用 mono。
// 要独占一行时调用处加 block（或放进 flex-col 里）。
export function Hint({
  mono = false,
  className,
  ...props
}: React.ComponentProps<"span"> & { mono?: boolean }) {
  return (
    <span
      data-slot="hint"
      className={cn("text-xs text-muted-foreground", mono && "font-mono", className)}
      {...props}
    />
  )
}
