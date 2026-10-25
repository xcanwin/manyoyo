import type { ChatMessage } from "@/lib/api"
import { lastFinishedReply } from "@/lib/recap"

// 计划模式（仅 claude）：这一轮只出计划不改文件，发送一次后自动关闭，避免忘了关。状态按会话记在 localStorage。
const KEY_PREFIX = "manyoyo:plan:"

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null
  } catch {
    return null
  }
}

export function loadPlanMode(sessionName: string, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(KEY_PREFIX + sessionName) === "1"
  } catch {
    return false
  }
}

export function savePlanMode(sessionName: string, on: boolean, storage: StorageLike | null = defaultStorage()) {
  try {
    if (!storage) return
    if (on) storage.setItem(KEY_PREFIX + sessionName, "1")
    else storage.removeItem(KEY_PREFIX + sessionName)
  } catch {
    // 静默降级
  }
}

export const EXECUTE_PLAN_PROMPT = "按上面的计划执行。"

// “按计划执行”按钮挂在哪条回复下面：最后一条已完成的最终回复，而且它对应的提问是计划模式发出的；任务进行中不显示
export function planExecuteTarget(messages: ChatMessage[], running: boolean): string {
  if (running) return ""
  const reply = lastFinishedReply(messages)
  if (!reply) return ""
  const index = messages.indexOf(reply)
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = messages[i]
    if (item.role === "user" && item.mode === "agent") {
      return item.planMode === true ? String(reply.id) : ""
    }
  }
  return ""
}
