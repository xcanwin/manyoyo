import DOMPurify from "dompurify"
import { marked, Renderer } from "marked"

marked.setOptions({ breaks: true, gfm: true })

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// 防止 markdown 内容里的图片加载、外部链接携带 Referer 泄露当前站点地址给第三方
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "IMG" || node.tagName === "A") {
    node.setAttribute("referrerpolicy", "no-referrer")
  }
  if (node.tagName === "A") {
    node.setAttribute("rel", "noopener noreferrer")
  }
})

export type RenderedMarkdown = { html: string; htmlBlocks: string[] }

// 与旧版前端 markdown-renderer.js 对齐的核心渲染逻辑：抽成纯函数方便单测，
// MarkdownContent 组件里只负责把 content/enableHtmlPreview 传进来、渲染结果
// 塞进 dangerouslySetInnerHTML
export function renderMarkdownToHtml(content: string, enableHtmlPreview: boolean): RenderedMarkdown {
  const blocks: string[] = []
  const renderer = new Renderer()
  const defaultImage = renderer.image.bind(renderer)
  // 外部 http(s) 图片转为需用户点击确认的链接，避免消息一渲染就自动发起外部
  // 请求（跟踪像素/IP 泄露）；相对路径图片（走容器文件接口，同源）仍按普通 <img> 渲染
  renderer.image = (token) => {
    const { href } = token
    if (/^https?:/i.test(href || "")) {
      const label = escapeHtml(token.text || href)
      return `<a href="${escapeHtml(href)}" title="${escapeHtml(token.title || "")}">🖼️ 点击查看图片：${label}</a>`
    }
    return defaultImage(token)
  }
  if (enableHtmlPreview) {
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
    // 只允许 https/mailto/tel 这几个协议、锚点，以及不带协议头的相对路径
    // （如 "diagram.png"、"images/pic.png"、"./a.png"、"/api/..."）；
    // 明确拒绝 javascript:/data:/vbscript: 等危险协议。写法对齐 DOMPurify 自身默认
    // 正则（node_modules/dompurify 里的 IS_ALLOWED_URI）的相对路径判定分支，
    // 只是把协议白名单收窄到项目实际用到的几个——之前收窄成只认 "/" 开头，
    // 漏掉了不带开头斜杠的相对路径，会导致这类图片的 src 被整个过滤掉
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
    ADD_ATTR: ["referrerpolicy", "data-preview-html-index"],
  })
  return { html: sanitized, htmlBlocks: blocks }
}
