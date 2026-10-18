// 任务结束提醒：标签页标题加 “(N) ” 角标，可选浏览器通知。
// 通知只写会话名和“已结束”，不带消息内容（锁屏、通知中心都会显示）

export const NOTIFY_STORAGE_KEY = "manyoyo:notify"

export function withAttentionBadge(title: string, count: number): string {
  return count > 0 ? `(${count}) ${title}` : title
}

// 两次会话列表之间“从执行中变成不在执行”的会话
export function findFinishedSessions(
  prevRunning: ReadonlySet<string>,
  sessions: { name: string; agentRunning?: boolean }[]
): string[] {
  const running = new Set(sessions.filter((s) => s.agentRunning === true).map((s) => s.name))
  return Array.from(prevRunning).filter((name) => !running.has(name) && sessions.some((s) => s.name === name))
}

// 什么时候算“用户没看到”：页面在后台，或者结束的不是当前打开的会话
export function shouldMarkUnseen(name: string, activeName: string | null, hidden: boolean): boolean {
  return hidden || name !== activeName
}

export function isNotifyEnabled(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(NOTIFY_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

export function setNotifyEnabled(enabled: boolean, storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage()) {
  try {
    if (enabled) storage?.setItem(NOTIFY_STORAGE_KEY, "1")
    else storage?.removeItem(NOTIFY_STORAGE_KEY)
  } catch {
    // 静默降级
  }
}

// 浏览器通知只在安全上下文（HTTPS 或 localhost）里可用
export function notificationSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === true && typeof Notification !== "undefined"
}

export function notifyFinished(displayName: string) {
  if (!notificationSupported() || !isNotifyEnabled() || Notification.permission !== "granted") return
  try {
    new Notification("MANYOYO", { body: `${displayName || "AGENT"} 已结束`, tag: `manyoyo-${displayName}` })
  } catch {
    // 部分浏览器（如 Android Chrome）只允许经 Service Worker 发通知，这里静默跳过
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null
  } catch {
    return null
  }
}
