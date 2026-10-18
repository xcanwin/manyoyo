import * as React from "react"

export type ResumePhase = "idle" | "syncing" | "synced"

// 回到页面后的同步提示：超过 300ms 还没同步完才显示进度线（快的时候不闪）；
// 同步成功后显示 1.5 秒“已同步”；失败什么都不加（沿用已有的错误提示）
export const RESUME_PROGRESS_DELAY_MS = 300
export const RESUME_SYNCED_MS = 1500

export function useResumeIndicator() {
  const [phase, setPhase] = React.useState<ResumePhase>("idle")
  const timersRef = React.useRef<number[]>([])
  const seqRef = React.useRef(0)

  const clearTimers = React.useCallback(() => {
    timersRef.current.forEach((id) => window.clearTimeout(id))
    timersRef.current = []
  }, [])

  React.useEffect(() => clearTimers, [clearTimers])

  // succeeded：同步结束后判断这次是否真的拿到了服务端的最新状态
  const track = React.useCallback(
    (sync: Promise<unknown>, succeeded: () => boolean) => {
      const seq = ++seqRef.current
      clearTimers()
      timersRef.current.push(window.setTimeout(() => seq === seqRef.current && setPhase("syncing"), RESUME_PROGRESS_DELAY_MS))
      const finish = () => {
        if (seq !== seqRef.current) return
        clearTimers()
        if (!succeeded()) {
          setPhase("idle")
          return
        }
        setPhase("synced")
        timersRef.current.push(window.setTimeout(() => seq === seqRef.current && setPhase("idle"), RESUME_SYNCED_MS))
      }
      sync.then(finish, finish)
    },
    [clearTimers]
  )

  return { phase, track }
}
