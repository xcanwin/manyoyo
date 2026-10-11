// 提示词本地草稿与待发箱：发送前先落到 localStorage，没发出去就放回输入框。
// 所有读写都 try/catch：localStorage 不可用（隐私模式、配额、被禁用）时静默降级为内存行为

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">

export type Outbox = {
  clientId: string
  text: string
  mode: "agent" | "command"
  createdAt: number
  tabId: string
}

export type ComposerState = { draft: string; outbox?: Outbox }

const KEY_PREFIX = "manyoyo:composer:"
const TAB_ID_KEY = "manyoyo:tabId"
const EXPIRE_MS = 30 * 24 * 3600 * 1000
const OTHER_TAB_GRACE_MS = 10 * 1000

function defaultStorage(): StorageLike | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function keyOf(sessionName: string): string {
  return `${KEY_PREFIX}${sessionName}`
}

type Stored = { draft?: unknown; outbox?: unknown; updatedAt?: unknown }

function readStored(sessionName: string, storage: StorageLike | null): Stored {
  try {
    const raw = storage?.getItem(keyOf(sessionName))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {}
  } catch {
    return {}
  }
}

function isOutbox(value: unknown): value is Outbox {
  const v = value as Partial<Outbox> | null
  return (
    !!v &&
    typeof v.clientId === "string" &&
    typeof v.text === "string" &&
    (v.mode === "agent" || v.mode === "command") &&
    typeof v.createdAt === "number" &&
    typeof v.tabId === "string"
  )
}

function writeStored(sessionName: string, draft: string, outbox: Outbox | undefined, storage: StorageLike | null) {
  try {
    if (!storage) return
    if (!draft && !outbox) {
      storage.removeItem(keyOf(sessionName))
      return
    }
    storage.setItem(keyOf(sessionName), JSON.stringify({ draft, outbox, updatedAt: Date.now() }))
  } catch {
    // 静默降级
  }
}

export function loadComposer(sessionName: string, storage: StorageLike | null = defaultStorage()): ComposerState {
  const stored = readStored(sessionName, storage)
  const state: ComposerState = { draft: typeof stored.draft === "string" ? stored.draft : "" }
  if (isOutbox(stored.outbox)) state.outbox = stored.outbox
  return state
}

export function saveDraft(sessionName: string, draft: string, storage: StorageLike | null = defaultStorage()) {
  writeStored(sessionName, draft, loadComposer(sessionName, storage).outbox, storage)
}

// 发送前同步调用：写入待发箱并清空草稿
export function setOutbox(sessionName: string, outbox: Outbox, storage: StorageLike | null = defaultStorage()) {
  writeStored(sessionName, "", outbox, storage)
}

// clientId 给了就只清匹配的那一条（别的标签页可能已经换了新的待发箱）
export function clearOutbox(sessionName: string, clientId?: string, storage: StorageLike | null = defaultStorage()) {
  const state = loadComposer(sessionName, storage)
  if (!state.outbox) return
  if (clientId !== undefined && state.outbox.clientId !== clientId) return
  writeStored(sessionName, state.draft, undefined, storage)
}

export function clearAllComposerData(storage: StorageLike | null = defaultStorage()) {
  try {
    if (!storage) return
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key && key.startsWith(KEY_PREFIX)) keys.push(key)
    }
    keys.forEach((key) => storage.removeItem(key))
  } catch {
    // 静默降级
  }
}

export function purgeExpiredComposerData(now: number = Date.now(), storage: StorageLike | null = defaultStorage()) {
  try {
    if (!storage) return
    const expired: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (!key || !key.startsWith(KEY_PREFIX)) continue
      const updatedAt = readStored(key.slice(KEY_PREFIX.length), storage).updatedAt
      if (typeof updatedAt === "number" && now - updatedAt > EXPIRE_MS) expired.push(key)
    }
    expired.forEach((key) => storage.removeItem(key))
  } catch {
    // 静默降级
  }
}

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes)
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(buf)
  else for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256)
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")
}

// 服务端格式：^[A-Za-z0-9_-]{8,64}$
export function createClientMessageId(): string {
  return `c${Date.now().toString(36)}${randomToken(6)}`
}

// 标签页 id：存在 sessionStorage 里，刷新后不变，用来区分“本标签页写的”和“别的标签页写的”
export function getTabId(): string {
  try {
    const existing = window.sessionStorage.getItem(TAB_ID_KEY)
    if (existing) return existing
    const id = randomToken(8)
    window.sessionStorage.setItem(TAB_ID_KEY, id)
    return id
  } catch {
    return "tab-fallback"
  }
}

export type OutboxDecision = "none" | "clear" | "wait" | "restore"

export function decideOutboxRestore(params: {
  outbox: Outbox | undefined
  messages: Array<{ clientMessageId?: string }>
  sessionRunning: boolean
  currentTabId: string
  now: number
}): OutboxDecision {
  const { outbox } = params
  if (!outbox) return "none"
  if (params.messages.some((m) => m.clientMessageId === outbox.clientId)) return "clear"
  if (params.sessionRunning) return "wait"
  if (outbox.tabId !== params.currentTabId && params.now - outbox.createdAt < OTHER_TAB_GRACE_MS) return "wait"
  return "restore"
}

// 用户文字永远不被覆盖：输入框为空才直接填，否则只给提示和“恢复”按钮
export function planRestore(currentDraft: string, outbox: Outbox): { kind: "fill"; text: string } | { kind: "banner" } {
  return currentDraft.trim() === "" ? { kind: "fill", text: outbox.text } : { kind: "banner" }
}
