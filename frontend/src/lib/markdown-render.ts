import DOMPurify from "dompurify"
import { marked, Renderer } from "marked"

import { escapeHtml, HIGHLIGHT_MESSAGE_MAX_CHARS, highlightCodeElement, normalizeCodeLang } from "@/lib/code-highlight"

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

// 渲染时的容器上下文：有它才能把容器内路径的图片改写成同源的 fs/raw 地址、把路径变成可点开的链接
export type MarkdownContext = {
  sessionName: string
  // 相对路径的基准目录（聊天里是工作目录，文件面板里是文件所在目录）
  baseDir: string
  // 是否把路径渲染成可点开的链接（点击由 MarkdownContent 的 onOpenPath 处理）
  pathLinks?: boolean
}

// 与服务端 fs/raw 的图片扩展名白名单一致（lib/web/server.js 的 IMAGE_EXTENSION_CONTENT_TYPES）
const RAW_IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|ico)$/i

export type ImageResolution =
  | { kind: "img"; src: string }
  | { kind: "external"; href: string }
  | { kind: "path"; path: string }
  | { kind: "blocked" }

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function joinContainerPath(baseDir: string, href: string): string {
  try {
    const base = baseDir.endsWith("/") ? baseDir : `${baseDir}/`
    return safeDecode(new URL(href, "http://manyoyo-internal" + (base.startsWith("/") ? base : `/${base}`)).pathname) ?? ""
  } catch {
    return ""
  }
}

export function buildRawFileUrl(sessionName: string, path: string): string {
  return `/api/sessions/${encodeURIComponent(sessionName)}/fs/raw?path=${encodeURIComponent(path)}`
}

