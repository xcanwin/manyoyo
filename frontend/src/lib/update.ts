import { apiGet } from "@/lib/api"

export type UpdateInfo = {
  enabled: boolean
  installMode: string
  current: string
  latest: string
  updateAvailable: boolean
  checkedAt: string | null
  error: string
}

export const DISMISS_KEY = "manyoyo:update-dismissed"

export const fetchUpdateInfo = async () => (await apiGet("/api/system/update")) as unknown as UpdateInfo

// 有新版本，且用户没有对这个版本点过“知道了”才显示
export function shouldShowUpdate(info: UpdateInfo | null, dismissedVersion: string | null): boolean {
  if (!info || !info.enabled || !info.updateAvailable || !info.latest) return false
  return dismissedVersion !== info.latest
}

export function describeUpdate(info: UpdateInfo): string {
  return `发现新版本 ${info.latest}（当前 ${info.current}）。在终端执行 manyoyo update 即可升级，只下载变化的部分，随时可以用 manyoyo update --rollback 回滚。`
}
