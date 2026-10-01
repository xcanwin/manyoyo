import * as React from "react"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DISMISS_KEY, describeUpdate, fetchUpdateInfo, shouldShowUpdate, type UpdateInfo } from "@/lib/update"

// 右下角的小提示：fixed 定位，不占布局，不挡工作台；每个新版本只提示到用户点掉为止
export function UpdateBanner() {
  const [info, setInfo] = React.useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = React.useState<string | null>(() => {
    try {
      return window.localStorage.getItem(DISMISS_KEY)
    } catch {
      return null
    }
  })

  React.useEffect(() => {
    let cancelled = false
    fetchUpdateInfo()
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch(() => {
        // 检查失败不打扰用户
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!info || !shouldShowUpdate(info, dismissed)) return null

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, info!.latest)
    } catch {
      // 存不了就只在本次会话里关掉
    }
    setDismissed(info!.latest)
  }

  return (
    <div
      role="status"
      data-testid="update-banner"
      className="fixed right-3 bottom-3 z-50 flex max-w-sm items-start gap-2 rounded-lg border bg-card p-3 text-sm text-card-foreground shadow-lg"
    >
      <p className="flex-1">{describeUpdate(info)}</p>
      <Button type="button" size="icon-xs" variant="ghost" aria-label="知道了" onClick={dismiss}>
        <XIcon />
      </Button>
    </div>
  )
}
