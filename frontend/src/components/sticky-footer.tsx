import * as React from "react"

import { cn } from "@/lib/utils"

// 整页表单底部固定的保存栏（STYLE.md 第 5 节）：主操作在最右，避让手机的安全区
export function StickyFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sticky-footer"
      className={cn(
        "sticky bottom-0 flex items-center justify-end gap-2 border-t bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        className
      )}
      {...props}
    />
  )
}
