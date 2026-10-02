// 时间一律按 zh-CN + 24 小时制的 "MM/DD HH:mm" 紧凑格式显示。
//
// 不要退回裸的 toLocaleString()：那样输出跟着浏览器语言走，英文环境会变成
// "9/20/2026, 10:12:33 AM"——既多了年份和秒这类噪音，又长到把侧边栏的会话行
// 挤变形。界面本身是中文的，时间格式也固定住才一致。
export function formatDateTime(
  value: string | number | null | undefined
): string {
  if (value === null || value === undefined) return ""
  const raw = typeof value === "string" ? value.trim() : value
  if (raw === "") return ""
  const date = new Date(raw)
  // 解析不出来时原样回显，至少让人看见服务端给了什么，而不是凭空变成空白
  if (Number.isNaN(date.getTime())) return String(raw)
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

// 字节数转人类可读体积。fallback 决定拿不到大小时显示什么：容量估算页要显示
// "未知"，文件列表里则宁可留白也不要塞一行噪音
export function formatBytes(
  bytes: number | null | undefined,
  fallback = "未知"
): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes))
    return fallback
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes
  let unitIndex = -1
  do {
    value /= 1024
    unitIndex += 1
  } while (value >= 1024 && unitIndex < units.length - 1)
  return `${value.toFixed(1)} ${units[unitIndex]}`
}
