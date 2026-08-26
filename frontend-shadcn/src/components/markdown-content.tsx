import * as React from "react"

import { cn } from "@/lib/utils"
import { renderMarkdownToHtml } from "@/lib/markdown-render"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"

// 与旧版前端的 openExternalLinkModalView/confirmExternalLinkOpen 对齐：
// Agent 回复内容可能包含 Agent 自己生成或从外部抓取的链接，直接点开有钓鱼风险，
// 拦截点击后先展示真实 URL 二次确认，确认后才用 noopener/noreferrer 新标签打开。
export function MarkdownContent({
  content,
  className,
  onPreviewHtml,
}: {
  content: string
  className?: string
  onPreviewHtml?: (code: string) => void
}) {
  const [pendingUrl, setPendingUrl] = React.useState<string | null>(null)

  // 代码块原文存进这份和 html 一起算出来的数组，而不是编码进 DOM 属性——
  // 避免大段 html 反复转义/截断，handleClick 委托点击时按下标查表即可
  const { html, htmlBlocks } = React.useMemo(
    () => renderMarkdownToHtml(content, Boolean(onPreviewHtml)),
    [content, onPreviewHtml]
  )

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    const previewTrigger = (event.target as HTMLElement).closest("[data-preview-html-index]")
    if (previewTrigger) {
      const index = Number(previewTrigger.getAttribute("data-preview-html-index"))
      const code = htmlBlocks[index]
      if (code !== undefined) onPreviewHtml?.(code)
      return
    }
    const link = (event.target as HTMLElement).closest("a")
    if (!link) return
    const href = link.getAttribute("href") || ""
    if (!href || href.startsWith("#")) return
    event.preventDefault()
    setPendingUrl(href)
  }

  function handleConfirmOpen() {
    const url = pendingUrl
    setPendingUrl(null)
    if (!url) return
    const popup = window.open(url, "_blank", "noopener,noreferrer")
    if (popup) {
      popup.opener = null
    }
  }

  return (
    <>
      <div
        className={cn(
          "prose prose-sm dark:prose-invert max-w-none break-words",
          // prose-sm 的 code 用 em 相对缩放，算下来比气泡正文还小，这里固定跟正文一样大
          "prose-code:text-sm prose-pre:text-sm",
          // 代码块背景改用 foreground 的浅色叠加而不是 muted——跟气泡本身的 muted 底色太接近，
          // 混在一起分不清代码块的边界。prose-pre: 修饰符只改 typography 插件自己的
          // --tw-prose-pre-bg 变量，套不到实际渲染的 background-color 上，改用直接的
          // 后代选择器 + !important 绕开插件内部的变量间接层
          "[&_pre]:bg-foreground/10! dark:[&_pre]:bg-foreground/15! prose-pre:text-foreground",
          // 表格默认可能比气泡宽，加 overflow-x-auto 让它能横向滚动，再给一条常驻可见的
          // 细滚动条（不依赖系统"仅交互时显示"的覆盖式滚动条），避免用户看不出还能往右滑
          "[&_table]:block [&_table]:overflow-x-auto [&_table]:[scrollbar-width:thin] [&_table::-webkit-scrollbar]:h-1.5 [&_table::-webkit-scrollbar-thumb]:rounded-full [&_table::-webkit-scrollbar-thumb]:bg-foreground/25",
          className
        )}
        onClick={handleClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <Dialog
        open={pendingUrl !== null}
        onOpenChange={(next) => {
          if (!next) setPendingUrl(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>打开外部链接</DialogTitle>
          <DialogDescription className="break-all">{pendingUrl}</DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingUrl(null)}>
              取消
            </Button>
            <Button onClick={handleConfirmOpen}>确认并新标签打开</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
