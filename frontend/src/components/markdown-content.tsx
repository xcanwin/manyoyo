import * as React from "react"

import { cn } from "@/lib/utils"
import { CHECK_ICON, renderMarkdownToHtml } from "@/lib/markdown-render"
import { sessionPathExists } from "@/lib/path-exists"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"

type MarkdownContentProps = {
  content: string
  className?: string
  onPreviewHtml?: (code: string) => void
  // 有会话上下文时，容器内路径的图片会改写成 fs/raw，路径可以点开（交给 onOpenPath）
  sessionName?: string
  baseDir?: string
  onOpenPath?: (path: string) => void
}

// 只比较 content/className/是否传了 onPreviewHtml，忽略 onPreviewHtml 的函数
// 引用本身——调用方在消息列表的 map 里内联传入这个回调，每次因轮询触发的重渲染
// 都会拿到新的函数引用，若按默认浅比较会导致 content 完全没变也判定为"变了"
export function markdownContentPropsEqual(prev: MarkdownContentProps, next: MarkdownContentProps): boolean {
  return (
    prev.content === next.content &&
    prev.className === next.className &&
    prev.sessionName === next.sessionName &&
    prev.baseDir === next.baseDir &&
    Boolean(prev.onPreviewHtml) === Boolean(next.onPreviewHtml) &&
    Boolean(prev.onOpenPath) === Boolean(next.onOpenPath)
  )
}

// 外链二次确认：Agent 回复里可能有它自己生成或从外部抓取的链接，直接点开有钓鱼风险，
// 拦截点击后先展示真实 URL 二次确认，确认后才用 noopener/noreferrer 新标签打开。
//
// 用 React.memo + markdownContentPropsEqual——消息列表所在的 ActivityView 每次
// 轮询同步都会整体重渲染，不做 memo 的话即便 content 没变，这个组件的函数体也会
// 重新执行，dangerouslySetInnerHTML 拿到的是新的 { __html } 包装对象，React 仍会
// 据此重设 innerHTML，把代码块内部已有的横向滚动位置/文字选区悄悄清零（移动端
// 表现为横滑查看代码块时滚动条突然复位、选中文字也会被打断）。
export const MarkdownContent = React.memo(
  function MarkdownContent({
    content,
    className,
    onPreviewHtml,
    sessionName,
    baseDir,
    onOpenPath,
  }: MarkdownContentProps) {
    const [pendingUrl, setPendingUrl] = React.useState<string | null>(null)

    // 代码块原文存进这份和 html 一起算出来的数组，而不是编码进 DOM 属性——
    // 避免大段 html 反复转义/截断，handleClick 委托点击时按下标查表即可
    const enablePreview = Boolean(onPreviewHtml)
    const pathLinks = Boolean(onOpenPath)
    const { html, htmlBlocks, codeBlocks } = React.useMemo(
      () =>
        renderMarkdownToHtml(
          content,
          enablePreview,
          sessionName ? { sessionName, baseDir: baseDir || "/", pathLinks } : undefined
        ),
      [content, enablePreview, sessionName, baseDir, pathLinks]
    )

    function handleClick(event: React.MouseEvent<HTMLDivElement>) {
      const copyTrigger = (event.target as HTMLElement).closest<HTMLElement>("[data-copy-code-index]")
      if (copyTrigger) {
        const code = codeBlocks[Number(copyTrigger.getAttribute("data-copy-code-index"))]
        if (code !== undefined) {
          navigator.clipboard.writeText(code).then(
            () => {
              // 短暂换成对勾表示已复制；直接改这颗按钮的 DOM，不触发整段 markdown 重渲染
              const original = copyTrigger.innerHTML
              copyTrigger.innerHTML = CHECK_ICON
              window.setTimeout(() => {
                copyTrigger.innerHTML = original
              }, 1500)
            },
            () => {
              // 剪贴板权限被拒绝时静默失败，不打断阅读
            }
          )
        }
        return
      }
      const previewTrigger = (event.target as HTMLElement).closest("[data-preview-html-index]")
      if (previewTrigger) {
        const index = Number(previewTrigger.getAttribute("data-preview-html-index"))
        const code = htmlBlocks[index]
        if (code !== undefined) onPreviewHtml?.(code)
        return
      }
      const pathTrigger = (event.target as HTMLElement).closest<HTMLElement>("[data-open-path]")
      if (pathTrigger) {
        event.preventDefault()
        const path = pathTrigger.getAttribute("data-open-path") || ""
        if (!path || !onOpenPath) return
        // 先确认路径存在才打开；不存在就什么都不做
        if (!sessionName) {
          onOpenPath(path)
          return
        }
        void sessionPathExists(sessionName, path).then((exists) => {
          if (exists) onOpenPath(path)
        })
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
          // 排版细节（字号档位、代码块、表格、引用、颜色）集中在 index.css 的 .chat-markdown
          className={cn(
            "prose prose-sm chat-markdown max-w-none break-words",
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
  },
  markdownContentPropsEqual
)
