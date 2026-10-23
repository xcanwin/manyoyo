import { apiGet } from "@/lib/api"

const CACHE_MS = 5000
const cache = new Map<string, { at: number; value: Promise<boolean> }>()

// 点聊天里的路径前先问一下它在不在；查询失败一律当作不存在（什么都不做）
export function sessionPathExists(sessionName: string, path: string): Promise<boolean> {
  const key = `${sessionName}\n${path}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_MS) return hit.value
  const value = apiGet(`/api/sessions/${encodeURIComponent(sessionName)}/fs/stat?path=${encodeURIComponent(path)}`)
    .then((res) => Boolean((res as { exists?: boolean } | null)?.exists))
    .catch(() => false)
  cache.set(key, { at: now, value })
  return value
}

export function clearPathExistsCache() {
  cache.clear()
}
