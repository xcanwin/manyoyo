// 推理强度选项的本地缓存：按“会话 + 模型”记最近一次服务端给的结果。
// 取选项要进容器问模型目录，慢（首次约一秒）；有缓存就先用缓存立刻显示按钮，后台再对账，
// 否则每次打开会话按钮都要等一会儿才“突然冒出来”。
const KEY = "manyoyo:effort-levels"
const MAX_ENTRIES = 50

type Entry = { levels: string[]; envDefault: string }
type StorageLike = Pick<Storage, "getItem" | "setItem">

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null
  } catch {
    return null
  }
}

function readAll(storage: StorageLike | null): Record<string, Entry> {
  try {
    const parsed = JSON.parse(storage?.getItem(KEY) ?? "{}")
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function loadEffortCache(key: string, storage: StorageLike | null = defaultStorage()): Entry | null {
  const entry = readAll(storage)[key]
  if (!entry || !Array.isArray(entry.levels) || !entry.levels.every((item) => typeof item === "string")) return null
  return { levels: entry.levels, envDefault: typeof entry.envDefault === "string" ? entry.envDefault : "" }
}

export function saveEffortCache(key: string, entry: Entry, storage: StorageLike | null = defaultStorage()) {
  try {
    if (!storage) return
    const all = readAll(storage)
    delete all[key]
    all[key] = entry
    const keys = Object.keys(all)
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[old]
    storage.setItem(KEY, JSON.stringify(all))
  } catch {
    // 静默降级
  }
}
