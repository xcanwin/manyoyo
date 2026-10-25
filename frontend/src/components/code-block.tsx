import * as React from "react"

import { cn } from "@/lib/utils"

// 内容区：被展示的等宽预格式文本（原始报错详情、日志、系统提示词原文），12px，不属于界面字档位（STYLE.md 第 2 节）
export function CodeBlock({ className, ...props }: React.ComponentProps<"pre">) {
  return (
    <pre
      data-slot="code-block"
      className={cn(
        "overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs break-all whitespace-pre-wrap",
        className
      )}
      {...props}
    />
  )
}
