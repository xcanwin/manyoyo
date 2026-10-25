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
      // font-normal：放在加粗的标签 / 标题里（FieldLabel、CardTitle）时也保持辅助档的 400
      className={cn("text-xs font-normal text-muted-foreground", mono && "font-mono", className)}
      {...props}
    />
  )
}
