import * as React from "react"

import { createSingleFlight, type SingleFlight } from "@/lib/sync-scheduler"

// 同步请求必须经过单飞：同一时间最多一个在路上，定时触发遇到在途请求直接跳过；
// 主动触发（发送结束、停止、切回页面）遇到在途请求则排队补跑一次，不能丢。
// 每个会话一个实例，切换会话时 abort 上一个会话还在路上的请求。
// syncOnce 每次执行一轮同步（forcePage：用最近一页覆盖本地，流结束/停止后的对账用）。
export function useSessionSync(
  sessionName: string | null,
  syncOnce: (name: string, signal: AbortSignal, forcePage: boolean) => Promise<unknown>,
  onNoSession: () => void
) {
  // 记的是“哪个会话要整页对账”，而不是一个全局布尔值：没有会话时发出的请求、或随被 abort 的那一轮丢失的请求，
  // 不能被另一个会话的首次同步拿去用
  const forcePageForRef = React.useRef<string | null>(null)
  const currentNameRef = React.useRef<string | null>(sessionName)
  const flightRef = React.useRef<SingleFlight | null>(null)
  const requestSync = React.useCallback((manual: boolean, forcePage = false): Promise<void> => {
    if (forcePage) forcePageForRef.current = currentNameRef.current
    return flightRef.current?.run(manual) ?? Promise.resolve()
  }, [])
  const syncOnceRef = React.useRef(syncOnce)
  const onNoSessionRef = React.useRef(onNoSession)
  React.useEffect(() => {
    syncOnceRef.current = syncOnce
    onNoSessionRef.current = onNoSession
  }, [syncOnce, onNoSession])

  React.useEffect(() => {
    currentNameRef.current = sessionName
    forcePageForRef.current = null
    if (!sessionName) {
      flightRef.current = null
      queueMicrotask(() => onNoSessionRef.current())
      return
    }
    const flight = createSingleFlight(async (signal) => {
      const forcePage = forcePageForRef.current === sessionName
      if (forcePage) forcePageForRef.current = null
      await syncOnceRef.current(sessionName, signal, forcePage)
    })
    flightRef.current = flight
    queueMicrotask(() => {
      void flight.run(true)
    })
    return () => {
      flight.abort()
      if (flightRef.current === flight) flightRef.current = null
    }
  }, [sessionName])

  return requestSync
}
