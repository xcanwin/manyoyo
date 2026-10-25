import * as React from "react"

import { cn } from "@/lib/utils"

// 可编辑行（RowList、环境变量表、规则表）的表头单元：12px 黑色加粗，与 DataTable 的表头一致（STYLE.md 第 10 节）
export function ColumnHeader({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="column-header"
      className={cn("text-xs font-semibold text-foreground", className)}
      {...props}
    />
  )
}
