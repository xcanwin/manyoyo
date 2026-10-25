import { describe, expect, test } from "vitest"

import type { ChatMessage } from "@/lib/api"
import { RECAP_IDLE_MS, lastFinishedReply, recapRequestFor, visibleRecap } from "@/lib/recap"

const T0 = Date.parse("2026-10-25T10:00:00.000Z")
const msg = (id: string, role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  content,
  mode: "agent",
  timestamp: new Date(T0).toISOString(),
  ...extra,
})
const talk = [msg("u1", "user", "修 bug"), msg("t1", "assistant", "[执行过程]", { streamTrace: true }), msg("a1", "assistant", "修好了")]

describe("lastFinishedReply", () => {
  test("跳过执行过程；执行中 / 被中断 / 用户消息结尾都不算", () => {
    expect(lastFinishedReply(talk)?.id).toBe("a1")
    expect(lastFinishedReply([...talk.slice(0, 2), msg("a1", "assistant", "写一半", { pending: true })])).toBeNull()
    expect(lastFinishedReply([...talk.slice(0, 2), msg("a1", "assistant", "中断", { interrupted: true })])).toBeNull()
    expect(lastFinishedReply([...talk, msg("u2", "user", "再来")])).toBeNull()
    expect(lastFinishedReply([])).toBeNull()
  })
})

describe("recapRequestFor", () => {
  test("空闲满 30 分钟、没有这条回复的回顾、没在运行才问", () => {
    expect(recapRequestFor(talk, null, T0 + RECAP_IDLE_MS, false)).toBe("a1")
    expect(recapRequestFor(talk, null, T0 + RECAP_IDLE_MS - 1, false)).toBeNull()
    expect(recapRequestFor(talk, null, T0 + RECAP_IDLE_MS, true)).toBeNull()
    expect(recapRequestFor(talk, { forMessageId: "a1", text: "x", createdAt: null }, T0 + 2 * RECAP_IDLE_MS, false)).toBeNull()
    expect(recapRequestFor(talk, { forMessageId: "old", text: "x", createdAt: null }, T0 + 2 * RECAP_IDLE_MS, false)).toBe("a1")
    expect(recapRequestFor([], null, T0 + RECAP_IDLE_MS, false)).toBeNull()
  })
})

describe("visibleRecap", () => {
  const recap = { forMessageId: "a1", text: "修好了 bug", createdAt: null }
  test("只在对应最后一条回复时显示；被关掉的不显示；有了新回复就消失", () => {
    expect(visibleRecap(talk, recap, "")).toEqual(recap)
    expect(visibleRecap(talk, recap, "a1")).toBeNull()
    expect(visibleRecap([...talk, msg("u2", "user", "继续")], recap, "")).toBeNull()
    expect(visibleRecap(talk, { ...recap, forMessageId: "zz" }, "")).toBeNull()
    expect(visibleRecap(talk, null, "")).toBeNull()
  })
})
