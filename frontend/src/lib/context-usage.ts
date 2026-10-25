// 上下文占用读数（仅 claude，见 lib/web/context-usage.js）。缓存时长在第三方服务下未知，提示一律用“可能”。

export type ContextUsage = {
  usedTokens: number
  // 0 = 不知道上下文窗口，不显示百分比
  window: number
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  updatedAt: string | null
}

export const IDLE_HINT_AFTER_MS = 5 * 60 * 1000

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${trim(count / 1_000_000)}M`
  if (count >= 1000) return `${trim(count / 1000)}k`
  return String(Math.max(0, Math.round(count)))
}

function trim(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "")
}

export function usagePercent(usage: ContextUsage): number | null {
  if (!usage.window || usage.window <= 0) return null
  return Math.min(100, (usage.usedTokens / usage.window) * 100)
}

// 小读数：“4.5k · 0%”；窗口未知只显示用量
export function contextReadout(usage: ContextUsage): string {
  const percent = usagePercent(usage)
  if (percent === null) return formatTokens(usage.usedTokens)
  const text = percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`
  return `${formatTokens(usage.usedTokens)} · ${text}`
}

// 上一次请求里有多少输入来自缓存（0～100）；没有输入时为 null
export function cacheHitPercent(usage: ContextUsage): number | null {
  const total = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
  if (total <= 0) return null
  return Math.round((usage.cacheReadTokens / total) * 100)
}

// 空闲超过 5 分钟：缓存可能已经过期，下次发送要重新缓存
export function idleHint(updatedAt: string | null, now: number): string {
  if (!updatedAt) return ""
  const elapsed = now - Date.parse(updatedAt)
  if (!Number.isFinite(elapsed) || elapsed < IDLE_HINT_AFTER_MS) return ""
  const minutes = Math.floor(elapsed / 60000)
  const span = minutes >= 60 ? `${Math.floor(minutes / 60)} 小时` : `${minutes} 分钟`
  return `已空闲 ${span}，下次发送可能要重新缓存（更贵）`
}
