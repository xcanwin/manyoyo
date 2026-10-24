import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

// 折叠区（STYLE.md 第 7 节）：每块上方一条分割线，标题是区块标题档（14px / 600），悬停变色，默认收起；
// 展开态不另加背景或描边。
export function SectionToggle({
  title,
  children,
}: {
  title: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Collapsible className="border-t pt-2">
      <CollapsibleTrigger className="group/section -mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm font-semibold outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
        {title}
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/section:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}
