import { classHighlighter, highlightCode } from "@lezer/highlight"
import type { Parser } from "@lezer/common"
import { cssLanguage } from "@codemirror/lang-css"
import { htmlLanguage } from "@codemirror/lang-html"
import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from "@codemirror/lang-javascript"
import { jsonLanguage } from "@codemirror/lang-json"
import { markdownLanguage } from "@codemirror/lang-markdown"
import { pythonLanguage } from "@codemirror/lang-python"
import { yamlLanguage } from "@codemirror/lang-yaml"
import { StreamLanguage } from "@codemirror/language"
import { shell } from "@codemirror/legacy-modes/mode/shell"

// Agent 回复里最常见的就是 shell 命令；legacy-modes 只引 shell 这一个模式（体积见 FEEDBACK）
// legacy-modes 6.5 的类型来自新拆出的 @codemirror/streamparser，StringStream 与 @codemirror/language 的
// 只差一个私有字段声明（运行时是同一套接口，用例覆盖了 shell 高亮），这里只做类型转换
const shellParser = StreamLanguage.define(shell as unknown as Parameters<typeof StreamLanguage.define>[0]).parser

// 聊天里代码块的高亮：复用文件编辑器已经打包进来的 CodeMirror 语言包（产物是单文件，
// 不能按需加载，另引一套高亮库只会让体积翻倍）。只在消息渲染完成后做一次（流式期间本来就只显示纯文本）
const PARSERS: Record<string, Parser> = {
  js: javascriptLanguage.parser,
  javascript: javascriptLanguage.parser,
  mjs: javascriptLanguage.parser,
  cjs: javascriptLanguage.parser,
  jsx: jsxLanguage.parser,
  ts: typescriptLanguage.parser,
  typescript: typescriptLanguage.parser,
  tsx: tsxLanguage.parser,
  json: jsonLanguage.parser,
  json5: jsonLanguage.parser,
  css: cssLanguage.parser,
  html: htmlLanguage.parser,
  vue: htmlLanguage.parser,
  python: pythonLanguage.parser,
  py: pythonLanguage.parser,
  yaml: yamlLanguage.parser,
  yml: yamlLanguage.parser,
  md: markdownLanguage.parser,
  markdown: markdownLanguage.parser,
  sh: shellParser,
  bash: shellParser,
  shell: shellParser,
  zsh: shellParser,
  console: shellParser,
}

// 单个代码块超过这个长度就不高亮（只显示语言标签）：避免一段超长输出卡住渲染
export const HIGHLIGHT_MAX_CHARS = 20_000
// 一条消息里高亮的总字数上限：超出后剩下的代码块只显示语言标签。
// 实测（Chrome，50 块共 3000 行）全部高亮要多花约 49ms，有了上限后极端消息也只多花几毫秒
export const HIGHLIGHT_MESSAGE_MAX_CHARS = 40_000

const LANG_PATTERN = /^[A-Za-z0-9+#._-]{1,20}$/

// fence 的 info 取第一个词作语言名；不合规的直接丢掉，不进任何属性
export function normalizeCodeLang(info: string | undefined): string {
  const first = String(info || "").trim().split(/\s+/)[0] || ""
  return LANG_PATTERN.test(first) ? first.toLowerCase() : ""
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

// 在已经消毒过的 DOM 上原地高亮：只新建 <span class="tok-…"> 和文本节点（textContent），
// 不经过任何 HTML 解析，所以不需要再消毒，也省掉了解析几万个 span 的开销。不支持或太长时返回 false
export function highlightCodeElement(code: HTMLElement, lang: string): boolean {
  const parser = PARSERS[lang]
  const text = code.textContent || ""
  if (!parser || text.length > HIGHLIGHT_MAX_CHARS) return false
  const doc = code.ownerDocument
  const fragment = doc.createDocumentFragment()
  try {
    highlightCode(
      text,
      parser.parse(text),
      classHighlighter,
      (piece, classes) => {
        if (!classes) {
          fragment.appendChild(doc.createTextNode(piece))
          return
        }
        const span = doc.createElement("span")
        span.className = classes
        span.textContent = piece
        fragment.appendChild(span)
      },
      () => {
        fragment.appendChild(doc.createTextNode("\n"))
      }
    )
  } catch {
    return false
  }
  code.replaceChildren(fragment)
  return true
}
