import DOMPurify from "dompurify"
import { marked, Renderer } from "marked"

marked.setOptions({ breaks: true, gfm: true })

// 不自动把正文里的裸网址变成链接：自动识别会把紧跟的括号、标点一起吞进去
// （如 https://a.com(b) 的 href 带上 "(b)"），而且用户给的纯文本就该保持纯文本。
// 显式写的 [文字](网址) 和 <网址> 仍然渲染成链接。裸网址的 link 令牌特征是 raw 与 text 相同。
marked.use({
  walkTokens(token) {
    if (token.type === "link" && token.raw === token.text) {
      const plain = token as unknown as { type: string; escaped?: boolean; tokens?: unknown }
      plain.type = "text"
      plain.escaped = true
      delete plain.tokens
    }
  },
})

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

// lucide 的 copy / check 图标（内联 svg，避免在 innerHTML 里引组件）
export const COPY_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'
export const CHECK_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'

export type RenderedMarkdown = { html: string; htmlBlocks: string[]; codeBlocks: string[] }

// markdown 渲染的核心逻辑：抽成纯函数方便单测，
// MarkdownContent 组件里只负责把 content/enableHtmlPreview 传进来、渲染结果
// 塞进 dangerouslySetInnerHTML
export function renderMarkdownToHtml(content: string, enableHtmlPreview: boolean): RenderedMarkdown {
  const blocks: string[] = []
  const codeBlocks: string[] = []
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
  // 所有代码块右上角都有复制按钮；html 代码块（开启预览时）在它左边多一个“预览”按钮。
  // 原文存进数组、按下标查表（见 MarkdownContent 的 handleClick），不编码进 DOM 属性
  const defaultCode = renderer.code.bind(renderer)
  renderer.code = (token) => {
    const base = defaultCode(token)
    const copyIndex = codeBlocks.length
    codeBlocks.push(token.text)
    let preview = ""
    if (enableHtmlPreview && String(token.lang || "").trim().toLowerCase() === "html") {
      const index = blocks.length
      blocks.push(token.text)
      preview = `<button type="button" data-preview-html-index="${index}" class="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground shadow-sm hover:bg-muted">预览</button>`
    }
    const copy = `<button type="button" title="复制代码" aria-label="复制代码" data-copy-code-index="${copyIndex}" class="flex items-center rounded-md border border-border bg-background p-1.5 text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground">${COPY_ICON}</button>`
    return `<div class="not-prose relative [&_pre]:pr-12">${base}<div class="absolute top-2 right-2 flex gap-1">${preview}${copy}</div></div>`
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
    ADD_ATTR: ["referrerpolicy", "data-preview-html-index", "data-copy-code-index"],
  })
  return { html: sanitized, htmlBlocks: blocks, codeBlocks }
}
