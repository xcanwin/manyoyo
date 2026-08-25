import * as React from "react"
import DOMPurify from "dompurify"
import { marked, Renderer } from "marked"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"

marked.setOptions({ breaks: true, gfm: true })

// 防止 markdown 内容里的图片加载、外部链接携带 Referer 泄露当前站点地址给第三方
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "IMG" || node.tagName === "A") {
    node.setAttribute("referrerpolicy", "no-referrer")
  }
  if (node.tagName === "A") {
    node.setAttribute("rel", "noopener noreferrer")
  }
})

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
  const { html, htmlBlocks } = React.useMemo(() => {
    const blocks: string[] = []
    const renderer = new Renderer()
    if (onPreviewHtml) {
      const defaultCode = renderer.code.bind(renderer)
      renderer.code = (token) => {
        const base = defaultCode(token)
        if (String(token.lang || "").trim().toLowerCase() !== "html") return base
        const index = blocks.length
        blocks.push(token.text)
        return `<div class="not-prose relative">${base}<button type="button" data-preview-html-index="${index}" class="absolute top-2 right-2 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground shadow-sm hover:bg-muted">预览</button></div>`
      }
    }
    const rawHtml = marked.parse(content || "", { async: false, renderer }) as string
    const sanitized = DOMPurify.sanitize(rawHtml, {
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
      ADD_ATTR: ["referrerpolicy", "data-preview-html-index"],
    })
    return { html: sanitized, htmlBlocks: blocks }
  }, [content, onPreviewHtml])

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
          "prose prose-sm dark:prose-invert max-w-none break-words prose-pre:bg-muted prose-pre:text-foreground",
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
