import * as React from "react"

import { createCoalescer, decideSyncDelay } from "@/lib/sync-scheduler"

export const SYNC_EVENT_COALESCE_MS = 300

// 多设备/多标签页同步：只靠 visibilitychange/focus 事件覆盖不了“两个窗口同时摆在眼前”的场景，
// 所以页面可见期间还要定时同步。节奏由 decideSyncDelay 决定（有焦点 6 秒、没焦点 30 秒、
// 隐藏或空闲超过 10 分钟暂停），用 setTimeout 链而不是 setInterval：上一轮结束后才排下一轮，
// 慢网下请求不会堆积。切回页面/重新聚焦时立刻同步一次（visibilitychange 与 focus 合并）。
// reconcile(manual)：manual=true 是切回页面触发的主动同步。
export function useSyncLoop(reconcile: (manual: boolean) => Promise<void>) {
  React.useEffect(() => {
    let lastActivityAt = Date.now()
    let timer = 0
    let ticking = false
    let cancelled = false

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
      void reconcile(true)
      schedule()
    })
    function onVisibilityChange() {
      if (document.visibilityState === "visible") onVisibleOrFocus()
      else schedule()
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
    schedule()
    return () => {
      cancelled = true
      activityEvents.forEach((type) => window.removeEventListener(type, markActivity))
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.removeEventListener("focus", onVisibleOrFocus)
      window.removeEventListener("blur", schedule)
      window.clearTimeout(timer)
    }
  }, [reconcile])
}
