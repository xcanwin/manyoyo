import * as React from "react"

import { sessionDisplayTitle, type SessionSummary } from "@/lib/api"
import { findFinishedSessions, notifyFinished, shouldMarkUnseen } from "@/lib/attention"

// 任务结束但用户没看到（页面在后台，或不是当前会话）时记下来，用于标签页标题角标与浏览器通知；
// 用户回到页面并打开那个会话后清掉。不新增轮询：当前会话的结束由工作台直接上报（markFinished），
// 其他会话在会话列表刷新时比对 agentRunning（工作台的同步循环每轮都会刷新会话列表，切回页面时也会立刻刷新）
export function useAttention({
  sessions,
  activeSessionName,
}: {
  sessions: SessionSummary[]
  activeSessionName: string | null
}) {
  const [unseen, setUnseen] = React.useState<ReadonlySet<string>>(() => new Set())
  const activeRef = React.useRef(activeSessionName)
  const sessionsRef = React.useRef(sessions)
  const unseenRef = React.useRef(unseen)
  const prevRunningRef = React.useRef<Set<string>>(new Set())

  React.useEffect(() => {
    activeRef.current = activeSessionName
    sessionsRef.current = sessions
    unseenRef.current = unseen
  })

  const markFinished = React.useCallback((name: string) => {
    if (!shouldMarkUnseen(name, activeRef.current, document.hidden)) return
    if (unseenRef.current.has(name)) return
    const next = new Set(unseenRef.current)
    next.add(name)
    unseenRef.current = next
    setUnseen(next)
    notifyFinished(sessionDisplayTitle(sessionsRef.current.find((s) => s.name === name)))
  }, [])

  React.useEffect(() => {
    const finished = findFinishedSessions(prevRunningRef.current, sessions)
    prevRunningRef.current = new Set(sessions.filter((s) => s.agentRunning === true).map((s) => s.name))
    finished.forEach(markFinished)
    // 会话被删掉了，它的角标也去掉
    const names = new Set(sessions.map((s) => s.name))
    if (Array.from(unseenRef.current).some((name) => !names.has(name))) {
      const next = new Set(Array.from(unseenRef.current).filter((name) => names.has(name)))
      unseenRef.current = next
      setUnseen(next)
    }
  }, [sessions, markFinished])

  const clearActive = React.useCallback(() => {
    const name = activeRef.current
    if (document.hidden || !name || !unseenRef.current.has(name)) return
    const next = new Set(unseenRef.current)
    next.delete(name)
    unseenRef.current = next
    setUnseen(next)
  }, [])

  React.useEffect(() => {
    clearActive()
  }, [activeSessionName, clearActive])

  React.useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) clearActive()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [clearActive])

  return { unseenCount: unseen.size, markFinished }
}
