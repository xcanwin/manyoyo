import { describe, expect, test } from "vitest"

import { findFinishedSessions, isNotifyEnabled, setNotifyEnabled, shouldMarkUnseen, withAttentionBadge, withRunningPrefix } from "./attention"

describe("任务结束提醒", () => {
  test("标题角标", () => {
    expect(withAttentionBadge("A · MANYOYO Web", 0)).toBe("A · MANYOYO Web")
    expect(withAttentionBadge("A · MANYOYO Web", 2)).toBe("(2) A · MANYOYO Web")
  })
  test("从执行中变成不在执行的会话；被删掉的不算", () => {
    const prev = new Set(["a", "b", "gone"])
    expect(findFinishedSessions(prev, [{ name: "a", agentRunning: false }, { name: "b", agentRunning: true }])).toEqual(["a"])
  })
  test("页面在后台或不是当前会话才算没看到", () => {
    expect(shouldMarkUnseen("a", "a", false)).toBe(false)
    expect(shouldMarkUnseen("a", "a", true)).toBe(true)
    expect(shouldMarkUnseen("a", "b", false)).toBe(true)
  })
  test("通知开关存在本机", () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) }
    expect(isNotifyEnabled(storage)).toBe(false)
    setNotifyEnabled(true, storage)
    expect(isNotifyEnabled(storage)).toBe(true)
    setNotifyEnabled(false, storage)
    expect(isNotifyEnabled(storage)).toBe(false)
  })
})

describe("withRunningPrefix", () => {
  test("执行中加 ◐ 前缀，与未读角标共存时角标在最前", () => {
    expect(withRunningPrefix("A · MANYOYO Web", false)).toBe("A · MANYOYO Web")
    expect(withRunningPrefix("A · MANYOYO Web", true)).toBe("◐ A · MANYOYO Web")
    expect(withAttentionBadge(withRunningPrefix("A", true), 2)).toBe("(2) ◐ A")
  })
})
