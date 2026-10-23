import { describe, expect, test } from "vitest"

import type { ChatMessage } from "@/lib/api"
import { groupHiddenMessages } from "@/lib/hidden-groups"

const m = (id: string, role: ChatMessage["role"], hidden = false): ChatMessage => ({ id, role, content: id, timestamp: "", hidden })

describe("groupHiddenMessages", () => {
  test("连续隐藏的归成一组，第一条标 first，用户消息带上", () => {
    const groups = groupHiddenMessages([m("u1", "user"), m("a1", "assistant"), m("u2", "user", true), m("a2", "assistant", true), m("u3", "user")])
    expect(groups.size).toBe(2)
    expect(groups.get("u2")).toMatchObject({ key: "u2", first: true })
    expect(groups.get("u2")?.userMessage?.id).toBe("u2")
    expect(groups.get("a2")).toMatchObject({ key: "u2", first: false })
    expect(groups.get("a2")?.userMessage?.id).toBe("u2")
  })

  test("相邻的两个隐藏组按用户消息分开", () => {
    const groups = groupHiddenMessages([m("u1", "user", true), m("a1", "assistant", true), m("u2", "user", true), m("a2", "assistant", true)])
    expect(groups.get("u1")?.first).toBe(true)
    expect(groups.get("u2")?.first).toBe(true)
    expect(groups.get("a2")?.key).toBe("u2")
  })

  test("只剩回复没有用户消息（分页截断）：自成一组，没有取消隐藏的对象", () => {
    const groups = groupHiddenMessages([m("a1", "assistant", true), m("u2", "user")])
    expect(groups.get("a1")).toMatchObject({ key: "a1", first: true })
    expect(groups.get("a1")?.userMessage).toBeUndefined()
  })

  test("没有隐藏的消息：空", () => {
    expect(groupHiddenMessages([m("u1", "user")]).size).toBe(0)
  })
})
