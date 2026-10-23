import { describe, expect, test } from "vitest"

import type { ChatMessage } from "@/lib/api"
import { findModelDenied } from "@/lib/model-denied"

const msg = (role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `${role}-${content}`,
  role,
  content,
  timestamp: "",
  ...extra,
})

describe("findModelDenied", () => {
  test("最后一条回复带 networkDenied：返回域名和这一轮的提示词", () => {
    const list = [
      msg("user", "旧问题"),
      msg("assistant", "旧回复"),
      msg("user", "写个网页"),
      msg("assistant", "[执行过程]", { streamTrace: true }),
      msg("assistant", "已中止", { networkDenied: { host: "api.x.com", model: true } }),
    ]
    expect(findModelDenied(list)).toEqual({ host: "api.x.com", prompt: "写个网页" })
  })

  test("之后又有新的用户消息：不再提示", () => {
    const list = [
      msg("user", "a"),
      msg("assistant", "已中止", { networkDenied: { host: "api.x.com" } }),
      msg("user", "b"),
    ]
    expect(findModelDenied(list)).toBeNull()
  })

  test("没有 networkDenied、或这一轮还在进行：不提示", () => {
    expect(findModelDenied([msg("user", "a"), msg("assistant", "ok")])).toBeNull()
    expect(findModelDenied([msg("user", "a"), msg("assistant", "x", { networkDenied: { host: "h" }, pending: true })])).toBeNull()
    expect(findModelDenied([])).toBeNull()
  })
})
