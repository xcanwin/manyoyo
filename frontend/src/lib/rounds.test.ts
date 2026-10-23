import { describe, expect, test } from "vitest"

import type { ChatMessage } from "@/lib/api"
import { buildRoundOptions } from "@/lib/rounds"

const S1 = "1".repeat(40)
const S2 = "2".repeat(40)
const user = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: "user", content, timestamp: "", mode: "agent", ...extra })

describe("buildRoundOptions", () => {
  test("只收有前后两张快照的用户消息，序号按所有 Agent 轮次算", () => {
    const rounds = buildRoundOptions([
      user("u1", "旧的一轮"),
      { id: "a1", role: "assistant", content: "x", timestamp: "" },
      user("u2", "写个很长很长很长很长很长很长很长很长很长很长很长很长的提示词", { snapBefore: S1, snapAfter: S2 }),
      user("u3", "只有开始前", { snapBefore: S1 }),
      user("u4", "命令", { mode: "command", snapBefore: S1, snapAfter: S2 }),
      user("u5", "坏快照", { snapBefore: "HEAD", snapAfter: S2 }),
    ])
    expect(rounds).toHaveLength(1)
    expect(rounds[0]).toMatchObject({ id: "u2", before: S1, after: S2 })
    expect(rounds[0].label.startsWith("第 2 轮 · 写个很长")).toBe(true)
    expect(rounds[0].label.endsWith("…")).toBe(true)
  })
})
