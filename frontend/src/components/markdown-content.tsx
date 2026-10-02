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

type MarkdownContentProps = {
  content: string
  className?: string
  onPreviewHtml?: (code: string) => void
}

// 只比较 content/className/是否传了 onPreviewHtml，忽略 onPreviewHtml 的函数
// 引用本身——调用方在消息列表的 map 里内联传入这个回调，每次因轮询触发的重渲染
// 都会拿到新的函数引用，若按默认浅比较会导致 content 完全没变也判定为"变了"
export function markdownContentPropsEqual(prev: MarkdownContentProps, next: MarkdownContentProps): boolean {
  return (
    prev.content === next.content &&
    prev.className === next.className &&
    Boolean(prev.onPreviewHtml) === Boolean(next.onPreviewHtml)
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
  }: MarkdownContentProps) {
    const [pendingUrl, setPendingUrl] = React.useState<string | null>(null)

    // 代码块原文存进这份和 html 一起算出来的数组，而不是编码进 DOM 属性——
    // 避免大段 html 反复转义/截断，handleClick 委托点击时按下标查表即可
    const { html, htmlBlocks } = React.useMemo(
      () => renderMarkdownToHtml(content, Boolean(onPreviewHtml)),
      [content, Boolean(onPreviewHtml)]
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
            // prose-sm 是为长文档设计的排版参数（行高 ≈1.71、段落上下各留 16px），
            // 套进聊天气泡显得松散；这里用更紧凑的排版
            // （行高 1.6、块级元素 margin 0.6em、列表项不额外加 margin）
            "prose-p:my-[0.6em] prose-p:leading-[1.6] prose-li:my-0",
            "prose-ul:my-[0.6em] prose-ol:my-[0.6em] prose-blockquote:my-[0.6em]",
            // prose-sm 的 code 用 em 相对缩放，算下来比气泡正文还小，这里固定跟正文一样大
            "prose-code:text-sm prose-pre:text-sm prose-pre:my-[0.6em]",
            // typography 插件默认给行内 code 补一对 ` 伪元素、并把字重提到 600，
            // 于是 `foo` 在页面上就是"加粗的 foo 前后各挂一个反引号"，既不像代码
            // 也没有底色区分。去掉伪元素与加粗，换成底色+圆角的常规行内代码样式；
            // :not(pre)>code 把代码块内部的 code 排除在外，避免和 pre 的底色叠两层
            "prose-code:before:content-none prose-code:after:content-none prose-code:font-normal",
            "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-foreground/10 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5",
            "dark:[&_:not(pre)>code]:bg-foreground/15",
            // 代码块背景改用 foreground 的浅色叠加而不是 muted——跟气泡本身的 muted 底色太接近，
            // 混在一起分不清代码块的边界。prose-pre: 修饰符只改 typography 插件自己的
            // --tw-prose-pre-bg 变量，套不到实际渲染的 background-color 上，改用直接的
            // 后代选择器 + !important 绕开插件内部的变量间接层
            "[&_pre]:bg-foreground/10! dark:[&_pre]:bg-foreground/15! prose-pre:text-foreground",
            // 表格默认可能比气泡宽，加 overflow-x-auto 让它能横向滚动，再给一条常驻可见的
            // 细滚动条（不依赖系统"仅交互时显示"的覆盖式滚动条），避免用户看不出还能往右滑
            "prose-table:my-[0.6em] [&_table]:block [&_table]:overflow-x-auto [&_table]:[scrollbar-width:thin] [&_table::-webkit-scrollbar]:h-1.5 [&_table::-webkit-scrollbar-thumb]:rounded-full [&_table::-webkit-scrollbar-thumb]:bg-foreground/25",
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
