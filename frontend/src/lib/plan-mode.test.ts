import { describe, expect, test } from "vitest"

import type { ChatMessage } from "@/lib/api"
import { loadPlanMode, planExecuteTarget, savePlanMode } from "@/lib/plan-mode"

const msg = (id: string, role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  content,
  mode: "agent",
  timestamp: "2026-10-25T10:00:00.000Z",
  ...extra,
})

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

describe("计划模式开关", () => {
  test("按会话记在 localStorage，关掉就清除；没有存储时静默", () => {
    const storage = memoryStorage()
    expect(loadPlanMode("a", storage)).toBe(false)
    savePlanMode("a", true, storage)
    expect(loadPlanMode("a", storage)).toBe(true)
    expect(loadPlanMode("b", storage)).toBe(false)
    savePlanMode("a", false, storage)
    expect(loadPlanMode("a", storage)).toBe(false)
    expect(() => savePlanMode("a", true, null)).not.toThrow()
    expect(loadPlanMode("a", null)).toBe(false)
  })
})

describe("planExecuteTarget", () => {
  const plan = [msg("u1", "user", "加 mul", { planMode: true }), msg("t1", "assistant", "[执行过程]", { streamTrace: true }), msg("a1", "assistant", "计划如下")]
  test("最后一轮是计划模式发出的、已完成、空闲：挂在最终回复上", () => {
    expect(planExecuteTarget(plan, false)).toBe("a1")
  })
  test("任务进行中、普通提问、已经有后续提问：不显示", () => {
    expect(planExecuteTarget(plan, true)).toBe("")
    expect(planExecuteTarget([msg("u1", "user", "加 mul"), msg("a1", "assistant", "好")], false)).toBe("")
    expect(planExecuteTarget([...plan, msg("u2", "user", "按上面的计划执行。")], false)).toBe("")
    expect(planExecuteTarget([...plan, msg("u2", "user", "按上面的计划执行。"), msg("a2", "assistant", "做完了")], false)).toBe("")
    expect(planExecuteTarget([], false)).toBe("")
  })
})
