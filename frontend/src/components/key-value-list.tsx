import * as React from "react"

import { cn } from "@/lib/utils"

export type KeyValueItem = {
  label: React.ReactNode
  value: React.ReactNode
  detail?: React.ReactNode
}

// 只读的“名称：值”信息（STYLE.md 第 7 节）：桌面两列，手机单列；标签辅助档，值正文
export function KeyValueList({ items, className }: { items: KeyValueItem[]; className?: string }) {
  return (
    <dl
      data-slot="key-value-list"
      className={cn("grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2", className)}
    >
      {items.map((item, index) => (
        <div key={index} className="flex min-w-0 flex-col gap-1">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="text-sm break-words">{item.value}</dd>
          {item.detail ? <dd className="text-xs text-muted-foreground">{item.detail}</dd> : null}
        </div>
      ))}
    </dl>
  )
}
