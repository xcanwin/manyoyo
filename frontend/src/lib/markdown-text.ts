import { marked } from "marked"

// 供"复制文本"功能使用：取渲染后的纯文本（而不是 markdown 源码）。
// 用 DOMParser 而不是 dangerouslySetInnerHTML 挂载到页面，天然不会执行脚本，
// 这里只读 textContent，不需要再过一遍 DOMPurify
export function markdownToPlainText(markdown: string): string {
  const html = marked.parse(markdown || "", { async: false }) as string
  const doc = new DOMParser().parseFromString(html, "text/html")
  return doc.body.textContent || ""
}
