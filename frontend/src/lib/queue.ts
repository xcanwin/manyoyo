// 任务进行中追加提示词：排队条目的类型、插入时机的文案与“记住上次选择”

export type QueueWhen = "now" | "step" | "turn"

export type QueueItem = {
  id: string
  clientMessageId: string
  text: string
  when: QueueWhen
  createdAt: string
}

export const QUEUE_WHEN_ORDER: QueueWhen[] = ["now", "step", "turn"]

// 下拉框里的选项文字
export const QUEUE_WHEN_LABELS: Record<QueueWhen, string> = {
  now: "立即插入",
  step: "当前这一步结束后插入",
  turn: "这一轮结束后发送",
}

// “排队中”气泡上的角标
export const QUEUE_WHEN_BADGES: Record<QueueWhen, string> = {
  now: "立即插入",
  step: "这一步结束后插入",
  turn: "这一轮结束后发送",
}

const STORAGE_KEY = "manyoyo:queue-when"

function isWhen(value: unknown): value is QueueWhen {
  return value === "now" || value === "step" || value === "turn"
}

// 默认“这一轮结束后发送”：不打断正在做的事，最稳妥
export function loadQueueWhen(): QueueWhen {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return isWhen(value) ? value : "turn"
  } catch {
    return "turn"
  }
}

export function saveQueueWhen(value: QueueWhen): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // localStorage 不可用时只是记不住，不影响发送
  }
}

// 服务端 /messages 与队列接口返回的 queue 字段：只留结构合法的条目
export function parseQueue(value: unknown): QueueItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter(
      (item): item is QueueItem =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as QueueItem).id === "string" &&
        typeof (item as QueueItem).text === "string" &&
        isWhen((item as QueueItem).when)
    )
    .map((item) => ({
      id: item.id,
      clientMessageId: typeof item.clientMessageId === "string" ? item.clientMessageId : "",
      text: item.text,
      when: item.when,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
    }))
}