// 图片地址的唯一解析规则（markdown 写法与原始 HTML 的 <img> 都走这里）：
// 站内地址原样用；外链要点击确认；data: 等其他协议不显示；
// 有容器上下文时，容器内路径（绝对 / 相对）且扩展名在白名单里的改写成 fs/raw，其余变成可点开的路径
export function resolveImageSrc(src: string, ctx?: MarkdownContext): ImageResolution {
  // 先按浏览器的方式规范化：去掉空白和控制字符、反斜杠当斜杠（否则 “/\evil.com”“ht\ttps:” 会绕过下面的判断）
  // eslint-disable-next-line no-control-regex -- 就是要去掉控制字符
  const value = String(src || "").replace(/[\u0000-\u0020\u007f]/g, "").replace(/\\/g, "/")
  if (!value) return { kind: "blocked" }
  if (value.startsWith("/api/sessions/")) return { kind: "img", src: value }
  if (/^https?:/i.test(value)) return { kind: "external", href: value }
  if (value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return { kind: "blocked" }
  if (!ctx) return { kind: "img", src: value }
  const path = value.startsWith("/") ? joinContainerPath("/", value) : joinContainerPath(ctx.baseDir || "/", value)
  if (!path) return { kind: "blocked" }
  if (RAW_IMAGE_EXT.test(path)) return { kind: "img", src: buildRawFileUrl(ctx.sessionName, path) }
  return { kind: "path", path }
}

// 只认“整段就是一个容器内绝对路径”的写法，正文里的普通文字不扫描
const ABSOLUTE_PATH = /^\/(?!\/)[^\s`<>"']+$/

function isOpenablePath(href: string): boolean {
  return ABSOLUTE_PATH.test(href) && !href.startsWith("/api/")
}

// 行内代码里的相对路径：./ ../ 开头、中间带 /、或常见扩展名的单个文件名；裸单词（aaa）不算
const RELATIVE_PATH = /^(?:\.{1,2}\/|[\w.-]+\/|[\w.-]+\.(?:txt|md|json|jsonc|ya?ml|toml|js|mjs|cjs|jsx|tsx?|py|sh|html|css|csv|png|jpe?g|gif|webp|svg|go|java|rs|c|h|cpp|sql|xml|zip|tar|gz|pdf)$)[^\s`<>"':]*$/

function resolveCodePath(text: string, baseDir: string): string | null {
    if (isOpenablePath(text)) return text
    if (!RELATIVE_PATH.test(text)) return null
    const resolved = joinContainerPath(baseDir, text)
    if (!resolved) return null
    return resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved
}

function postProcess(fragment: DocumentFragment, ctx?: MarkdownContext) {
  const doc = fragment.ownerDocument
  let highlightBudget = HIGHLIGHT_MESSAGE_MAX_CHARS
  for (const code of Array.from(fragment.querySelectorAll<HTMLElement>("pre > code[class^='language-']"))) {
    const lang = normalizeCodeLang(code.className.replace(/^language-/, ""))
    const length = code.textContent?.length ?? 0
    if (!lang || length > highlightBudget) continue
    if (highlightCodeElement(code, lang)) highlightBudget -= length
  }
  for (const img of Array.from(fragment.querySelectorAll("img"))) {
    const alt = img.getAttribute("alt") || ""
    const resolved = resolveImageSrc(img.getAttribute("src") || "", ctx)
    if (resolved.kind === "img") {
      img.setAttribute("src", resolved.src)
      continue
    }
    let replacement: Node
    if (resolved.kind === "external") {
      const a = doc.createElement("a")
      a.setAttribute("href", resolved.href)
      a.setAttribute("referrerpolicy", "no-referrer")
      a.setAttribute("rel", "noopener noreferrer")
      a.textContent = `🖼️ 点击查看图片：${alt || resolved.href}`
      replacement = a
    } else if (resolved.kind === "path" && ctx?.pathLinks) {
      const a = doc.createElement("a")
      a.setAttribute("href", "#")
      a.setAttribute("data-open-path", resolved.path)
      a.textContent = `🖼️ ${alt || resolved.path}`
      replacement = a
    } else {
      replacement = doc.createTextNode(alt ? `[图片：${alt}]` : "")
    }
    img.replaceWith(replacement)
  }
  if (!ctx?.pathLinks) return
  for (const a of Array.from(fragment.querySelectorAll("a[href]"))) {
    if (a.hasAttribute("data-open-path")) continue
    const href = a.getAttribute("href") || ""
    if (!isOpenablePath(href)) continue
    const decoded = safeDecode(href)
    if (decoded === null) continue
    a.setAttribute("data-open-path", decoded)
    a.setAttribute("href", "#")
  }
  for (const code of Array.from(fragment.querySelectorAll("code"))) {
    if (code.closest("pre") || code.closest("a")) continue
    const text = code.textContent || ""
    const path = resolveCodePath(text, ctx.baseDir || "/")
    if (!path) continue
    const a = doc.createElement("a")
    a.setAttribute("href", "#")
    a.setAttribute("data-open-path", path)
    code.replaceWith(a)
    a.appendChild(code)
  }
}

// markdown 渲染的核心逻辑：抽成纯函数方便单测，
// MarkdownContent 组件里只负责把 content/enableHtmlPreview 传进来、渲染结果
// 塞进 dangerouslySetInnerHTML
export function renderMarkdownToHtml(content: string, enableHtmlPreview: boolean, ctx?: MarkdownContext): RenderedMarkdown {
  const blocks: string[] = []
  const codeBlocks: string[] = []
  const renderer = new Renderer()
  // 所有代码块右上角都有复制按钮；html 代码块（开启预览时）在它左边多一个“预览”按钮。
  // 原文存进数组、按下标查表（见 MarkdownContent 的 handleClick），不编码进 DOM 属性
  const defaultCode = renderer.code.bind(renderer)
  renderer.code = (token) => {
    const lang = normalizeCodeLang(token.lang)
    // 高亮在消毒之后、直接在 DOM 上做（见 postProcess），这里只输出转义后的纯文本
    const base = defaultCode({ ...token, lang: lang || undefined })
    const copyIndex = codeBlocks.length
    codeBlocks.push(token.text)
    let preview = ""
    if (enableHtmlPreview && String(token.lang || "").trim().toLowerCase() === "html") {
      const index = blocks.length
      blocks.push(token.text)
      preview = `<button type="button" data-preview-html-index="${index}" class="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground shadow-sm hover:bg-muted">预览</button>`
    }
    const copy = `<button type="button" title="复制代码" aria-label="复制代码" data-copy-code-index="${copyIndex}" class="flex items-center rounded-md border border-border bg-background p-1.5 text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground">${COPY_ICON}</button>`
    // 语言标签放在右上角按钮左边（与按钮同一行，不压住第一行代码）
    const label = lang ? `<span data-code-lang="${escapeHtml(lang)}" class="self-center px-1 text-xs text-muted-foreground select-none">${escapeHtml(lang)}</span>` : ""
    // 有语言标签时右上角更宽，代码从按钮下方开始（窄屏上长行不会被标签盖住）
    const pad = lang ? "[&_pre]:pt-10 [&_pre]:pb-3.5" : "[&_pre]:py-3.5"
    return `<div class="not-prose relative [&_pre]:overflow-x-auto ${pad} [&_pre]:pl-4 [&_pre]:pr-14">${base}<div class="absolute top-2 right-2 flex gap-1">${label}${preview}${copy}</div></div>`
  }
  // 单元格内容包一层 div：列很多、表格放不下时，浏览器会把每列压到最窄，一句话被折成好几行。
  // 在这层 div 上给最小宽度（见 index.css 的 .md-cell），长内容的列就不会被压得太窄
  const defaultTablecell = renderer.tablecell.bind(renderer)
  renderer.tablecell = (token) =>
    defaultTablecell(token).replace(/^(<t[hd][^>]*>)([\s\S]*)(<\/t[hd]>\s*)$/, '$1<div class="md-cell">$2</div>$3')
  const rawHtml = marked.parse(content || "", { async: false, renderer }) as string
  const fragment = DOMPurify.sanitize(rawHtml, {
    RETURN_DOM_FRAGMENT: true,
    // 只允许 https/mailto/tel 这几个协议、锚点，以及不带协议头的相对路径
    // （如 "diagram.png"、"images/pic.png"、"./a.png"、"/api/..."）；
    // 明确拒绝 javascript:/data:/vbscript: 等危险协议。写法对齐 DOMPurify 自身默认
    // 正则（node_modules/dompurify 里的 IS_ALLOWED_URI）的相对路径判定分支，
    // 只是把协议白名单收窄到项目实际用到的几个——之前收窄成只认 "/" 开头，
    // 漏掉了不带开头斜杠的相对路径，会导致这类图片的 src 被整个过滤掉
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
    ADD_ATTR: ["referrerpolicy", "data-preview-html-index", "data-copy-code-index", "data-code-lang"],
  })
  // 图片与路径统一在消毒之后处理：markdown 写法和原始 HTML 的 <img> 都会经过这里，
  // 新建的节点只设置固定的几个属性，文字用 textContent，不会引入新的标签
  postProcess(fragment, ctx)
  const holder = fragment.ownerDocument.createElement("div")
  holder.appendChild(fragment)
  return { html: holder.innerHTML, htmlBlocks: blocks, codeBlocks }
}
