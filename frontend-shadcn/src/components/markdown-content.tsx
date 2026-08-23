import * as React from "react"
import DOMPurify from "dompurify"
import { marked } from "marked"

import { cn } from "@/lib/utils"

marked.setOptions({ breaks: true, gfm: true })

export function MarkdownContent({
  content,
  className,
}: {
  content: string
  className?: string
}) {
  const html = React.useMemo(() => {
    const rawHtml = marked.parse(content || "", { async: false }) as string
    return DOMPurify.sanitize(rawHtml, {
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
    })
  }, [content])

  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none break-words prose-pre:bg-muted prose-pre:text-foreground",
        className
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
