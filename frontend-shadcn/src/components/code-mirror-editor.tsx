import * as React from "react"
import { basicSetup } from "codemirror"
import { Compartment, EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { yaml } from "@codemirror/lang-yaml"

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
          EditorView.theme({
            "&": { height: "100%", fontSize: "12px" },
            ".cm-scroller": { overflow: "auto" },
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
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
