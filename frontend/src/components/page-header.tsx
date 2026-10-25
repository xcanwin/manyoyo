import * as React from "react"

import { cn } from "@/lib/utils"

// 整页 / 主视图的标题行（STYLE.md 第 7 节）：标题 + 说明 + 右侧操作。
// compact 是工具栏版：区块标题档、40px 高、底部一条分隔线。
export function PageHeader({
  title,
  description,
  actions,
  compact = false,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  compact?: boolean
  className?: string
}) {
  if (compact) {
    return (
      <div
        data-slot="page-header"
        data-compact
        className={cn("flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3", className)}
      >
        <div className="min-w-0 truncate text-sm font-semibold">{title}</div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    )
  }
  return (
    // 手机上标题和操作上下排列，避免说明文字被挤成窄窄一列
    <div data-slot="page-header" className={cn("flex flex-col gap-4 md:flex-row md:items-start md:justify-between", className)}>
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="font-heading text-base leading-none font-medium">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}
