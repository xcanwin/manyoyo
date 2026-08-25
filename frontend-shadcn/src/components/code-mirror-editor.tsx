import * as React from "react"
import { basicSetup } from "codemirror"
import { Compartment, EditorState, Prec } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { yaml } from "@codemirror/lang-yaml"
import { oneDark } from "@codemirror/theme-one-dark"

// 应用整体的暗色靠 <html class="dark">，CodeMirror 自带的 baseTheme 不会跟着变——
// 不额外接主题 oneDark 的话，暗色模式下编辑器会一直保持刺眼的白底（行号槽、
// ctrl+f 搜索面板、markdown 标题号/列表号在光标所在行的高亮背景上更是完全看不清）
function prefersDarkMode(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark")
}

// oneDark 默认背景是偏灰偏亮的 #282c34，且 .cm-gutters 也用同一个颜色、border: none——
// 整个编辑器（代码区 + 行号槽）统一换成更深的 #121314，行号槽再加一条竖线做列分隔。
// 用 Prec.high 包一层再传进 compartment，确保这份样式在合并时总是排在 oneDark 自己的规则
// 后面、盖得过去（普通数组顺序不保证）
const darkGutterFix = EditorView.theme(
  {
    "&": { backgroundColor: "#121314" },
    ".cm-gutters": {
      backgroundColor: "#121314",
      borderRight: "1px solid #3a3f4b",
    },
  },
  { dark: true }
)

// 与 lib/web/frontend/codemirror-entry.js 的 resolveLanguageExtension 对齐
function resolveLanguageExtension(language: string) {
  switch (String(language || "").trim()) {
    case "css":
      return css()
    case "html":
      return html()
    case "javascript":
      return javascript({ jsx: true, typescript: true })
    case "json":
      return json()
    case "markdown":
      return markdown()
    case "python":
      return python()
    case "yaml":
      return yaml()
    default:
      return []
  }
}

export function CodeMirrorEditor({
  value,
  language,
  readOnly,
  onChange,
}: {
  value: string
  language: string
  readOnly: boolean
  onChange?: (value: string) => void
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const viewRef = React.useRef<EditorView | null>(null)
  const languageCompartmentRef = React.useRef(new Compartment())
  const readOnlyCompartmentRef = React.useRef(new Compartment())
  const themeCompartmentRef = React.useRef(new Compartment())
  const onChangeRef = React.useRef(onChange)
  React.useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  const suppressRef = React.useRef(false)

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const languageCompartment = languageCompartmentRef.current
    const readOnlyCompartment = readOnlyCompartmentRef.current
    const themeCompartment = themeCompartmentRef.current
    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || suppressRef.current || !onChangeRef.current) return
            onChangeRef.current(update.state.doc.toString())
          }),
          readOnlyCompartment.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          languageCompartment.of(resolveLanguageExtension(language)),
          themeCompartment.of(prefersDarkMode() ? [oneDark, Prec.high(darkGutterFix)] : []),
          EditorView.theme({
            "&": { height: "100%", fontSize: "12px" },
            ".cm-scroller": { overflow: "auto" },
            // 给纵向滚动条留出空间，避免内容较多时盖住行尾文字
            ".cm-content": { paddingRight: "14px" },
          }),
        ],
      }),
    })
    viewRef.current = view

    // <html class="dark"> 由 ThemeProvider 统一切换，这里只负责跟着重配 compartment，
    // 不重复接入 ThemeProvider 的 context（编辑器实例较底层，用 DOM 观察更省事）
    const observer = new MutationObserver(() => {
      viewRef.current?.dispatch({
        effects: themeCompartmentRef.current.reconfigure(prefersDarkMode() ? [oneDark, Prec.high(darkGutterFix)] : []),
      })
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })

    return () => {
      observer.disconnect()
      view.destroy()
      viewRef.current = null
    }
    // 只在挂载时创建一次编辑器实例；内容/语言/只读状态变化在下方各自的 effect 里
    // 通过 compartment 动态调整，避免每次输入都重建整个 EditorView
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    suppressRef.current = true
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    suppressRef.current = false
  }, [value])

  React.useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageCompartmentRef.current.reconfigure(resolveLanguageExtension(language)),
    })
  }, [language])

  React.useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    })
  }, [readOnly])

  return <div ref={containerRef} className="h-full min-h-64 overflow-hidden rounded-md border" />
}
