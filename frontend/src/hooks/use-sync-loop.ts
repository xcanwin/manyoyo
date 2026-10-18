import * as React from "react"

import { createCoalescer, decideSyncDelay } from "@/lib/sync-scheduler"

export const SYNC_EVENT_COALESCE_MS = 300
// 离开页面超过这么久再回来，才算“回来了”，需要告诉用户同步结果（只切出去一下不打扰）
export const RESUME_HIDDEN_MS = 5000

// 多设备/多标签页同步：只靠 visibilitychange/focus 事件覆盖不了“两个窗口同时摆在眼前”的场景，
// 所以页面可见期间还要定时同步。节奏由 decideSyncDelay 决定（有焦点 6 秒、没焦点 30 秒、
// 隐藏或空闲超过 10 分钟暂停），用 setTimeout 链而不是 setInterval：上一轮结束后才排下一轮，
// 慢网下请求不会堆积。切回页面/重新聚焦时立刻同步一次（visibilitychange 与 focus 合并）。
// reconcile(manual)：manual=true 是切回页面触发的主动同步。
// onResumeSync：离开页面一阵子后回来、或网络恢复时触发的那一次同步，交给界面显示“正在同步 / 已同步”；
// 定时同步、窗口重新聚焦都不算（否则每几秒闪一次）
export function useSyncLoop(
  reconcile: (manual: boolean) => Promise<void>,
  options: { onResumeSync?: (sync: Promise<void>) => void } = {}
) {
  const onResumeSyncRef = React.useRef(options.onResumeSync)
  React.useEffect(() => {
    onResumeSyncRef.current = options.onResumeSync
  })
  React.useEffect(() => {
    let lastActivityAt = Date.now()
    let timer = 0
    let ticking = false
    let cancelled = false
    let hiddenAt = document.visibilityState === "visible" ? 0 : Date.now()
    let resumePending = false
    let lastSync: Promise<void> | null = null

    function schedule() {
      window.clearTimeout(timer)
      timer = 0
      if (cancelled || ticking) return
      const delay = decideSyncDelay({
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        idleMs: Date.now() - lastActivityAt,
      })
      if (delay === null) return
      timer = window.setTimeout(async () => {
        timer = 0
        ticking = true
        try {
          await reconcile(false)
        } finally {
          ticking = false
        }
        schedule()
      }, delay)
    }

    function markActivity() {
      lastActivityAt = Date.now()
      if (timer === 0 && !ticking) schedule()
    }
    const onVisibleOrFocus = createCoalescer(SYNC_EVENT_COALESCE_MS, () => {
      markActivity()
      const sync = reconcile(true)
      lastSync = sync
      if (resumePending) {
        resumePending = false
        onResumeSyncRef.current?.(sync)
      }
      void sync
      schedule()
    })
    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        if (hiddenAt && Date.now() - hiddenAt >= RESUME_HIDDEN_MS) resumePending = true
        hiddenAt = 0
        onVisibleOrFocus()
        attachResumeToLastSync()
      } else {
        hiddenAt = Date.now()
        schedule()
      }
    }
    function onOnline() {
      resumePending = true
      onVisibleOrFocus()
      attachResumeToLastSync()
    }
    // 合并窗口里先来了一次 focus：这次“回来”被合并掉了，提示挂到刚发出的那次同步上，
    // 不能留着等到之后某次普通聚焦才显示
    function attachResumeToLastSync() {
      if (!resumePending) return
      resumePending = false
      if (lastSync) onResumeSyncRef.current?.(lastSync)
    }
    const activityEvents: Array<keyof WindowEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "touchstart",
      "scroll",
    ]
    activityEvents.forEach((type) => window.addEventListener(type, markActivity, { passive: true }))
    document.addEventListener("visibilitychange", onVisibilityChange)
    window.addEventListener("focus", onVisibleOrFocus)
    window.addEventListener("blur", schedule)
    window.addEventListener("online", onOnline)
    schedule()
    return () => {
      cancelled = true
      activityEvents.forEach((type) => window.removeEventListener(type, markActivity))
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.removeEventListener("focus", onVisibleOrFocus)
      window.removeEventListener("blur", schedule)
      window.removeEventListener("online", onOnline)
      window.clearTimeout(timer)
    }
  }, [reconcile])
}
