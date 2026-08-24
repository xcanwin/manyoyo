import * as React from "react"
import DOMPurify from "dompurify"
import { marked } from "marked"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

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
}: {
  content: string
  className?: string
}) {
  const [pendingUrl, setPendingUrl] = React.useState<string | null>(null)

  const html = React.useMemo(() => {
    const rawHtml = marked.parse(content || "", { async: false }) as string
    return DOMPurify.sanitize(rawHtml, {
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
      ADD_ATTR: ["referrerpolicy"],
    })
  }, [content])

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
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
      <AlertDialog
        open={pendingUrl !== null}
        onOpenChange={(next) => {
          if (!next) setPendingUrl(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>打开外部链接</AlertDialogTitle>
          <AlertDialogDescription className="break-all">{pendingUrl}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel variant="outline" size="default">
              取消
            </AlertDialogCancel>
            <Button onClick={handleConfirmOpen}>确认并新标签打开</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
