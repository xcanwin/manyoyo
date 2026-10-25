import * as React from "react"

import { apiPost } from "@/lib/api"

export type SideQuestionState = {
  sessionName: string
  question: string
  status: "loading" | "done" | "error"
  answer: string
  error: string
}

// 侧问（/btw）：答案只存在内存里，不进对话记录。关闭或换会话时中止请求（服务端会在容器里终止对应进程）
export function useSideQuestion(activeSessionName: string | null) {
  const [state, setState] = React.useState<SideQuestionState | null>(null)
  const controllerRef = React.useRef<AbortController | null>(null)

  const close = React.useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setState(null)
  }, [])

  const ask = React.useCallback(async (sessionName: string, question: string) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setState({ sessionName, question, status: "loading", answer: "", error: "" })
    try {
      const data = await apiPost(`/api/sessions/${encodeURIComponent(sessionName)}/agent/side`, { question }, controller.signal)
      if (controller.signal.aborted) return
      setState({ sessionName, question, status: "done", answer: String(data.answer ?? ""), error: "" })
    } catch (err) {
      if (controller.signal.aborted) return
      setState({ sessionName, question, status: "error", answer: "", error: err instanceof Error ? err.message : "侧问失败" })
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [])

  // 换到别的会话：浮层属于原会话，中止并清掉
  const visible = state && state.sessionName === activeSessionName ? state : null
  React.useEffect(() => {
    if (state && state.sessionName !== activeSessionName) {
      controllerRef.current?.abort()
      controllerRef.current = null
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(null)
    }
  }, [activeSessionName, state])

  return { state: visible, ask, close }
}
